// Teste 5: signalsmith-stretch (WASM) rodando num Web Worker comum, sem AudioWorklet.
// O pacote npm só expõe a fábrica de AudioWorkletNode; a fábrica emscripten "crua" fica
// no início do .mjs. Carregamos o texto (?raw), cortamos antes de registerWorkletProcessor
// e importamos como módulo blob — o WASM vem embutido em base64 (sem arquivo .wasm).
import stretchSrc from 'signalsmith-stretch?raw'
import { analyze, makeTestSignal, SR } from './audioAnalysis'

interface StretchModule {
  HEAP8: Int8Array
  exports?: { memory: WebAssembly.Memory }
  _main(): void
  _presetDefault(channels: number, sampleRate: number): void
  _presetCheaper(channels: number, sampleRate: number): void
  _inputLatency(): number
  _outputLatency(): number
  _setBuffers(channels: number, length: number): number
  _seek(inputSamples: number, rate: number): void
  _process(inputSamples: number, outputSamples: number): void
  _flush(outputSamples: number): void
  _reset(): void
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void
}

let factoryP: Promise<() => Promise<StretchModule>> | null = null
function loadFactory(): Promise<() => Promise<StretchModule>> {
  if (!factoryP) {
    const cut = stretchSrc.indexOf('function registerWorkletProcessor')
    if (cut < 0) throw new Error('formato inesperado do SignalsmithStretch.mjs')
    const code = stretchSrc.slice(0, cut) + '\nexport default SignalsmithStretch;\n'
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    factoryP = import(/* @vite-ignore */ url).then((m: { default: () => Promise<StretchModule> }) => m.default)
  }
  return factoryP
}

interface Stretcher {
  m: StretchModule
  channels: number
  bufferLength: number
  inPtr: number[]
  outPtr: number[]
  inLat: number
  outLat: number
}

async function createStretcher(channels: number, preset: 'default' | 'cheaper'): Promise<Stretcher> {
  const factory = await loadFactory()
  const m = await factory()
  m._main()
  if (preset === 'cheaper') m._presetCheaper(channels, SR)
  else m._presetDefault(channels, SR)
  const inLat = m._inputLatency()
  const outLat = m._outputLatency()
  const bufferLength = inLat + outLat
  const ptr = m._setBuffers(channels, bufferLength)
  const bytes = bufferLength * 4
  const inPtr: number[] = []
  const outPtr: number[] = []
  for (let c = 0; c < channels; c++) {
    inPtr.push(ptr + bytes * c)
    outPtr.push(ptr + bytes * (c + channels))
  }
  return { m, channels, bufferLength, inPtr, outPtr, inLat, outLat }
}

const heap = (s: Stretcher): ArrayBuffer => (s.m.exports ? s.m.exports.memory.buffer : (s.m.HEAP8.buffer as ArrayBuffer))

/**
 * Estilo "worklet" (igual ao processador oficial): a cada bloco de saída, posiciona a
 * entrada no tempo mapeado (seek com bufferLength amostras) e chama process(0, B).
 * Alinhamento: a saída do bloco corresponde ao tempo de saída t + outputLatency.
 */
function stretchSeekStyle(s: Stretcher, input: Float32Array[], rate: number, B: number): Float32Array[] {
  const N = input[0].length
  const L = Math.round(N / rate)
  const out = input.map(() => new Float32Array(L))
  const latBlocks = Math.ceil(s.outLat / B)
  for (let k = -latBlocks; k * B < L; k++) {
    const outT = k * B + s.outLat // amostras de saída
    const inEnd = Math.round(outT * rate) + s.inLat
    const mem = heap(s)
    for (let c = 0; c < s.channels; c++) {
      const buf = new Float32Array(mem, s.inPtr[c], s.bufferLength)
      const src = input[c % input.length]
      const start = inEnd - s.bufferLength
      for (let j = 0; j < s.bufferLength; j++) {
        const idx = start + j
        buf[j] = idx >= 0 && idx < N ? src[idx] : 0
      }
    }
    s.m._seek(s.bufferLength, rate)
    s.m._process(0, B)
    const mem2 = heap(s)
    const at = k * B
    for (let c = 0; c < s.channels; c++) {
      const ob = new Float32Array(mem2, s.outPtr[c], B)
      for (let j = 0; j < B; j++) {
        const o = at + j
        if (o >= 0 && o < L) out[c][o] = ob[j]
      }
    }
  }
  return out
}

/** Streaming puro: process(entrada proporcional, B) contínuo + flush; atraso medido depois. */
function stretchStreaming(s: Stretcher, input: Float32Array[], rate: number, B: number): { out: Float32Array[]; delay: number } {
  const N = input[0].length
  const L = Math.round(N / rate)
  const delay = s.outLat + Math.round(s.inLat / rate)
  const total = L + delay
  const raw = input.map(() => new Float32Array(total + B))
  let inPos = 0
  let outPos = 0
  while (outPos < total) {
    const want = Math.min(Math.round((outPos + B) * rate) - inPos, s.bufferLength)
    const mem = heap(s)
    for (let c = 0; c < s.channels; c++) {
      const buf = new Float32Array(mem, s.inPtr[c], s.bufferLength)
      const src = input[c % input.length]
      for (let j = 0; j < want; j++) buf[j] = inPos + j < N ? src[inPos + j] : 0
    }
    s.m._process(want, B)
    inPos += want
    const mem2 = heap(s)
    for (let c = 0; c < s.channels; c++) raw[c].set(new Float32Array(mem2, s.outPtr[c], B), outPos)
    outPos += B
  }
  return { out: raw.map((r) => r.slice(delay, delay + L)), delay }
}

self.addEventListener('message', (e: MessageEvent<{ rates: number[]; seconds: number }>) => {
  run(e.data.rates, e.data.seconds).then(
    (r) => self.postMessage({ ok: true, result: r }),
    (err: unknown) => self.postMessage({ ok: false, error: String(err instanceof Error ? (err.stack ?? err.message) : err) })
  )
})

async function run(rates: number[], seconds: number): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const probe = await createStretcher(2, 'default')
  const res: Record<string, unknown> = {
    loadMs: Math.round(performance.now() - t0),
    inputLatency: probe.inLat,
    outputLatency: probe.outLat,
    bufferLength: probe.bufferLength,
    crossOriginIsolated: self.crossOriginIsolated
  }
  const input = makeTestSignal(seconds)
  res.inputAnalysis = analyze(input[0], 1)
  const rows: Record<string, unknown>[] = []
  for (const mode of ['seek', 'streaming'] as const) {
    for (const rate of rates) {
      const s = await createStretcher(2, 'default')
      const t1 = performance.now()
      let out: Float32Array[]
      let delay: number | undefined
      if (mode === 'seek') out = stretchSeekStyle(s, input, rate, 512)
      else ({ out, delay } = stretchStreaming(s, input, rate, 512))
      const ms = performance.now() - t1
      const outSec = out[0].length / SR
      rows.push({
        mode,
        rate,
        expectedSamples: Math.round(input[0].length / rate),
        outSamples: out[0].length,
        outSeconds: +outSec.toFixed(3),
        ms: Math.round(ms),
        realtimeFactorOut: +(outSec / (ms / 1000)).toFixed(1),
        realtimeFactorIn: +(seconds / (ms / 1000)).toFixed(1),
        delaySamples: delay,
        ...analyze(out[0], rate)
      })
    }
  }
  res.rows = rows
  return res
}
