// Sequência automática do spike (renderer). Ver docs/superpowers/plans/2026-08-18-fase0-scaffold-spike.md Task 3.
import { Output, Mp4OutputFormat, StreamTarget, MediaStreamVideoTrackSource, MediaStreamAudioTrackSource, type StreamTargetChunk } from 'mediabunny'

export type Logger = (msg: string) => void

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface SpikeReport {
  gestureTests: Record<string, string>
  screenSettings?: MediaTrackSettings
  systemAudioSettings?: MediaTrackSettings | null
  camSettings?: MediaTrackSettings | null
  micSettings?: MediaTrackSettings | null
  encoderConfigs: Record<string, unknown>
  bytesTimeline: { t: number; bytes: number }[]
  cpuSamples: unknown[]
  errors: string[]
  timings: Record<string, number>
}

const report: SpikeReport = { gestureTests: {}, encoderConfigs: {}, bytesTimeline: [], cpuSamples: [], errors: [], timings: {} }

export function getReport(): SpikeReport {
  return report
}

function isTransientActivationError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'InvalidStateError' || /transient activation|user gesture/i.test(e.message))
}

// Teste A: getDisplayMedia sem gesto de usuário funciona? (só abre e fecha o stream)
export async function testDisplayMediaGesture(label: string, log: Logger, chooseFirstScreen: () => Promise<void>): Promise<boolean> {
  await chooseFirstScreen()
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5 } }, audio: false })
    s.getTracks().forEach((t) => t.stop())
    report.gestureTests[label] = 'OK'
    log(`[A:${label}] getDisplayMedia OK`)
    return true
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    report.gestureTests[label] = `ERRO ${msg}${isTransientActivationError(e) ? ' (transient activation)' : ''}`
    log(`[A:${label}] getDisplayMedia falhou: ${msg}`)
    return false
  }
}

export interface RunOptions {
  log: Logger
  chooseScreen: (wantAudio: boolean) => Promise<void>
  onPreview?: (screen: MediaStream, cam: MediaStream | null) => void
}

// Sequência principal: 15 s de gravação (pausa 5→8 s) em 4 faixas fMP4.
export async function runRecordingSpike(opts: RunOptions): Promise<void> {
  const { log } = opts
  const api = window.spikeApi
  const t0 = performance.now()
  const mark = (k: string): void => {
    report.timings[k] = Math.round(performance.now() - t0)
  }

  const q = new URLSearchParams(location.search)
  const fps = Number(q.get('fps') ?? 30)
  const secs = Number(q.get('secs') ?? 15)
  // Suporte a encoder de hardware/software (WebCodecs)
  for (const [label, w, h, f] of [['1080p30', 1920, 1080, 30], ['1080p60', 1920, 1080, 60], ['1440p30', 2560, 1440, 30], ['720p30', 1280, 720, 30]] as const) {
    for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
      const r = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: w, height: h, framerate: f, bitrate: 12e6, hardwareAcceleration: hw, latencyMode: 'realtime' })
      report.encoderConfigs[`support:${label}:${hw}`] = r.supported
      log(`isConfigSupported ${label} ${hw}: ${r.supported}`)
    }
  }
  await opts.chooseScreen(true)
  log(`getDisplayMedia (tela 1080p${fps} + loopback), ${secs} s...`)
  const screen = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: fps } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints
  })
  mark('displayMedia')
  const screenTrack = screen.getVideoTracks()[0]
  const sysTrack = screen.getAudioTracks()[0] ?? null
  report.screenSettings = screenTrack.getSettings()
  report.systemAudioSettings = sysTrack ? sysTrack.getSettings() : null
  log(`tela: ${JSON.stringify(report.screenSettings)}`)
  log(`áudio do sistema: ${sysTrack ? JSON.stringify(report.systemAudioSettings) : 'AUSENTE'}`)

  let cam: MediaStream | null = null
  try {
    cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
    report.camSettings = cam.getVideoTracks()[0].getSettings()
    log(`câmera: ${JSON.stringify(report.camSettings)}`)
  } catch (e) {
    report.camSettings = null
    report.errors.push(`câmera: ${String(e)}`)
    log(`câmera indisponível: ${String(e)}`)
  }
  let mic: MediaStream | null = null
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } })
    report.micSettings = mic.getAudioTracks()[0].getSettings()
    log(`mic: ${JSON.stringify(report.micSettings)}`)
  } catch (e) {
    report.micSettings = null
    report.errors.push(`mic: ${String(e)}`)
    log(`mic indisponível: ${String(e)}`)
  }
  mark('devices')
  opts.onPreview?.(screen, cam)

  // Teste B: proteção da janela
  await api.protect(true)
  await sleep(700)
  await api.captureThumb('protected.png')
  await api.protect(false)
  await sleep(700)
  await api.captureThumb('unprotected.png')
  await api.protect(true)
  mark('thumbs')

  // mediabunny
  const handle = await api.openWrite('rec.mp4')
  let bytes = 0
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      bytes = Math.max(bytes, chunk.position + chunk.data.byteLength)
      await api.write(handle, chunk.data, chunk.position)
    }
  })
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }), target: new StreamTarget(writable) })
  const sources: { name: string; src: MediaStreamVideoTrackSource | MediaStreamAudioTrackSource }[] = []

  const screenSrc = new MediaStreamVideoTrackSource(screenTrack, {
    codec: 'avc',
    bitrate: 12e6,
    latencyMode: 'realtime',
    keyFrameInterval: 1,
    hardwareAcceleration: 'no-preference',
    onEncoderConfig: (c) => {
      report.encoderConfigs.screen = c
      log(`encoder tela: ${JSON.stringify(c)}`)
    }
  })
  output.addVideoTrack(screenSrc, { frameRate: fps })
  sources.push({ name: 'screen', src: screenSrc })

  if (cam) {
    const camSrc = new MediaStreamVideoTrackSource(cam.getVideoTracks()[0], {
      codec: 'avc',
      bitrate: 5e6,
      latencyMode: 'realtime',
      keyFrameInterval: 1,
      hardwareAcceleration: 'no-preference',
      onEncoderConfig: (c) => {
        report.encoderConfigs.webcam = c
        log(`encoder webcam: ${JSON.stringify(c)}`)
      }
    })
    output.addVideoTrack(camSrc, { frameRate: 30 })
    sources.push({ name: 'webcam', src: camSrc })
  }
  const aacOk = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported
  log(`AAC suportado: ${aacOk}`)
  const audioCodec = aacOk ? 'aac' : 'opus'
  if (mic) {
    const micSrc = new MediaStreamAudioTrackSource(mic.getAudioTracks()[0], { codec: audioCodec, bitrate: 160e3 })
    output.addAudioTrack(micSrc)
    sources.push({ name: 'mic', src: micSrc })
  }
  if (sysTrack) {
    const sysSrc = new MediaStreamAudioTrackSource(sysTrack, { codec: audioCodec, bitrate: 160e3 })
    output.addAudioTrack(sysSrc)
    sources.push({ name: 'system', src: sysSrc })
  }
  for (const s of sources) s.src.errorPromise.catch((e) => {
    report.errors.push(`${s.name}: ${String(e)}`)
    log(`ERRO fonte ${s.name}: ${String(e)}`)
  })

  await output.start()
  mark('outputStart')
  log('gravando 15 s (pausa 5→8 s)...')
  const startWall = performance.now()
  const sampler = setInterval(() => {
    const t = Math.round((performance.now() - startWall) / 1000)
    report.bytesTimeline.push({ t, bytes })
    void api.cpu().then((m) => report.cpuSamples.push({ t, m }))
  }, 1000)

  // sons do sistema (processo externo) em t=2 s e t=9 s
  setTimeout(() => void api.playSound(), 2000)
  setTimeout(() => void api.playSound(), 9000)

  await sleep(5000)
  for (const s of sources) s.src.pause()
  log('pausado')
  await sleep(3000)
  for (const s of sources) s.src.resume()
  log('retomado')

  // Teste E: overlay interativa recebe clique físico; click-through não
  setTimeout(async () => {
    await api.setOverlayInteractive(true)
    await sleep(300)
    await api.osClickOverlay()
    await sleep(500)
    await api.setOverlayInteractive(false)
    await sleep(300)
    await api.osClickOverlay()
  }, 1500)

  // Teste F: atalho global com Notepad em foco
  setTimeout(() => void api.testHotkeyNotepad(), 4500)

  await sleep(Math.max(1000, (secs - 8) * 1000))
  clearInterval(sampler)
  log('finalizando...')
  await output.finalize()
  mark('finalize')
  await api.closeWrite(handle)
  screen.getTracks().forEach((t) => t.stop())
  cam?.getTracks().forEach((t) => t.stop())
  mic?.getTracks().forEach((t) => t.stop())
  await api.protect(false)
  log(`bytes gravados: ${bytes}`)
}
