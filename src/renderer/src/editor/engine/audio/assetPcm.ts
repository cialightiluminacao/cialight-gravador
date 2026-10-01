// PCM de um asset para o mixer (roda em worker): mediabunny AudioSampleSink → chunks de 1 s a 48 kHz
// estéreo (ChunkedPcm, LRU de 30 s por asset). Cada chunk k é decodificado numa janela
// [k − 0,2 s, k + 1 + 0,2 s] (margem para o início do decoder e para a reamostragem nas bordas) e
// reamostrado para 48 kHz. As amostras ficam no seu timestamp real: o 1º timestamp negativo do AAC
// (priming) cai antes de 0 e não desloca o resto. Formatos nativos (s16-planar do MP3, f32 intercalado
// do Opus…) são convertidos por copyTo(…, { format: 'f32-planar' }).
import { ALL_FORMATS, AudioSampleSink, Input, UrlSource, type InputAudioTrack } from 'mediabunny'
import type { Us } from '@shared/editor/project'
import { ChunkedPcm, resampleLinear, SR, type PcmSource } from './mixer'

const MARGIN_S = 0.2
const CACHE_CHUNKS = 30

interface Opened {
  input: Input
  sink: AudioSampleSink
  sampleRate: number
  channels: number
  firstS: number
  endS: number
}

export class AssetPcm implements PcmSource {
  private readonly pcm = new ChunkedPcm(CACHE_CHUNKS)
  private readonly opened: Promise<Opened>
  private readonly decoding = new Map<number, Promise<void>>()
  private lock: Promise<unknown> = Promise.resolve()
  private disposed = false

  /** trackIndex: faixa de áudio a:N do arquivo; null = faixa principal. */
  constructor(readonly url: string, readonly trackIndex: number | null) {
    this.opened = open(url, trackIndex)
    this.opened.catch(() => {}) // falha: a fonte fica em silêncio (ensure resolve sem chunks)
  }

  /** Garante em cache os chunks que read(srcFromUs, frames, speed, reverse) vai tocar. Nunca rejeita. */
  async ensure(srcFromUs: Us, frames: number, speed: number, reverse: boolean): Promise<void> {
    const ks = ChunkedPcm.chunksFor(srcFromUs, frames, speed, reverse)
    await Promise.all(ks.map((k) => this.chunk(k)))
    for (const k of ks) this.pcm.touch(k)
  }

  read(srcFromUs: Us, frames: number, speed: number, reverse: boolean): Float32Array {
    return this.pcm.read(srcFromUs, frames, speed, reverse)
  }

  dispose(): void {
    this.disposed = true
    this.pcm.clear()
    void this.lock.then(() => this.opened).then((o) => o.input.dispose()).catch(() => {})
  }

  private chunk(k: number): Promise<void> {
    if (this.pcm.has(k)) return Promise.resolve()
    let p = this.decoding.get(k)
    if (!p) {
      // decodificação serializada por asset (um decoder por vez)
      p = this.lock
        .then(() => this.opened)
        .then((o) => (this.disposed || this.pcm.has(k) ? undefined : this.decode(o, k)))
        .catch(() => {})
        .finally(() => this.decoding.delete(k))
      this.lock = p
      this.decoding.set(k, p)
    }
    return p
  }

  private async decode(o: Opened, k: number): Promise<void> {
    if (k + 1 <= o.firstS || k >= o.endS) {
      this.pcm.put(k, null) // fora da mídia: silêncio sem decodificar
      return
    }
    const winStart = k - MARGIN_S
    const winEnd = k + 1 + MARGIN_S
    const sr = o.sampleRate
    const ch = o.channels
    const len = Math.ceil((winEnd - winStart) * sr)
    const planes = Array.from({ length: ch }, () => new Float32Array(len))
    let tmp = new Float32Array(0)
    for await (const s of o.sink.samples(Math.max(winStart, o.firstS), winEnd)) {
      try {
        const n = s.numberOfFrames
        if (tmp.length < n) tmp = new Float32Array(n)
        const off = Math.round((s.timestamp - winStart) * sr)
        const from = Math.max(0, -off)
        const to = Math.min(n, len - off)
        if (to <= from) continue
        for (let c = 0; c < ch; c++) {
          // faixa com menos canais num sample: repete o último disponível
          s.copyTo(tmp, { planeIndex: Math.min(c, s.numberOfChannels - 1), format: 'f32-planar' })
          planes[c].set(tmp.subarray(from, to), off + from)
        }
      } finally {
        s.close()
      }
    }
    const inter = new Float32Array(len * ch)
    for (let f = 0; f < len; f++) for (let c = 0; c < ch; c++) inter[f * ch + c] = planes[c][f]
    const win = resampleLinear(inter, sr, ch, SR)
    const off = Math.round(MARGIN_S * SR)
    const out = new Float32Array(SR * 2)
    out.set(win.subarray(off * 2, Math.min(win.length, (off + SR) * 2)))
    if (!this.disposed) this.pcm.put(k, out)
  }
}

async function open(url: string, trackIndex: number | null): Promise<Opened> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    let track: InputAudioTrack | null
    if (trackIndex === null) track = await input.getPrimaryAudioTrack()
    else track = (await input.getAudioTracks())[trackIndex] ?? null
    if (!track) throw new Error(trackIndex === null ? 'sem faixa de áudio' : `faixa de áudio a:${trackIndex} inexistente`)
    if (!(await track.canDecode())) throw new Error(`codec de áudio não decodificável: ${track.codec}`)
    const [firstS, endS] = await Promise.all([track.getFirstTimestamp(), track.computeDuration()])
    return { input, sink: new AudioSampleSink(track), sampleRate: track.sampleRate, channels: Math.max(1, track.numberOfChannels), firstS, endS }
  } catch (err) {
    input.dispose()
    throw err
  }
}
