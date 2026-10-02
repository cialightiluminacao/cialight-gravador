// Time-stretch com tom preservado (signalsmith-stretch, WASM, MIT). Carregador próprio: o binário WASM e o
// mapa de nomes vêm de signalsmithWasm.ts (vendorizado por scripts/vendor-signalsmith.mjs) e são instanciados
// direto com WebAssembly — sem o glue emscripten nem a fábrica de AudioWorklet do pacote, sem blob/eval.
// Roda igual no audio worker (preview e exportação), na página e no Node (vitest).
// Determinístico: a única fonte de aleatoriedade do runtime (random_get) recebe uma sequência fixa.
import { SIGNALSMITH_EXPORTS as E, SIGNALSMITH_IMPORTS as I, SIGNALSMITH_WASM_BASE64 } from './signalsmithWasm'

const SAMPLE_RATE = 48000
// frames de entrada/saída por chamada ao WASM (os buffers do módulo têm este tamanho)
const IO_FRAMES = 8192

export interface Stretcher {
  /**
   * Consome `input` (estéreo intercalado 48 kHz, qualquer número de frames) e produz `outFrames` (> 0) frames
   * estéreo intercalados. A razão entrada/saída é a velocidade (tempo); o tom não muda. A saída atrasa
   * `outputLatency` frames e a entrada é lida `inputLatency` frames adiantada (ver StretchBank).
   */
  process(input: Float32Array, outFrames: number): Float32Array
  /** Depois de reset(): carrega o histórico de entrada (estéreo intercalado) que termina no ponto de leitura, sem produzir saída. */
  seek(input: Float32Array, rate: number): void
  reset(): void
  /** inputLatency + outputLatency: tamanho do pré-roll de seek(). */
  readonly latencyFrames: number
  readonly inputLatency: number
  readonly outputLatency: number
}

type Fn = (...args: number[]) => number
interface Raw {
  memory: WebAssembly.Memory
  ctors: Fn; main: Fn; presetDefault: Fn; inputLatency: Fn; outputLatency: Fn
  setBuffers: Fn; reset: Fn; seek: Fn; process: Fn
}

let compiled: Promise<WebAssembly.Module> | null = null
function wasmModule(): Promise<WebAssembly.Module> {
  if (!compiled) {
    const bin = atob(SIGNALSMITH_WASM_BASE64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    compiled = WebAssembly.compile(bytes)
    compiled.catch(() => (compiled = null)) // falha: próxima chamada tenta de novo
  }
  return compiled
}

async function instantiate(): Promise<Raw> {
  let memory: WebAssembly.Memory | null = null
  const u8 = (): Uint8Array => new Uint8Array(memory!.buffer)
  let seed = 0x9e3779b9
  const env: Record<string, Fn> = {
    [I.abort]: () => {
      throw new Error('signalsmith-stretch: abort')
    },
    [I.memcpy]: (dest, src, num) => {
      u8().copyWithin(dest, src, src + num)
      return 0
    },
    [I.resizeHeap]: (requested) => {
      const need = (requested >>> 0) - memory!.buffer.byteLength
      if (need <= 0) return 1
      try {
        memory!.grow(Math.ceil(need / 65536))
        return 1
      } catch {
        return 0
      }
    },
    // xorshift32 com semente fixa: mesma saída a cada execução (exportação determinística)
    [I.randomGet]: (ptr, size) => {
      const v = u8()
      for (let i = 0; i < size; i++) {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        v[ptr + i] = seed & 0xff
      }
      return 0
    }
  }
  const inst = await WebAssembly.instantiate(await wasmModule(), { a: env })
  const ex = inst.exports as Record<string, unknown>
  const raw = Object.fromEntries(Object.entries(E).map(([k, v]) => [k, ex[v]])) as unknown as Raw
  memory = raw.memory
  raw.ctors()
  raw.main(0, 0)
  return raw
}

/**
 * Stretcher estéreo a 48 kHz (preset padrão: janela de 120 ms, latências de 60 ms + 60 ms). A velocidade de cada
 * chamada é a razão entrada/saída do process (e o `rate` do seek); `rate` aqui é só a velocidade inicial
 * pretendida — o mesmo stretcher serve qualquer velocidade (o StretchBank os reaproveita).
 */
export async function createStretcher(rate: number, channels: 2): Promise<Stretcher> {
  void rate
  const m = await instantiate()
  m.presetDefault(channels, SAMPLE_RATE)
  const inputLatency = m.inputLatency()
  const outputLatency = m.outputLatency()
  const latencyFrames = inputLatency + outputLatency
  // buffers de I/O: process divide em sub-blocos que cabem neles, em qualquer velocidade
  const len = Math.max(IO_FRAMES, latencyFrames)
  const ptr = m.setBuffers(channels, len)
  const bytes = len * 4
  const inPtr = [ptr, ptr + bytes]
  const outPtr = [ptr + 2 * bytes, ptr + 3 * bytes]
  const f32 = (p: number, n: number): Float32Array => new Float32Array(m.memory.buffer, p, n) // re-obtida a cada uso (a memória pode crescer)

  /** Copia frames [from, from+n) da entrada intercalada para os buffers planares do módulo. */
  const load = (input: Float32Array, from: number, n: number): void => {
    const l = f32(inPtr[0], n)
    const r = f32(inPtr[1], n)
    for (let i = 0; i < n; i++) {
      l[i] = input[(from + i) * 2]
      r[i] = input[(from + i) * 2 + 1]
    }
  }

  return {
    inputLatency,
    outputLatency,
    latencyFrames,
    reset: () => m.reset(),
    seek(input, r) {
      const total = input.length >> 1
      // o módulo guarda só o fim do histórico: basta o último trecho que cabe no buffer
      const n = Math.min(total, len)
      load(input, total - n, n)
      m.seek(n, r)
    },
    process(input, outFrames) {
      const inFrames = input.length >> 1
      const out = new Float32Array(outFrames * 2)
      // sub-blocos com a mesma proporção entrada/saída, cada um cabendo nos buffers
      const ratio = inFrames / outFrames
      const step = Math.max(1, Math.floor((len - 1) / Math.max(1, ratio)))
      for (let o0 = 0; o0 < outFrames; o0 += step) {
        const o1 = Math.min(outFrames, o0 + step)
        const i0 = Math.round(o0 * ratio)
        const i1 = Math.round(o1 * ratio)
        load(input, i0, i1 - i0)
        m.process(i1 - i0, o1 - o0)
        const l = f32(outPtr[0], o1 - o0)
        const r = f32(outPtr[1], o1 - o0)
        for (let i = 0; i < o1 - o0; i++) {
          out[(o0 + i) * 2] = l[i]
          out[(o0 + i) * 2 + 1] = r[i]
        }
      }
      return out
    }
  }
}
