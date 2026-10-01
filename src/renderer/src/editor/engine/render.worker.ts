// Render worker do editor: resolveFrame → fontes (DecoderPool) → Compositor WebGL2 → `rendered`.
// Único caminho de render para preview e exportação. Pedidos de quadro que chegam durante um
// render são coalescidos (fica só o último); o cliente resolve os intermediários com o resultado dele.
import type { VideoSample } from 'mediabunny'
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

let compositor: Compositor | null = null
let canvas: OffscreenCanvas | null = null
let dpr = 1
const pool = new DecoderPool()
let project: Project | null = null
let selection: string[] = []
let pending: FrameMsg | null = null
let busy = false
// Sessões das anotações: carregadas antes do draw (que é síncrono); null = indisponível
const sessions = new Map<string, Promise<void>>()
const loadedSessions = new Map<string, Session | null>()
let annCanvas: OffscreenCanvas | null = null

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
      case 'readPixels': {
        const data = compositor ? compositor.readPixels(m.x, m.y, m.w, m.h) : new Uint8Array(0)
        post({ t: 'pixels', id: m.id, data }, [data.buffer])
        break
      }
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
        post({ t: 'error', message: errMsg(err), fatal: false })
      }
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
  const layers = resolveFrame(p, m.tUs)
  const sources = new Map<string, TexImageSource | VideoFrame | null>()
  const meta = new Map<string, SourceMeta>()
  const missing = new Set<string>()
  const frames: VideoFrame[] = []

  try {
    await Promise.all(
      layers.map(async (layer) => {
        if (layer.kind === 'annotations') {
          await loadSession(layer.sessionId)
          return
        }
        if (layer.kind !== 'media') return
        const asset = p.assets.find((a) => a.id === layer.assetId)
        const fallback: SourceMeta = asset?.video ? { w: asset.video.width, h: asset.video.height, rotation: asset.video.rotation } : { w: canvas!.width, h: canvas!.height, rotation: 0 }
        let src: TexImageSource | VideoFrame | null = null
        if (asset && asset.status !== 'missing') {
          if (layer.srcUs === null) {
            const bmp = await pool.image(asset.id)
            if (bmp) {
              src = bmp
              meta.set(layer.itemId, { w: bmp.width, h: bmp.height, rotation: 0 })
            }
          } else {
            let sample: VideoSample | null = null
            try {
              sample = await pool.frameAt(asset.id, layer.srcUs, m.playing)
              if (sample) {
                const frame = sample.toVideoFrame()
                frames.push(frame)
                src = frame
                meta.set(layer.itemId, { w: frame.displayWidth, h: frame.displayHeight, rotation: sample.rotation })
              }
            } finally {
              sample?.close()
            }
          }
        }
        if (!src) {
          missing.add(layer.assetId)
          meta.set(layer.itemId, fallback)
        }
        sources.set(layer.itemId, src)
      })
    )

    comp.draw(layers, sources, p.canvas.background, { meta, annotations: drawAnnotations, selectionOutline: selection.map((itemId) => ({ itemId })) })
  } finally {
    for (const f of frames) f.close() // inclusive se a coleta falhar no meio
  }
  post({ t: 'rendered', seq: m.seq, tUs: m.tUs, ms: performance.now() - t0, missing: [...missing] })
}

function loadSession(sessionId: string): Promise<void> {
  let s = sessions.get(sessionId)
  if (!s) {
    s = fetch(`${FILE_PROTOCOL}://${encodeURIComponent(sessionId)}/session.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Session>) : null))
      .catch(() => null)
      .then((session) => void loadedSessions.set(sessionId, session))
    sessions.set(sessionId, s)
  }
  return s
}

function drawAnnotations(layer: AnnotationsLayer): OffscreenCanvas | null {
  const session = loadedSessions.get(layer.sessionId)
  if (!session || !canvas || session.strokes.length === 0) return null
  const W = canvas.width
  const H = canvas.height
  if (!annCanvas || annCanvas.width !== W || annCanvas.height !== H) annCanvas = new OffscreenCanvas(W, H)
  const ctx = annCanvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, W, H)
  // autoFade das anotações ainda não faz parte do projeto: traços ficam até serem apagados
  drawStrokes(ctx, W, H, session, layer.sessionMs, null)
  return annCanvas
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
