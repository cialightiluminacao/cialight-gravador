// Gravação de narração direto na timeline (renderer). O microfone (sem processamento: o editor tem a própria redução de
// ruído/normalização) entra num AudioWorklet no AudioContext da REPRODUÇÃO — o mesmo relógio que move o playhead —, e
// os samples vão para o encoder (AAC, ou Opus se não houver AAC) num MP4 fragmentado gravado em generated/ por IPC
// enquanto a timeline toca (muda, ou audível com "ouvir o vídeo"). O início do item sai do quadro do contexto do 1º
// sample e da âncora do relógio (narrationPlacement). Arquivo fragmentado: o que foi gravado até uma queda continua
// legível; o marcador no main guarda o início para recuperar.
import { AudioSample, AudioSampleSource, canEncodeAudio, Mp4OutputFormat, Output, Quality, StreamTarget, type StreamTargetChunk } from 'mediabunny'
import type { IpcApi } from '@shared/ipc'
import type { Us } from '@shared/editor/project'
import { narrationPlacement, type NarrationClock } from '@shared/editor/narration'
import { AUDIO_BITRATE, FRAGMENT_DURATION_SEC } from '@shared/defaults'
import type { PlaybackController } from './PlaybackController'
import workletUrl from './narrationCapture.worklet?worker&url'

const ANCHOR_POLL_MS = 40
/** Sem bloco de áudio da reprodução até aqui: grava contra a timeline parada (relógio nunca começou). */
const ANCHOR_GIVE_UP_MS = 3000

/** Por que a gravação terminou sem o usuário pedir. */
export type NarrationInterruption = 'device' | 'encoder'

export interface NarrationResult {
  rel: string
  startUs: Us
  inUs: Us
  /** Duração gravada (samples no arquivo). */
  recordedUs: Us
  interrupted: NarrationInterruption | null
  message?: string
}

/** Microfone sem processamento (como a v1 grava): o editor faz a redução de ruído/normalização depois. */
export function narrationConstraints(deviceId: string | null): MediaTrackConstraints {
  return { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false }
}

const loadedContexts = new WeakSet<BaseAudioContext>()

export class NarrationRecorder {
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private output: Output | null = null
  private audioSrc: AudioSampleSource | null = null
  private handle: number | null = null
  private rel = ''
  private queue: Promise<void> = Promise.resolve()
  private framesWritten = 0
  private firstFrame: number | null = null
  private playheadUs: Us = 0
  private clock: NarrationClock | null = null
  private anchorTimer: ReturnType<typeof setInterval> | null = null
  private interrupted: NarrationInterruption | null = null
  private interruptMessage: string | undefined
  private state: 'idle' | 'armed' | 'recording' | 'stopping' | 'done' = 'idle'
  private stopped: Promise<NarrationResult> | null = null
  private onInterrupt: ((reason: NarrationInterruption) => void) | null = null
  private writeError: unknown = null

  constructor(
    private readonly api: IpcApi,
    private readonly projectId: string,
    private readonly playback: PlaybackController,
    private readonly onLevel: (rms: number, peak: number) => void
  ) {}

  get recording(): boolean {
    return this.state === 'recording'
  }

  /** Samples gravados até agora (µs). */
  get recordedUs(): Us {
    return Math.round((this.framesWritten / this.ctx.sampleRate) * 1e6)
  }

  private get ctx(): AudioContext {
    return this.playback.audioContext()
  }

  /** Abre o microfone e o VU (antes da contagem regressiva: erro de dispositivo aparece antes de gravar). */
  async arm(deviceId: string | null, onInterrupt: (reason: NarrationInterruption) => void): Promise<void> {
    if (this.state !== 'idle') throw new Error('narração já em andamento')
    this.onInterrupt = onInterrupt
    const ctx = this.ctx
    await ctx.resume()
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl)
      loadedContexts.add(ctx)
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: narrationConstraints(deviceId) })
    const track = this.stream.getAudioTracks()[0]
    if (!track) throw new Error('o microfone não entregou áudio')
    // microfone desconectado/perdido no meio: termina preservando o que já foi gravado
    track.addEventListener('ended', () => this.interrupt('device', 'O microfone foi desconectado durante a gravação.'))
    this.source = ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(ctx, 'cialight-narration-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    // o nó precisa estar ligado ao destino para ser processado; ganho 0: o microfone nunca sai no alto-falante
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(ctx.destination)
    this.node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data)
    this.state = 'armed'
  }

  /** Latência de entrada informada pelo microfone (s; 0 se o navegador não informa). */
  private inputLatencyS(): number {
    const s = this.stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined
    return typeof s?.latency === 'number' && Number.isFinite(s.latency) && s.latency > 0 ? s.latency : 0
  }

  /**
   * Começa a gravar no playhead: abre o arquivo, o encoder, liga a captura e toca a timeline (`monitor`: audível; senão
   * muda). Sem nada para tocar à frente (playhead no fim), grava contra a timeline parada.
   */
  async start(playheadUs: Us, monitor: boolean): Promise<void> {
    if (this.state !== 'armed' || !this.node) throw new Error('microfone não preparado')
    this.playheadUs = playheadUs
    const ctx = this.ctx
    const opts = { numberOfChannels: 1, sampleRate: ctx.sampleRate, quality: new Quality({ bitrate: AUDIO_BITRATE }) }
    const codec = (await canEncodeAudio('aac', opts)) ? 'aac' : (await canEncodeAudio('opus', opts)) ? 'opus' : null
    if (!codec) throw new Error('nenhum codificador de áudio disponível (AAC ou Opus)')
    const meta = { kind: 'narration' as const, startUs: Math.max(0, Math.round(playheadUs)), inUs: 0, createdAt: new Date().toISOString() }
    const { handle, rel } = await this.api.project.writeGeneratedOpen(this.projectId, 'narracao', 'm4a', meta)
    this.handle = handle
    this.rel = rel
    const writable = new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        await this.api.project.writeGenerated(handle, chunk.data, chunk.position)
      }
    })
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: FRAGMENT_DURATION_SEC }), target: new StreamTarget(writable) })
    const src = new AudioSampleSource({ codec, quality: new Quality({ bitrate: AUDIO_BITRATE }) })
    output.addAudioTrack(src)
    await output.start()
    this.output = output
    this.audioSrc = src
    this.state = 'recording'
    this.node.port.postMessage('start')
    if (this.playback.canPlayForward()) {
      this.playback.setMuted(!monitor)
      void this.playback.play(1)
      this.watchAnchor()
    }
  }

  /** Espera a reprodução começar (1º bloco) para fixar a âncora do relógio e grava o início no marcador do main. */
  private watchAnchor(): void {
    const t0 = performance.now()
    this.anchorTimer = setInterval(() => {
      const a = this.playback.clockAnchor
      if (a && a.rate === 1) {
        this.clock = { us0: a.us0, t0S: a.t0S, outputLatencyS: a.outputLatencyS }
        this.clearAnchorTimer()
        this.saveMeta()
      } else if (performance.now() - t0 > ANCHOR_GIVE_UP_MS || (!this.playback.playing && !a)) this.clearAnchorTimer()
    }, ANCHOR_POLL_MS)
  }

  private clearAnchorTimer(): void {
    if (this.anchorTimer !== null) clearInterval(this.anchorTimer)
    this.anchorTimer = null
  }

  private placement(): { startUs: Us; inUs: Us } {
    const firstSampleS = this.firstFrame === null ? 0 : this.firstFrame / this.ctx.sampleRate
    return narrationPlacement({ playheadUs: this.playheadUs, clock: this.firstFrame === null ? null : this.clock, firstSampleS, inputLatencyS: this.inputLatencyS() })
  }

  private saveMeta(): void {
    if (this.handle === null || this.firstFrame === null) return
    const at = this.placement()
    const handle = this.handle
    void this.api.project.writeGeneratedMeta(handle, { kind: 'narration', startUs: at.startUs, inUs: at.inUs, createdAt: new Date().toISOString() }).catch(() => {})
  }

  private onWorklet(m: { t: 'level'; rms: number; peak: number } | { t: 'chunk'; frame: number; data: Float32Array } | { t: 'stopped' }): void {
    if (m.t === 'level') {
      this.onLevel(m.rms, m.peak)
      return
    }
    if (m.t !== 'chunk' || !this.audioSrc) return
    if (this.firstFrame === null) {
      this.firstFrame = m.frame
      if (this.clock) this.saveMeta()
    }
    const src = this.audioSrc
    const sr = this.ctx.sampleRate
    const ts = this.framesWritten / sr
    this.framesWritten += m.data.length
    // em ordem: o encoder recebe os blocos na sequência em que chegaram
    this.queue = this.queue.then(async () => {
      if (this.writeError) return
      const sample = new AudioSample({ data: m.data, format: 'f32', numberOfChannels: 1, sampleRate: sr, timestamp: ts })
      try {
        await src.add(sample)
      } catch (e) {
        this.writeError = e
        this.interrupt('encoder', `A gravação falhou (${e instanceof Error ? e.message : String(e)}).`)
      } finally {
        sample.close()
      }
    })
  }

  private interrupt(reason: NarrationInterruption, message: string): void {
    if (this.state !== 'recording' && this.state !== 'armed') return
    if (!this.interrupted) {
      this.interrupted = reason
      this.interruptMessage = message
    }
    this.onInterrupt?.(reason)
  }

  /**
   * Para: o worklet entrega o resto, o encoder fecha o arquivo e a reprodução pausa. Devolve onde o item entra; o
   * arquivo continua com o marcador (quem chama registra o asset, salva e limpa o marcador). Chamadas repetidas
   * devolvem o mesmo resultado.
   */
  stop(): Promise<NarrationResult> {
    if (!this.stopped) this.stopped = this.doStop()
    return this.stopped
  }

  private async doStop(): Promise<NarrationResult> {
    if (this.state !== 'recording') throw new Error('nada gravando')
    this.state = 'stopping'
    const node = this.node!
    // o worklet manda o bloco incompleto e confirma
    await new Promise<void>((resolve) => {
      const done = (e: MessageEvent): void => {
        if (e.data?.t !== 'stopped') return
        node.port.removeEventListener('message', done)
        resolve()
      }
      node.port.addEventListener('message', done)
      node.port.postMessage('stop')
      setTimeout(resolve, 500) // contexto suspenso/fechado: não espera para sempre
    })
    this.clearAnchorTimer()
    if (this.playback.playing) this.playback.pause()
    this.playback.setMuted(false)
    this.release()
    await this.queue
    try {
      await this.output?.finalize()
    } catch (e) {
      if (!this.interrupted) {
        this.interrupted = 'encoder'
        this.interruptMessage = `Falha ao fechar o arquivo (${e instanceof Error ? e.message : String(e)}); o que foi gravado foi preservado.`
      }
    } finally {
      if (this.handle !== null) await this.api.project.writeGeneratedClose(this.handle).catch(() => {})
      this.handle = null
    }
    const at = this.placement()
    this.state = 'done'
    return { rel: this.rel, startUs: at.startUs, inUs: at.inUs, recordedUs: this.recordedUs, interrupted: this.interrupted, message: this.interruptMessage }
  }

  /** Desiste antes de gravar (contagem cancelada) ou solta tudo depois de parar. */
  dispose(): void {
    this.clearAnchorTimer()
    if (this.state === 'recording') {
      // desmontando no meio (janela fechando): fecha o arquivo; o marcador faz o projeto recuperar a gravação
      void this.stop().catch(() => {})
      return
    }
    this.release()
  }

  private release(): void {
    try {
      this.source?.disconnect()
      this.node?.disconnect()
      this.sink?.disconnect()
    } catch {
      // já desligados
    }
    if (this.node) this.node.port.onmessage = null
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.stream = null
    this.source = null
    this.sink = null
  }
}
