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
// Reverso (reprodução com o tempo da fonte voltando: item reverso, shuttle para trás — dois passos seguidos para
// trás; o primeiro vai por seek simples, sem bloco nem pré-busca): em vez de um seek por quadro
// (decodificar do keyframe até ali a cada quadro), a entrada decodifica em bloco os últimos quadros antes do alvo
// (`samples(início, fim)`, do keyframe em diante), guarda o bloco e serve os quadros dele em ordem decrescente; o
// bloco anterior é pré-buscado assim que o atual entra em uso. Os quadros do bloco são copiados (`detach`) para fora
// do decoder: segurar quadros dele trava o decoder de hardware (medido: para no 8º quadro segurado). A cópia é na GPU
// (createImageBitmap → VideoFrame RGBA, ~1 ms no 1080p; a leitura para a CPU custa 15–65 ms por quadro e fica só
// de reserva). Tamanho do bloco: o que cabe em REV_BUDGET_BYTES (entre REV_MIN_FRAMES e REV_MAX_FRAMES); no máximo
// 2 blocos vivos por entrada (atual + anterior).
// Passos grandes para trás (shuttle −4×/−8×, render atrasado): o bloco guarda um quadro a cada meio passo em vez de
// todos (o mesmo trecho decodificado serve ~2·n pedidos; o quadro mostrado fica a menos de meio passo do exato). O
// espaçamento é decidido por bloco pelo passo atual (um bloco esparso não serve a passos pequenos), e nenhum bloco
// passa de n quadros (fonte VFR mais densa que a taxa média: os mais antigos saem).
// Salto (passo > REV_JUMP_S, não é reprodução contínua): seek simples.
// Se o decoder de uma entrada saudável falhar (ex.: recuperado pelo Chromium), ela é recriada uma vez.
// Abertura que falhou (arquivo preso por outro programa, ausente…) vira placeholder e é tentada de novo
// depois de OPEN_RETRY_MS — não a cada quadro, nem nunca mais até a URL mudar.
import { ALL_FORMATS, Input, UrlSource, VideoSample, VideoSampleSink, type InputVideoTrack } from 'mediabunny'
import type { Us } from '@shared/editor/project'
import { decoderMatrixOverride } from '@shared/editor/sourceColor'

// Salto à frente maior que isso reinicia o iterador no alvo (em vez de decodificar tudo no meio).
const MAX_SKIP_S = 1
const EPS_S = 1e-6
const OPEN_RETRY_MS = 5000
// reverso: memória por bloco e limites de quadros por bloco
const REV_BUDGET_BYTES = 96 * 1024 * 1024
const REV_MIN_FRAMES = 4
const REV_MAX_FRAMES = 30
// fim (exclusivo) do bloco pedido para o alvo t: inclui o quadro que começa exatamente em t
const REV_END_PAD_S = 1e-4
// passo para trás acima disso é um salto, não reprodução: seek
const REV_JUMP_S = 2
// passos até 4 quadros: bloco denso (todos os quadros); acima, um quadro a cada meio passo
const REV_DENSE_STEPS = 4
// trecho máximo da fonte que um bloco esparso cobre: passo grande × n quadros decodificaria quase o arquivo todo
// (lento → passo maior → bloco maior); com o teto o custo fica perto do de um seek
const REV_SPARSE_SPAN_S = 1.5

interface Opened {
  input: Input
  sink: Pick<VideoSampleSink, 'getSample' | 'samples'>
  firstS: number
  /** Duração de um quadro (s) e bytes por quadro copiado (RGBA), para o tamanho do bloco do reverso. */
  meta: () => Promise<{ frameS: number; frameBytes: number }>
}

/**
 * Bloco do reverso: quadros em ordem crescente que cobrem [frames[0].timestamp, endS); atStart = vai até o 1º quadro;
 * stride = espaçamento dos quadros guardados (frameS, a duração média de um quadro, no bloco denso).
 */
interface RevBlock {
  frames: VideoSample[]
  endS: number
  atStart: boolean
  stride: number
  frameS: number
}

interface Entry {
  assetId: string
  url: string
  trackIndex: number | null // faixa de vídeo v:N; null = principal
  opened: Promise<Opened>
  /** Instante em que a abertura falhou (nova tentativa após OPEN_RETRY_MS). */
  openFailedAt: number | null
  it: AsyncGenerator<VideoSample, void, unknown> | null
  held: VideoSample | null // último sample com timestamp ≤ alvo (do pool)
  ahead: VideoSample | null // próximo sample já decodificado (do pool)
  done: boolean
  /** Reverso: bloco em uso e o anterior em pré-busca; revGen invalida pré-buscas antigas. */
  rev: RevBlock | null
  revPrev: Promise<RevBlock | null> | null
  revGen: number
  /** Último alvo pedido (s): alvo menor que ele = reprodução para trás. */
  lastT: number | null
  /** Passos sequenciais seguidos para trás e o tamanho do último (s). */
  backSteps: number
  lastStep: number
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

  private readonly now: () => number
  private readonly openFn: (url: string, trackIndex: number | null) => Promise<Opened>
  private readonly detach: (s: VideoSample) => Promise<VideoSample>

  /** deps: relógio, abertura e cópia dos quadros do bloco do reverso injetáveis (testes). */
  constructor(
    private readonly maxLive = 8,
    deps: { now?: () => number; open?: (url: string, trackIndex: number | null) => Promise<Opened>; detach?: (s: VideoSample) => Promise<VideoSample> } = {}
  ) {
    this.now = deps.now ?? (() => performance.now())
    this.openFn = deps.open ?? open
    this.detach = deps.detach ?? detachFrame
  }

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
        let o: Opened
        try {
          o = await e.opened
        } catch {
          // não abre (arquivo ausente/preso/corrompido/codec): placeholder; reabre só após OPEN_RETRY_MS
          e.openFailedAt ??= this.now()
          return null
        }
        try {
          const step = e.lastT !== null ? e.lastT - t : 0
          const back = sequential && step > EPS_S
          // mesmo instante de novo (quadro repetido): não muda o sentido nem o passo do reverso
          const same = sequential && e.lastT !== null && Math.abs(step) <= EPS_S
          e.lastT = t
          if (!same) e.backSteps = back ? e.backSteps + 1 : 0
          if (back) e.lastStep = step
          if (sequential) {
            // quadro do bloco do reverso em cache, sem esperar a fila da entrada (a pré-busca pode estar rodando nela)
            const rev = e.rev
            if (rev && usable(rev, t, back ? step : same ? e.lastStep : 0)) {
              if (back) this.prefetchPrev(e, o)
              return pick(rev, t)!.clone()
            }
            // 2º passo seguido para trás: reverso em bloco; o 1º (pode ser só um ajuste) vai por seek simples
            if (back && e.backSteps >= 2) return await this.run(e, (oo) => this.reverse(e, oo, t, step))
            if (back) return await this.run(e, (oo) => {
              closeIter(e)
              return this.seek(oo, t)
            })
          }
          return await this.run(e, (oo) => {
            if (sequential) return this.sequential(e, oo, t)
            closeIter(e) // seek: o buffer de reprodução não serve mais
            return this.seek(oo, t)
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
    for (const [key, e] of this.entries) if (!keep.has(key) && (e.it || e.held || e.ahead || e.rev || e.revPrev)) void this.run(e, async () => closeIter(e)).catch(() => {})
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
    if (e && e.openFailedAt !== null && e.busy === 0 && this.now() - e.openFailedAt >= OPEN_RETRY_MS) {
      this.drop(key, e)
      e = undefined
    }
    if (!e) {
      const trackIndex = this.trackIdx[assetId] ?? null
      e = {
        assetId, url, trackIndex, opened: this.openFn(url, trackIndex), openFailedAt: null, it: null, held: null, ahead: null, done: false,
        rev: null, revPrev: null, revGen: 0, lastT: null, backSteps: 0, lastStep: 0, lock: Promise.resolve(), busy: 0, lastUsed: 0
      }
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
    closeRev(e) // andando para frente: o cache do reverso não serve mais
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

  /** Reverso (dentro da fila da entrada): usa o bloco pré-buscado ou decodifica o bloco que termina em t. */
  private async reverse(e: Entry, o: Opened, t: number, step: number): Promise<VideoSample | null> {
    closeForward(e) // o iterador para frente não serve para trás
    if (step > REV_JUMP_S) {
      closeRev(e)
      return this.seek(o, t)
    }
    if (e.revPrev) {
      const prev = await e.revPrev
      e.revPrev = null
      if (prev && usable(prev, t, step)) {
        closeBlock(e.rev)
        e.rev = prev
      } else closeBlock(prev)
    }
    if (!e.rev || !usable(e.rev, t, step)) {
      closeBlock(e.rev)
      e.rev = null
      const { frameS } = await blockShape(o)
      e.rev = await this.decodeBlock(o, t + REV_END_PAD_S, strideFor(step, frameS))
    }
    const hit = pick(e.rev, t)
    if (!hit) return this.seek(o, t) // bloco vazio (fora do arquivo): o quadro mais próximo
    this.prefetchPrev(e, o)
    return hit.clone()
  }

  /**
   * Decodifica (do keyframe em diante) o trecho que termina em endS e copia (detach) até n quadros: todos (stride =
   * duração do quadro) ou, esparso, o último quadro ≤ cada alvo endS − k·stride.
   */
  private async decodeBlock(o: Opened, endS: number, stride: number): Promise<RevBlock> {
    const shape = await blockShape(o)
    const frameS = shape.frameS
    const dense = stride <= frameS + EPS_S
    const n = dense ? shape.n : Math.min(shape.n, Math.max(2, Math.floor(REV_SPARSE_SPAN_S / stride) + 1))
    const startS = Math.max(o.firstS, endS - (dense ? n * frameS : (n - 1) * stride + frameS))
    const frames: VideoSample[] = []
    let dropped = false
    // esparso: guarda p se há um alvo T = endS − k·stride em [p, próximo quadro) — em µs inteiros (sem deriva)
    const endUs = Math.round(endS * 1e6)
    const strideUs = Math.max(1, Math.round(stride * 1e6))
    const keep = (p: VideoSample, next: VideoSample | null): boolean => {
      if (dense || !next) return true
      const k = Math.floor((endUs - Math.round(p.timestamp * 1e6)) / strideUs)
      return endUs - k * strideUs < Math.round(next.timestamp * 1e6)
    }
    // guarda a cópia; nunca mais que n (os mais antigos saem). Se a cópia falhar, o quadro original é fechado aqui.
    const push = async (p: VideoSample): Promise<void> => {
      let copy: VideoSample
      try {
        copy = await this.detach(p)
      } catch (err) {
        p.close()
        throw err
      }
      frames.push(copy)
      if (frames.length > n) {
        frames.shift()!.close()
        dropped = true
      }
    }
    let pending: VideoSample | null = null
    try {
      for await (const s of o.sink.samples(startS, endS)) {
        if (s.timestamp >= endS) {
          s.close()
          break
        }
        const prev = pending
        pending = s // antes da cópia de prev: se ela falhar, o catch fecha este
        if (prev) {
          if (keep(prev, s)) await push(prev)
          else prev.close()
        }
      }
      const last = pending
      pending = null
      if (last) await push(last)
    } catch (err) {
      pending?.close()
      for (const f of frames) f.close()
      throw err
    }
    return { frames, endS, atStart: !dropped && startS <= o.firstS + EPS_S, stride, frameS }
  }

  /** Pré-busca (na fila da entrada) o bloco imediatamente anterior ao atual; descartada se o reverso for abandonado. */
  private prefetchPrev(e: Entry, o: Opened): void {
    const cur = e.rev
    if (!cur || e.revPrev || cur.atStart || cur.frames.length === 0) return
    const gen = e.revGen
    const endS = cur.frames[0].timestamp
    // espaçamento pelo passo atual (não herdado do bloco atual)
    const stride = strideFor(e.lastStep, cur.frameS)
    e.revPrev = this.run(e, () => this.decodeBlock(o, endS, stride))
      .then((blk) => {
        if (gen === e.revGen) return blk
        closeBlock(blk)
        return null
      })
      .catch(() => null)
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
    await applySourceColorRule(track)
    const firstS = await track.getFirstTimestamp()
    // medido só no primeiro uso do reverso
    let meta: Promise<{ frameS: number; frameBytes: number }> | null = null
    const getMeta = (): Promise<{ frameS: number; frameBytes: number }> =>
      (meta ??= (async () => {
        const rate = (await track.computePacketStats(60).catch(() => null))?.averagePacketRate ?? 0
        const frameBytes = (await track.getCodedWidth()) * (await track.getCodedHeight()) * 4
        return { frameS: rate > 0 ? 1 / rate : 1 / 30, frameBytes }
      })())
    return { input, sink: new VideoSampleSink(track), firstS, meta: getMeta }
  } catch (err) {
    input.dispose()
    throw err
  }
}

/**
 * Cópia do quadro para fora do decoder (o bloco do reverso guarda dezenas de quadros; segurar os do decoder de
 * hardware o trava): na GPU (ImageBitmap RGBA → VideoFrame); se falhar, para a CPU. Mantém timestamp e rotação.
 * Consome `s`.
 */
async function detachFrame(s: VideoSample): Promise<VideoSample> {
  const frame = s.toVideoFrame()
  try {
    const bmp = await createImageBitmap(frame)
    try {
      const copy = new VideoFrame(bmp, { timestamp: frame.timestamp, ...(frame.duration !== null ? { duration: frame.duration } : {}) })
      const out = new VideoSample(copy, { timestamp: s.timestamp, duration: s.duration, rotation: s.rotation })
      s.close()
      return out
    } finally {
      bmp.close()
    }
  } catch {
    return detachToCpu(s)
  } finally {
    frame.close()
  }
}

/** Reserva do detachFrame: cópia para a CPU (VideoFrame de buffer, mesmo formato/espaço de cor). Formato desconhecido: fica o próprio quadro. */
async function detachToCpu(s: VideoSample): Promise<VideoSample> {
  const frame = s.toVideoFrame()
  try {
    if (!frame.format) return s
    const rect = frame.visibleRect!
    const buf = new Uint8Array(frame.allocationSize())
    const layout = await frame.copyTo(buf)
    const copy = new VideoFrame(buf, {
      format: frame.format, codedWidth: rect.width, codedHeight: rect.height, layout, timestamp: frame.timestamp,
      ...(frame.duration !== null ? { duration: frame.duration } : {}),
      colorSpace: frame.colorSpace.toJSON(), displayWidth: frame.displayWidth, displayHeight: frame.displayHeight
    })
    const out = new VideoSample(copy, { timestamp: s.timestamp, duration: s.duration, rotation: s.rotation })
    s.close()
    return out
  } finally {
    frame.close()
  }
}

/**
 * Regra única de cor (shared/editor/sourceColor.ts): marcada → a marcação; sem marcação → convenção dos players,
 * HD = BT.709 (o padrão do Chromium/mediabunny, nada a fazer) e SD = BT.601. Para SD sem marcação, declara
 * `matrix: smpte170m` na configuração do decoder: o VideoFrame já sai convertido certo (sem a perda de cores
 * saturadas de uma correção depois da conversão). Só a matriz muda (primárias/transferência BT.709, sem
 * conversão de gamut nem de gama — como o ffmpeg). Devolve se trocou.
 */
export async function applySourceColorRule(track: Pick<InputVideoTrack, 'getColorSpace' | 'getDecoderConfig' | 'getCodedWidth' | 'getCodedHeight'>): Promise<boolean> {
  const cs = await track.getColorSpace().catch(() => null)
  if (!cs) return false
  const matrix = decoderMatrixOverride(!!cs.matrix, await track.getCodedWidth(), await track.getCodedHeight())
  if (!matrix) return false
  const original = track.getDecoderConfig.bind(track)
  track.getDecoderConfig = async () => {
    const config = await original()
    return config ? { ...config, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix, fullRange: cs.fullRange ?? false } } : config
  }
  return true
}

/** Quadros por bloco do reverso (o que cabe em REV_BUDGET_BYTES) e duração de um quadro. */
async function blockShape(o: Opened): Promise<{ n: number; frameS: number }> {
  const { frameS, frameBytes } = await o.meta()
  return { n: Math.min(REV_MAX_FRAMES, Math.max(REV_MIN_FRAMES, Math.floor(REV_BUDGET_BYTES / Math.max(1, frameBytes)))), frameS }
}

/** Espaçamento do bloco para o passo para trás `step`: denso (todos os quadros) até REV_DENSE_STEPS quadros, senão meio passo. */
function strideFor(step: number, frameS: number): number {
  return step <= REV_DENSE_STEPS * frameS ? frameS : step / 2
}

/**
 * O bloco serve ao pedido t com este passo? Cobre t e o espaçamento dos quadros guardados não passa de
 * max(espaçamento que o passo pede, o próprio passo). A folga de até um passo absorve a variação do passo no shuttle
 * rápido (−8× a 60 Hz anda ~4 quadros por pedido, bem na fronteira denso/esparso: sem ela a pré-busca era recusada e
 * cada pedido decodificava duas vezes), e some quando o passo é ~1 quadro (|taxa| ≈ 1 exige bloco denso). O quadro
 * mostrado fica antes do alvo, a menos de um espaçamento: menos de um passo do pedido atual e de meio passo do pedido
 * que criou o bloco.
 */
function usable(b: RevBlock, t: number, step: number): boolean {
  return covers(b, t) && b.stride <= Math.max(strideFor(step, b.frameS), step) + EPS_S
}

/** O bloco cobre t? (antes do 1º quadro do arquivo, o bloco do início cobre: devolve o 1º quadro) */
function covers(b: RevBlock, t: number): boolean {
  return b.frames.length > 0 && t < b.endS && (t >= b.frames[0].timestamp - EPS_S || b.atStart)
}

/** Quadro do bloco com o maior timestamp ≤ t (o 1º, se t for anterior a todos). */
function pick(b: RevBlock, t: number): VideoSample | null {
  let lo = 0
  let hi = b.frames.length - 1
  if (hi < 0) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (b.frames[mid].timestamp <= t + EPS_S) lo = mid
    else hi = mid - 1
  }
  return b.frames[lo]
}

function closeBlock(b: RevBlock | null): void {
  if (b) for (const f of b.frames) f.close()
}

/** Libera o reverso (bloco atual; a pré-busca em curso é descartada quando terminar). */
function closeRev(e: Entry): void {
  if (!e.rev && !e.revPrev) return
  e.revGen++
  closeBlock(e.rev)
  e.rev = null
  // pré-busca já resolvida (com o gen antigo): fecha os quadros dela
  const prev = e.revPrev
  e.revPrev = null
  void prev?.then(closeBlock)
}

/** Libera o buffer da reprodução para frente (iterador e os 2 samples). */
function closeForward(e: Entry): void {
  e.held?.close()
  e.ahead?.close()
  e.held = null
  e.ahead = null
  e.done = false
  if (e.it) void e.it.return(undefined).catch(() => {})
  e.it = null
}

function closeIter(e: Entry): void {
  closeForward(e)
  closeRev(e)
}
