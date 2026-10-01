// Pool de decodificadores (mediabunny/WebCodecs) com LRU de `maxLive` decoders vivos.
// Uma entrada por (asset, slot): slot 0 é o uso normal; slots ≥ 1 só quando o mesmo asset aparece em
// mais de uma camada no mesmo quadro (cada camada precisa do seu próprio iterador).
// Reprodução (sequential) reaproveita um iterador `samples()` por entrada; seek usa `getSample()`.
//
// Posse dos quadros: o VideoSample devolvido é do chamador, que o fecha no mesmo quadro. O pool guarda
// no máximo 2 samples por entrada em reprodução (held = quadro atual, ahead = próximo já decodificado),
// como buffer de decodificação — não são entregues ao compositor. Eles são liberados assim que deixam
// de ser necessários: num pedido de seek (sequential = false), em `releaseExcept` (entrada fora do
// quadro), em `releaseAll` (pausa/ociosidade) e ao descartar a entrada.
// As ImageBitmap de `image()` pertencem ao pool (o chamador NÃO as fecha); as substituídas em
// `setSources` só são fechadas em `flushRetired()`, chamado quando nenhum render as usa.
// Se o decoder de uma entrada saudável falhar (ex.: recuperado pelo Chromium), ela é recriada uma vez.
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny'
import type { Us } from '@shared/editor/project'

// Salto à frente maior que isso reinicia o iterador no alvo (em vez de decodificar tudo no meio).
const MAX_SKIP_S = 1
const EPS_S = 1e-6

interface Opened {
  input: Input
  sink: VideoSampleSink
  firstS: number
}

interface Entry {
  assetId: string
  url: string
  trackIndex: number | null // faixa de vídeo v:N; null = principal
  opened: Promise<Opened>
  it: AsyncGenerator<VideoSample, void, unknown> | null
  held: VideoSample | null // último sample com timestamp ≤ alvo (do pool)
  ahead: VideoSample | null // próximo sample já decodificado (do pool)
  done: boolean
  lock: Promise<unknown>
  busy: number // contado desde a aquisição (inclui a espera de `opened`): não é despejada
  lastUsed: number
}

const keyOf = (assetId: string, slot: number): string => `${assetId}#${slot}`

export class DecoderPool {
  private urls: Record<string, string> = {}
  private trackIdx: Record<string, number> = {}
  private entries = new Map<string, Entry>()
  private images = new Map<string, { url: string; bmp: Promise<ImageBitmap | null> }>()
  private retired: Promise<ImageBitmap | null>[] = []
  private clock = 0

  constructor(private readonly maxLive = 8) {}

  /**
   * assetId → URL (proxy ou original) e, para arquivos multi-faixa (rec.mp4 da sessão), assetId → índice v:N.
   * Entradas cuja URL ou faixa mudou ou sumiu são descartadas.
   */
  setSources(urls: Record<string, string>, videoTracks: Record<string, number> = {}): void {
    this.urls = { ...urls }
    this.trackIdx = { ...videoTracks }
    for (const [key, e] of this.entries) if (urls[e.assetId] !== e.url || (videoTracks[e.assetId] ?? null) !== e.trackIndex) this.drop(key, e)
    for (const [id, img] of this.images) {
      if (urls[id] === img.url) continue
      this.images.delete(id)
      this.retired.push(img.bmp)
    }
  }

  /** Sample em srcUs (maior timestamp ≤ srcUs). `sequential` reaproveita o iterador; null se fora/erro. */
  async frameAt(assetId: string, srcUs: Us, sequential: boolean, slot = 0): Promise<VideoSample | null> {
    const t = srcUs / 1e6
    const key = keyOf(assetId, slot)
    for (let attempt = 0; attempt < 2; attempt++) {
      const e = this.acquire(key, assetId)
      if (!e) return null
      try {
        try {
          await e.opened
        } catch {
          return null // não abre (arquivo ausente/corrompido/codec): placeholder, sem tentar de novo
        }
        try {
          return await this.run(e, (o) => {
            if (sequential) return this.sequential(e, o, t)
            closeIter(e) // seek: o buffer de reprodução não serve mais
            return this.seek(o, t)
          })
        } catch {
          this.drop(key, e) // decoder perdido: recria uma vez
        }
      } finally {
        e.busy--
      }
    }
    return null
  }

  async image(assetId: string): Promise<ImageBitmap | null> {
    const url = this.urls[assetId]
    if (!url) return null
    let img = this.images.get(assetId)
    if (!img || img.url !== url) {
      const bmp = fetch(url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => createImageBitmap(b))
        .catch(() => null)
      img = { url, bmp }
      this.images.set(assetId, img)
    }
    return img.bmp
  }

  /** Aquece o decoder do asset em srcUs (abre a entrada e posiciona o iterador). */
  prefetch(assetId: string, srcUs: Us, slot = 0): void {
    const e = this.acquire(keyOf(assetId, slot), assetId)
    if (!e) return
    const t = srcUs / 1e6
    e.opened
      .then((o) => this.run(e, async () => {
        const ref = e.held ?? e.ahead
        if (e.it && ref && t >= ref.timestamp - EPS_S && t <= ref.timestamp + MAX_SKIP_S) return
        this.restart(e, o, t)
        const r = await e.it!.next()
        if (r.done) e.done = true
        else e.ahead = r.value
      }))
      .catch(() => {})
      .finally(() => {
        e.busy--
      })
  }

  /** Libera o buffer de reprodução das entradas fora de `used` ([assetId, slot]); mantém os decoders abertos. */
  releaseExcept(used: [string, number][]): void {
    const keep = new Set(used.map(([a, s]) => keyOf(a, s)))
    for (const [key, e] of this.entries) if (!keep.has(key) && (e.it || e.held || e.ahead)) void this.run(e, async () => closeIter(e)).catch(() => {})
  }

  /** Pausa/ociosidade: libera todos os buffers de reprodução. */
  releaseAll(): void {
    this.releaseExcept([])
  }

  /** Fecha as ImageBitmap substituídas (chamar só quando nenhum render estiver em andamento). */
  flushRetired(): void {
    for (const b of this.retired) void b.then((bmp) => bmp?.close())
    this.retired = []
  }

  dispose(): void {
    for (const [key, e] of [...this.entries]) this.drop(key, e)
    for (const img of this.images.values()) this.retired.push(img.bmp)
    this.images.clear()
    this.flushRetired()
    this.urls = {}
    this.trackIdx = {}
  }

  // ---- internos ----

  private acquire(key: string, assetId: string): Entry | null {
    const url = this.urls[assetId]
    if (!url) return null
    let e = this.entries.get(key)
    if (!e) {
      const trackIndex = this.trackIdx[assetId] ?? null
      e = { assetId, url, trackIndex, opened: open(url, trackIndex), it: null, held: null, ahead: null, done: false, lock: Promise.resolve(), busy: 0, lastUsed: 0 }
      e.opened.catch(() => {}) // falha tratada em frameAt/prefetch
      this.entries.set(key, e)
    }
    e.busy++
    e.lastUsed = ++this.clock
    this.evict()
    return e
  }

  /** Serializa operações por entrada (o iterador não é reentrante). */
  private run<T>(e: Entry, fn: (o: Opened) => Promise<T>): Promise<T> {
    const p = e.lock.then(() => e.opened).then(fn)
    e.lock = p.catch(() => {})
    return p
  }

  private async seek(o: Opened, t: number): Promise<VideoSample | null> {
    return (await o.sink.getSample(t)) ?? (t < o.firstS ? await o.sink.getSample(o.firstS) : null)
  }

  private async sequential(e: Entry, o: Opened, t: number): Promise<VideoSample | null> {
    const ref = e.held ?? e.ahead
    if (!e.it || (ref && (t < ref.timestamp - EPS_S || t > ref.timestamp + MAX_SKIP_S))) this.restart(e, o, t)
    while (!e.done) {
      if (!e.ahead) {
        const r = await e.it!.next()
        if (r.done) {
          e.done = true
          break
        }
        e.ahead = r.value
      }
      if (e.ahead.timestamp > t + EPS_S) break
      e.held?.close()
      e.held = e.ahead
      e.ahead = null
    }
    const out = e.held ?? e.ahead // antes do 1º quadro: o 1º disponível
    return out ? out.clone() : null
  }

  private restart(e: Entry, o: Opened, t: number): void {
    closeIter(e)
    e.it = o.sink.samples(Math.max(o.firstS, t))
  }

  private evict(): void {
    while (this.entries.size > this.maxLive) {
      let victim: [string, Entry] | null = null
      for (const [key, e] of this.entries) {
        if (e.busy > 0) continue
        if (!victim || e.lastUsed < victim[1].lastUsed) victim = [key, e]
      }
      if (!victim) return
      this.drop(victim[0], victim[1])
    }
  }

  private drop(key: string, e: Entry): void {
    if (this.entries.get(key) !== e) return // já substituída por outra entrada
    this.entries.delete(key)
    // espera operações em curso antes de liberar o decoder
    void e.lock.then(() => {
      closeIter(e)
      e.opened.then((o) => o.input.dispose()).catch(() => {})
    })
  }
}

async function open(url: string, trackIndex: number | null): Promise<Opened> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    const track = trackIndex === null ? await input.getPrimaryVideoTrack() : ((await input.getVideoTracks())[trackIndex] ?? null)
    if (!track) throw new Error(trackIndex === null ? 'sem faixa de vídeo' : `faixa de vídeo v:${trackIndex} inexistente`)
    if (!(await track.canDecode())) throw new Error(`codec não decodificável: ${track.codec}`)
    await assumeBt601WhenUntagged(track)
    const firstS = await track.getFirstTimestamp()
    return { input, sink: new VideoSampleSink(track), firstS }
  } catch (err) {
    input.dispose()
    throw err
  }
}

/**
 * Faixa sem matriz de cor declarada: o Chromium (e o mediabunny, que copia o padrão dele) decodifica como BT.709;
 * o ffmpeg — que gera a maioria desses arquivos (RGB → YUV com a matriz padrão BT.601, sem marcar) e as miniaturas
 * da linha do tempo — lê como BT.601. Declarar BT.601 na configuração do decoder faz o VideoFrame sair igual ao
 * ffmpeg, sem a perda de cores saturadas que uma correção depois da conversão (já recortada em 0–255) teria.
 * Só a matriz muda (primárias/transferência BT.709 = sem conversão de gama nem de gamut, como o ffmpeg).
 */
export async function assumeBt601WhenUntagged(track: Pick<InputVideoTrack, 'getColorSpace' | 'getDecoderConfig'>): Promise<boolean> {
  const cs = await track.getColorSpace().catch(() => null)
  if (!cs || cs.matrix) return false
  const original = track.getDecoderConfig.bind(track)
  track.getDecoderConfig = async () => {
    const config = await original()
    return config ? { ...config, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'smpte170m', fullRange: cs.fullRange ?? false } } : config
  }
  return true
}

function closeIter(e: Entry): void {
  e.held?.close()
  e.ahead?.close()
  e.held = null
  e.ahead = null
  e.done = false
  if (e.it) void e.it.return(undefined).catch(() => {})
  e.it = null
}
