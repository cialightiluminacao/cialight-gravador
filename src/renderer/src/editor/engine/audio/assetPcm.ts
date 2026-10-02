// PCM de um asset para o mixer (roda em worker): mediabunny AudioSampleSink → chunks de 1 s a 48 kHz
// estéreo (ChunkedPcm, LRU de 30 s por asset). Cada chunk k é decodificado numa janela
// [k − 0,2 s, k + 1 + 0,2 s] (margem para o início do decoder e para a reamostragem nas bordas) e
// reamostrado para 48 kHz. As amostras ficam no seu timestamp real: o 1º timestamp negativo do AAC
// (priming) cai antes de 0 e não desloca o resto. Formatos nativos (s16-planar do MP3, f32 intercalado
// do Opus…) são convertidos por copyTo(…, { format: 'f32-planar' }).
import { ALL_FORMATS, AudioSampleSink, Input, UrlSource, type InputAudioTrack } from 'mediabunny'
import type { Us } from '@shared/editor/project'
import { ChunkedPcm, resampleLinear, SR, type PcmSource, type StretchBank } from './mixer'

const MARGIN_S = 0.2
const CACHE_CHUNKS = 30
// chunk (ou abertura) que falhou só é tentado de novo depois disso
const RETRY_MS = 2000

export interface Opened {
  input: Pick<Input, 'dispose'>
  sink: Pick<AudioSampleSink, 'samples'>
  sampleRate: number
  channels: number
  firstS: number
  endS: number
}

export interface AssetPcmOptions {
  /** Chamado uma vez por asset na 1ª falha de abertura/decodificação. */
  onError?: (message: string) => void
  now?: () => number
  open?: (url: string, trackIndex: number | null) => Promise<Opened>
  /** Stretchers por segmento (compartilhados pelo worker); sem ele os segmentos 'stretch' reamostram. */
  stretch?: StretchBank
}

export class AssetPcm implements PcmSource {
  private readonly pcm: ChunkedPcm
  private opened!: Promise<Opened | null>
  private openFailedAt: number | null = null
  private readonly failedAt = new Map<number, number>() // chunk → instante da falha (espera RETRY_MS)
  private readonly decoding = new Map<number, Promise<void>>()
  private lock: Promise<unknown> = Promise.resolve()
  private disposed = false
  private reported = false
  private readonly now: () => number
  private readonly openFn: (url: string, trackIndex: number | null) => Promise<Opened>

  /** trackIndex: faixa de áudio a:N do arquivo; null = faixa principal. */
  constructor(readonly url: string, readonly trackIndex: number | null, private readonly opts: AssetPcmOptions = {}) {
    this.now = opts.now ?? (() => performance.now())
    this.openFn = opts.open ?? open
    this.pcm = new ChunkedPcm(CACHE_CHUNKS, opts.stretch)
    this.startOpen()
  }

  /**
   * Garante em cache os chunks que read(srcFromUs, frames, speed, reverse) vai tocar. Nunca rejeita.
   * `stale`: pedido obsoleto (seek/pausa) — chunks ainda não iniciados não são decodificados.
   */
  async ensure(srcFromUs: Us, frames: number, speed: number, reverse: boolean, stale?: () => boolean): Promise<void> {
    const ks = ChunkedPcm.chunksFor(srcFromUs, frames, speed, reverse)
    await Promise.all(ks.map((k) => this.chunk(k, stale)))
    for (const k of ks) this.pcm.touch(k)
  }

  /**
   * Para readStretched: garante o stretcher do segmento e os chunks que ele vai ler (com pré-roll e o avanço
   * da latência). Nunca rejeita; sem stretcher (WASM indisponível) avisa uma vez e prepara a leitura reamostrada.
   */
  async ensureStretched(segKey: string, srcFromUs: Us, frames: number, speed: number, stale?: () => boolean): Promise<void> {
    const bank = this.opts.stretch
    try {
      await bank?.ensure(segKey, speed)
    } catch (err) {
      this.report(`velocidade com tom preservado indisponível (${errMsg(err)})`)
    }
    const span = bank?.span(srcFromUs, frames, speed)
    if (!span) return this.ensure(srcFromUs, frames, speed, false, stale)
    const ks = ChunkedPcm.chunksForFrames(span[0], span[1])
    await Promise.all(ks.map((k) => this.chunk(k, stale)))
    for (const k of ks) this.pcm.touch(k)
  }

  read(srcFromUs: Us, frames: number, speed: number, reverse: boolean): Float32Array {
    return this.pcm.read(srcFromUs, frames, speed, reverse)
  }

  readStretched(segKey: string, srcFromUs: Us, frames: number, speed: number): Float32Array {
    return this.pcm.readStretched(segKey, srcFromUs, frames, speed)
  }

  dispose(): void {
    this.disposed = true
    this.pcm.clear()
    void this.lock.then(() => this.opened).then((o) => o?.input.dispose()).catch(() => {})
  }

  private startOpen(): void {
    this.opened = this.openFn(this.url, this.trackIndex).then(
      (o) => o,
      (err) => {
        // falha: silêncio; nova tentativa de abrir depois de RETRY_MS
        this.openFailedAt = this.now()
        this.report(`áudio indisponível (${errMsg(err)})`)
        return null
      }
    )
  }

  private backingOff(k: number): boolean {
    const t = this.failedAt.get(k)
    return t !== undefined && this.now() - t < RETRY_MS
  }

  private async chunk(k: number, stale?: () => boolean): Promise<void> {
    // 2ª volta: o job em curso era de um pedido obsoleto e pulou o chunk
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.disposed || this.pcm.has(k) || this.backingOff(k) || stale?.()) return
      let p = this.decoding.get(k)
      if (!p) {
        if (this.openFailedAt !== null) {
          if (this.now() - this.openFailedAt < RETRY_MS) return
          this.openFailedAt = null
          this.startOpen()
        }
        // decodificação serializada por asset (um decoder por vez)
        p = this.lock
          .then(() => this.opened)
          .then(async (o) => {
            if (!o || this.disposed || this.pcm.has(k) || stale?.()) return
            try {
              await this.decode(o, k)
              this.failedAt.delete(k)
            } catch (err) {
              this.failedAt.set(k, this.now())
              this.report(`falha ao decodificar o áudio (${errMsg(err)})`)
            }
          })
          .finally(() => this.decoding.delete(k))
        this.lock = p
        this.decoding.set(k, p)
      }
      await p
    }
  }

  private report(message: string): void {
    if (this.reported) return
    this.reported = true
    this.opts.onError?.(message)
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
