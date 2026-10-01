// Render worker do editor: resolveFrame → fontes (DecoderPool) → Compositor WebGL2 → `rendered`.
// Único caminho de render para preview e exportação. Pedidos de quadro que chegam durante um
// render são coalescidos (fica só o último); o cliente resolve os intermediários com o resultado dele.
// Todo VideoFrame entregue ao compositor é fechado no mesmo quadro (ver posse em decoderPool.ts).
import { resolveFrame, type AnnotationsLayer } from '@shared/editor/resolve'
import type { Project } from '@shared/editor/project'
import type { Session } from '@shared/types'
import { drawStrokes } from '@shared/compositor'
import { FILE_PROTOCOL } from '@shared/ipc'
import { Compositor, type SourceMeta } from './compositor/compositor'
import { DecoderPool } from './decoderPool'
import type { RenderIn, RenderOut } from './protocol'

type FrameMsg = Extract<RenderIn, { t: 'frame' }>

const post = (m: RenderOut, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer)

// Sessão indisponível: nova tentativa depois disso.
const SESSION_RETRY_MS = 5000
// Reprodução: decoders dos itens que começam dentro desse intervalo são aquecidos antes.
const PREFETCH_US = 1_000_000

let compositor: Compositor | null = null
let canvas: OffscreenCanvas | null = null
let dpr = 1
const pool = new DecoderPool()
let project: Project | null = null
let selection: string[] = []
let pending: FrameMsg | null = null
let busy = false
// Sessões das anotações: carregadas antes do draw (que é síncrono). Falha → null, nova tentativa após SESSION_RETRY_MS.
const sessions = new Map<string, { load: Promise<void>; session: Session | null; failedAt: number | null }>()
let annCanvas: OffscreenCanvas | null = null
// itens já aquecidos nesta reprodução (zera ao pausar/seek)
const prefetched = new Set<string>()

self.addEventListener('message', (e: MessageEvent<RenderIn>) => {
  const m = e.data
  try {
    switch (m.t) {
      case 'init':
        canvas = m.canvas
        dpr = m.dpr || 1
        compositor = new Compositor(m.canvas)
        compositor.resize(m.width * dpr, m.height * dpr)
        canvas.addEventListener('webglcontextlost', () => post({ t: 'error', message: 'contexto WebGL perdido', fatal: true }))
        post({ t: 'ready' })
        break
      case 'project': {
        project = m.project
        const urls: Record<string, string> = {}
        for (const [id, u] of Object.entries(m.mediaUrls)) urls[id] = m.useProxy && u.proxy ? u.proxy : u.original
        pool.setSources(urls)
        if (!busy) pool.flushRetired()
        break
      }
      case 'resize':
        compositor?.resize(m.width * dpr, m.height * dpr)
        break
      case 'frame':
        pending = m
        if (!busy) void pump()
        break
      case 'overlay':
        selection = m.selection
        break
      case 'idle':
        pool.releaseAll()
        break
      case 'readPixels': {
        const data = compositor ? compositor.readPixels(m.x, m.y, m.w, m.h) : new Uint8Array(0)
        post({ t: 'pixels', id: m.id, data }, [data.buffer])
        break
      }
      case 'dispose':
        pending = null
        project = null
        compositor?.dispose()
        compositor = null
        pool.dispose()
        post({ t: 'disposed' })
        break
      case 'exportStart':
        post({ t: 'exportError', jobId: m.jobId, message: 'exportação ainda não disponível' })
        break
      case 'exportCancel':
      case 'chunkAck':
        break
    }
  } catch (err) {
    post({ t: 'error', message: errMsg(err), fatal: m.t === 'init' })
  }
})

async function pump(): Promise<void> {
  busy = true
  try {
    while (pending) {
      const m = pending
      pending = null
      try {
        await renderFrame(m)
      } catch (err) {
        post({ t: 'error', message: errMsg(err), fatal: false, seq: m.seq })
      }
      pool.flushRetired() // nenhuma ImageBitmap substituída está em uso entre quadros
    }
  } finally {
    busy = false
  }
}

async function renderFrame(m: FrameMsg): Promise<void> {
  const t0 = performance.now()
  const comp = compositor
  const p = project
  if (!comp || !p || !canvas) throw new Error('render antes de init/project')
  const W = canvas.width
  const H = canvas.height
  const layers = resolveFrame(p, m.tUs)
  const sources = new Map<string, TexImageSource | VideoFrame | null>()
  const meta = new Map<string, SourceMeta>()
  const missing = new Set<string>()
  const frames: VideoFrame[] = []
  // mesmo asset em mais de uma camada no quadro: cada uma com seu slot (iterador próprio)
  const slots = new Map<string, number>()
  const used: [string, number][] = []

  try {
    // allSettled + try/catch por camada: nenhuma camada aborta a coleta das outras, e todo quadro
    // obtido entra em `frames` antes do finally (sem vazamento quando uma camada falha).
    await Promise.allSettled(
      layers.map(async (layer) => {
        if (layer.kind === 'annotations') {
          await loadSession(layer.sessionId)
          return
        }
        if (layer.kind !== 'media') return
        const asset = p.assets.find((a) => a.id === layer.assetId)
        let src: TexImageSource | VideoFrame | null = null
        try {
          if (asset && asset.status !== 'missing') {
            if (layer.srcUs === null) {
              const bmp = await pool.image(asset.id)
              if (bmp) {
                src = bmp
                meta.set(layer.itemId, { w: bmp.width, h: bmp.height, rotation: 0 })
              }
            } else {
              const slot = slots.get(asset.id) ?? 0
              slots.set(asset.id, slot + 1)
              used.push([asset.id, slot])
              const sample = await pool.frameAt(asset.id, layer.srcUs, m.playing, slot)
              if (sample) {
                try {
                  // O VideoFrame do decoder vem sem rotação (mediabunny guarda a do arquivo em sample.rotation)
                  const frame = sample.toVideoFrame()
                  frames.push(frame)
                  src = frame
                  meta.set(layer.itemId, { w: frame.displayWidth, h: frame.displayHeight, rotation: sample.rotation })
                } finally {
                  sample.close()
                }
              }
            }
          }
        } catch {
          src = null
        }
        if (!src) {
          missing.add(layer.assetId)
          meta.set(layer.itemId, asset?.video ? { w: asset.video.width, h: asset.video.height, rotation: asset.video.rotation } : { w: W, h: H, rotation: 0 })
        }
        sources.set(layer.itemId, src)
      })
    )
    comp.draw(layers, sources, p.canvas.background, { meta, annotations: drawAnnotations, selectionOutline: selection.map((itemId) => ({ itemId })) })
  } finally {
    for (const f of frames) f.close()
  }
  // buffers de reprodução só para o que está no quadro (e o que vai começar) e só durante a reprodução
  if (m.playing) pool.releaseExcept([...used, ...prefetchUpcoming(p, m.tUs, used)])
  else {
    prefetched.clear()
    pool.releaseAll()
  }
  post({ t: 'rendered', seq: m.seq, tUs: m.tUs, ms: performance.now() - t0, missing: [...missing] })
}

/**
 * Reprodução: aquece o decoder dos itens que começam em até PREFETCH_US (uma vez por item), no slot e
 * na posição da fonte do quadro em que começam. Devolve as entradas a manter fora do releaseExcept.
 * Não mexe numa entrada em uso no quadro atual (reposicionar o iterador quebraria a reprodução dela).
 */
function prefetchUpcoming(p: Project, tUs: number, used: [string, number][]): [string, number][] {
  const busyKeys = new Set(used.map(([a, s]) => `${a}#${s}`))
  const keep: [string, number][] = []
  for (const track of p.tracks) {
    if (track.hidden) continue
    for (const item of track.items) {
      if (item.type !== 'media' || item.startUs <= tUs || item.startUs > tUs + PREFETCH_US) continue
      // slots como em renderFrame: ordem das camadas de vídeo com asset disponível
      const slots = new Map<string, number>()
      for (const layer of resolveFrame(p, item.startUs)) {
        if (layer.kind !== 'media' || layer.srcUs === null) continue
        const asset = p.assets.find((a) => a.id === layer.assetId)
        if (!asset || asset.status === 'missing') continue
        const slot = slots.get(asset.id) ?? 0
        slots.set(asset.id, slot + 1)
        if (layer.itemId !== item.id) continue
        if (busyKeys.has(`${asset.id}#${slot}`)) break
        keep.push([asset.id, slot])
        if (!prefetched.has(item.id)) {
          prefetched.add(item.id)
          pool.prefetch(asset.id, layer.srcUs, slot)
        }
        break
      }
    }
  }
  return keep
}

function loadSession(sessionId: string): Promise<void> {
  const cur = sessions.get(sessionId)
  if (cur && (cur.failedAt === null || Date.now() - cur.failedAt < SESSION_RETRY_MS)) return cur.load
  const entry: { load: Promise<void>; session: Session | null; failedAt: number | null } = { load: Promise.resolve(), session: null, failedAt: null }
  entry.load = fetch(`${FILE_PROTOCOL}://${encodeURIComponent(sessionId)}/session.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Session>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((s) => {
      entry.session = s
    })
    .catch(() => {
      entry.failedAt = Date.now()
    })
  sessions.set(sessionId, entry)
  return entry.load
}

function drawAnnotations(layer: AnnotationsLayer): OffscreenCanvas | null {
  const session = sessions.get(layer.sessionId)?.session
  if (!session || !canvas || session.strokes.length === 0) return null
  const W = canvas.width
  const H = canvas.height
  if (!annCanvas || annCanvas.width !== W || annCanvas.height !== H) annCanvas = new OffscreenCanvas(W, H)
  const ctx = annCanvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, W, H)
  drawStrokes(ctx, W, H, session, layer.sessionMs, layer.autoFadeMs)
  return annCanvas
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
