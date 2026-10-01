import { readFileSync } from 'fs'
import { join } from 'path'
import type { RecordingConfig, Session } from '@shared/types'
import { DEFAULT_PIP } from '@shared/defaults'
import type { SessionStore } from './session/sessionStore'
import { runFfmpeg } from './export/ffmpegRunner'

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
