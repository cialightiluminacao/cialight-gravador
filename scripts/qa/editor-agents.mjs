// Real MCP client -> packaged connector -> local pipe -> Electron editor -> compositor -> MP4.
// Uses a separate profile and synthetic media exclusively inside test-out/.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { synthSpeech } from './synthSpeech.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'test-out', 'agents', String(Date.now()))
const PROFILE = join(OUT, 'profile'), PORT = 9473
mkdirSync(PROFILE, { recursive: true })
const checks = []
const check = (name, condition, detail) => { checks.push({ name, passed: !!condition, detail }); console.log(`${condition ? 'OK' : 'FAIL'} ${name}`); if (!condition) throw new Error(name + ': ' + JSON.stringify(detail)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, timeout = 120000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(300) }
  throw new Error('Prazo esgotado: ' + JSON.stringify(last))
}

let app, ws, transport, client
let appErrors = ''
const pending = new Map()
let seq = 0
async function evaluate(body) {
  const id = ++seq
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')) }, 30000)
    pending.set(id, message => { clearTimeout(timer); resolve(message) })
  })
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true } }))
  const result = await response
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails))
  return result.result?.result?.value
}
async function raw(tool, args = {}) { return client.callTool({ name: tool, arguments: args }) }
async function call(tool, args = {}) {
  const result = await raw(tool, args)
  const text = result.content?.find(c => c.type === 'text')?.text ?? '{}'
  if (result.isError) throw new Error(`${tool}: ${text}`)
  return { ...JSON.parse(text), images: result.content?.filter(c => c.type === 'image') ?? [] }
}
try {
  const wav = join(OUT, 'fala.wav')
  const speech = await synthSpeech({ outWav: wav, ssmlOrText: '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-BR">Olá. Esta é uma demonstração do nosso editor.<break time="1400ms"/>Agora podemos editar vídeos e gerar legendas automaticamente.</speak>' })
  const video = join(OUT, 'demonstração.mp4')
  execFileSync(join(ROOT, 'resources/ffmpeg/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x12345a:s=640x360:r=24', '-i', wav, '-t', String(speech.durationUs / 1e6), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], { windowsHide: true })
  const environment = { ...process.env, CIALIGHT_QA: 'agents', CIALIGHT_QA_USER_DATA: PROFILE, CIALIGHT_RAW_DIR: join(OUT, 'Brutos'), CIALIGHT_WHISPER_MODELS_DIR: join(ROOT, 'test-out/whisper-models') }
  delete environment.ELECTRON_RUN_AS_NODE
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  app.stderr.on('data', chunk => { appErrors = (appErrors + chunk).slice(-10000) })
  const page = await until(async () => {
    if (app.exitCode !== null) throw new Error(`Aplicativo encerrou (${app.exitCode}): ${appErrors}`)
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page' && t.url.includes('index.html')) } catch { return false }
  }, 40000)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = r })
  ws.onmessage = event => { const result = JSON.parse(event.data); if (result.id && pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id) } }
  await until(() => evaluate('return !!window.api?.agents'))
  await evaluate('await window.api.agents.enable(true); return true')
  const connection = join(PROFILE, 'agents/connection.json')
  check('Perfil e conexão isolados', existsSync(connection))
  transport = new StdioClientTransport({ command: process.env.CIALIGHT_MCP_EXECUTABLE ?? process.execPath, args: [join(ROOT, 'resources/agents/mcp.cjs'), '--connection', connection], env: { ...process.env, ...(process.env.CIALIGHT_MCP_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stderr: 'pipe' })
  client = new Client({ name: 'cialight-qa', version: '1.0.0' })
  await client.connect(transport)
  const tools = await client.listTools()
  check('MCP anuncia as dez ferramentas', tools.tools.length === 10, tools.tools.map(t => t.name))
  const created = await call('cialight_projects', { action: 'create', name: 'Teste completo dos agentes' })
  const projectId = created.projectId
  let current = await call('cialight_inspect', { projectId })
  const imported = await call('cialight_import', { projectId, revision: current.revision, paths: [video] })
  check('Importação real pelo MCP', imported.assets.length === 1 && imported.assets[0].status !== 'error')
  await until(async () => { current = await call('cialight_inspect', { projectId }); return current.project.assets.every(a => a.status === 'ready') })
  const assetId = current.project.assets[0].id
  const staleRevision = current.revision
  const assembled = await call('cialight_edit', { projectId, revision: current.revision, actions: [{ type: 'add_media', assetId, at: 0 }] })
  check('Vídeo e áudio vinculados na timeline', assembled.createdIds.length === 2)
  const conflict = await raw('cialight_edit', { projectId, revision: staleRevision, actions: [{ type: 'rename', name: 'Não deve mudar' }] })
  check('Conflito impede sobrescrever edição', conflict.isError)
  current = await call('cialight_inspect', { projectId })
  const dry = await call('cialight_edit', { projectId, revision: current.revision, dryRun: true, actions: [{ type: 'text', at: 0, duration: 2, text: 'Prévia não aplicada' }] })
  check('Simulação não altera a revisão', dry.revision === current.revision)
  const batch = await call('cialight_edit', { projectId, revision: current.revision, actions: [{ type: 'text', at: 0, duration: 2, text: 'CiaLight com agentes' }, { type: 'marker', at: 1, label: 'Conferir' }] })
  await call('cialight_history', { projectId, revision: batch.revision, action: 'undo' })
  current = await call('cialight_inspect', { projectId })
  check('Um desfazer remove o lote inteiro', current.project.markers.length === 0 && !current.project.tracks.some(t => t.items.some(i => i.type === 'text')))
  await call('cialight_history', { projectId, revision: current.revision, action: 'redo' })
  current = await call('cialight_inspect', { projectId })
  const preview = await call('cialight_preview', { projectId, at: 1 })
  check('Prévia retorna PNG do compositor', preview.images.length === 1 && preview.width <= 1280)
  writeFileSync(join(OUT, 'preview.png'), Buffer.from(preview.images[0].data, 'base64'))
  const silence = await call('cialight_analyze', { projectId, revision: current.revision, task: 'silences', apply: false })
  const silenceResult = await until(async () => { const r = await call('cialight_jobs', { jobId: silence.jobId }); return r.jobs[0].state !== 'running' ? r.jobs[0] : false })
  check('Análise real detecta a pausa sintetizada', silenceResult.state === 'done' && silenceResult.result.silences.savedSeconds > 0.5, silenceResult)
  current = await call('cialight_inspect', { projectId })
  const cancelledJob = await call('cialight_analyze', { projectId, revision: current.revision, task: 'transcribe', apply: true })
  await call('cialight_jobs', { jobId: cancelledJob.jobId, cancel: true })
  const cancelled = await until(async () => { const r = await call('cialight_jobs', { jobId: cancelledJob.jobId }); return r.jobs[0].state !== 'running' ? r.jobs[0] : false })
  check('Cancelar análise preserva a timeline', cancelled.state === 'cancelled' && !(await call('cialight_inspect', { projectId })).project.tracks.some(t => t.role === 'captions'))
  current = await call('cialight_inspect', { projectId })
  const conflictingJob = await call('cialight_analyze', { projectId, revision: current.revision, task: 'transcribe', apply: true })
  await call('cialight_edit', { projectId, revision: current.revision, actions: [{ type: 'rename', name: 'Edição manual preservada' }] })
  const conflicted = await until(async () => { const r = await call('cialight_jobs', { jobId: conflictingJob.jobId }); return r.jobs[0].state !== 'running' ? r.jobs[0] : false })
  check('Análise não sobrescreve alterações posteriores', conflicted.state === 'error' && /Conflito/.test(conflicted.error) && (await call('cialight_inspect', { projectId })).project.name === 'Edição manual preservada', conflicted)
  current = await call('cialight_inspect', { projectId })
  const analysis = await call('cialight_analyze', { projectId, revision: current.revision, task: 'prepare', apply: true, model: 'base' })
  const analyzed = await until(async () => { const r = await call('cialight_jobs', { jobId: analysis.jobId }); return r.jobs[0].state !== 'running' ? r.jobs[0] : false }, 240000)
  check('Preparação completa: corte, voz e legendas locais', analyzed.state === 'done' && analyzed.result.captions > 0, analyzed)
  await until(async () => { const s = await call('cialight_status'); return Object.keys(s.audioJobs).length === 0 })
  current = await call('cialight_inspect', { projectId })
  const preparedDuration = current.duration
  const exported = await call('cialight_export', { projectId, revision: current.revision, preset: 'youtube1080', outputDir: OUT, fileName: 'agentes-final' })
  const final = await until(async () => { const r = await call('cialight_jobs', { jobId: exported.jobId }); return !['running', 'pending'].includes(r.jobs[0].state) ? r.jobs[0] : false }, 240000)
  check('Exportação real conclui pelo compositor', final.state === 'done' && existsSync(final.result.path), final)
  const metadata = JSON.parse(execFileSync(join(ROOT, 'resources/ffmpeg/ffprobe.exe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', final.result.path], { encoding: 'utf8', windowsHide: true }))
  check('MP4 completo tem vídeo, áudio e a duração editada', metadata.streams.some(s => s.codec_type === 'video') && metadata.streams.some(s => s.codec_type === 'audio') && Math.abs(Number(metadata.format.duration) - preparedDuration) < 0.15)
  const audioStats = spawnSync(join(ROOT, 'resources/ffmpeg/ffmpeg.exe'), ['-hide_banner', '-i', final.result.path, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true })
  const meanVolume = Number(/mean_volume:\s*([-\d.]+) dB/.exec(audioStats.stderr)?.[1] ?? NaN)
  check('Voz exportada contém sinal audível', audioStats.status === 0 && Number.isFinite(meanVolume) && meanVolume > -60, meanVolume)
  await evaluate("document.querySelector('[aria-label=\"Agentes de IA\"]').click(); return true")
  await sleep(400)
  const shot = await new Promise(resolve => {
    const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  writeFileSync(join(OUT, 'agents-panel.png'), Buffer.from(shot.result.data, 'base64'))
  await evaluate('await window.api.agents.enable(false); return true')
  const disabled = await raw('cialight_status')
  check('Desativar conexão impede novos comandos', disabled.isError && !existsSync(connection))
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ checks, video: final.result.path, metadata, appErrors }, null, 2))
  console.log(`Resultado: ${OUT}`)
} finally {
  await client?.close().catch(() => {})
  ws?.close()
  app?.kill()
  writeFileSync(join(OUT, 'checks.json'), JSON.stringify(checks, null, 2))
  writeFileSync(join(OUT, 'app-errors.log'), appErrors)
}
