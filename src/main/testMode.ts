import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ExportOptions, ExportPresetId, RecordingConfig, Session } from '@shared/types'
import { DEFAULT_PIP } from '@shared/defaults'
import { PRESET_ORDER } from '@shared/presets/presets'
import type { SessionStore } from './session/sessionStore'
import { probeFile, runFfmpeg } from './export/ffmpegRunner'
import { probeEncoders } from './export/encoderProbe'
import { startExportJob } from './export/exportJob'
import { buildReviewAssets } from './export/reviewAssets'
import { preloadPath, loadPage } from './windows/recorderWindow'
import { log } from './log'

// Modo de teste de integração (CIALIGHT_TEST=ffmpeg|capture). Roda no Electron
// real com o ffmpeg embutido; escreve um relatório JSON em test-out/ e sai com
// código 0 (sucesso) ou 1 (falha). Chamado por `npm run test:ffmpeg|test:capture`.

const outDir = join(app.getAppPath(), 'test-out')

function ok(cond: boolean, msg: string, failures: string[]): void {
  if (!cond) failures.push(msg)
  console.log(`${cond ? 'OK ' : 'FAIL'} ${msg}`)
}

/** Verifica se o 'moov' vem antes do 'mdat' (faststart) lendo os primeiros MB. */
function isFastStart(file: string): boolean {
  const buf = readFileSync(file)
  const head = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024))
  const moov = head.indexOf('moov')
  const mdat = head.indexOf('mdat')
  return moov >= 0 && (mdat < 0 || moov < mdat)
}

async function makeSyntheticSession(store: SessionStore): Promise<Session> {
  const id = 'test-ffmpeg-session'
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
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
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

async function runExport(store: SessionStore, session: Session, presetId: ExportPresetId, extra: Partial<ExportOptions>, outFolder: string): Promise<{ outputs: string[]; error?: string; message?: string }> {
  const options: ExportOptions = {
    presetId,
    trimStartMs: 1000,
    trimEndMs: 9000,
    includeWebcam: false,
    includeAnnotations: false,
    audioMode: 'mix',
    micOffsetMs: 0,
    targetSizeMB: null,
    reels: false,
    outputDir: outFolder,
    fileName: `teste-${presetId}`,
    pipOverride: null,
    ...extra
  }
  return new Promise((resolve) => {
    startExportJob({ sessionId: session.id, options, composedFile: null }, store, (p) => {
      if (p.stage === 'done') resolve({ outputs: p.outputs ?? [], message: p.message })
      else if (p.stage === 'error' || p.stage === 'cancelled') resolve({ outputs: [], error: p.error ?? p.stage })
    })
  })
}

async function testFfmpeg(store: SessionStore): Promise<number> {
  const failures: string[] = []
  mkdirSync(outDir, { recursive: true })
  const probe = await probeEncoders(true)
  console.log('encoders:', JSON.stringify(probe))
  ok(probe.available.includes('libx264'), 'libx264 disponível', failures)
  const session = await makeSyntheticSession(store)
  const dir = store.dirOf(session.id)
  const p0 = await probeFile(join(dir, 'rec.mp4'))
  ok(p0.streams.length === 4, `rec.mp4 sintético tem 4 faixas (${p0.streams.length})`, failures)

  const assets = await buildReviewAssets(session, dir)
  ok(existsSync(assets.proxy), 'preview.mp4 gerado', failures)
  ok(!!assets.webcam && existsSync(assets.webcam), 'webcam.mp4 gerado', failures)
  ok(assets.thumbs.length >= 5, `miniaturas geradas (${assets.thumbs.length})`, failures)
  ok(!!assets.waveform && existsSync(assets.waveform), 'wave.png gerado', failures)
  ok(assets.keyframesSec.length >= 5, `keyframes lidos (${assets.keyframesSec.length})`, failures)
  const pp = await probeFile(assets.proxy)
  ok(pp.streams.filter((s) => s.type === 'audio').length === 1 && pp.streams.filter((s) => s.type === 'video').length === 1, 'proxy: 1 vídeo + 1 áudio mixado', failures)

  const exportsDir = join(outDir, 'exports')
  mkdirSync(exportsDir, { recursive: true })
  const results: Record<string, unknown> = {}
  for (const presetId of PRESET_ORDER) {
    const extra: Partial<ExportOptions> = presetId === 'small' ? { targetSizeMB: 20 } : presetId === 'separate' ? { audioMode: 'separate' } : {}
    const t0 = Date.now()
    const r = await runExport(store, session, presetId, extra, exportsDir)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    ok(!r.error, `preset ${presetId} exportou (${secs}s)${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`, failures)
    const info: Record<string, unknown>[] = []
    for (const f of r.outputs) {
      if (!existsSync(f)) {
        ok(false, `${presetId}: saída ${f} existe`, failures)
        continue
      }
      const size = statSync(f).size
      const pr = f.endsWith('.wav') ? null : await probeFile(f)
      const v = pr?.streams.find((s) => s.type === 'video')
      const a = pr?.streams.filter((s) => s.type === 'audio') ?? []
      info.push({ file: f, sizeMB: +(size / 1048576).toFixed(2), durationMs: pr?.durationMs, video: v ? { codec: v.codec, profile: v.profile, w: v.width, h: v.height, fps: v.fps } : null, audio: a.map((x) => ({ codec: x.codec, ch: x.channels })) })
      if (f.endsWith('.mp4')) {
        ok(isFastStart(f), `${presetId}: ${f.split(/[\\/]/).pop()} tem faststart`, failures)
        ok(!!pr && Math.abs(pr.durationMs - 8000) < 700, `${presetId}: duração ≈ 8 s (${pr?.durationMs} ms)`, failures)
        if (v && presetId !== 'cutOnly' && presetId !== 'separate') ok(v.codec === 'h264' && ['High', 'Main', 'Constrained Baseline', 'Baseline'].includes(v.profile ?? ''), `${presetId}: h264 ${v.profile}`, failures)
        if (presetId === 'small') {
          ok((v?.height ?? 0) <= 720, `small: altura ≤ 720 (${v?.height})`, failures)
          ok(v?.profile === 'Main', `small: perfil Main (${v?.profile})`, failures)
          ok(size <= 20 * 1048576, `small: tamanho ≤ 20 MB (${(size / 1048576).toFixed(2)} MB)`, failures)
        }
      }
    }
    if (presetId === 'separate') ok(r.outputs.length >= 5, `separate: ≥5 arquivos (${r.outputs.length})`, failures)
    results[presetId] = { ...r, info }
  }
  writeFileSync(join(outDir, 'ffmpeg-report.json'), JSON.stringify({ probe, results, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTODOS OS TESTES DE FFMPEG PASSARAM')
  return failures.length ? 1 : 0
}

async function testCapture(): Promise<number> {
  mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=recorder'] } })
  const result = await new Promise<{ ok: boolean; report: unknown }>((resolve) => {
    ipcMain.once('test:result', (_e, r: { ok: boolean; report: unknown }) => resolve(r))
    setTimeout(() => resolve({ ok: false, report: 'timeout de 90 s' }), 90_000)
    loadPage(win, 'index.html?test=capture')
  })
  writeFileSync(join(outDir, 'capture-report.json'), JSON.stringify(result, null, 2))
  console.log(result.ok ? 'TESTE DE CAPTURA PASSOU' : `TESTE DE CAPTURA FALHOU: ${JSON.stringify(result.report).slice(0, 2000)}`)
  return result.ok ? 0 : 1
}

export async function runIntegrationTest(mode: string, store: SessionStore): Promise<void> {
  let code = 1
  try {
    if (mode === 'ffmpeg') code = await testFfmpeg(store)
    else if (mode === 'capture') code = await testCapture()
    else console.error(`modo de teste desconhecido: ${mode}`)
  } catch (e) {
    console.error('teste falhou com exceção:', e)
    log.error('teste falhou', e)
  }
  app.exit(code)
}
