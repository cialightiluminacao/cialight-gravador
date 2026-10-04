import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { ExportOptions, ExportPresetId, Session } from '@shared/types'
import { PRESET_ORDER } from '@shared/presets/presets'
import type { SessionStore } from './session/sessionStore'
import { probeFile, probeKeyframes, runFfmpeg } from './export/ffmpegRunner'
import type { Asset } from '@shared/editor/project'
import type { HwEncoder } from '@shared/types'
import { createEmptyProject } from '@shared/editor/factory'
import { ProjectStore } from './project/projectStore'
import { probe, type MediaInfo } from './media/probe'
import { needsProxy } from './media/proxyPolicy'
import { IngestQueue, assetFromInfo, type IngestJob } from './media/ingest'
import { buildLoudness, buildSpeech } from './media/analysis'
import { speechFromFile, type SpeechFile } from '@shared/editor/speech'
import { cachedEncoderProbe, probeEncoders } from './export/encoderProbe'
import { getSettings } from './settings/settingsStore'
import { startExportJob } from './export/exportJob'
import { buildReviewAssets } from './export/reviewAssets'
import { preloadPath, loadPage } from './windows/recorderWindow'
import { log } from './log'
import { testEditorRender } from './editorTestMode'
import { testEditorExport } from './editorExportTestMode'
import { testEditorFormats } from './editorFormatsTestMode'
import { testTranscribe } from './transcribeTestMode'
import { checkFolderImports } from './transcribe/peImports'
import { crossCorrelationLag, isFastStart, makeSyntheticSession, makeVoiceFixture } from './testFixtures'
import { rnnoiseDir, whisperCliPath, whisperDir } from './export/ffmpegPath'
import { DENOISE_DELAY_SAMPLES, processAudioFile } from './media/audioProcess'
import { DENOISE_MODEL } from '@shared/editor/audioProcess'
import { tmpdir } from 'os'
import { SessionSchema, parseSession } from '@shared/schemas'
import { sessionCursorRef, sessionDirFor } from './cursor/cursorTrackFile'
import { CURSOR_FILE, type CursorTrackV1 } from '@shared/cursor'
import { parseProject, toDiskProject } from '@shared/editor/schema'
import { parseProjectV13 } from '@shared/__fixtures__/projectSchemaV13'
import { checkCursorAfterRecording, checkCursorRealSourceAndOverhead, installCursorTest } from './cursor/cursorTestChecks'

// Modo de teste de integração (CIALIGHT_TEST=ffmpeg|capture|ingest|editor-render|editor-export|models|transcribe). Roda no Electron
// real com o ffmpeg embutido; escreve um relatório JSON em test-out/ e sai com
// código 0 (sucesso) ou 1 (falha). Chamado por `npm run test:ffmpeg|test:capture|test:ingest|test:editor`.

const outDir = join(app.getAppPath(), 'test-out')

function ok(cond: boolean, msg: string, failures: string[]): void {
  if (!cond) failures.push(msg)
  console.log(`${cond ? 'OK ' : 'FAIL'} ${msg}`)
}

async function runExport(store: SessionStore, session: Session, presetId: ExportPresetId, extra: Partial<ExportOptions>, outFolder: string, override: { encoder?: HwEncoder } = {}): Promise<{ outputs: string[]; error?: string; message?: string; messages: string[] }> {
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
  const messages: string[] = []
  return new Promise((resolve) => {
    startExportJob({ sessionId: session.id, options, composedFile: null }, store, (p) => {
      if (p.message && !messages.includes(p.message)) messages.push(p.message)
      if (p.stage === 'done') resolve({ outputs: p.outputs ?? [], message: p.message, messages })
      else if (p.stage === 'error' || p.stage === 'cancelled') resolve({ outputs: [], error: p.error ?? p.stage, messages })
    }, override)
  })
}

/**
 * test:ffmpeg força o probe de encoders, que grava o cache (lastEncoderProbe/encoderProbeV2) no settings.json do
 * usuário — a mesma pasta userData do app instalado. Guarda os bytes antes e devolve no fim (sempre, mesmo com falha).
 */
async function testFfmpeg(store: SessionStore): Promise<number> {
  const file = join(app.getPath('userData'), 'settings.json')
  const before = existsSync(file) ? readFileSync(file) : null
  try {
    return await testFfmpegRun(store)
  } finally {
    const now = existsSync(file) ? readFileSync(file) : null
    // não existia antes: o arquivo criado pelo probe sai (o app instalado volta ao padrão)
    if (!before && now) {
      rmSync(file, { force: true })
      console.log('settings.json criado pelo probe de encoders removido (não existia antes do teste)')
    }
    if (before && (!now || !now.equals(before))) {
      writeFileSync(file, before)
      console.log('settings.json restaurado (o probe de encoders tinha atualizado o cache)')
    }
    console.log(`settings.json do usuário ${before ? (readFileSync(file).equals(before) ? 'igual ao de antes' : 'DIFERENTE') : existsSync(file) ? 'DIFERENTE (não existia)' : 'inexistente, como antes'}`)
  }
}

async function testFfmpegRun(store: SessionStore): Promise<number> {
  const failures: string[] = []
  mkdirSync(outDir, { recursive: true })
  const probe = await probeEncoders(true)
  console.log('encoders:', JSON.stringify(probe))
  ok(probe.available.includes('libx264'), 'libx264 disponível', failures)
  const session = await makeSyntheticSession(store, 'test-ffmpeg-session')
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
  // encoder que falha na hora (aqui: AMF forçado; numa máquina sem AMD ele não abre) → a exportação v1 troca
  // para o próximo da cadeia e termina, em vez de mostrar erro
  if (!probe.available.includes('h264_amf')) {
    const r = await runExport(store, session, 'high', { fileName: 'teste-fallback-encoder' }, exportsDir, { encoder: 'h264_amf' })
    const fellBack = r.messages.find((m) => m.includes('h264_amf falhou'))
    ok(!r.error && r.outputs.length === 1 && existsSync(r.outputs[0]), `fallback de encoder: AMF forçado falha e a exportação termina com outro (${fellBack ?? r.error?.split('\n')[0] ?? 'sem troca'})`, failures)
    ok(!!fellBack, 'fallback de encoder: aviso de troca de codificador emitido', failures)
    if (r.outputs[0] && existsSync(r.outputs[0])) {
      const v = (await probeFile(r.outputs[0])).streams.find((s) => s.type === 'video')
      ok(v?.codec === 'h264', `fallback de encoder: saída H.264 (${v?.codec})`, failures)
    }
    results.fallback = r
  } else console.log('fallback de encoder: AMF disponível nesta máquina — teste de falha forçada pulado')
  writeFileSync(join(outDir, 'ffmpeg-report.json'), JSON.stringify({ probe, results, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTODOS OS TESTES DE FFMPEG PASSARAM')
  return failures.length ? 1 : 0
}

async function testCapture(store: SessionStore): Promise<number> {
  mkdirSync(outDir, { recursive: true })
  const failures: string[] = []
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { preload: preloadPath(), sandbox: false, backgroundThrottling: false, additionalArguments: ['--cialight-window=recorder'] } })
  // trilha do cursor (F6): primeiro a fonte real (binding nativo, custo de CPU), depois a sintética para a gravação
  const okc = (cond: boolean, msg: string): void => ok(cond, msg, failures)
  const cursorReport: Record<string, unknown> = {}
  cursorReport.real = await checkCursorRealSourceAndOverhead(win, outDir, okc)
  const cursorSt = installCursorTest(ipcMain)
  // a janela do teste fica por cima: o "flash" dela mede o alinhamento relógio × PTS no vídeo do monitor principal
  win.setAlwaysOnTop(true)
  const result = await new Promise<{ ok: boolean; report: Record<string, unknown> }>((resolve) => {
    ipcMain.once('test:result', (_e, r: { ok: boolean; report: Record<string, unknown> }) => resolve(r))
    setTimeout(() => resolve({ ok: false, report: { errors: ['timeout de 90 s'] } }), 90_000)
    loadPage(win, 'index.html?test=capture')
  })
  ok(result.ok, `engine concluiu sem exceção (${JSON.stringify(result.report.errors ?? [])})`, failures)
  const session = result.report.session as Session | undefined
  if (session) {
    const rec = join(store.dirOf(session.id), session.files.rec)
    ok(existsSync(rec), 'rec.mp4 existe', failures)
    const p = await probeFile(rec)
    const videos = p.streams.filter((s) => s.type === 'video')
    const audios = p.streams.filter((s) => s.type === 'audio')
    const expectV = 1 + (session.tracks.webcam !== undefined ? 1 : 0)
    const expectA = (session.tracks.mic !== undefined ? 1 : 0) + (session.tracks.system !== undefined ? 1 : 0)
    ok(videos.length === expectV, `faixas de vídeo: ${videos.length} (esperado ${expectV})`, failures)
    ok(audios.length === expectA, `faixas de áudio: ${audios.length} (esperado ${expectA})`, failures)
    ok(videos[0]?.codec === 'h264', `tela em h264 (${videos[0]?.codec})`, failures)
    // 9 s de teste com 2 s de pausa → ~7 s de mídia (tolerância 0,8 s)
    ok(Math.abs(p.durationMs - 7000) < 800, `duração ≈ 7 s (${p.durationMs} ms)`, failures)
    for (const s of p.streams) ok(s.durationMs === undefined || Math.abs(s.durationMs - p.durationMs) < 500, `faixa ${s.index} (${s.type}) com duração coerente (${s.durationMs} ms)`, failures)
    ok((session.durationMs ?? 0) > 6200 && (session.durationMs ?? 0) < 7800, `session.durationMs coerente (${session.durationMs})`, failures)
    ok(session.pauses.length === 1, `1 pausa registrada (${session.pauses.length})`, failures)
    ok(session.pip.length >= 2, `keyframes de PiP registrados (${session.pip.length})`, failures)
    ok(session.strokes.length === 1, 'traço registrado', failures)
    ok(session.state === 'stopped', `estado stopped (${session.state})`, failures)
    const j = JSON.parse(readFileSync(join(store.dirOf(session.id), 'session.json'), 'utf8')) as Session
    ok(j.state === 'stopped' && j.durationMs === session.durationMs, 'session.json persistido', failures)
    // F6: a trilha do cursor fica em cursor.json; o session.json continua com o mesmo esquema e as mesmas chaves
    let parsedOk = true
    try {
      parseSession(j)
    } catch {
      parsedOk = false
    }
    ok(parsedOk && SessionSchema.strict().safeParse(j).success, 'session.json passa no SessionSchema inalterado (sem chaves desconhecidas)', failures)
    const expectedKeys = ['version', 'id', 'createdAt', 'state', 'source', 'video', 'systemAudio', 'tracks', 'pauses', 'pip', 'strokes', 'clearEvents', 'markers', 'engine', 'files', 'durationMs', 'bytes', ...(session.webcam ? ['webcam'] : []), ...(session.mic ? ['mic'] : [])].sort()
    ok(JSON.stringify(Object.keys(j).sort()) === JSON.stringify(expectedKeys), `session.json com as mesmas chaves de antes (${Object.keys(j).sort().join(',')})`, failures)
    const sv = videos[0]
    cursorReport.recording = await checkCursorAfterRecording(
      {
        st: cursorSt,
        sessionDir: store.dirOf(session.id),
        rec,
        video: { width: sv?.width ?? 0, height: sv?.height ?? 0, durationMs: sv?.durationMs ?? p.durationMs, fps: sv?.fps ?? session.video.fps },
        rendererClicks: (result.report.cursorClicks as { x: number; y: number; rendererMediaMs: number; mainMediaMs: number | null }[] | undefined) ?? [],
        flashes: (result.report.flashes as { mediaMs: number; color: 'green' | 'black'; wallMs: number }[] | undefined) ?? [],
        flashPaints: (result.report.flashPaints as { id: string; renderTime: number }[] | undefined) ?? [],
        clockVsPts: (result.report.clockVsPts as { clockStartMs: number | null; firstMediaMs: number | null } | undefined) ?? null,
        win
      },
      okc
    )
    ok(((result.report.cursorClicks as unknown[] | undefined) ?? []).length === 1, 'cursor: renderer injetou 1 clique sintético', failures)
    // E2E do editor (scripts/qa/editor-e2e.mjs) reaproveita a gravação: CIALIGHT_CAPTURE_KEEP=1 não apaga
    if (!process.env.CIALIGHT_CAPTURE_KEEP) await store.delete(session.id).catch(() => {})
  }
  writeFileSync(join(outDir, 'capture-report.json'), JSON.stringify({ result, cursor: cursorReport, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DE CAPTURA PASSOU')
  return failures.length ? 1 : 0
}

// ---- ingestão (CIALIGHT_TEST=ingest) ----
// Mídia sintética em test-out/ingest/ e projeto em test-out/ingest/Projetos. Não grava settings.json
// (o app instalado divide a pasta userData): só lê o cache de encoders, e o teste confere o hash.

function settingsHash(): string | null {
  const f = join(app.getPath('userData'), 'settings.json')
  return existsSync(f) ? createHash('sha1').update(readFileSync(f)).digest('hex') : null
}

/** Resolve quando o asset terminar ('done') ou rejeita após o tempo limite. */
function waitDone(queue: IngestQueue, projectId: string, assetId: string, timeoutMs = 120_000): Promise<Partial<Asset>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando ${assetId}`)), timeoutMs)
    queue.on('done', (pid, aid, patch) => {
      if (pid !== projectId || aid !== assetId) return
      clearTimeout(t)
      resolve(patch)
    })
  })
}

/** Intervalos entre keyframes, em quadros a `fps`. */
function keyIntervals(times: number[], fps: number): number[] {
  const out: number[] = []
  for (let i = 1; i < times.length; i++) out.push(Math.round((times[i] - times[i - 1]) * fps))
  return out
}

const uniq = (xs: number[]): string => [...new Set(xs)].join(',')

type Decodable = { video: boolean; audio: boolean }
let decodeRuns = 0

/**
 * `decodable` de vídeo/áudio com o WebCodecs real (janela oculta, rota #decode-test). Os arquivos são copiados
 * para uma "sessão" de fixtures em <brutos>/ingest-decode-fixtures e servidos por cialight-file://.
 */
async function decodeInRenderer(store: SessionStore, files: { name: string; path: string; kind: 'video' | 'audio' }[]): Promise<{ results: Record<string, Decodable>; errors: string[] }> {
  const sid = `ingest-decode-fixtures-${++decodeRuns}`
  const sdir = store.dirOf(sid)
  try {
    rmSync(sdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    log.warn('fixtures de decodificação antigas não removidas', e)
  }
  mkdirSync(sdir, { recursive: true })
  const items = files.map((f) => {
    const name = basename(f.path)
    copyFileSync(f.path, join(sdir, name))
    return { name: f.name, kind: f.kind, url: `cialight-file://${sid}/${encodeURIComponent(name)}` }
  })
  // a janela fica aberta até o fim do teste (app.exit): fechar a última janela encerraria o app no meio
  const win = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { preload: preloadPath(), sandbox: false, additionalArguments: ['--cialight-window=recorder'] } })
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ results: {}, errors: ['timeout de 30 s no harness de decodificação'] }), 30_000)
    ipcMain.once('test:result', (_e, r: { results: Record<string, Decodable>; errors: string[] }) => {
      clearTimeout(timer)
      resolve(r)
    })
    loadPage(win, `index.html#decode-test/${encodeURIComponent(JSON.stringify({ items }))}`)
  })
}

// ---- redução de ruído e normalização (parte do CIALIGHT_TEST=ingest) ----

/** Média RMS (dBFS, volumedetect) de [from, to) s do 1º stream de áudio. */
async function meanDb(file: string, fromS: number, toS: number): Promise<number> {
  const r = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', `atrim=${fromS}:${toS},volumedetect`, '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'], { label: 'volumedetect' })
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderrTail)
  return m ? (m[1] === '-inf' ? -120 : Number(m[1])) : NaN
}

/** PCM mono s16 48 kHz do 1º stream de áudio, decodificado pelo ffmpeg. */
async function pcmMono(file: string, raw: string): Promise<Int16Array> {
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-progress', 'pipe:1', '-nostats', raw], { label: 'pcm' })
  const b = readFileSync(raw)
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~1)))
}

type MkAsset = (id: string, path: string, info: MediaInfo, decodable?: boolean) => Asset

/**
 * Voz sintética + ruído branco a −30 dBFS: o denoise derruba o ruído nas pausas em ≥ 10 dB (mantendo a voz, com a
 * do Windows); a normalização leva −30 LUFS a −16 ±1 (estéreo e mono tocado nos dois canais); nenhuma saída se
 * desloca no tempo (correlação cruzada com a voz limpa, |atraso| ≤ 2 amostras); a 2ª chamada da mesma chave vem do
 * cache, fonte regravada gera outro arquivo; nenhum .part sobra.
 */
async function testVoiceProcessing(queue: IngestQueue, mk: MkAsset, gen: (args: string[], label: string) => Promise<unknown>, dir: string, pdir: string, projectId: string, failures: string[]): Promise<void> {
  const vf = await makeVoiceFixture(dir, 'voz')
  const { file: voice, kind, speech, pauses, durS: dur } = vf
  const noisy = join(dir, 'voz-ruido.wav')
  // ruído branco uniforme de amplitude a: RMS = a/√3 → −30 dBFS com a = √3·10^(−30/20)
  await gen(['-i', voice, '-f', 'lavfi', '-i', `anoisesrc=color=white:r=48000:a=${(Math.sqrt(3) * 10 ** (-30 / 20)).toFixed(5)}:d=${dur}:seed=7`, '-filter_complex', '[0][1]amix=inputs=2:normalize=0:duration=first', '-ac', '1', '-c:a', 'pcm_s16le', noisy], 'voz + ruído −30 dB')
  const aNoisy: Asset = { ...mk('a_noisy', noisy, await probe(noisy)), status: 'ready' }
  const clean = await pcmMono(voice, join(dir, 'voz.s16'))
  const lagOk = async (file: string, label: string, raw: string): Promise<void> => {
    const lag = crossCorrelationLag(clean, await pcmMono(file, join(dir, raw)))
    ok(Math.abs(lag) <= 2, `${label}: sem deslocamento no tempo (${lag} amostras)`, failures)
  }

  const t0 = Date.now()
  const dn = await queue.processAudio(projectId, aNoisy, { denoise: true, normalize: false })
  const dnFile = join(pdir, ...dn.rel.split('/'))
  console.log(`denoise em ${((Date.now() - t0) / 1000).toFixed(1)} s (voz ${kind})`)
  ok(dn.key === 'dn-sh' && existsSync(dnFile) && dn.rel.endsWith(`.${dn.fingerprint}.m4a`), `denoise: arquivo gerado com a impressão da fonte (${dn.rel})`, failures)
  for (const [a, b] of pauses) {
    const before = await meanDb(noisy, a, b)
    const after = await meanDb(dnFile, a, b)
    ok(before - after >= 10, `denoise: ruído na pausa ${a.toFixed(1)}–${b.toFixed(1)} s cai ≥ 10 dB (${before} → ${after} dB)`, failures)
  }
  const speechBefore = await meanDb(voice, speech[0], speech[1])
  const speechAfter = await meanDb(dnFile, speech[0], speech[1])
  console.log(`voz (${kind}): ${speechBefore} dB limpa → ${speechAfter} dB após o denoise`)
  // só a voz do Windows sobrevive ao RNNoise (a harmônica vira "ruído"): voz preservada e correlação só com ela
  if (kind === 'tts') {
    ok(Math.abs(speechAfter - speechBefore) <= 3, `denoise: voz preservada ±3 dB (${speechBefore} → ${speechAfter} dB)`, failures)
    await lagOk(dnFile, `denoise (atraso bruto do arnndn: ${DENOISE_DELAY_SAMPLES})`, 'voz-dn.s16')
  }
  const mtime = statSync(dnFile).mtimeMs
  const t1 = Date.now()
  const again = await queue.processAudio(projectId, aNoisy, { denoise: true, normalize: false })
  const cachedMs = Date.now() - t1
  ok(again.rel === dn.rel && cachedMs < 500 && statSync(dnFile).mtimeMs === mtime, `denoise: 2ª vez vem do cache (${cachedMs} ms)`, failures)

  // normalização: voz estéreo e mono a −30 LUFS → −16 ±1 (o mono é medido como tocado: nos dois canais)
  const durUs = Math.round(dur * 1e6)
  const stereoSrc = join(dir, 'voz-estereo.wav')
  const stereo30 = join(dir, 'voz-30lufs-estereo.wav')
  const mono30 = join(dir, 'voz-30lufs-mono.wav')
  await gen(['-i', voice, '-af', 'pan=stereo|c0=c0|c1=c0', '-c:a', 'pcm_s16le', stereoSrc], 'voz estéreo')
  const l0 = (await buildLoudness(stereoSrc, durUs)).integrated
  await gen(['-i', stereoSrc, '-af', `volume=${(-30 - l0).toFixed(2)}dB`, '-c:a', 'pcm_s16le', stereo30], 'voz −30 LUFS estéreo')
  await gen(['-i', stereo30, '-af', 'pan=mono|c0=c0', '-c:a', 'pcm_s16le', mono30], 'voz −30 LUFS mono')
  const lIn = await buildLoudness(stereo30, durUs)
  ok(Math.abs(lIn.integrated + 30) <= 0.5, `normalização: entrada a −30 LUFS (${lIn.integrated})`, failures)
  const upmixed = async (file: string): Promise<{ integrated: number; truePeak: number }> => {
    const st = join(dir, `${basename(file)}.estereo.wav`)
    await gen(['-i', file, '-af', 'pan=stereo|c0=c0|c1=c0', '-c:a', 'pcm_s16le', st], 'upmix')
    return buildLoudness(st, durUs)
  }
  for (const [id, file] of [['a_ln_st', stereo30], ['a_ln_mono', mono30]] as const) {
    const a: Asset = { ...mk(id, file, await probe(file)), status: 'ready' }
    const r = await queue.processAudio(projectId, a, { denoise: false, normalize: true })
    const out = join(pdir, ...r.rel.split('/'))
    const label = id === 'a_ln_st' ? 'estéreo' : 'mono'
    const l = id === 'a_ln_st' ? await buildLoudness(out, durUs) : await upmixed(out)
    ok(r.key === 'ln-i16-tp1.5' && Math.abs(l.integrated + 16) <= 1 && l.truePeak <= -1, `normalização ${label}: −30 → ${l.integrated} LUFS (alvo −16 ±1), TP ${l.truePeak}`, failures)
    await lagOk(out, `normalização ${label}`, `voz-ln-${id}.s16`)
  }
  // as duas: o ruído sai antes da normalização
  const both = await queue.processAudio(projectId, aNoisy, { denoise: true, normalize: true })
  const bothFile = join(pdir, ...both.rel.split('/'))
  const lb = existsSync(bothFile) ? await upmixed(bothFile) : null
  ok(both.key === 'dn-sh_ln-i16-tp1.5' && !!lb && Math.abs(lb.integrated + 16) <= 1, `denoise + normalização: ${lb?.integrated} LUFS`, failures)
  if (kind === 'tts' && existsSync(bothFile)) await lagOk(bothFile, 'denoise + normalização', 'voz-dn-ln.s16')

  // fonte regravada (mesmo caminho, outro conteúdo): impressão nova → processa de novo em outro arquivo, nunca o antigo
  const rewritten = join(dir, 'voz-regravada.wav')
  copyFileSync(noisy, rewritten)
  const aRe: Asset = { ...mk('a_regravada', rewritten, await probe(rewritten)), status: 'ready' }
  const first = await queue.processAudio(projectId, aRe, { denoise: true, normalize: false })
  await gen(['-i', noisy, '-af', 'volume=0.5', '-t', '5', '-c:a', 'pcm_s16le', rewritten], 'voz regravada')
  const second = await queue.processAudio(projectId, aRe, { denoise: true, normalize: false })
  ok(first.fingerprint !== second.fingerprint && first.rel !== second.rel && existsSync(join(pdir, ...second.rel.split('/'))), `fonte regravada: processa de novo com outra impressão (${first.rel} → ${second.rel})`, failures)

  const parts = readdirSync(join(pdir, 'generated')).filter((n) => n.includes('.part'))
  ok(parts.length === 0, `processar áudio: sem .part em generated/ (${parts.join(', ')})`, failures)
}

// ---- trilha do cursor na ingestão (F6, parte do CIALIGHT_TEST=ingest) ----
/**
 * Gravações sintéticas em <brutos>/ingest-cursor-* (rec.mp4 pequeno; com cursor.json válido, sem ele e com um
 * inválido): a fila (com as mesmas dependências do main: sessionDirFor + sessionCursorRef) dá `asset.cursor` só à
 * com trilha; abrir o projeto (withMediaStatus) devolve o campo que a v1.3 descartou ao regravar; e o IPC real
 * (preload → main, janela oculta) devolve a trilha validada, null sem ela e null para '..'. Chamar DEPOIS de
 * decodeInRenderer (a página usada aqui é a do harness de decodificação, que responde 'test:result' vazio).
 */
async function testCursorIngest(store: SessionStore, gen: (args: string[], label: string) => Promise<unknown>, projects: ProjectStore, projectId: string, failures: string[]): Promise<void> {
  const ids = { com: 'ingest-cursor-com', sem: 'ingest-cursor-sem', ruim: 'ingest-cursor-ruim' }
  const track: CursorTrackV1 = {
    version: 1, width: 320, height: 180,
    samples: [{ tMs: 0, x: 0.1, y: 0.2 }, { tMs: 16, x: 0.15, y: 0.25 }, { tMs: 33, x: 0.2, y: 0.3 }, { tMs: 1900, x: 0.9, y: 0.8 }],
    clicks: [{ tMs: 20, x: 0.15, y: 0.25, button: 'left' }, { tMs: 1000, x: 0.5, y: 0.5, button: 'right' }]
  }
  for (const sid of Object.values(ids)) {
    const sdir = store.dirOf(sid)
    rmSync(sdir, { recursive: true, force: true })
    mkdirSync(sdir, { recursive: true })
  }
  const rec0 = join(store.dirOf(ids.com), 'rec.mp4')
  await gen(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', rec0], 'ingest: gravação com cursor')
  copyFileSync(rec0, join(store.dirOf(ids.sem), 'rec.mp4'))
  copyFileSync(rec0, join(store.dirOf(ids.ruim), 'rec.mp4'))
  writeFileSync(join(store.dirOf(ids.com), CURSOR_FILE), JSON.stringify(track))
  writeFileSync(join(store.dirOf(ids.ruim), CURSOR_FILE), JSON.stringify({ ...track, version: 9 }))

  const refOf = (sid: string): string | null => {
    const d = sessionDirFor((x) => store.dirOf(x), sid)
    return d ? sessionCursorRef(d) : null
  }
  const queue = new IngestQueue({
    projectFile: (pid, rel) => projects.filePath(pid, rel),
    resolveInput: (_pid, a) => ({ path: a.source.type === 'session' ? store.filePath(a.source.sessionId, 'rec.mp4') : '', analyzeOnly: true, videoMap: '0:v:0' }),
    encoders: () => ['libx264'],
    sessionCursorRef: refOf,
    log
  })
  const screenAsset = (key: keyof typeof ids): Asset => ({
    id: `a_cursor_${key}`, name: key, kind: 'video', source: { type: 'session', sessionId: ids[key], stream: 'screen' }, durationUs: 2_000_000,
    video: { width: 320, height: 180, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 }, videoTrackIndex: 0, status: 'processing'
  })
  const keys = ['com', 'sem', 'ruim'] as const
  const waits = keys.map((k) => waitDone(queue, projectId, `a_cursor_${k}`))
  for (const k of keys) queue.enqueue(projectId, screenAsset(k))
  const [pCom, pSem, pRuim] = await Promise.all(waits)
  ok(pCom.status === 'ready' && pCom.cursor === CURSOR_FILE && !!pCom.filmstrip, `cursor: gravação com cursor.json → asset.cursor (${JSON.stringify(pCom)})`, failures)
  ok(pSem.status === 'ready' && !('cursor' in pSem), `cursor: gravação sem cursor.json → sem campo (${JSON.stringify(pSem)})`, failures)
  ok(pRuim.status === 'ready' && !('cursor' in pRuim), `cursor: cursor.json inválido → sem campo, sem erro (${JSON.stringify(pRuim)})`, failures)

  // v1.3 abre e regrava (descarta asset.cursor e cursorFx); ao abrir de novo, o build novo devolve o asset.cursor
  const withCursor: Asset = { ...screenAsset('com'), ...pCom, status: 'ready' }
  const base = { ...createEmptyProject('Cursor'), id: 'p-cursor-test' }
  const proj = { ...base, assets: [withCursor, { ...screenAsset('sem'), status: 'ready' as const }] }
  const v13 = parseProjectV13(JSON.parse(JSON.stringify(toDiskProject(proj))))
  ok(v13.success, 'cursor: projeto com asset.cursor legível pela v1.3', failures)
  const resaved = parseProject(JSON.parse(JSON.stringify(v13.success ? v13.data : {})))
  ok(resaved.assets.every((a) => a.cursor === undefined), 'cursor: a v1.3 descarta asset.cursor ao regravar', failures)
  const opener = new ProjectStore({
    projectsRoot: () => join(outDir, 'ingest', 'Projetos'), trash: async () => {}, log,
    sessionMediaExists: (sid) => existsSync(store.filePath(sid, 'rec.mp4')),
    sessionCursorRef: refOf
  })
  const reopened = opener.withMediaStatus(resaved)
  ok(reopened.assets.map((a) => a.cursor ?? null).join(',') === `${CURSOR_FILE},`, `cursor: abrir o projeto restaura asset.cursor só onde há trilha (${reopened.assets.map((a) => a.cursor ?? '-').join(',')})`, failures)

  // IPC real: janela oculta com o preload; o handler é o registrado por registerIpc
  const win = new BrowserWindow({ width: 200, height: 150, show: false, webPreferences: { preload: preloadPath(), sandbox: false, additionalArguments: ['--cialight-window=recorder'] } })
  try {
    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
      loadPage(win, `index.html#decode-test/${encodeURIComponent(JSON.stringify({ items: [] }))}`)
    })
    const call = (sid: string): Promise<unknown> => win.webContents.executeJavaScript(`window.api.cursor.readCursorTrack(${JSON.stringify(sid)})`)
    const got = await call(ids.com)
    ok(JSON.stringify(got) === JSON.stringify(track), `cursor: IPC readCursorTrack devolve a trilha validada (${JSON.stringify(got).slice(0, 120)})`, failures)
    const none = await Promise.all([call(ids.sem), call(ids.ruim), call('..'), call('../x'), call('nao-existe')])
    ok(none.every((r) => r === null), `cursor: IPC devolve null sem trilha, inválida ou fora das gravações (${JSON.stringify(none)})`, failures)
  } catch (e) {
    ok(false, `cursor: IPC falhou (${e instanceof Error ? e.message : String(e)})`, failures)
  } finally {
    win.destroy()
  }
  for (const sid of Object.values(ids)) rmSync(store.dirOf(sid), { recursive: true, force: true })
}

async function testIngest(store: SessionStore): Promise<number> {
  const failures: string[] = []
  const hashBefore = settingsHash()
  const dir = join(outDir, 'ingest')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const src = join(dir, 'longgop.mp4')
  const rotated = join(dir, 'rotacionado.mp4')
  const mp3 = join(dir, 'seno.mp3')
  const png = join(dir, 'quadro.png')
  const gen = (args: string[], label: string): Promise<unknown> => runFfmpeg(['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats'], { label })
  // 1080p30 6 s, GOP 300 (um único keyframe) + seno 48 kHz
  await gen(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', src], 'ingest: longgop')
  // giro horário de 90° como o de celular (equivale ao antigo -metadata rotate=90, ignorado pelo ffmpeg 8): displaymatrix −90
  await gen(['-display_rotation', '-90', '-i', src, '-c', 'copy', rotated], 'ingest: rotacionado')
  await gen(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '6', '-c:a', 'libmp3lame', '-b:a', '128k', mp3], 'ingest: mp3')
  await gen(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1', '-frames:v', '1', '-update', '1', png], 'ingest: png')

  // probe + decisão
  const iSrc = await probe(src)
  ok(iSrc.kind === 'video' && iSrc.video?.width === 1920 && iSrc.video?.height === 1080, `longgop: vídeo 1920×1080 (${iSrc.video?.width}×${iSrc.video?.height})`, failures)
  ok(Math.abs((iSrc.durationUs ?? 0) - 6_000_000) < 50_000, `longgop: duração ≈ 6 s (${iSrc.durationUs} µs)`, failures)
  ok((iSrc.video?.gopUs ?? 0) > 2_000_000, `longgop: GOP estimado longo (${iSrc.video?.gopUs} µs)`, failures)
  ok(iSrc.audio?.sampleRate === 48000, `longgop: áudio 48 kHz (${iSrc.audio?.sampleRate})`, failures)
  ok(!iSrc.vfr, 'longgop: CFR', failures)
  const dSrc = needsProxy(iSrc, true)
  ok(dSrc.proxy && !dSrc.intermediate && dSrc.reasons.includes('longGop'), `longgop: precisa de proxy (${dSrc.reasons.join(',')})`, failures)
  const iRot = await probe(rotated)
  ok(iRot.video?.rotation === 90, `rotacionado: rotation 90 (${iRot.video?.rotation})`, failures)
  const iMp3 = await probe(mp3)
  ok(iMp3.kind === 'audio' && !iMp3.video && Math.abs((iMp3.durationUs ?? 0) - 6_000_000) < 100_000, `mp3: áudio ≈ 6 s (${iMp3.kind}, ${iMp3.durationUs} µs)`, failures)
  const iPng = await probe(png)
  ok(iPng.kind === 'image' && iPng.durationUs === null, `png: imagem sem duração (${iPng.kind}, ${iPng.durationUs})`, failures)

  // fila real sobre um projeto em disco
  const projects = new ProjectStore({ projectsRoot: () => join(dir, 'Projetos'), trash: async (p) => rmSync(p, { recursive: true, force: true }), log })
  const project = { ...createEmptyProject('Teste de ingestão'), id: 'p-ingest-test' }
  const mk = (id: string, path: string, info: MediaInfo, decodable = true): Asset => {
    const a = assetFromInfo(id, path, statSync(path), info)
    return a.video ? { ...a, video: { ...a.video, decodable } } : a
  }
  project.assets = [mk('a_long', src, iSrc), mk('a_rot', rotated, iRot), mk('a_mp3', mp3, iMp3), mk('a_png', png, iPng)]
  projects.create(project)
  // só leitura do cache (V2; numa instalação que ainda só tem o cache da v1, a lista dele serve para exercitar os encoders)
  const cached = cachedEncoderProbe() ?? getSettings().lastEncoderProbe
  let encoder: HwEncoder = cached?.preferred ?? 'libx264'
  const queue = new IngestQueue({
    projectFile: (pid, rel) => projects.filePath(pid, rel),
    resolveInput: (_pid, a) => ({ path: a.source.type === 'file' ? a.source.path : '' }),
    encoders: () => [encoder],
    rnnoiseDir,
    log
  })
  const steps = new Set<string>()
  queue.on('progress', (j: IngestJob) => steps.add(`${j.assetId}:${j.step}`))
  const pdir = projects.dirOf(project.id)
  const abs = (rel: string | undefined): string => join(pdir, ...(rel ?? '').split('/'))
  const exists = (rel: string | undefined): boolean => !!rel && existsSync(abs(rel))

  const t0 = Date.now()
  const waits = project.assets.map((a) => waitDone(queue, project.id, a.id))
  for (const a of project.assets) queue.enqueue(project.id, a)
  const [pLong, pRot, pMp3, pPng] = await Promise.all(waits)
  console.log(`fila concluída em ${((Date.now() - t0) / 1000).toFixed(1)} s com ${encoder}`)

  ok(pLong.status === 'ready', `longgop: status ready (${pLong.status}${pLong.error ? ` — ${pLong.error}` : ''})`, failures)
  ok(pLong.proxy === 'proxies/a_long.mp4' && exists(pLong.proxy), `longgop: proxy gerado (${pLong.proxy})`, failures)
  if (exists(pLong.proxy)) {
    const pp = await probeFile(abs(pLong.proxy))
    const v = pp.streams.find((s) => s.type === 'video')
    ok(v?.height === 720 && v?.width === 1280, `proxy: 1280×720 (${v?.width}×${v?.height})`, failures)
    ok(Math.abs(pp.durationMs - 6000) <= 34, `proxy: duração 6 s ±1 quadro (${pp.durationMs} ms)`, failures)
    ok(pp.streams.some((s) => s.type === 'audio' && s.codec === 'aac'), 'proxy: áudio AAC', failures)
    // regra única de cor: fonte 1080p sem marcação → proxy marcado BT.709 limitado (timeline, preview e export concordam)
    const pc = (await probe(abs(pLong.proxy))).color
    ok(iSrc.color?.space === null && pc?.space === 'bt709' && pc.primaries === 'bt709' && pc.transfer === 'bt709' && pc.range === 'tv', `proxy: marcações de cor pela regra (fonte ${JSON.stringify(iSrc.color)} → proxy ${JSON.stringify(pc)})`, failures)
    const iv = keyIntervals(await probeKeyframes(abs(pLong.proxy)), 30)
    ok(iv.length >= 11 && iv.every((n) => n === 15), `proxy: keyframes a cada 15 quadros (${iv.length + 1} keyframes, intervalos ${uniq(iv)})`, failures)
    ok(isFastStart(abs(pLong.proxy)), 'proxy: faststart', failures)
  }
  const fi = pLong.filmstripInfo
  ok(pLong.filmstrip === 'cache/a_long.strip.jpg' && exists(pLong.filmstrip) && !!fi, `filmstrip gerado (${JSON.stringify(fi)})`, failures)
  if (fi && exists(pLong.filmstrip)) {
    const v = (await probeFile(abs(pLong.filmstrip))).streams.find((s) => s.type === 'video')
    ok(fi.frames === 6 && fi.everyUs === 1_000_000, `filmstrip: 6 quadros a cada 1 s (${fi.frames}, ${fi.everyUs})`, failures)
    ok(v?.width === fi.frames * fi.tileW && v?.height === fi.tileH && fi.tileH === 64, `filmstrip: largura = frames×tileW (${v?.width} = ${fi.frames}×${fi.tileW}, altura ${v?.height})`, failures)
  }
  const peaksExpected = 2 * 100 * 6
  const peaksSize = exists(pLong.peaks) ? statSync(abs(pLong.peaks)).size : -1
  ok(Math.abs(peaksSize - peaksExpected) <= peaksExpected * 0.02, `peaks longgop: ${peaksSize} bytes (esperado ${peaksExpected} ±2 %)`, failures)
  const thumb = join(pdir, 'cache', 'thumb.jpg')
  const tw = existsSync(thumb) ? (await probeFile(thumb)).streams[0]?.width : undefined
  ok(tw === 320, `cache/thumb.jpg com 320 px (${tw})`, failures)

  ok(pRot.status === 'ready' && exists(pRot.proxy), `rotacionado: proxy (${pRot.status}${pRot.error ? ` — ${pRot.error}` : ''})`, failures)
  if (exists(pRot.proxy)) {
    const v = (await probeFile(abs(pRot.proxy))).streams.find((s) => s.type === 'video')
    ok(v?.width === 720 && v?.height === 1280, `rotacionado: proxy em pé 720×1280 (${v?.width}×${v?.height})`, failures)
  }
  ok(!!pRot.filmstripInfo && pRot.filmstripInfo.tileW < pRot.filmstripInfo.tileH, `rotacionado: filmstrip em pé (${JSON.stringify(pRot.filmstripInfo)})`, failures)

  ok(pMp3.status === 'ready' && !pMp3.proxy && !pMp3.filmstrip, `mp3: só peaks (${JSON.stringify(pMp3)})`, failures)
  const mp3Peaks = exists(pMp3.peaks) ? statSync(abs(pMp3.peaks)).size : -1
  ok(Math.abs(mp3Peaks - peaksExpected) <= peaksExpected * 0.02, `peaks mp3: ${mp3Peaks} bytes (esperado ${peaksExpected} ±2 %)`, failures)
  ok(pPng.status === 'ready' && !pPng.proxy && !pPng.filmstrip && !pPng.peaks, `png: pronto sem derivados (${JSON.stringify(pPng)})`, failures)
  const longSteps = [...steps].filter((s) => s.startsWith('a_long:'))
  ok(['probe', 'proxy', 'filmstrip', 'peaks'].every((st) => steps.has(`a_long:${st}`)), `progresso por etapa (${longSteps.join(', ')})`, failures)

  // não decodificável → intermediário full-res, GOP 1 s, sem proxy
  const wUndec = waitDone(queue, project.id, 'a_undec')
  queue.enqueue(project.id, mk('a_undec', src, iSrc, false))
  const pUndec = await wUndec
  ok(pUndec.status === 'ready' && exists(pUndec.intermediate) && !pUndec.proxy, `intermediário gerado sem proxy (${pUndec.intermediate}${pUndec.error ? ` — ${pUndec.error}` : ''})`, failures)
  ok(pUndec.video?.decodable === false, 'intermediário: patch leva decodable=false', failures)
  if (exists(pUndec.intermediate)) {
    const v = (await probeFile(abs(pUndec.intermediate))).streams.find((s) => s.type === 'video')
    ok(v?.width === 1920 && v?.height === 1080, `intermediário: 1920×1080 (${v?.width}×${v?.height})`, failures)
    const ic = (await probe(abs(pUndec.intermediate))).color
    ok(ic?.space === 'bt709' && ic.range === 'tv', `intermediário: marcações de cor pela regra (${JSON.stringify(ic)})`, failures)
    const iv = keyIntervals(await probeKeyframes(abs(pUndec.intermediate)), 30)
    ok(iv.length >= 4 && iv.every((n) => n === 30), `intermediário: GOP 1 s (${uniq(iv)})`, failures)
  }

  // áudio que o WebCodecs pode não decodificar (FLAC; ALAC em .m4a; AC-3 num MKV com vídeo H.264): decisão real
  // no renderer → o não decodificável ganha intermediário AAC (só áudio → .m4a; vídeo → vídeo copiado + AAC),
  // que passa a decodificar; o decodificável fica sem intermediário
  const flac = join(dir, 'seno.flac')
  const alac = join(dir, 'seno-alac.m4a')
  const mkvAc3 = join(dir, 'video-ac3.mkv')
  await gen(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100', '-t', '4', '-c:a', 'flac', flac], 'ingest: flac')
  await gen(['-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=44100', '-t', '4', '-c:a', 'alac', alac], 'ingest: alac')
  await gen(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k', mkvAc3], 'ingest: mkv ac3')
  const dec = await decodeInRenderer(store, [
    { name: 'flac', path: flac, kind: 'audio' },
    { name: 'alac', path: alac, kind: 'audio' },
    { name: 'mkvAc3', path: mkvAc3, kind: 'video' },
    { name: 'mp3', path: mp3, kind: 'audio' },
    { name: 'mp4', path: src, kind: 'video' }
  ])
  console.log(`decodable (WebCodecs): ${JSON.stringify(dec)}`)
  ok(dec.errors.length === 0, `harness de decodificação sem erro (${dec.errors.join('; ')})`, failures)
  ok(dec.results.alac?.audio === false, `alac (.m4a): áudio não decodificável (${JSON.stringify(dec.results.alac)})`, failures)
  ok(dec.results.mkvAc3?.video === true && dec.results.mkvAc3?.audio === false, `mkv: vídeo H.264 decodificável, áudio AC-3 não (${JSON.stringify(dec.results.mkvAc3)})`, failures)
  ok(dec.results.mp3?.audio === true && dec.results.mp4?.video === true && dec.results.mp4?.audio === true, `controles mp3/mp4 decodificáveis (${JSON.stringify(dec.results.mp3)} ${JSON.stringify(dec.results.mp4)})`, failures)
  const iFlac = await probe(flac)
  const iAlac = await probe(alac)
  const iMkv = await probe(mkvAc3)
  const withAudio = (a: Asset, audioDecodable: boolean): Asset => (a.audio ? { ...a, audio: { ...a.audio, decodable: audioDecodable } } : a)
  const flacDecodable = dec.results.flac?.audio ?? false
  const wFlac = waitDone(queue, project.id, 'a_flac')
  const wAlac = waitDone(queue, project.id, 'a_alac')
  const wMkv = waitDone(queue, project.id, 'a_mkv')
  queue.enqueue(project.id, withAudio(mk('a_flac', flac, iFlac), flacDecodable))
  queue.enqueue(project.id, withAudio(mk('a_alac', alac, iAlac), dec.results.alac?.audio ?? true))
  queue.enqueue(project.id, withAudio(mk('a_mkv', mkvAc3, iMkv, dec.results.mkvAc3?.video ?? true), dec.results.mkvAc3?.audio ?? true))
  const [pFlac, pAlac, pMkv] = await Promise.all([wFlac, wAlac, wMkv])
  // FLAC: o WebCodecs desta versão do Chromium pode decodificar (sem intermediário) ou não (com .m4a)
  ok(pFlac.status === 'ready' && !!pFlac.peaks && (flacDecodable ? !pFlac.intermediate : exists(pFlac.intermediate)), `flac (decodable=${flacDecodable}): ${flacDecodable ? 'sem' : 'com'} intermediário (${JSON.stringify(pFlac)})`, failures)
  ok(pAlac.status === 'ready' && pAlac.intermediate === 'proxies/a_alac.intermediate.m4a' && exists(pAlac.intermediate) && !!pAlac.peaks && pAlac.audio?.decodable === false, `alac: intermediário .m4a + peaks (${JSON.stringify(pAlac)})`, failures)
  ok(pMkv.status === 'ready' && pMkv.intermediate === 'proxies/a_mkv.intermediate.mp4' && exists(pMkv.intermediate) && !pMkv.proxy, `mkv: intermediário .mp4, sem proxy (${pMkv.intermediate} ${pMkv.proxy ?? ''}${pMkv.error ? ` — ${pMkv.error}` : ''})`, failures)
  if (exists(pAlac.intermediate)) {
    const s = (await probeFile(abs(pAlac.intermediate))).streams
    ok(s.length === 1 && s[0].type === 'audio' && s[0].codec === 'aac', `alac: intermediário só com áudio AAC (${s.map((x) => `${x.type}:${x.codec}`).join(', ')})`, failures)
  }
  if (exists(pMkv.intermediate)) {
    const s = (await probeFile(abs(pMkv.intermediate))).streams
    const v = s.find((x) => x.type === 'video')
    ok(v?.codec === 'h264' && v.width === 640 && s.some((x) => x.type === 'audio' && x.codec === 'aac'), `mkv: intermediário com o vídeo H.264 copiado + AAC (${s.map((x) => `${x.type}:${x.codec}`).join(', ')})`, failures)
  }
  if (exists(pAlac.intermediate) && exists(pMkv.intermediate)) {
    const after = await decodeInRenderer(store, [
      { name: 'alacInt', path: abs(pAlac.intermediate), kind: 'audio' },
      { name: 'mkvInt', path: abs(pMkv.intermediate), kind: 'video' }
    ])
    ok(after.results.alacInt?.audio === true && after.results.mkvInt?.video === true && after.results.mkvInt?.audio === true, `intermediários decodificam no WebCodecs (${JSON.stringify(after.results)})`, failures)
  }

  // fala e loudness: ruído rosa em rajadas com pausas conhecidas (1–2,5 s, 4–5 s, 6,2–8 s de 10 s) e seno de 1 kHz a −20 dBFS
  const speechWav = join(dir, 'fala-sintetica.wav')
  const sineWav = join(dir, 'seno-20dbfs.wav')
  const twoTracks = join(dir, 'duas-faixas.mp4')
  await gen(['-f', 'lavfi', '-i', "anoisesrc=color=pink:r=48000:a=0.3:d=10,volume='between(t,1,2.5)+between(t,4,5)+between(t,6.2,8)':eval=frame", '-c:a', 'pcm_s16le', speechWav], 'ingest: fala sintética')
  await gen(['-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*1000*t):s=48000:d=6', '-c:a', 'pcm_s16le', sineWav], 'ingest: seno -20 dBFS')
  await gen(['-i', speechWav, '-i', sineWav, '-map', '0:a', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', twoTracks], 'ingest: duas faixas de áudio')
  const wSpeech = waitDone(queue, project.id, 'a_speech')
  const wSine = waitDone(queue, project.id, 'a_sine')
  queue.enqueue(project.id, mk('a_speech', speechWav, await probe(speechWav)))
  queue.enqueue(project.id, mk('a_sine', sineWav, await probe(sineWav)))
  const [pSpeech, pSine] = await Promise.all([wSpeech, wSine])
  ok(pSpeech.status === 'ready' && pSpeech.speech === 'cache/a_speech.speech.json' && exists(pSpeech.speech) && !!pSpeech.loudness, `fala sintética: speech.json + loudness (${JSON.stringify(pSpeech)})`, failures)
  if (exists(pSpeech.speech)) {
    const sf = JSON.parse(readFileSync(abs(pSpeech.speech), 'utf8')) as SpeechFile
    ok(sf.version === 1 && sf.thresholdDb === -35 && sf.minSilenceUs === 350_000 && sf.durationUs === 10_000_000 && sf.silences.length === 4 && !('intervals' in sf), `speech.json: formato com silêncios brutos (${JSON.stringify(sf)})`, failures)
    // verdade + padding de 120 ms, ±50 ms
    const got = speechFromFile(sf)
    const want = [[1_000_000, 2_500_000], [4_000_000, 5_000_000], [6_200_000, 8_000_000]].map(([a, b]) => [a - 120_000, b + 120_000])
    ok(got.length === want.length && got.every((iv, i) => Math.abs(iv.fromUs - want[i][0]) <= 50_000 && Math.abs(iv.toUs - want[i][1]) <= 50_000), `fala: intervalos ±50 ms (${JSON.stringify(got)} vs ${JSON.stringify(want)})`, failures)
  }
  const sineL = pSine.loudness
  ok(!!sineL && Math.abs(sineL.integrated + 23) <= 1 && Math.abs(sineL.truePeak + 20) <= 1 && sineL.lra < 1, `seno −20 dBFS: ≈ −23 LUFS (${JSON.stringify(sineL)})`, failures)
  // faixa escolhida por -map (mic/sistema da sessão): a:0 é a fala em rajadas, a:1 o seno contínuo
  const sp0 = speechFromFile(await buildSpeech(twoTracks, join(dir, 'duas-0.speech.json'), 10_000_000, { map: '0:a:0' }))
  const sp1 = speechFromFile(await buildSpeech(twoTracks, join(dir, 'duas-1.speech.json'), 6_000_000, { map: '0:a:1' }))
  const ld1 = await buildLoudness(twoTracks, 6_000_000, { map: '0:a:1' })
  ok(sp0.length === 3 && sp1.length === 1 && sp1[0].fromUs === 0 && sp1[0].toUs === 6_000_000, `-map: fala a:0 ${sp0.length} intervalos, seno a:1 ${JSON.stringify(sp1)}`, failures)
  ok(Math.abs(ld1.integrated + 23) <= 1.5, `-map: loudness da faixa a:1 ≈ −23 LUFS (${ld1.integrated})`, failures)
  // modo analyzeAudio (backfill): só fala + loudness, sem proxy/filmstrip/peaks e sem mexer no status
  const wBack = waitDone(queue, project.id, 'a_backfill')
  queue.enqueue(project.id, { ...mk('a_backfill', sineWav, await probe(sineWav)), status: 'ready' }, { analyzeAudio: true })
  const pBack = await wBack
  ok(pBack.speech === 'cache/a_backfill.speech.json' && exists(pBack.speech) && !!pBack.loudness && Math.abs(pBack.loudness.integrated + 23) <= 1 && !('status' in pBack) && !pBack.peaks && !pBack.proxy && !pBack.filmstrip, `analyzeAudio: só fala + loudness (${JSON.stringify(pBack)})`, failures)
  // cancelamento durante a análise: rejeita com CancelledError e não deixa .part
  const ctl = new AbortController()
  const cancelled = buildSpeech(twoTracks, join(dir, 'cancelada.speech.json'), 10_000_000, { map: '0:a:0', signal: ctl.signal }).then(() => false, (e) => e instanceof Error && e.name === 'CancelledError')
  ctl.abort()
  ok(await cancelled && !readdirSync(dir).some((n) => n.includes('cancelada')), 'análise de fala cancelada: sem resultado nem .part', failures)

  await testVoiceProcessing(queue, mk, gen, dir, pdir, project.id, failures)
  await testCursorIngest(store, gen, projects, project.id, failures)

  // proxy com cada encoder do cache de probe (somente leitura; nada é gravado nas configurações)
  for (const enc of cached?.available ?? []) {
    if (enc === encoder) continue
    encoder = enc
    const id = `a_enc_${enc}`
    const w = waitDone(queue, project.id, id)
    queue.enqueue(project.id, mk(id, src, iSrc))
    const r = await w
    const v = exists(r.proxy) ? (await probeFile(abs(r.proxy))).streams.find((s) => s.type === 'video') : undefined
    const iv = exists(r.proxy) ? keyIntervals(await probeKeyframes(abs(r.proxy)), 30) : []
    ok(r.status === 'ready' && v?.height === 720 && iv.length >= 10 && iv.every((n) => n === 15), `proxy com ${enc}: 720p, keyframes a cada 15 (${v?.height}, ${uniq(iv)}${r.error ? ` — ${r.error}` : ''})`, failures)
    const ec = exists(r.proxy) ? (await probe(abs(r.proxy))).color : undefined
    ok(ec?.space === 'bt709' && ec.primaries === 'bt709' && ec.transfer === 'bt709' && ec.range === 'tv', `proxy com ${enc}: marcações de cor (${JSON.stringify(ec)})`, failures)
  }

  // cancelamento: nenhum 'done' e nenhum .part sobrando
  let doneAfterCancel = false
  queue.on('done', (_pid, aid) => {
    if (aid === 'a_cancel') doneAfterCancel = true
  })
  queue.enqueue(project.id, mk('a_cancel', src, iSrc))
  await new Promise((r) => setTimeout(r, 400))
  queue.cancel(project.id)
  await new Promise((r) => setTimeout(r, 2500))
  const leftovers = [...readdirSync(join(pdir, 'proxies')), ...readdirSync(join(pdir, 'cache'))].filter((n) => n.includes('.part'))
  ok(!doneAfterCancel && !queue.busy(project.id), 'cancelamento: sem done e fila vazia', failures)
  ok(leftovers.length === 0, `cancelamento: sem arquivos .part (${leftovers.join(', ')})`, failures)

  ok(settingsHash() === hashBefore, 'settings.json do usuário intocado', failures)
  writeFileSync(join(outDir, 'ingest-report.json'), JSON.stringify({ encoder: cached?.preferred ?? 'libx264', available: cached?.available ?? [], probes: { src: iSrc, rotated: iRot, mp3: iMp3, png: iPng }, patches: { pLong, pRot, pMp3, pPng, pUndec, pFlac, pAlac, pMkv, pSpeech, pSine }, decodable: dec.results, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DE INGESTÃO PASSOU')
  return failures.length ? 1 : 0
}

// ---- modelos empacotados (CIALIGHT_TEST=models; também no app empacotado: release/win-unpacked) ----
// Confere que rnnoiseDir() acha o modelo (sha256 pinado em resources/models/models.json) e que o ffmpeg empacotado
// roda o denoise com ele. Escreve só em %TEMP%\cialight-models-test (o app empacotado não tem test-out/) e o
// relatório em models-report.json lá.
const MODELS_SHA256: Record<string, string> = { 'rnnoise/sh.rnnn': '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0' }

async function testModels(): Promise<number> {
  const failures: string[] = []
  const dir = join(tmpdir(), 'cialight-models-test')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const model = join(rnnoiseDir(), DENOISE_MODEL.file)
  ok(existsSync(model), `modelo em ${model} (empacotado: ${app.isPackaged}, resourcesPath ${process.resourcesPath})`, failures)
  const sha = existsSync(model) ? createHash('sha256').update(readFileSync(model)).digest('hex') : null
  ok(sha === MODELS_SHA256['rnnoise/sh.rnnn'], `sha256 do modelo (${sha})`, failures)
  const src = join(dir, 'ruido.wav')
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=white:r=48000:a=0.05:d=2', '-c:a', 'pcm_s16le', src, '-progress', 'pipe:1', '-nostats'], { label: 'models: ruído' })
  const out = join(dir, 'ruido-dn.m4a')
  try {
    await processAudioFile(src, '0:a:0', out, { denoise: true, normalize: false }, { modelDir: rnnoiseDir(), durationUs: 2_000_000, dualMono: false })
    ok(existsSync(out) && statSync(out).size > 1000, `denoise com o modelo empacotado (${out})`, failures)
  } catch (e) {
    ok(false, `denoise com o modelo empacotado falhou: ${e instanceof Error ? e.message : String(e)}`, failures)
  }
  // whisper.cpp (legendas automáticas): binário na pasta de recursos, todo import PE na pasta ou no Windows (runtime
  // do Visual C++ app-local) e `--version` sai com 0
  const wcli = whisperCliPath()
  ok(existsSync(wcli), `whisper-cli em ${wcli}`, failures)
  let whisperImports: ReturnType<typeof checkFolderImports> | null = null
  try {
    whisperImports = checkFolderImports(whisperDir())
    ok(whisperImports.files >= 17 && whisperImports.missing.length === 0, `imports PE da pasta do whisper (${whisperImports.files} arquivos; ausentes: ${whisperImports.missing.map((m) => `${m.file}→${m.dll}`).join(', ') || 'nenhum'})`, failures)
    for (const d of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']) ok(existsSync(join(whisperDir(), d)), `runtime VC++ ${d} ao lado do whisper-cli`, failures)
  } catch (e) {
    ok(false, `imports PE da pasta do whisper: ${e instanceof Error ? e.message : String(e)}`, failures)
  }
  const ver = await new Promise<{ code: number | null; out: string }>((res) => {
    execFile(wcli, ['--version'], { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => res({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code?: unknown }).code as number) : -1) : 0, out: `${stdout}${stderr}` }))
  })
  ok(ver.code === 0 && /whisper\.cpp version/.test(ver.out), `whisper-cli --version sai com 0 (${ver.code}; ${ver.out.trim().split(/\r?\n/).pop() ?? ''})`, failures)
  writeFileSync(join(dir, 'models-report.json'), JSON.stringify({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, rnnoiseDir: rnnoiseDir(), model, sha, whisperDir: whisperDir(), whisperImports, whisperVersion: ver, failures }, null, 2))
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DE MODELOS PASSOU')
  return failures.length ? 1 : 0
}

export async function runIntegrationTest(mode: string, store: SessionStore, projects: ProjectStore): Promise<void> {
  let code = 1
  try {
    if (mode === 'ffmpeg') code = await testFfmpeg(store)
    else if (mode === 'capture') code = await testCapture(store)
    else if (mode === 'ingest') code = await testIngest(store)
    else if (mode === 'editor-render') code = await testEditorRender(projects, store, outDir)
    else if (mode === 'editor-export') code = await testEditorExport(projects, store, outDir)
    else if (mode === 'editor-formats') code = await testEditorFormats(projects, outDir)
    else if (mode === 'models') code = await testModels()
    else if (mode === 'transcribe') code = await testTranscribe(projects, outDir)
    else console.error(`modo de teste desconhecido: ${mode}`)
  } catch (e) {
    console.error('teste falhou com exceção:', e)
    log.error('teste falhou', e)
  }
  app.exit(code)
}
