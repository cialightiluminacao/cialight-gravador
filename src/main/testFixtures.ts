import { existsSync, readFileSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import type { RecordingConfig, Session } from '@shared/types'
import { DEFAULT_PIP } from '@shared/defaults'
import type { SessionStore } from './session/sessionStore'
import { probeFile, runFfmpeg } from './export/ffmpegRunner'

// Utilitários dos testes de integração (CIALIGHT_TEST=…): fixtures geradas pelo ffmpeg embutido.

/** Verifica se o 'moov' vem antes do 'mdat' (faststart) lendo os primeiros MB. */
export function isFastStart(file: string): boolean {
  const buf = readFileSync(file)
  const head = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024))
  const moov = head.indexOf('moov')
  const mdat = head.indexOf('mdat')
  return moov >= 0 && (mdat < 0 || moov < mdat)
}

/** Sessão v1 sintética de 12 s (rec.mp4 com v0 tela, v1 webcam, a0 mic, a1 sistema + session.json). */
export async function makeSyntheticSession(store: SessionStore, id: string): Promise<Session> {
  const cfg: RecordingConfig = {
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1' },
    quality: '1080p',
    fps: 30,
    countdownSec: 0,
    webcam: { deviceId: 'x', label: 'Cam', mirrored: true },
    mic: { deviceId: 'y', label: 'Mic', echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    systemAudio: true,
    pipInitial: DEFAULT_PIP
  }
  const { dir, session } = store.create(cfg, id, { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1.640028', bitrate: 12e6 } })
  const rec = join(dir, 'rec.mp4')
  // 12 s: tela testsrc2 1080p30, webcam testsrc 720p30, mic seno 440 Hz, sistema seno 880 Hz
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '12', '-map', '0:v', '-map', '1:v', '-map', '2:a', '-map', '3:a',
    // marcado como BT.601, como as gravações reais (VideoEncoder do Chromium)
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-progress', 'pipe:1', '-nostats', rec
  ], { label: 'sintético' })
  session.tracks = { screen: 0, webcam: 1, mic: 0, system: 1 }
  session.webcam!.width = 1280
  session.webcam!.height = 720
  session.state = 'stopped'
  session.durationMs = 12000
  session.strokes = [{ id: 's1', tMs: 2000, tool: 'arrow', points: [{ x: 0.2, y: 0.2, tMs: 2000 }, { x: 0.5, y: 0.5, tMs: 2400 }], color: '#ff3b30', width: 6 }]
  session.pip = [DEFAULT_PIP, { ...DEFAULT_PIP, tMs: 5000, x: 0.05, y: 0.05 }]
  store.save(session)
  return session
}

// ---- voz sintética (redução de ruído / normalização) ----

const VOICE_TEXT = 'Olá, este é um teste de redução de ruído. A voz deve continuar clara depois do processamento.'

/** Voz do Windows (System.Speech, pt-BR se houver) em WAV mono 48 kHz; false se indisponível. */
function windowsTts(out: string): boolean {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1",
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', $f)`,
    `$s.Speak('${VOICE_TEXT}')`,
    '$s.Dispose()'
  ].join('; ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60_000 })
    return existsSync(out) && statSync(out).size > 48_000 * 2
  } catch {
    return false
  }
}

export interface VoiceFixture {
  /** WAV mono 48 kHz. */
  file: string
  /** 'tts' = voz do Windows; 'harmonic' = "vogal" harmônica em sílabas (o RNNoise trata tom puro como ruído). */
  kind: 'tts' | 'harmonic'
  durS: number
  /** Trecho só com fala e pausas só com silêncio (s). */
  speech: [number, number]
  pauses: [number, number][]
}

/** Voz sintética com pausas conhecidas: 1 s antes e 2 s depois da fala (harmônica: fala em 1–3 s e 5–7 s de 9 s). */
export async function makeVoiceFixture(dir: string, name: string): Promise<VoiceFixture> {
  const gen = (args: string[], label: string): Promise<unknown> => runFfmpeg(['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats'], { label })
  const tts = join(dir, `${name}-tts.wav`)
  const file = join(dir, `${name}.wav`)
  if (windowsTts(tts)) {
    await gen(['-i', tts, '-af', 'adelay=1000,apad=pad_dur=2', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file], 'voz: pausas')
    const durS = (await probeFile(file)).durationMs / 1000
    return { file, kind: 'tts', durS, speech: [1.3, durS - 2.5], pauses: [[0.1, 0.9], [durS - 1.8, durS - 0.1]] }
  }
  const v = '0.3*(0.6+0.4*sin(2*PI*4*t))*(sin(2*PI*220*t)+0.5*sin(4*PI*220*t)+0.25*sin(6*PI*220*t))*(between(t,1,3)+between(t,5,7))'
  await gen(['-f', 'lavfi', '-i', `aevalsrc='${v}':s=48000:d=9`, '-c:a', 'pcm_s16le', file], 'voz harmônica')
  return { file, kind: 'harmonic', durS: 9, speech: [1.2, 2.8], pauses: [[0.1, 0.9], [3.4, 4.6]] }
}

/** Atraso (amostras) de `b` em relação a `a` pela correlação cruzada em ±maxLag (amostras de `a` a cada `stride`). */
export function crossCorrelationLag(a: ArrayLike<number>, b: ArrayLike<number>, maxLag = 2000, stride = 2): number {
  let best = -Infinity
  let lag = 0
  const n = Math.min(a.length, b.length) - maxLag
  for (let l = -maxLag; l <= maxLag; l++) {
    let s = 0
    for (let i = maxLag; i < n; i += stride) s += a[i] * b[i + l]
    if (s > best) {
      best = s
      lag = l
    }
  }
  return lag
}
