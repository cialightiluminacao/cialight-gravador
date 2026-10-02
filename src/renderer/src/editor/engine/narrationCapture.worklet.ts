// AudioWorklet da gravação de narração. Roda no AudioContext da reprodução (mesmo relógio): recebe o microfone já em
// mono (channelCount 1, 'explicit') e, gravando, junta os quanta em blocos de ~85 ms e os envia com o quadro do
// contexto do 1º sample (`frame`). Cada quantum vira exatamente 128 samples no arquivo (silêncio se o microfone não
// mandou nada), então a posição no arquivo anda junto com o relógio do contexto. Também manda o nível (VU) sempre.

declare const currentFrame: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

const QUANTUM = 128
const CHUNK = QUANTUM * 32 // 4096 samples ≈ 85 ms a 48 kHz
const LEVEL_EVERY = QUANTUM * 16 // ≈ 43 ms

class NarrationCapture extends AudioWorkletProcessor {
  private recording = false
  private buf = new Float32Array(CHUNK)
  private n = 0
  private chunkFrame = 0
  private levelN = 0
  private sumSq = 0
  private peak = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent): void => {
      if (e.data === 'start') {
        this.recording = true
        this.n = 0
      } else if (e.data === 'stop') {
        this.flush()
        this.recording = false
        this.port.postMessage({ t: 'stopped' })
      }
    }
  }

  private flush(): void {
    if (this.n === 0) return
    const data = this.buf.slice(0, this.n)
    this.port.postMessage({ t: 'chunk', frame: this.chunkFrame, data }, [data.buffer])
    this.n = 0
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    for (let i = 0; i < QUANTUM; i++) {
      const v = ch ? (ch[i] ?? 0) : 0
      this.sumSq += v * v
      const a = Math.abs(v)
      if (a > this.peak) this.peak = a
    }
    this.levelN += QUANTUM
    if (this.levelN >= LEVEL_EVERY) {
      this.port.postMessage({ t: 'level', rms: Math.sqrt(this.sumSq / this.levelN), peak: this.peak })
      this.levelN = 0
      this.sumSq = 0
      this.peak = 0
    }
    if (this.recording) {
      if (this.n === 0) this.chunkFrame = currentFrame
      if (ch) this.buf.set(ch.subarray(0, QUANTUM), this.n)
      else this.buf.fill(0, this.n, this.n + QUANTUM)
      this.n += QUANTUM
      if (this.n >= CHUNK) this.flush()
    }
    return true
  }
}

registerProcessor('cialight-narration-capture', NarrationCapture)
