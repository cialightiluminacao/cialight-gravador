// Mixer de áudio do editor (puro): PCM Float32 estéreo intercalado a 48 kHz. Usado pelo audio worker
// no preview e pela exportação. Cada segmento do plano (planAudio) lê a sua fonte na posição
// srcIn + (t − start)·speed (reverso: do fim para o início), aplica o envelope de ganho e soma;
// no fim, limitador suave acima de 0,9. Modos do segmento: 'copy'/'resample' leem a fonte por interpolação
// (o tom muda com a velocidade), 'stretch' passa pelo time-stretch com estado contínuo por segmento
// (StretchBank, tom preservado) e 'mute' não soa.
import { gainAt, type AudioSegment } from '@shared/editor/audioPlan'
import type { Us } from '@shared/editor/project'
import type { Stretcher } from './stretch'

export const SR = 48000

/** Fonte de PCM de um asset, já a 48 kHz. Leitura síncrona: o que não estiver disponível sai como zeros. */
export interface PcmSource {
  /** `frames` frames estéreo intercalados (frames·2) a partir de srcFromUs, andando `speed` por frame (para trás se `reverse`). */
  read(srcFromUs: Us, frames: number, speed: number, reverse: boolean): Float32Array
  /**
   * Como read() para a frente, mas com o tom preservado: o segmento `segKey` (itemId) mantém um Stretcher
   * com posição de fonte contínua entre chamadas; salto de posição ou de velocidade → reset + pré-roll.
   */
  readStretched(segKey: string, srcFromUs: Us, frames: number, speed: number): Float32Array
}

// O ganho é avaliado nas bordas de sub-blocos de 64 amostras e interpolado linearmente dentro deles.
const GAIN_STEP = 64

/** Índice do primeiro frame do bloco (iniciado em fromUs) cujo instante é ≥ tUs; aritmética inteira até a divisão. */
const frameAtOrAfter = (fromUs: Us, tUs: Us): number => Math.ceil(((tUs - fromUs) * SR) / 1e6)
const usAtFrame = (fromUs: Us, frame: number): Us => fromUs + Math.round((frame * 1e6) / SR)

/**
 * `sources`: fontes de PCM por AudioSegment.sourceKey (original = assetId; processada = assetId~chave).
 * `trackPeaks` (medidores): recebe o pico (0–1+, depois do ganho e antes do limitador) de cada faixa que soou no bloco.
 */
export function mixBlock(segments: AudioSegment[], fromUs: Us, frames: number, sources: Map<string, PcmSource>, trackPeaks?: Map<string, number>): Float32Array {
  const out = new Float32Array(frames * 2)
  for (const seg of segments) {
    const src = seg.mode === 'mute' ? undefined : sources.get(seg.sourceKey)
    if (!src) continue
    const endUs = seg.startUs + seg.durationUs
    const i0 = Math.max(0, frameAtOrAfter(fromUs, seg.startUs))
    const i1 = Math.min(frames, frameAtOrAfter(fromUs, endUs))
    const n = i1 - i0
    if (n <= 0) continue
    const local = usAtFrame(fromUs, i0) - seg.startUs
    const srcFrom = seg.reverse ? seg.srcInUs + Math.round((seg.durationUs - local) * seg.speed) : seg.srcInUs + Math.round(local * seg.speed)
    const pcm = seg.mode === 'stretch' ? src.readStretched(seg.itemId, srcFrom, n, seg.speed) : src.read(srcFrom, n, seg.speed, seg.reverse)
    const g = (frame: number): number => gainAt(seg, Math.min(endUs, Math.max(seg.startUs, usAtFrame(fromUs, frame))))
    let pk = 0
    for (let j = 0; j < n; j += GAIN_STEP) {
      const len = Math.min(GAIN_STEP, n - j)
      const g0 = g(i0 + j)
      const dg = (g(i0 + j + len) - g0) / len
      for (let k = 0; k < len; k++) {
        const gain = g0 + dg * k
        const s = (j + k) * 2
        const o = (i0 + j + k) * 2
        const l = pcm[s] * gain
        const r = pcm[s + 1] * gain
        out[o] += l
        out[o + 1] += r
        if (trackPeaks) pk = Math.max(pk, Math.abs(l), Math.abs(r))
      }
    }
    // itens de uma faixa não se sobrepõem: o pico do segmento é o da faixa no trecho dele
    if (trackPeaks) trackPeaks.set(seg.trackId, Math.max(pk, trackPeaks.get(seg.trackId) ?? 0))
  }
  for (let i = 0; i < out.length; i++) out[i] = limit(out[i])
  return out
}

/** Limitador suave: linear até 0,9; acima, 0,9 + 0,1·tanh((|x|−0,9)/0,1) (nunca passa de 1). */
export function limit(x: number): number {
  const a = Math.abs(x)
  if (a <= 0.9) return x
  return Math.sign(x) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1))
}

/**
 * Reamostragem linear de PCM intercalado com `channels` canais para estéreo intercalado em outRate.
 * Mono duplica; mais de 2 canais: L = média dos canais pares, R = média dos ímpares.
 */
export function resampleLinear(input: Float32Array, inRate: number, channels: number, outRate: number): Float32Array {
  const ch = Math.max(1, channels)
  const inFrames = Math.floor(input.length / ch)
  // estéreo na taxa de entrada
  let st: Float32Array
  if (ch === 2) st = input.length === inFrames * 2 ? input : input.subarray(0, inFrames * 2)
  else {
    st = new Float32Array(inFrames * 2)
    const nL = Math.ceil(ch / 2)
    const nR = Math.floor(ch / 2)
    for (let f = 0; f < inFrames; f++) {
      const b = f * ch
      if (ch === 1) {
        st[f * 2] = st[f * 2 + 1] = input[b]
        continue
      }
      let l = 0, r = 0
      for (let c = 0; c < ch; c++) {
        if (c % 2 === 0) l += input[b + c]
        else r += input[b + c]
      }
      st[f * 2] = l / nL
      st[f * 2 + 1] = r / nR
    }
  }
  if (inRate === outRate) return st === input ? input.slice() : st
  const outFrames = Math.round((inFrames * outRate) / inRate)
  const out = new Float32Array(outFrames * 2)
  const ratio = inRate / outRate
  for (let i = 0; i < outFrames; i++) {
    const p = i * ratio
    const f = Math.floor(p)
    const t = p - f
    const f1 = Math.min(f + 1, inFrames - 1)
    out[i * 2] = st[f * 2] + (st[f1 * 2] - st[f * 2]) * t
    out[i * 2 + 1] = st[f * 2 + 1] + (st[f1 * 2 + 1] - st[f * 2 + 1]) * t
  }
  return out
}

/**
 * Cache de PCM de um asset em chunks de 1 s (SR frames estéreo) alinhados ao tempo da fonte:
 * chunk k cobre [k s, k+1 s). `null` = silêncio conhecido (fora da mídia). LRU com no máximo `maxChunks`.
 * Leitura por interpolação linear (speed ≠ 1 = reamostragem simples, o pitch muda).
 */
export class ChunkedPcm implements PcmSource {
  private readonly chunks = new Map<number, Float32Array | null>()

  /** stretch: banco de stretchers do worker; sem ele (ou sem stretcher para o segmento) readStretched reamostra. */
  constructor(private readonly maxChunks: number, private readonly stretch?: StretchBank) {}

  /** Chunks com os frames inteiros [fromFrame, toFrame) da fonte. */
  static chunksForFrames(fromFrame: number, toFrame: number): number[] {
    const out: number[] = []
    for (let k = Math.floor(fromFrame / SR); k <= Math.floor((toFrame - 1) / SR); k++) out.push(k)
    return out
  }

  /** Chunks tocados por read(srcFromUs, frames, speed, reverse), incluindo o vizinho da interpolação. */
  static chunksFor(srcFromUs: Us, frames: number, speed: number, reverse: boolean): number[] {
    const p0 = (srcFromUs * SR) / 1e6
    const pN = p0 + Math.max(0, frames - 1) * (reverse ? -speed : speed)
    const a = Math.floor(Math.min(p0, pN) / SR)
    const b = Math.floor((Math.floor(Math.max(p0, pN)) + 1) / SR)
    const out: number[] = []
    for (let k = a; k <= b; k++) out.push(k)
    return out
  }

  has(k: number): boolean {
    return this.chunks.has(k)
  }

  /** Marca o chunk como usado agora (LRU). */
  touch(k: number): void {
    const c = this.chunks.get(k)
    if (c === undefined) return
    this.chunks.delete(k)
    this.chunks.set(k, c)
  }

  put(k: number, pcm: Float32Array | null): void {
    this.chunks.delete(k)
    this.chunks.set(k, pcm)
    while (this.chunks.size > this.maxChunks) this.chunks.delete(this.chunks.keys().next().value as number)
  }

  clear(): void {
    this.chunks.clear()
  }

  readStretched(segKey: string, srcFromUs: Us, frames: number, speed: number): Float32Array {
    return this.stretch?.read(segKey, (from, n) => this.frames(from, n), srcFromUs, frames, speed) ?? this.read(srcFromUs, frames, speed, false)
  }

  /** Frames inteiros [fromFrame, fromFrame + n) a velocidade 1 (zeros fora do cache). */
  frames(fromFrame: number, n: number): Float32Array {
    const out = new Float32Array(Math.max(0, n) * 2)
    let i = 0
    while (i < n) {
      const f = fromFrame + i
      const k = Math.floor(f / SR)
      const len = Math.min(n - i, (k + 1) * SR - f)
      const c = this.chunks.get(k)
      if (c) out.set(c.subarray((f - k * SR) * 2, (f - k * SR + len) * 2), i * 2)
      i += len
    }
    return out
  }

  read(srcFromUs: Us, frames: number, speed: number, reverse: boolean): Float32Array {
    const out = new Float32Array(frames * 2)
    const p0 = (srcFromUs * SR) / 1e6
    const step = reverse ? -speed : speed
    let curK = NaN
    let cur: Float32Array | null | undefined
    const sample = (f: number, c: number): number => {
      const k = Math.floor(f / SR)
      if (k !== curK) {
        curK = k
        cur = this.chunks.get(k)
      }
      return cur ? cur[(f - k * SR) * 2 + c] : 0
    }
    for (let i = 0; i < frames; i++) {
      const p = p0 + i * step
      const f = Math.floor(p)
      const t = p - f
      for (let c = 0; c < 2; c++) {
        const a = sample(f, c)
        out[i * 2 + c] = t === 0 ? a : a + (sample(f + 1, c) - a) * t
      }
    }
    return out
  }
}

/** Leitura da fonte a velocidade 1, em frames inteiros: [fromFrame, fromFrame + frames). */
export type FrameReader = (fromFrame: number, frames: number) => Float32Array

interface StretchState { st: Stretcher; speed: number; base: number; out: number; fedTo: number }

/**
 * Itens dos segmentos 'stretch' que tocam [fromUs, toUs). O worker prende (pin) o bloco + o aquecimento à frente:
 * o LRU só despeja o que já ficou para trás, então quantos trechos cabem na janela não muda a saída (exportação
 * idêntica byte a byte; o banco passa de maxLive enquanto a janela pedir).
 */
export function stretchKeysIn(segs: readonly AudioSegment[], fromUs: Us, toUs: Us): Set<string> {
  const out = new Set<string>()
  for (const s of segs) if (s.mode === 'stretch' && s.startUs < toUs && s.startUs + s.durationUs > fromUs) out.add(s.itemId)
  return out
}

// tolerância de continuidade (frames): as posições de fonte chegam em µs arredondados
const STRETCH_TOL_FRAMES = 2

/**
 * Stretchers por segmento (chave = itemId), compartilhados pelas fontes do worker. Cada segmento lembra a
 * posição de fonte em que parou: blocos consecutivos continuam o mesmo fluxo (sem clique nem lacuna); salto
 * de posição (seek, outro trecho) ou de velocidade → reset + pré-roll (seek com latencyFrames de histórico).
 *
 * Alinhamento (signalsmith): depois do pré-roll, a saída j corresponde à fonte base + j·speed quando a
 * entrada já foi entregue até base + lead + j·speed, lead = outputLatency·speed + inputLatency. A posição
 * é sempre recalculada de base/out (inteiros), sem acumular frações.
 * No máximo `maxLive` segmentos com estado (LRU, exceto os presos por pin); os liberados são reaproveitados.
 */
export class StretchBank {
  private readonly states = new Map<string, StretchState>() // ordem = LRU (mais recente no fim)
  private readonly creating = new Map<string, Promise<void>>()
  private readonly spare: Stretcher[] = []
  private pinned = new Set<string>()
  private latency: { input: number; output: number; total: number } | null = null
  private failure: unknown = null

  /** create(rate): rate é só a velocidade do 1º uso; o stretcher serve qualquer velocidade depois (reuso). */
  constructor(private readonly create: (rate: number) => Promise<Stretcher>, private readonly maxLive = 16) {}

  /** Garante um stretcher para o segmento. Rejeita se o WASM não carregar (e não tenta de novo). */
  async ensure(key: string, speed: number): Promise<void> {
    if (this.failure) throw this.failure
    const s = this.states.get(key)
    if (s) {
      this.touch(key, s)
      return
    }
    let p = this.creating.get(key)
    if (!p) {
      p = (async () => {
        // cheio: o segmento usado há mais tempo e fora do bloco atual (pin) cede o stretcher; se todos estão
        // presos, o banco passa do limite (nunca despeja quem o mixBlock vai ler)
        for (const [oldKey, old] of this.states) {
          if (this.states.size < this.maxLive) break
          if (this.pinned.has(oldKey)) continue
          this.states.delete(oldKey)
          this.spare.push(old.st)
        }
        let st = this.spare.pop()
        if (!st) {
          try {
            st = await this.create(speed)
          } catch (err) {
            this.failure = err
            throw err
          }
        }
        this.latency ??= { input: st.inputLatency, output: st.outputLatency, total: st.latencyFrames }
        // speed NaN: a 1ª leitura sempre faz o pré-roll
        this.states.set(key, { st, speed: NaN, base: 0, out: 0, fedTo: 0 })
      })().finally(() => this.creating.delete(key))
      this.creating.set(key, p)
    }
    await p
  }

  /**
   * Segmentos do bloco em preparo/mixagem: não são despejados até o próximo pin (o aquecimento à frente, que
   * roda em paralelo, não tira o stretcher de quem o mixBlock vai ler).
   */
  pin(keys: Set<string>): void {
    this.pinned = keys
  }

  has(key: string): boolean {
    return this.states.has(key)
  }

  /** Solta os segmentos que saíram do plano (os stretchers ficam para reuso). */
  retain(keys: Set<string>): void {
    this.pinned = new Set([...this.pinned].filter((k) => keys.has(k)))
    for (const [k, s] of this.states) {
      if (keys.has(k)) continue
      this.states.delete(k)
      this.spare.push(s.st)
    }
  }

  /**
   * Frames de fonte [from, to) que read(…, srcFromUs, frames, speed) pode pedir ao leitor (pré-roll + avanço
   * da latência); null antes do 1º stretcher existir.
   */
  span(srcFromUs: Us, frames: number, speed: number): [number, number] | null {
    const lat = this.latency
    if (!lat) return null
    const p = Math.round((srcFromUs * SR) / 1e6)
    const lead = Math.round(lat.output * speed) + lat.input
    return [p + lat.input - lat.total - STRETCH_TOL_FRAMES, p + lead + Math.ceil(frames * speed) + STRETCH_TOL_FRAMES]
  }

  /** `frames` frames estéreo esticados a partir de srcFromUs; null se o segmento não tem stretcher (chamar ensure antes). */
  read(key: string, reader: FrameReader, srcFromUs: Us, frames: number, speed: number): Float32Array | null {
    const s = this.states.get(key)
    if (!s) return null
    this.touch(key, s)
    const p = (srcFromUs * SR) / 1e6
    const lead = Math.round(s.st.outputLatency * speed) + s.st.inputLatency
    if (s.speed !== speed || Math.abs(p - (s.base + s.out * speed)) > STRETCH_TOL_FRAMES) {
      // pré-roll: histórico de latencyFrames até base + inputLatency (= saída −outputLatency) e mais
      // outputLatency frames de saída descartados — a rampa de entrada do stretcher fica antes de base
      const base = Math.round(p)
      const D = s.st.outputLatency
      const from = base + s.st.inputLatency
      s.st.reset()
      s.st.seek(reader(from - s.st.latencyFrames, s.st.latencyFrames), speed)
      s.st.process(reader(from, base + lead - from), D)
      s.speed = speed
      s.base = base
      s.out = 0
      s.fedTo = base + lead
    }
    const end = s.base + lead + Math.round((s.out + frames) * speed)
    const out = s.st.process(reader(s.fedTo, end - s.fedTo), frames)
    s.out += frames
    s.fedTo = end
    return out
  }

  private touch(key: string, s: StretchState): void {
    this.states.delete(key)
    this.states.set(key, s)
  }
}
