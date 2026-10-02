// Gravação de narração direto na timeline (renderer). O microfone (sem processamento: o editor tem a própria redução de
// ruído/normalização) entra num AudioWorklet no AudioContext da REPRODUÇÃO — o mesmo relógio que move o playhead —, e
// os samples vão para o encoder (AAC, ou Opus se não houver AAC) num MP4 fragmentado gravado em generated/ por IPC
// enquanto a timeline toca (muda, ou audível com "ouvir o vídeo"). O início do item sai do quadro do contexto do 1º
// sample e da âncora do relógio (narrationPlacement). Arquivo fragmentado (fragmentos de 0,25 s): o que foi gravado até
// uma queda continua legível; o marcador no main guarda o início para recuperar.
import { AudioSample, AudioSampleSource, canEncodeAudio, Mp4OutputFormat, Output, Quality, StreamTarget, type StreamTargetChunk } from 'mediabunny'
import type { IpcApi } from '@shared/ipc'
import type { Us } from '@shared/editor/project'
import { narrationPlacement, type NarrationClock } from '@shared/editor/narration'
import { AUDIO_BITRATE } from '@shared/defaults'
import type { PlaybackController } from './PlaybackController'
import { discardNarrationFile, NarrationCancelled, NARRATION_FRAGMENT_SEC, openNarrationFile } from './narrationFile'
import workletUrl from './narrationCapture.worklet?worker&url'

const ANCHOR_POLL_MS = 40
/** Sem bloco de áudio da reprodução até aqui: grava contra a timeline parada (relógio nunca começou). */
const ANCHOR_GIVE_UP_MS = 3000
/** O worklet confirma o fim (último bloco entregue) em bem menos que isto; contexto suspenso: não espera mais. */
const WORKLET_STOP_MS = 500
/** Encoder/escrita travados (disco com problema): fecha o que der depois disto, preservando o que já foi gravado. */
const FINALIZE_TIMEOUT_MS = 5000

/** Por que a gravação terminou sem o usuário pedir. */
export type NarrationInterruption = 'device' | 'encoder' | 'write' | 'playback'

export interface NarrationResult {
  rel: string
  startUs: Us
  inUs: Us
  /** Duração gravada (samples no arquivo). */
  recordedUs: Us
  interrupted: NarrationInterruption | null
  message?: string
}

/** Processamento que o navegador manteve ligado no microfone (deveria estar todo desligado). */
export interface MicProcessing { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }

/** Microfone sem processamento (como a v1 grava): o editor faz a redução de ruído/normalização depois. */
export function narrationConstraints(deviceId: string | null): MediaTrackConstraints {
  return { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false }
}

const loadedContexts = new WeakSet<BaseAudioContext>()

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])
}

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
  private disposed = false
  private stopped: Promise<NarrationResult> | null = null
  private onInterrupt: ((reason: NarrationInterruption) => void) | null = null
  private encodeError = false

  constructor(
    private readonly api: Pick<IpcApi, 'project'>,
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

  /**
   * Abre o microfone e o VU (antes da contagem regressiva: erro de dispositivo aparece antes de gravar). Descartado
   * (dispose) no meio: solta o que abriu e lança NarrationCancelled.
   */
  async arm(deviceId: string | null, onInterrupt: (reason: NarrationInterruption) => void): Promise<void> {
    if (this.state !== 'idle' || this.disposed) throw new Error('narração já em andamento')
    this.onInterrupt = onInterrupt
    const ctx = this.ctx
    await ctx.resume()
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl)
      loadedContexts.add(ctx)
    }
    if (this.disposed) throw new NarrationCancelled()
    const stream = await navigator.mediaDevices.getUserMedia({ audio: narrationConstraints(deviceId) })
    this.stream = stream
    if (this.disposed) {
      this.release()
      throw new NarrationCancelled()
    }
    const track = stream.getAudioTracks()[0]
    if (!track) {
      this.release() // solta o que veio (vídeo, nada) antes de desistir
      throw new Error('o microfone não entregou áudio')
    }
    // microfone desconectado/perdido no meio: termina preservando o que já foi gravado
    track.addEventListener('ended', () => this.interrupt('device', 'O microfone foi desconectado durante a gravação.'))
    this.source = ctx.createMediaStreamSource(stream)
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

  /**
   * Processamento que ficou ligado apesar de pedido desligado (o Chromium reaproveita a fonte de um microfone já aberto
   * por outra parte do app com processamento); null sem microfone.
   */
  processing(): MicProcessing | null {
    const s = this.stream?.getAudioTracks()[0]?.getSettings()
    if (!s) return null
    return { echoCancellation: s.echoCancellation === true, noiseSuppression: s.noiseSuppression === true, autoGainControl: s.autoGainControl === true }
  }

  /** Latência de entrada informada pelo microfone (s; 0 se o navegador não informa). */
  private inputLatencyS(): number {
    const s = this.stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined
    return typeof s?.latency === 'number' && Number.isFinite(s.latency) && s.latency > 0 ? s.latency : 0
  }

  /**
   * Começa a gravar no playhead: abre o arquivo, o encoder, liga a captura e toca a timeline (`monitor`: audível; senão
   * muda). Sem nada para tocar à frente (playhead no fim), grava contra a timeline parada. Falha (ou dispose no meio)
   * depois de abrir o arquivo: arquivo e marcador descartados.
   */
  async start(playheadUs: Us, monitor: boolean): Promise<void> {
    if (this.state !== 'armed' || !this.node || this.disposed) throw new Error('microfone não preparado')
    this.playheadUs = playheadUs
    const ctx = this.ctx
    const opts = { numberOfChannels: 1, sampleRate: ctx.sampleRate, quality: new Quality({ bitrate: AUDIO_BITRATE }) }
    const codec = (await canEncodeAudio('aac', opts)) ? 'aac' : (await canEncodeAudio('opus', opts)) ? 'opus' : null
    if (!codec) throw new Error('nenhum codificador de áudio disponível (AAC ou Opus)')
    if (this.disposed) throw new NarrationCancelled()
    const meta = { kind: 'narration' as const, startUs: Math.max(0, Math.round(playheadUs)), inUs: 0, createdAt: new Date().toISOString() }
    const opened = await openNarrationFile(
      this.api.project,
      this.projectId,
      meta,
      (write) => {
        const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => write(chunk.data, chunk.position) })
        const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: NARRATION_FRAGMENT_SEC }), target: new StreamTarget(writable) })
        const src = new AudioSampleSource({ codec, quality: new Quality({ bitrate: AUDIO_BITRATE }) })
        output.addAudioTrack(src)
        return { output, src, start: () => output.start() }
      },
      {
        cancelled: () => this.disposed,
        onWriteError: (e) => this.interrupt('write', `Não foi possível gravar no disco (${e instanceof Error ? e.message : String(e)}).`)
      }
    )
    if (this.disposed) {
      await discardNarrationFile(this.api.project, this.projectId, opened.handle, opened.rel)
      throw new NarrationCancelled()
    }
    this.handle = opened.handle
    this.rel = opened.rel
    this.output = opened.out.output
    this.audioSrc = opened.out.src
    this.state = 'recording'
    this.node.port.postMessage('start')
    if (this.playback.canPlayForward()) {
      this.playback.setMuted(!monitor)
      void this.playback.play(1)
      this.watchAnchor()
    }
  }

  /**
   * Espera a reprodução começar (1º bloco) para fixar a âncora do relógio e grava o início no marcador do main. Depois
   * vigia: a reprodução recomeçou de outro ponto (âncora nova) ou parou antes do fim → a narração termina (o início já
   * calculado deixaria de valer). Parar no limite da reprodução (ponto de saída ou fim) é normal: a gravação continua
   * contra o quadro parado.
   */
  private watchAnchor(): void {
    const t0 = performance.now()
    this.anchorTimer = setInterval(() => {
      const a = this.playback.clockAnchor
      if (!this.clock) {
        if (a && a.rate === 1) {
          this.clock = { us0: a.us0, t0S: a.t0S, outputLatencyS: a.outputLatencyS }
          this.saveMeta()
        } else if (performance.now() - t0 > ANCHOR_GIVE_UP_MS || (!this.playback.playing && !a)) this.clearAnchorTimer()
        return
      }
      if (a && (a.us0 !== this.clock.us0 || a.t0S !== this.clock.t0S || a.rate !== 1)) {
        this.clearAnchorTimer()
        this.interrupt('playback', 'A reprodução da linha do tempo mudou de ponto durante a gravação.')
      } else if (!a && !this.playback.playing) {
        this.clearAnchorTimer()
        // parou no limite (ponto de saída ou fim): normal, a gravação segue contra o último quadro; senão, alguém parou
        if (!this.playback.endedAtLimit) this.interrupt('playback', 'A reprodução da linha do tempo parou durante a gravação.')
      }
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
    void this.api.project.writeGeneratedMeta(this.handle, { kind: 'narration', startUs: at.startUs, inUs: at.inUs, createdAt: new Date().toISOString() }).catch(() => {})
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
      if (this.encodeError) return
      const sample = new AudioSample({ data: m.data, format: 'f32', numberOfChannels: 1, sampleRate: sr, timestamp: ts })
      try {
        await src.add(sample)
      } catch (e) {
        this.encodeError = true
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
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (e?: MessageEvent): void => {
        if (e && e.data?.t !== 'stopped') return
        node.port.removeEventListener('message', done)
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      node.port.addEventListener('message', done)
      timer = setTimeout(() => done(), WORKLET_STOP_MS) // contexto suspenso/fechado: não espera para sempre
      node.port.postMessage('stop')
    })
    this.clearAnchorTimer()
    if (this.playback.playing) this.playback.pause()
    this.playback.setMuted(false)
    this.release()
    try {
      // escrita com problema pode travar o encoder: o que já foi gravado fica, o resto desiste depois do prazo
      const r = await withTimeout(
        (async () => {
          await this.queue
          await this.output?.finalize()
        })(),
        FINALIZE_TIMEOUT_MS
      )
      if (r === 'timeout' && !this.interrupted) {
        this.interrupted = 'encoder'
        this.interruptMessage = 'O arquivo demorou demais para fechar; o que foi gravado foi preservado.'
      }
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

  /**
   * Seguro em qualquer estado. Preparando/armado/começando: solta o microfone (e um arquivo aberto no meio do start é
   * descartado por ele). Gravando (desmontagem brusca): fecha o arquivo e deixa o marcador — o projeto recupera a
   * gravação ao abrir. Parando/parado: só solta o que restar.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearAnchorTimer()
    if (this.state === 'recording') {
      void this.stop().catch(() => {})
      return
    }
    if (this.state === 'stopping') return // doStop solta tudo
    this.release()
    // arquivo aberto e ainda não gravando (não deveria acontecer: start descarta sozinho)
    if (this.handle !== null && this.state !== 'done') {
      void discardNarrationFile(this.api.project, this.projectId, this.handle, this.rel)
      this.handle = null
    }
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
