// Pool de decodificadores (mediabunny/WebCodecs) por asset, com LRU de `maxLive` decoders vivos.
// Reprodução (sequential) reaproveita um iterador `samples()` por asset; seek usa `getSample()`.
// O VideoSample devolvido é do chamador (deve fechá-lo no mesmo quadro). As ImageBitmap de
// `image()` pertencem ao pool (o chamador NÃO as fecha). Se o decoder de uma entrada saudável
// falhar (ex.: recuperado pelo Chromium), a entrada é recriada uma vez de forma transparente.
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type VideoSample } from 'mediabunny'
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
  url: string
  opened: Promise<Opened>
  it: AsyncGenerator<VideoSample, void, unknown> | null
  held: VideoSample | null // último sample com timestamp ≤ alvo (do pool)
  ahead: VideoSample | null // próximo sample já decodificado (do pool)
  done: boolean
  lock: Promise<unknown>
  busy: number
  lastUsed: number
}

export class DecoderPool {
  private urls: Record<string, string> = {}
  private entries = new Map<string, Entry>()
  private images = new Map<string, { url: string; bmp: Promise<ImageBitmap | null> }>()
  private clock = 0

  constructor(private readonly maxLive = 8) {}

  /** assetId → URL (proxy ou original). Entradas cuja URL mudou ou sumiu são descartadas. */
  setSources(urls: Record<string, string>): void {
    this.urls = { ...urls }
    for (const [id, e] of this.entries) if (urls[id] !== e.url) this.drop(id)
    for (const [id, img] of this.images) {
      if (urls[id] === img.url) continue
      this.images.delete(id)
      void img.bmp.then((b) => b?.close())
    }
  }

  /** Sample em srcUs (maior timestamp ≤ srcUs). `sequential` reaproveita o iterador; null se fora/erro. */
  async frameAt(assetId: string, srcUs: Us, sequential: boolean): Promise<VideoSample | null> {
    const t = srcUs / 1e6
    for (let attempt = 0; attempt < 2; attempt++) {
      const e = this.entry(assetId)
      if (!e) return null
      try {
        await e.opened
      } catch {
        return null // não abre (arquivo ausente/corrompido/codec): placeholder, sem tentar de novo
      }
      try {
        return await this.run(e, (o) => (sequential ? this.sequential(e, o, t) : this.seek(o, t)))
      } catch {
        this.drop(assetId) // decoder perdido: recria uma vez
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
  prefetch(assetId: string, srcUs: Us): void {
    const e = this.entry(assetId)
    if (!e) return
    const t = srcUs / 1e6
    e.opened
      .then((o) => this.run(e, async () => {
        if (e.it && e.held && t >= e.held.timestamp - EPS_S && t <= e.held.timestamp + MAX_SKIP_S) return
        this.restart(e, o, t)
        const r = await e.it!.next()
        if (r.done) e.done = true
        else e.ahead = r.value
      }))
      .catch(() => {})
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.drop(id)
    for (const img of this.images.values()) void img.bmp.then((b) => b?.close())
    this.images.clear()
    this.urls = {}
  }

  // ---- internos ----

  private entry(assetId: string): Entry | null {
    const url = this.urls[assetId]
    if (!url) return null
    let e = this.entries.get(assetId)
    if (!e) {
      e = { url, opened: open(url), it: null, held: null, ahead: null, done: false, lock: Promise.resolve(), busy: 0, lastUsed: 0 }
      e.opened.catch(() => {}) // falha tratada em frameAt/prefetch
      this.entries.set(assetId, e)
      this.evict(assetId)
    }
    e.lastUsed = ++this.clock
    return e
  }

  /** Serializa operações por entrada (o iterador não é reentrante). */
  private run<T>(e: Entry, fn: (o: Opened) => Promise<T>): Promise<T> {
    e.busy++
    const p = e.lock.then(() => e.opened).then(fn)
    e.lock = p.catch(() => {})
    return p.finally(() => {
      e.busy--
    })
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

  private evict(keep: string): void {
    while (this.entries.size > this.maxLive) {
      let victim: string | null = null
      let oldest = Infinity
      for (const [id, e] of this.entries) {
        if (id === keep || e.busy > 0) continue
        if (e.lastUsed < oldest) {
          oldest = e.lastUsed
          victim = id
        }
      }
      if (!victim) return
      this.drop(victim)
    }
  }

  private drop(assetId: string): void {
    const e = this.entries.get(assetId)
    if (!e) return
    this.entries.delete(assetId)
    // espera operações em curso antes de liberar o decoder
    void e.lock.then(() => {
      closeIter(e)
      e.opened.then((o) => o.input.dispose()).catch(() => {})
    })
  }
}

async function open(url: string): Promise<Opened> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('sem faixa de vídeo')
    if (!(await track.canDecode())) throw new Error(`codec não decodificável: ${track.codec}`)
    const firstS = await track.getFirstTimestamp()
    return { input, sink: new VideoSampleSink(track), firstS }
  } catch (err) {
    input.dispose()
    throw err
  }
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
