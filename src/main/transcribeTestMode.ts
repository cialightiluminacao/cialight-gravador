// Teste real das legendas automáticas (CIALIGHT_TEST=transcribe; `npm run test:transcribe`, só sob a trava do Electron).
// Fala sintética pt-BR (System.Speech via scripts/qa/synthSpeech.mjs — nunca o microfone) vira um MP4 importado num
// projeto de teste; o modelo `base` é baixado por downloadModel para test-out/whisper-models (cache: o carimbo .ok faz
// a 2ª execução pular); cancelamento do download (small, pasta descartável); transcrição de [10 s, 50 s) com precisão e
// carimbos medidos; cancelamento da transcrição; 10 s de silêncio. Tudo em test-out/ (nunca o userData real).
import { app } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import type { Asset, Project } from '@shared/editor/project'
import type { TranscribeProgress } from '@shared/ipc'
import { createEmptyProject } from '@shared/editor/factory'
import { addAsset } from '@shared/editor/ops'
import type { ProjectStore } from './project/projectStore'
import { gen } from './editorExportTestMode'
import { probe } from './media/probe'
import { assetFromInfo } from './media/ingest'
import { ffmpegPath, whisperCliPath } from './export/ffmpegPath'
import { log } from './log'
import { DownloadCancelledError, WHISPER_MODELS, downloadModel, modelStatus, whisperModelsDir } from './transcribe/whisperModels'
import { TranscribeCancelledError, TranscribeService, transcribeInputOf } from './transcribe/transcribeService'
import { scoreWords } from './transcribe/wordScore'

const PROJECT_ID = 'p-transcribe-test'

// ~75 s: 10 frases, 3 pausas ≥ 1,5 s, números e acentos (mesmo texto do spike)
const SSML_PTBR = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-BR">
Bom dia a todos, e sejam bem-vindos à apresentação dos resultados do terceiro trimestre.
Neste período, a equipe atendeu 120 clientes novos em São Paulo e no Paraná.
<break time="1500ms"/>
A produção de luminárias cresceu bastante, e a fábrica operou em dois turnos durante seis semanas.
Na próxima segunda-feira, às 14 horas, vamos revisar o orçamento de iluminação pública.
Também precisamos de atenção com a manutenção preventiva dos equipamentos elétricos.
<break time="2000ms"/>
O relatório completo será enviado por e-mail até o dia 15 de outubro.
Quem tiver dúvidas sobre a importação de peças pode falar comigo depois da reunião.
Lembrem-se de que a segurança vem sempre em primeiro lugar.
<break time="1500ms"/>
Agradeço a participação de vocês e desejo uma ótima semana de trabalho.
Até a próxima, e obrigado pela atenção.
</speak>`

function ok(cond: boolean, msg: string, failures: string[]): void {
  if (!cond) failures.push(msg)
  console.log(`${cond ? 'OK ' : 'FAIL'} ${msg}`)
}

interface Truth { durationUs: number; words: { text: string; startUs: number; endUs: number }[] }

/** synthSpeech.mjs pelo Node embutido do Electron (ELECTRON_RUN_AS_NODE): grava <wav> e <wav>.words.json. */
function synth(ssmlFile: string, wav: string): Promise<void> {
  return new Promise((res, rej) => {
    const script = join(app.getAppPath(), 'scripts', 'qa', 'synthSpeech.mjs')
    const p = spawn(process.execPath, [script, ssmlFile, wav, 'pt-BR'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', rej)
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`synthSpeech saiu com ${code}: ${err.slice(-500)}`))))
  })
}

function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')))
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function testTranscribe(projects: ProjectStore, outDir: string): Promise<number> {
  const failures: string[] = []
  const dir = join(outDir, 'transcribe')
  mkdirSync(dir, { recursive: true })
  const report: Record<string, unknown> = {}

  // pastas: modelos em test-out (nunca o userData real); userData do app = %APPDATA%\cialight-gravador (só lido)
  const modelsDir = whisperModelsDir()
  report.userData = app.getPath('userData')
  report.modelsDir = modelsDir
  ok(basename(app.getPath('userData')) === 'cialight-gravador', `userData do app resolve para ...\\cialight-gravador (${app.getPath('userData')})`, failures)
  ok(modelsDir === resolve(app.getAppPath(), 'test-out', 'whisper-models'), `modelos do teste em test-out/whisper-models (${modelsDir})`, failures)
  ok(existsSync(whisperCliPath()), `whisper-cli em ${whisperCliPath()}`, failures)

  // a. fala sintética → MP4 (vídeo + AAC), como uma mídia importada; 10 s de silêncio idem
  const wav = join(dir, 'fala.wav')
  if (!existsSync(`${wav}.words.json`) || !existsSync(wav)) {
    const ssml = join(dir, 'fala.ssml')
    writeFileSync(ssml, SSML_PTBR, 'utf8')
    await synth(ssml, wav)
  }
  const truth = JSON.parse(readFileSync(`${wav}.words.json`, 'utf8')) as Truth
  console.log(`fala sintética: ${(truth.durationUs / 1e6).toFixed(2)} s, ${truth.words.length} palavras`)
  const mp4 = join(dir, 'fala.mp4')
  const silent = join(dir, 'silencio.mp4')
  await gen(['-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=10', '-i', wav, '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', mp4], 'transcribe: fala.mp4')
  await gen(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', silent], 'transcribe: silencio.mp4')
  const aFala: Asset = { ...assetFromInfo('a_fala', mp4, statSync(mp4), await probe(mp4)), status: 'ready' }
  const aSil: Asset = { ...assetFromInfo('a_silencio', silent, statSync(silent), await probe(silent)), status: 'ready' }
  rmSync(projects.dirOf(PROJECT_ID), { recursive: true, force: true })
  let p: Project = { ...createEmptyProject('Transcrição', { width: 320, height: 240, fps: 10, background: '#000000' }), id: PROJECT_ID }
  p = addAsset(addAsset(p, aFala), aSil)
  projects.create(p)

  // b. modelo base: baixa (ou reaproveita pelo carimbo) e confere o sha256 completo
  const base = WHISPER_MODELS.base
  const wasPresent = modelStatus().find((m) => m.id === 'base')?.present === true
  if (!wasPresent) {
    const t0 = Date.now()
    let events = 0
    await downloadModel('base', (pr) => {
      events++
      if (events % 20 === 0) console.log(`  download base: ${(pr.receivedBytes / 1048576).toFixed(0)} / ${(pr.totalBytes / 1048576).toFixed(0)} MB`)
    }, undefined)
    const secs = (Date.now() - t0) / 1000
    console.log(`download base: ${secs.toFixed(1)} s, ${events} eventos de progresso (${(events / secs).toFixed(1)}/s)`)
    ok(events / secs <= 11, `progresso do download limitado a ~10/s (${(events / secs).toFixed(1)}/s)`, failures)
    report.download = { seconds: secs, events }
  } else console.log('modelo base já presente (carimbo .ok): download pulado')
  report.baseCached = wasPresent
  const modelFile = join(modelsDir, base.file)
  ok(modelStatus().find((m) => m.id === 'base')?.present === true, 'modelo base presente pelo status', failures)
  ok(existsSync(`${modelFile}.ok`) && readFileSync(`${modelFile}.ok`, 'utf8').trim() === base.sha256, 'carimbo .ok com o sha256 pinado', failures)
  const realSha = await sha256File(modelFile)
  ok(realSha === base.sha256, `sha256 do arquivo baixado confere (${realSha.slice(0, 12)}…)`, failures)
  ok(!existsSync(`${modelFile}.part`), 'sem .part do base', failures)

  // c. cancelamento do download (small) numa pasta descartável, depois de ≥ 1 MB
  const dlDir = join(dir, 'dl-cancel')
  rmSync(dlDir, { recursive: true, force: true })
  mkdirSync(dlDir, { recursive: true })
  const ac = new AbortController()
  let got = 0
  let dlErr: unknown = null
  try {
    await downloadModel('small', (pr) => {
      got = pr.receivedBytes
      if (pr.receivedBytes >= 1048576) ac.abort()
    }, ac.signal, { dir: dlDir })
  } catch (e) {
    dlErr = e
  }
  ok(dlErr instanceof DownloadCancelledError && (dlErr as Error).message === 'Download cancelado', `download cancelado após ${(got / 1048576).toFixed(1)} MB → "Download cancelado" (${dlErr instanceof Error ? dlErr.message : String(dlErr)})`, failures)
  ok(got >= 1048576, 'cancelado só depois de ≥ 1 MB recebido', failures)
  ok(readdirSync(dlDir).length === 0, `nenhum arquivo final nem .part na pasta (${readdirSync(dlDir).join(', ') || 'vazia'})`, failures)

  // serviço com a mesma resolução de mídia do IPC
  const pids: { pid: number; kind: string }[] = []
  const temps: string[] = []
  const svc = new TranscribeService({
    resolveInput: (projectId, assetId) =>
      transcribeInputOf(
        { projectFile: (id, rel) => projects.filePath(id, rel), sessionFile: () => { throw new Error('sem gravação no teste') }, sessionTracks: () => undefined },
        projectId,
        projects.cached(projectId).assets.find((x) => x.id === assetId),
        assetId
      ),
    ffmpegPath,
    whisperCliPath,
    modelsDir: whisperModelsDir,
    log,
    hooks: { onChild: (pid, kind) => pids.push({ pid, kind }), onTempDir: (d) => temps.push(d) }
  })

  // d. transcrição de [10 s, 50 s)
  const FROM = 10_000_000
  const TO = 50_000_000
  const prog: TranscribeProgress[] = []
  const t0 = Date.now()
  const r = await svc.transcribe({ projectId: PROJECT_ID, modelId: 'base', language: 'pt', jobs: [{ assetId: 'a_fala', fromUs: FROM, toUs: TO }] }, (pr) => prog.push(pr))
  const wallS = (Date.now() - t0) / 1000
  const rtf = (TO - FROM) / 1e6 / wallS
  const words = r.words.a_fala ?? []
  const ref = truth.words.filter((w) => w.startUs >= FROM && w.startUs < TO)
  const s = scoreWords(ref, words)
  console.log(`transcrição [10 s, 50 s): ${words.length} palavras em ${wallS.toFixed(2)} s → RTF ${rtf.toFixed(1)}× (base, ${prog.length} eventos de progresso)`)
  console.log(`precisão: ${(s.accuracy * 100).toFixed(1)} % (${s.correct}/${s.refWords}), WER ${(s.wer * 100).toFixed(1)} %; início: mediana ${(s.startErrMedianUs / 1000).toFixed(0)} ms, p90 ${(s.startErrP90Us / 1000).toFixed(0)} ms, máx ${(s.startErrMaxUs / 1000).toFixed(0)} ms, ≤ 300 ms ${(s.within300 * 100).toFixed(1)} %`)
  if (s.subs.length) console.log(`  substituições: ${s.subs.join(', ')}`)
  report.transcribe = { wallS, rtf, words: words.length, score: s, warnings: r.warnings, progress: prog }
  ok(s.accuracy >= 0.8, `≥ 80 % das palavras da verdade-base corretas (${(s.accuracy * 100).toFixed(1)} %)`, failures)
  ok(s.within300 >= 0.9, `≥ 90 % das palavras casadas com |erro de início| ≤ 0,3 s (${(s.within300 * 100).toFixed(1)} %)`, failures)
  ok(words.length > 0 && words.every((w) => w.startUs >= FROM && w.endUs <= TO && w.endUs >= w.startUs && Number.isInteger(w.startUs)), 'palavras em tempo da FONTE (dentro de [10 s, 50 s), µs inteiros)', failures)
  ok(r.warnings.length === 0, `sem avisos (${r.warnings.join('; ') || 'nenhum'})`, failures)
  ok(prog.length >= 2 && prog.at(-1)?.fraction === 1 && prog.every((x, i) => i === 0 || x.fraction >= prog[i - 1].fraction), 'progresso crescente até 1', failures)
  ok(temps.length === 1 && !existsSync(temps[0]), 'pasta temporária da execução apagada', failures)
  ok(pids.some((x) => x.kind === 'whisper') && pids.every((x) => !alive(x.pid)), 'nenhum processo filho vivo depois da transcrição', failures)

  // e. cancelamento no meio do whisper (e uma por vez)
  pids.length = 0
  temps.length = 0
  const ac2 = new AbortController()
  let abortAt = 0
  let second: unknown = null
  const running = svc.transcribe({ projectId: PROJECT_ID, modelId: 'base', language: 'pt', jobs: [{ assetId: 'a_fala', fromUs: 0, toUs: truth.durationUs }] }, (pr) => {
    if (pr.stage === 'transcribe' && pr.fraction < 1 && !abortAt) {
      setTimeout(() => {
        abortAt = Date.now()
        ac2.abort()
      }, 700)
    }
  }, ac2.signal)
  try {
    await svc.transcribe({ projectId: PROJECT_ID, modelId: 'base', language: 'pt', jobs: [{ assetId: 'a_fala', fromUs: 0, toUs: 1_000_000 }] }, () => {})
  } catch (e) {
    second = e
  }
  ok(second instanceof Error && /Já existe uma transcrição em andamento/.test(second.message), `segunda transcrição simultânea recusada (${second instanceof Error ? second.message : String(second)})`, failures)
  let cancelErr: unknown = null
  try {
    await running
  } catch (e) {
    cancelErr = e
  }
  const cancelMs = abortAt ? Date.now() - abortAt : NaN
  const whisperPids = pids.filter((x) => x.kind === 'whisper').map((x) => x.pid)
  ok(cancelErr instanceof TranscribeCancelledError && (cancelErr as Error).message === 'Transcrição cancelada', `cancelar rejeita com "Transcrição cancelada" (${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)})`, failures)
  ok(cancelMs <= 2000, `cancelamento em ${cancelMs} ms (≤ 2 s)`, failures)
  ok(temps.length === 1 && !existsSync(temps[0]), `pasta temporária apagada após cancelar (${temps[0]})`, failures)
  ok(whisperPids.length === 1 && whisperPids.every((pid) => !alive(pid)), `processo do whisper (PID ${whisperPids.join(', ')}) encerrado`, failures)
  report.cancel = { cancelMs, whisperPids }

  // f. 10 s de silêncio → nenhuma palavra, sem erro
  let silErr: unknown = null
  let silWords = -1
  let silWarn: string[] = []
  try {
    const rs = await svc.transcribe({ projectId: PROJECT_ID, modelId: 'base', language: 'pt', jobs: [{ assetId: 'a_silencio', fromUs: 0, toUs: 10_000_000 }] }, () => {})
    silWords = (rs.words.a_silencio ?? []).length
    silWarn = rs.warnings
  } catch (e) {
    silErr = e
  }
  ok(silErr === null && silWords === 0, `silêncio: 0 palavras, sem erro (${silErr instanceof Error ? silErr.message : `${silWords} palavras`})`, failures)
  report.silence = { words: silWords, warnings: silWarn }

  writeFileSync(join(outDir, 'transcribe-report.json'), JSON.stringify({ ...report, failures }, null, 2))
  console.log(`\nRTF ${rtf.toFixed(1)}× · precisão ${(s.accuracy * 100).toFixed(1)} % · início ≤ 300 ms ${(s.within300 * 100).toFixed(1)} % · cancelamento ${cancelMs} ms`)
  console.log(failures.length ? `\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}` : '\nTESTE DE TRANSCRIÇÃO PASSOU')
  return failures.length ? 1 : 0
}
