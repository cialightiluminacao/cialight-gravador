// Audio worker do editor: decodifica (AssetPcm) e mixa (mixBlock) blocos de PCM pedidos pelo AudioClient.
// A thread principal só agenda os AudioBufferSourceNode. Pedidos atendidos em ordem; depois de cada
// bloco, aquece o cache do segundo seguinte (mídia que vai começar já fica decodificada).
// Exportação: uma instância própria recebe uma MessagePort ('port') e atende pela porta os pedidos do
// render worker de exportação, em ordem e com memória constante (cache LRU de chunks por asset).
// Velocidade com tom preservado: um StretchBank do worker guarda o stretcher de cada segmento 'stretch'
// (chave itemId) com a posição contínua entre blocos — o mesmo caminho no preview e na exportação.
import { planAudio, type AudioSegment } from '@shared/editor/audioPlan'
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from '../mediaUrls'
import { AssetPcm } from './assetPcm'
import { mixBlock, SR, StretchBank, type PcmSource } from './mixer'
import type { AudioIn, AudioOut } from './protocol'
import { createStretcher } from './stretch'

type RenderMsg = Extract<AudioIn, { t: 'render' }> & { reply: (m: AudioOut, transfer?: Transferable[]) => void }

const LOOKAHEAD_US = 1_000_000

const post = (m: AudioOut, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer)

let segments: AudioSegment[] = []
const sources = new Map<string, AssetPcm>()
const stretch = new StretchBank((rate) => createStretcher(rate, 2))
const queue: RenderMsg[] = []
let busy = false
// muda a cada `cancel`: pedidos e aquecimentos de antes ficam obsoletos
let epoch = 0

self.addEventListener('message', (e: MessageEvent<AudioIn>) => {
  const m = e.data
  try {
    switch (m.t) {
      case 'project':
        setProject(m.project, m.mediaUrls, m.useProxy)
        break
      case 'render':
        enqueue(m, post)
        break
      case 'port': {
        const port = m.port
        const reply = (out: AudioOut, transfer: Transferable[] = []): void => port.postMessage(out, transfer)
        port.onmessage = (ev: MessageEvent<AudioIn>) => {
          if (ev.data.t === 'render') enqueue(ev.data, reply)
        }
        break
      }
      case 'cancel':
        queue.length = 0
        epoch++
        break
      case 'dispose':
        queue.length = 0
        segments = []
        stretch.retain(new Set())
        for (const s of sources.values()) s.dispose()
        sources.clear()
        break
    }
  } catch (err) {
    post({ t: 'error', message: errMsg(err) })
  }
})

function enqueue(m: Extract<AudioIn, { t: 'render' }>, reply: RenderMsg['reply']): void {
  queue.push({ ...m, reply })
  if (!busy) void pump()
}

function setProject(project: Project, mediaUrls: MediaUrls, useProxy: boolean): void {
  segments = planAudio(project)
  stretch.retain(new Set(segments.filter((s) => s.mode === 'stretch').map((s) => s.itemId)))
  const used = new Set(segments.filter((s) => s.mode !== 'mute').map((s) => s.assetId))
  for (const [id, src] of sources) {
    const want = used.has(id) ? sourceFor(project, id, mediaUrls, useProxy) : null
    if (!want || want.url !== src.url || want.trackIndex !== src.trackIndex) {
      src.dispose()
      sources.delete(id)
    }
  }
  for (const id of used) {
    if (sources.has(id)) continue
    const want = sourceFor(project, id, mediaUrls, useProxy)
    if (want) sources.set(id, new AssetPcm(want.url, want.trackIndex, { stretch, onError: (message) => post({ t: 'error', message, assetId: id }) }))
  }
}

/** URL e faixa de áudio do asset. O índice a:N vale só para o arquivo original (proxy e intermediário levam só a:0). */
function sourceFor(project: Project, assetId: string, mediaUrls: MediaUrls, useProxy: boolean): { url: string; trackIndex: number | null } | null {
  const asset = project.assets.find((a) => a.id === assetId)
  const u = mediaUrls[assetId]
  if (!asset || !u) return null
  const multi = asset.audioTrackIndex !== undefined
  if (useProxy && u.proxy && !multi) return { url: u.proxy, trackIndex: null }
  if (asset.intermediate) return { url: u.original, trackIndex: multi ? 0 : null }
  return { url: u.original, trackIndex: multi ? asset.audioTrackIndex! : null }
}

async function pump(): Promise<void> {
  busy = true
  try {
    while (queue.length) {
      const m = queue.shift()!
      const e0 = epoch
      const stale = (): boolean => epoch !== e0
      try {
        const segs = segments
        await prepare(segs, m.fromUs, m.frames, stale)
        if (stale()) continue // cancelado durante a decodificação: o cliente já descartou
        const pcm = mixBlock(segs, m.fromUs, m.frames, sources as Map<string, PcmSource>)
        m.reply({ t: 'block', seq: m.seq, fromUs: m.fromUs, pcm }, [pcm.buffer])
        const endUs = m.fromUs + Math.round((m.frames * 1e6) / SR)
        void prepare(segs, endUs, Math.round((LOOKAHEAD_US * SR) / 1e6), stale)
      } catch (err) {
        m.reply({ t: 'error', message: errMsg(err), seq: m.seq })
      }
    }
  } finally {
    busy = false
  }
}

/** Decodifica o que os segmentos vão ler em [fromUs, fromUs + frames/SR) — mesma conta de posição do mixBlock. */
function prepare(segs: AudioSegment[], fromUs: Us, frames: number, stale: () => boolean): Promise<unknown> {
  const blockEnd = fromUs + Math.round((frames * 1e6) / SR)
  const jobs: Promise<void>[] = []
  for (const seg of segs) {
    const src = seg.mode === 'mute' ? undefined : sources.get(seg.assetId)
    const a = Math.max(fromUs, seg.startUs)
    const b = Math.min(blockEnd, seg.startUs + seg.durationUs)
    if (!src || b <= a) continue
    const local = a - seg.startUs
    const srcFrom = seg.reverse ? seg.srcInUs + Math.round((seg.durationUs - local) * seg.speed) : seg.srcInUs + Math.round(local * seg.speed)
    const frames = Math.ceil(((b - a) * SR) / 1e6) + 1
    if (seg.mode === 'stretch') jobs.push(src.ensureStretched(seg.itemId, srcFrom, frames, seg.speed, stale))
    else jobs.push(src.ensure(srcFrom, frames, seg.speed, seg.reverse, stale))
  }
  return Promise.all(jobs)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
