import { Output, Mp4OutputFormat, StreamTarget, MediaStreamVideoTrackSource, MediaStreamAudioTrackSource, type StreamTargetChunk } from 'mediabunny'
import type { IpcApi } from '@shared/ipc'
import type { PipKeyframe, RecordingConfig, Session, Stroke } from '@shared/types'
import { AUDIO_BITRATE, FRAGMENT_DURATION_SEC, KEYFRAME_INTERVAL_SEC, WEBCAM_BITRATE } from '@shared/defaults'
import { sessionIdFor } from '@shared/filenames'
import { aacSupported, pickVideoConfig, type VideoConfigChoice } from './encoderSupport'
import { SessionRecorder } from './sessionRecorder'
import { FallbackRecorder } from './fallbackRecorder'

// Engine de gravação (renderer do gravador). Abre os streams, grava 4 faixas num
// fMP4 via mediabunny (streaming para o disco pelo main) e registra os eventos da
// sessão. Validado no spike (docs/research/spike-results.md).

export type EngineEvent =
  | { type: 'bytes'; bytes: number; elapsedMs: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'fallback' }
  | { type: 'stopped'; session: Session }

export interface PreparedStreams {
  screen: MediaStream
  cam: MediaStream | null
  mic: MediaStream | null
  video: VideoConfigChoice
  systemAudioTrack: MediaStreamTrack | null
}

type Listener = (e: EngineEvent) => void

export class RecordingEngine {
  private listeners = new Set<Listener>()
  private config: RecordingConfig | null = null
  private streams: PreparedStreams | null = null
  private recorder: SessionRecorder | null = null
  private output: Output | null = null
  private sources: { name: string; src: MediaStreamVideoTrackSource | MediaStreamAudioTrackSource }[] = []
  private handle: number | null = null
  private bytes = 0
  private bytesTimer: ReturnType<typeof setInterval> | null = null
  private fallback: FallbackRecorder | null = null
  private state: 'idle' | 'prepared' | 'recording' | 'paused' | 'stopping' | 'stopped' = 'idle'
  private micMuted = false
  private camOn = true

  constructor(private api: IpcApi) {}

  on(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error(err)
      }
    }
  }

  get phase(): typeof this.state {
    return this.state
  }

  get session(): Session | null {
    return this.recorder?.session ?? null
  }

  get prepared(): PreparedStreams | null {
    return this.streams
  }

  get isMicMuted(): boolean {
    return this.micMuted
  }

  get isCameraOn(): boolean {
    return this.camOn
  }

  /** Abre streams e cria a sessão (sem começar a codificar). Chamado antes da contagem regressiva. */
  async prepare(config: RecordingConfig): Promise<PreparedStreams> {
    if (this.state !== 'idle' && this.state !== 'stopped') throw new Error('engine ocupado')
    this.config = config
    await this.api.capture.select(config.source.id, config.systemAudio)

    // 1) tela (+ loopback) — SEM microfone na mesma chamada
    const wantFps = config.fps
    const screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: wantFps, max: wantFps } },
      audio: config.systemAudio
        ? ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints)
        : false
    })
    const screenTrack = screen.getVideoTracks()[0]
    const st = screenTrack.getSettings()
    const srcW = st.width ?? 1920
    const srcH = st.height ?? 1080
    const video = await pickVideoConfig(config.quality, wantFps, srcW, srcH)
    // aplica a resolução escolhida na própria track (Chromium reescala a captura)
    if (video.width !== srcW || video.height !== srcH) {
      try {
        await screenTrack.applyConstraints({ width: { ideal: video.width }, height: { ideal: video.height }, frameRate: { ideal: video.fps } })
      } catch (e) {
        this.emit({ type: 'warning', message: `Não foi possível reduzir a resolução da captura (${String(e)}); gravando em ${srcW}×${srcH}.` })
        video.width = srcW
        video.height = srcH
      }
    }
    if (video.downgraded) this.emit({ type: 'warning', message: `O encoder de vídeo não suporta a qualidade escolhida; gravando em ${video.height}p.` })
    const systemAudioTrack = screen.getAudioTracks()[0] ?? null
    if (config.systemAudio && !systemAudioTrack) this.emit({ type: 'warning', message: 'O áudio do sistema não pôde ser capturado nesta fonte.' })

    // 2) câmera
    let cam: MediaStream | null = null
    if (config.webcam) {
      try {
        cam = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: config.webcam.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        })
      } catch (e) {
        this.emit({ type: 'warning', message: `Câmera indisponível (${(e as Error).name}); gravando sem webcam.` })
      }
    }
    // 3) microfone
    let mic: MediaStream | null = null
    if (config.mic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: config.mic.deviceId },
            echoCancellation: config.mic.echoCancellation,
            noiseSuppression: config.mic.noiseSuppression,
            autoGainControl: config.mic.autoGainControl
          }
        })
      } catch (e) {
        this.emit({ type: 'warning', message: `Microfone indisponível (${(e as Error).name}); gravando sem microfone.` })
      }
    }
    this.streams = { screen, cam, mic, video, systemAudioTrack }
    this.micMuted = false
    this.camOn = true

    // 4) sessão
    const sessionId = sessionIdFor(new Date())
    const { session } = await this.api.session.create(config, sessionId)
    session.video = { width: video.width, height: video.height, fps: video.fps, codec: video.fullCodecString, bitrate: video.bitrate }
    if (cam) {
      const cs = cam.getVideoTracks()[0].getSettings()
      session.webcam = { deviceId: config.webcam!.deviceId, label: config.webcam!.label, width: cs.width ?? 1280, height: cs.height ?? 720, mirrored: config.webcam!.mirrored }
    } else {
      session.webcam = undefined
    }
    if (!mic) session.mic = undefined
    session.systemAudio = !!systemAudioTrack
    this.recorder = new SessionRecorder(session, { now: () => performance.now(), save: (s) => this.api.session.save(s) })
    this.state = 'prepared'
    return this.streams
  }

  /** Começa a codificar/gravar. */
  async start(): Promise<void> {
    if (this.state !== 'prepared' || !this.streams || !this.recorder || !this.config) throw new Error('engine não preparado')
    const { screen, cam, mic, video, systemAudioTrack } = this.streams
    const session = this.recorder.session
    try {
      await this.startMediabunny(screen, cam, mic, systemAudioTrack, video, session)
    } catch (e) {
      console.warn('WebCodecs/mediabunny falhou ao iniciar; usando fallback MediaRecorder', e)
      this.emit({ type: 'warning', message: 'Encoder de hardware indisponível — usando gravação de compatibilidade.' })
      await this.startFallback(screen, cam, mic, systemAudioTrack, session)
    }
    this.recorder.begin()
    // trilha do cursor no main (F6): mesmo instante do relógio de mídia; envio sem espera
    const src = this.config.source
    this.api.cursor.begin({ sessionId: session.id, width: video.width, height: video.height, source: { kind: src.kind, id: src.id, displayId: src.displayId } })
    this.state = 'recording'
    this.bytesTimer = setInterval(() => this.emit({ type: 'bytes', bytes: this.bytes, elapsedMs: this.recorder?.mediaTimeMs() ?? 0 }), 1000)
  }

  private async startMediabunny(screen: MediaStream, cam: MediaStream | null, mic: MediaStream | null, sys: MediaStreamTrack | null, video: VideoConfigChoice, session: Session): Promise<void> {
    this.handle = await this.api.session.writeOpen(session.id, 'rec.mp4')
    const handle = this.handle
    this.bytes = 0
    const writable = new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        this.bytes = Math.max(this.bytes, chunk.position + chunk.data.byteLength)
        await this.api.session.write(handle, chunk.data, chunk.position)
      }
    })
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: FRAGMENT_DURATION_SEC }),
      target: new StreamTarget(writable)
    })
    this.sources = []
    const screenSrc = new MediaStreamVideoTrackSource(screen.getVideoTracks()[0], {
      codec: 'avc',
      fullCodecString: video.fullCodecString,
      bitrate: video.bitrate,
      latencyMode: 'realtime',
      keyFrameInterval: KEYFRAME_INTERVAL_SEC,
      hardwareAcceleration: 'no-preference',
      sizeChangeBehavior: 'contain'
    })
    output.addVideoTrack(screenSrc, { frameRate: video.fps })
    this.sources.push({ name: 'tela', src: screenSrc })
    session.tracks = { screen: 0 }
    if (cam) {
      const camSrc = new MediaStreamVideoTrackSource(cam.getVideoTracks()[0], {
        codec: 'avc',
        bitrate: WEBCAM_BITRATE,
        latencyMode: 'realtime',
        keyFrameInterval: KEYFRAME_INTERVAL_SEC,
        hardwareAcceleration: 'no-preference',
        sizeChangeBehavior: 'contain'
      })
      output.addVideoTrack(camSrc, { frameRate: 30 })
      this.sources.push({ name: 'webcam', src: camSrc })
      session.tracks.webcam = 1
    }
    const audioCodec = (await aacSupported()) ? 'aac' : 'opus'
    let aIdx = 0
    if (mic) {
      const micSrc = new MediaStreamAudioTrackSource(mic.getAudioTracks()[0], { codec: audioCodec, bitrate: AUDIO_BITRATE })
      output.addAudioTrack(micSrc)
      this.sources.push({ name: 'microfone', src: micSrc })
      session.tracks.mic = aIdx++ as 0 | 1
    }
    if (sys) {
      const sysSrc = new MediaStreamAudioTrackSource(sys as MediaStreamAudioTrack, { codec: audioCodec, bitrate: AUDIO_BITRATE })
      output.addAudioTrack(sysSrc)
      this.sources.push({ name: 'sistema', src: sysSrc })
      session.tracks.system = aIdx++ as 0 | 1
    }
    for (const s of this.sources) {
      s.src.errorPromise.catch((e) => this.onSourceError(s.name, e))
    }
    await output.start()
    this.output = output
    session.engine = 'webcodecs'
    session.files = { rec: 'rec.mp4' }
  }

  private async startFallback(screen: MediaStream, cam: MediaStream | null, mic: MediaStream | null, sys: MediaStreamTrack | null, session: Session): Promise<void> {
    if (this.handle !== null) {
      await this.api.session.writeClose(this.handle).catch(() => {})
      this.handle = null
    }
    this.output = null
    this.sources = []
    this.fallback = new FallbackRecorder(this.api, session.id, { screen, cam, mic, sys }, (bytes) => (this.bytes = bytes))
    const files = await this.fallback.start()
    session.engine = 'mediarecorder'
    session.files = { rec: files.screen, fallback: files }
    session.tracks = { screen: 0, ...(cam ? { webcam: 1 as const } : {}), ...(mic ? { mic: 0 as const } : {}), ...(sys ? { system: (mic ? 1 : 0) as 0 | 1 } : {}) }
    this.emit({ type: 'fallback' })
  }

  private onSourceError(name: string, e: unknown): void {
    if (this.state === 'stopping' || this.state === 'stopped') return
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`fonte ${name} falhou`, e)
    // Encoder caiu no meio: encerramos preservando o que foi gravado (fMP4 é reproduzível até o último fragmento).
    this.emit({ type: 'error', message: `A gravação da faixa "${name}" falhou (${msg}). A gravação foi encerrada e o que já foi capturado está salvo.`, fatal: true })
    void this.stop().catch(() => {})
  }

  pause(): void {
    if (this.state !== 'recording' || !this.recorder) return
    for (const s of this.sources) s.src.pause()
    this.fallback?.pause()
    this.recorder.pause()
    this.api.cursor.pause()
    this.state = 'paused'
  }

  resume(): void {
    if (this.state !== 'paused' || !this.recorder) return
    for (const s of this.sources) s.src.resume()
    this.fallback?.resume()
    this.recorder.resume()
    this.api.cursor.resume()
    this.state = 'recording'
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted
    const t = this.streams?.mic?.getAudioTracks()[0]
    if (t) t.enabled = !muted
  }

  setCameraOn(on: boolean): void {
    this.camOn = on
    const t = this.streams?.cam?.getVideoTracks()[0]
    if (t) t.enabled = on
    // a PiP fica invisível no vídeo final quando a câmera está desligada
    const cur = this.recorder?.currentPip
    if (cur && this.recorder && (this.state === 'recording' || this.state === 'paused')) {
      this.recorder.addPipKeyframe({ x: cur.x, y: cur.y, w: cur.w, h: cur.h, shape: cur.shape, visible: on })
    }
  }

  addPipKeyframe(k: Omit<PipKeyframe, 'tMs'>): void {
    this.recorder?.addPipKeyframe(k)
  }

  get currentPip(): PipKeyframe | null {
    return this.recorder?.currentPip ?? null
  }

  mediaTimeMs(): number {
    return this.recorder?.mediaTimeMs() ?? 0
  }

  mediaTimeAt(wallMs: number): number {
    return this.recorder?.mediaTimeAt(wallMs) ?? 0
  }

  upsertStroke(s: Stroke): void {
    this.recorder?.upsertStroke(s)
  }

  undoLastStroke(): string | null {
    return this.recorder?.undoLastStroke() ?? null
  }

  clearStrokes(): void {
    this.recorder?.clearStrokes()
  }

  visibleStrokes(): Stroke[] {
    return this.recorder?.visibleStrokes() ?? []
  }

  addMarker(): void {
    this.recorder?.addMarker()
  }

  get bytesWritten(): number {
    return this.bytes
  }

  /** Encerra a gravação, fecha arquivos e streams. Retorna a sessão salva. */
  async stop(): Promise<Session> {
    if (!this.recorder) throw new Error('nada gravando')
    if (this.state === 'stopping' || this.state === 'stopped') return this.recorder.session
    this.state = 'stopping'
    if (this.bytesTimer) clearInterval(this.bytesTimer)
    this.bytesTimer = null
    // a trilha do cursor termina onde o vídeo termina (antes do finalize); o main grava o cursor.json
    const cursorSaved = this.api.cursor.stop(this.recorder.session.id).catch(() => false)
    try {
      if (this.output) {
        for (const s of this.sources) if ((s.src as MediaStreamVideoTrackSource).resume) s.src.resume()
        await this.output.finalize()
      }
      if (this.fallback) await this.fallback.stop()
    } catch (e) {
      console.error('finalize falhou', e)
      this.emit({ type: 'warning', message: `Falha ao finalizar o arquivo (${String(e)}); o conteúdo gravado foi preservado.` })
    } finally {
      if (this.handle !== null) {
        await this.api.session.writeClose(this.handle).catch(() => {})
        this.handle = null
      }
      this.stopStreams()
    }
    const session = this.recorder.stop()
    session.bytes = this.bytes
    await this.api.session.save(session)
    await cursorSaved
    this.state = 'stopped'
    this.output = null
    this.sources = []
    this.fallback = null
    this.emit({ type: 'stopped', session })
    return session
  }

  /** Descarta a sessão (arquivos para a lixeira). */
  async cancel(): Promise<void> {
    if (!this.recorder) {
      this.stopStreams()
      this.state = 'idle'
      return
    }
    const id = this.recorder.session.id
    this.api.cursor.discard(id)
    try {
      if (this.state === 'recording' || this.state === 'paused') {
        this.state = 'stopping'
        if (this.bytesTimer) clearInterval(this.bytesTimer)
        this.bytesTimer = null
        try {
          await this.output?.finalize()
          await this.fallback?.stop()
        } catch {
          /* descartando de qualquer forma */
        }
      }
    } finally {
      if (this.handle !== null) {
        await this.api.session.writeClose(this.handle).catch(() => {})
        this.handle = null
      }
      this.stopStreams()
      this.recorder.abort()
      await this.api.session.delete(id).catch(() => {})
      this.output = null
      this.sources = []
      this.fallback = null
      this.recorder = null
      this.state = 'idle'
    }
  }

  /** Solta os streams sem gravar (ex.: usuário fechou antes de gravar). */
  releasePrepared(): void {
    this.stopStreams()
    if (this.recorder && this.state === 'prepared') {
      const id = this.recorder.session.id
      void this.api.session.delete(id).catch(() => {})
      this.recorder = null
    }
    this.state = 'idle'
  }

  private stopStreams(): void {
    const s = this.streams
    if (!s) return
    for (const t of [...s.screen.getTracks(), ...(s.cam?.getTracks() ?? []), ...(s.mic?.getTracks() ?? [])]) {
      try {
        t.stop()
      } catch {
        /* já parada */
      }
    }
    this.streams = null
  }
}
