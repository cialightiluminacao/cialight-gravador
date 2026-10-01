// Mixer de áudio do editor (puro): PCM Float32 estéreo intercalado a 48 kHz. Usado pelo audio worker
// no preview e pela exportação. Cada segmento do plano (planAudio) lê a sua fonte na posição
// srcIn + (t − start)·speed (reverso: do fim para o início), aplica o envelope de ganho e soma;
// no fim, limitador suave acima de 0,9.
import { gainAt, type AudioSegment } from '@shared/editor/audioPlan'
import type { Us } from '@shared/editor/project'

export const SR = 48000

/** Fonte de PCM de um asset, já a 48 kHz. Leitura síncrona: o que não estiver disponível sai como zeros. */
export interface PcmSource {
  /** `frames` frames estéreo intercalados (frames·2) a partir de srcFromUs, andando `speed` por frame (para trás se `reverse`). */
  read(srcFromUs: Us, frames: number, speed: number, reverse: boolean): Float32Array
}

// O ganho é avaliado nas bordas de sub-blocos de 64 amostras e interpolado linearmente dentro deles.
const GAIN_STEP = 64

/** Índice do primeiro frame do bloco (iniciado em fromUs) cujo instante é ≥ tUs; aritmética inteira até a divisão. */
const frameAtOrAfter = (fromUs: Us, tUs: Us): number => Math.ceil(((tUs - fromUs) * SR) / 1e6)
const usAtFrame = (fromUs: Us, frame: number): Us => fromUs + Math.round((frame * 1e6) / SR)

export function mixBlock(segments: AudioSegment[], fromUs: Us, frames: number, sources: Map<string, PcmSource>): Float32Array {
  const out = new Float32Array(frames * 2)
  for (const seg of segments) {
    const src = sources.get(seg.assetId)
    if (!src) continue
    const endUs = seg.startUs + seg.durationUs
    const i0 = Math.max(0, frameAtOrAfter(fromUs, seg.startUs))
    const i1 = Math.min(frames, frameAtOrAfter(fromUs, endUs))
    const n = i1 - i0
    if (n <= 0) continue
    const local = usAtFrame(fromUs, i0) - seg.startUs
    const srcFrom = seg.reverse ? seg.srcInUs + Math.round((seg.durationUs - local) * seg.speed) : seg.srcInUs + Math.round(local * seg.speed)
    const pcm = src.read(srcFrom, n, seg.speed, seg.reverse)
    const g = (frame: number): number => gainAt(seg, Math.min(endUs, Math.max(seg.startUs, usAtFrame(fromUs, frame))))
    for (let j = 0; j < n; j += GAIN_STEP) {
      const len = Math.min(GAIN_STEP, n - j)
      const g0 = g(i0 + j)
      const dg = (g(i0 + j + len) - g0) / len
      for (let k = 0; k < len; k++) {
        const gain = g0 + dg * k
        const s = (j + k) * 2
        const o = (i0 + j + k) * 2
        out[o] += pcm[s] * gain
        out[o + 1] += pcm[s + 1] * gain
      }
    }
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

  constructor(private readonly maxChunks: number) {}

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
