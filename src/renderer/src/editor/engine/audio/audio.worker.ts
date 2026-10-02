// Audio worker do editor: decodifica (AssetPcm) e mixa (mixBlock) blocos de PCM pedidos pelo AudioClient.
// A thread principal só agenda os AudioBufferSourceNode. Pedidos atendidos em ordem; depois de cada
// bloco, aquece o cache do segundo seguinte (mídia que vai começar já fica decodificada).
// Exportação: uma instância própria recebe uma MessagePort ('port') e atende pela porta os pedidos do
// render worker de exportação, em ordem e com memória constante (cache LRU de chunks por asset).
// Velocidade com tom preservado: um StretchBank do worker guarda o stretcher de cada segmento 'stretch'
// (chave itemId) com a posição contínua entre blocos — o mesmo caminho no preview e na exportação.
// Shuttle (J/K/L até 2×, só preview): o pedido traz `rate`; o bloco é mixado no tempo do shuttle (t/rate) com os
// segmentos de shuttleSegments (velocidade × rate, esticados), e devolvido com o fromUs da timeline.
// Redução de ruído/normalização: cada segmento lê a fonte do seu sourceKey — o original do asset ou a versão
// pré-processada em generated/ (arquivo só de áudio, faixa única); `bypassProcessing` (A/B) força o original. No
// preview as fontes dos dois lados do A/B ficam vivas e aquecidas (segurar/soltar o botão não decodifica do zero).
// Ducking: o plano (puro) recebe a fala das faixas de voz como dado — o worker lê os speech.json (mediaUrls.speech,
// cache por URL) antes de montar o plano, e os pedidos de bloco esperam o plano pronto. Mesmo caminho no preview e
// na exportação, então os dois abaixam a música igual. speech.json que não carrega = sem dados (aquela voz não abaixa).
// Medidores: cada bloco devolve o pico por faixa (mixBlock), poucos números por bloco.
import { splitAudioSourceKey } from '@shared/editor/audioProcess'
import { abPlan, shuttleSegments, voiceAssetIds, type AudioSegment } from '@shared/editor/audioPlan'
import { speechFromFile, type SpeechFile, type SpeechInterval } from '@shared/editor/speech'
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
// A/B (só preview): segmentos do outro lado (original × processado) cuja fonte difere — mantidos vivos e aquecidos
let alternate: AudioSegment[] = []
// segmentos do shuttle por taxa (refeitos quando o projeto muda)
let shuttle = new Map<number, AudioSegment[]>()
const sources = new Map<string, AssetPcm>()
const stretch = new StretchBank((rate) => createStretcher(rate, 2))
const queue: RenderMsg[] = []
let busy = false
// fala por URL do speech.json (falha não fica em cache: tenta de novo no próximo projeto)
const speechCache = new Map<string, Promise<SpeechInterval[] | null>>()
// plano com ducking em montagem (speech.json carregando); os blocos esperam
let planReady: Promise<void> = Promise.resolve()
let planGen = 0
// muda a cada `cancel`: pedidos e aquecimentos de antes ficam obsoletos
let epoch = 0

self.addEventListener('message', (e: MessageEvent<AudioIn>) => {
  const m = e.data
  try {
    switch (m.t) {
      case 'project':
        setProject(m.project, m.mediaUrls, m.useProxy, !!m.bypassProcessing)
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
        alternate = []
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

function setProject(project: Project, mediaUrls: MediaUrls, useProxy: boolean, bypassProcessing: boolean): void {
  const gen = ++planGen
  const use = (ab: ReturnType<typeof abPlan>): void => {
    segments = ab.segments
    // exportação (sem proxy) não compara: só o plano tocado
    alternate = useProxy ? ab.alternate.filter((s) => s.mode !== 'mute') : []
    shuttle = new Map()
  }
  // as fontes não dependem do ducking (só o ganho muda): o plano sem fala já define o que decodificar
  use(abPlan(project, bypassProcessing))
  const voice = voiceAssetIds(project).filter((id) => mediaUrls[id]?.speech)
  planReady = voice.length
    ? loadSpeech(voice, mediaUrls).then((speech) => {
        if (gen === planGen) use(abPlan(project, bypassProcessing, speech))
      })
    : Promise.resolve()
  stretch.retain(new Set(segments.filter((s) => s.mode === 'stretch').map((s) => s.itemId)))
  const used = new Set([...segments.filter((s) => s.mode !== 'mute'), ...alternate].map((s) => s.sourceKey))
  for (const [key, src] of sources) {
    const want = used.has(key) ? sourceFor(project, key, mediaUrls, useProxy) : null
    if (!want || want.url !== src.url || want.trackIndex !== src.trackIndex) {
      src.dispose()
      sources.delete(key)
    }
  }
  for (const key of used) {
    if (sources.has(key)) continue
    const want = sourceFor(project, key, mediaUrls, useProxy)
    const assetId = splitAudioSourceKey(key).assetId
    if (want) sources.set(key, new AssetPcm(want.url, want.trackIndex, { stretch, onError: (message) => post({ t: 'error', message, assetId }) }))
  }
}

/**
 * URL e faixa de áudio de uma fonte (sourceKey). O índice a:N vale só para o arquivo original (proxy e
 * intermediário levam só a:0); a versão pré-processada é um arquivo só de áudio (faixa principal).
 */
function sourceFor(project: Project, sourceKey: string, mediaUrls: MediaUrls, useProxy: boolean): { url: string; trackIndex: number | null } | null {
  const { assetId, processKey } = splitAudioSourceKey(sourceKey)
  const asset = project.assets.find((a) => a.id === assetId)
  const u = mediaUrls[assetId]
  if (!asset || !u) return null
  if (processKey) {
    const url = u.audio?.[processKey]
    return url ? { url, trackIndex: null } : null
  }
  const multi = asset.audioTrackIndex !== undefined
  if (useProxy && u.proxy && !multi) return { url: u.proxy, trackIndex: null }
  if (asset.intermediate) return { url: u.original, trackIndex: multi ? 0 : null }
  return { url: u.original, trackIndex: multi ? asset.audioTrackIndex! : null }
}

/** Intervalos de fala dos assets (speech.json pela URL do protocolo), por assetId; o que não carregar fica de fora. */
async function loadSpeech(assetIds: string[], mediaUrls: MediaUrls): Promise<Record<string, SpeechInterval[]>> {
  const out: Record<string, SpeechInterval[]> = {}
  await Promise.all(
    assetIds.map(async (id) => {
      const url = mediaUrls[id]!.speech!
      let p = speechCache.get(url)
      if (!p) {
        p = fetch(url, { cache: 'no-store' })
          .then(async (r) => (r.ok ? speechFromFile((await r.json()) as SpeechFile) : null))
          .catch(() => null)
        speechCache.set(url, p)
      }
      const iv = await p
      if (iv) out[id] = iv
      else if (speechCache.get(url) === p) speechCache.delete(url)
    })
  )
  return out
}

/** Espera o plano mais recente (um projeto novo durante a espera troca a promessa). */
async function planSettled(): Promise<void> {
  let p: Promise<void>
  do {
    p = planReady
    await p
  } while (p !== planReady)
}

async function pump(): Promise<void> {
  busy = true
  try {
    while (queue.length) {
      await planSettled()
      const m = queue.shift()!
      const e0 = epoch
      const stale = (): boolean => epoch !== e0
      try {
        const rate = m.rate ?? 1
        const segs = segmentsAt(rate)
        // no shuttle o bloco é mixado no tempo do shuttle (timeline ÷ rate)
        const fromUs = rate === 1 ? m.fromUs : Math.round(m.fromUs / rate)
        // stretchers do bloco presos até o próximo: o aquecimento à frente não os despeja antes do mixBlock
        const blockEnd = fromUs + Math.round((m.frames * 1e6) / SR)
        stretch.pin(new Set(segs.filter((s) => s.mode === 'stretch' && s.startUs < blockEnd && s.startUs + s.durationUs > fromUs).map((s) => s.itemId)))
        await prepare(segs, fromUs, m.frames, stale)
        if (stale()) continue // cancelado durante a decodificação: o cliente já descartou
        const peaks = new Map<string, number>()
        const pcm = mixBlock(segs, fromUs, m.frames, sources as Map<string, PcmSource>, peaks)
        m.reply({ t: 'block', seq: m.seq, fromUs: m.fromUs, pcm, tracks: Object.fromEntries(peaks) }, [pcm.buffer])
        void prepare(segs, blockEnd, Math.round((LOOKAHEAD_US * SR) / 1e6), stale)
        // A/B: o outro lado também fica decodificado (bloco + aquecimento), para segurar/soltar não começar do zero
        if (rate === 1 && alternate.length) void warm(alternate, fromUs, m.frames + Math.round((LOOKAHEAD_US * SR) / 1e6), stale)
      } catch (err) {
        m.reply({ t: 'error', message: errMsg(err), seq: m.seq })
      }
    }
  } finally {
    busy = false
  }
}

/** Segmentos do plano a 1× ou do shuttle a `rate`× (cache por taxa). */
function segmentsAt(rate: number): AudioSegment[] {
  if (rate === 1) return segments
  let s = shuttle.get(rate)
  if (!s) shuttle.set(rate, (s = shuttleSegments(segments, rate)))
  return s
}

/** Decodifica o que os segmentos vão ler em [fromUs, fromUs + frames/SR) — mesma conta de posição do mixBlock. */
function prepare(segs: AudioSegment[], fromUs: Us, frames: number, stale: () => boolean): Promise<unknown> {
  const blockEnd = fromUs + Math.round((frames * 1e6) / SR)
  const jobs: Promise<void>[] = []
  for (const seg of segs) {
    const src = seg.mode === 'mute' ? undefined : sources.get(seg.sourceKey)
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

/**
 * Só decodifica (sem stretcher: o StretchBank é por item e pertence ao plano tocado) os chunks que os segmentos
 * alternativos leriam em [fromUs, fromUs + frames/SR).
 */
function warm(segs: AudioSegment[], fromUs: Us, frames: number, stale: () => boolean): Promise<unknown> {
  const blockEnd = fromUs + Math.round((frames * 1e6) / SR)
  const jobs: Promise<void>[] = []
  for (const seg of segs) {
    const src = sources.get(seg.sourceKey)
    const a = Math.max(fromUs, seg.startUs)
    const b = Math.min(blockEnd, seg.startUs + seg.durationUs)
    if (!src || b <= a) continue
    const local = a - seg.startUs
    const srcFrom = seg.reverse ? seg.srcInUs + Math.round((seg.durationUs - local) * seg.speed) : seg.srcInUs + Math.round(local * seg.speed)
    jobs.push(src.ensure(srcFrom, Math.ceil(((b - a) * SR) / 1e6) + 1, seg.speed, seg.reverse, stale))
  }
  return Promise.all(jobs)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
