// Medição de desempenho da exportação do editor (não é um teste de aprovação): vídeo sintético de N s (padrão
// 180 s, 1920×1080 @ 30 fps, testsrc2 — mais movimento que uma gravação de tela), com ou sem dois blurs pequenos,
// exportado pelo diálogo ("YouTube 1080p" → Exportar). Mede o tempo real, a velocidade (× tempo real) e a
// estimativa de tempo restante que o diálogo mostra ao longo da exportação.
//
// uso (depois de `npm run build`, sob o lock):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "node scripts/qa/bench-export.mjs --seconds 180 --blur"
// Tudo em test-out/qa-bench (apagado no fim); restaura o settings.json (hash).
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const args = process.argv.slice(2)
const SECONDS = Number(args[args.indexOf('--seconds') + 1]) || 180
const BLUR = args.includes('--blur')
const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9338'
const TAG = process.env.BENCH_TAG ?? ''
const BENCH = join(ROOT, 'test-out', 'qa-bench' + TAG)
const OUT = join(BENCH, 'saida')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const hash = (b) => (b ? createHash('sha256').update(b).digest('hex') : null)

rmSync(BENCH, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw' + TAG, CIALIGHT_QA_FIXTURE_SECONDS: String(SECONDS), CIALIGHT_QA_FIXTURE_SIZE: '1920x1080' },
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws = null
let seq = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r) => (ws.onopen = r))
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m)
            pending.delete(m.id)
          }
        }
        return
      }
    } catch {
      // app ainda subindo
    }
    await sleep(1000)
  }
  throw new Error('janela do app não apareceu no CDP')
}
async function ev(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function waitFor(body, ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await ev(body)
    if (v) return v
    await sleep(300)
  }
  return null
}
const dialog = `document.querySelector('[role="dialog"]')`

let code = 0
try {
  await connect()
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  const ready = await waitFor(`const s = window.__qaEditor?.store.getState(); return s?.project?.assets?.length && s.project.assets.every((a) => a.status === 'ready')`, 600000)
  if (!ready) throw new Error('mídias do fixture não ficaram prontas')
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; return 1`)
  if (BLUR) {
    const fx = (id, r) => ({
      id, type: 'effect', effect: 'blur', startUs: 0, durationUs: SECONDS * 1e6,
      region: { shape: 'rect', x: { value: r.x }, y: { value: r.y }, w: { value: r.w }, h: { value: r.h }, rotation: { value: 0 } },
      strength: { value: 80 }, feather: 0, color: '#000000', invert: false, scope: 'below'
    })
    const track = (id, name, item) => ({ id, kind: 'video', name, muted: false, hidden: false, locked: false, volume: 1, role: 'effects', items: [item] })
    const tracks = [track('t_bench_1', 'Efeitos', fx('i_bench_1', { x: 0.25, y: 0.3, w: 0.15, h: 0.1 })), track('t_bench_2', 'Efeitos 2', fx('i_bench_2', { x: 0.7, y: 0.75, w: 0.2, h: 0.08 }))]
    await ev(`return window.__qaEditor.store.getState().apply((p) => {
      const last = p.tracks.reduce((m, t, i) => (t.kind === 'video' ? i : m), -1)
      const tracks = [...p.tracks]; tracks.splice(last + 1, 0, ...${JSON.stringify(tracks)}); return { ...p, tracks } })`)
  }
  await sleep(1500)
  await ev(`[...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar')).click(); return 1`)
  await waitFor(`return ${dialog} ? 1 : null`, 10000)
  await ev(`[...${dialog}.querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith('YouTube 1080p')).click(); return 1`)
  await sleep(500)
  await ev(`[...${dialog}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Exportar').click(); return 1`)
  const t0 = Date.now()
  const samples = []
  let text = ''
  for (;;) {
    text = (await ev(`return ${dialog}?.textContent ?? ''`)) ?? ''
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    const s = (Date.now() - t0) / 1000
    const pct = text.match(/(\d+)\s?%/)?.[1]
    const eta = text.match(/(?:falta|restam?|resta)[^0-9]*([0-9][^·|]*)/i)?.[0] ?? text.match(/\d+\s?min[^·]*|\d+\s?s(?:eg)?\b[^·]*/)?.[0]
    if (!samples.length || s - samples[samples.length - 1].s >= 5) samples.push({ s: Math.round(s), pct, eta: eta?.trim().slice(0, 40) })
    if (s > 3600) throw new Error('mais de 1 h')
    await sleep(250)
  }
  const total = (Date.now() - t0) / 1000
  const profile = await ev(`return globalThis.__exportProfile ?? null`)
  const file = readdirSync(OUT).find((f) => f.endsWith('.mp4'))
  const result = {
    seconds: SECONDS, blur: BLUR, ok: text.includes('Vídeo exportado'), totalS: Math.round(total * 10) / 10,
    speedX: Math.round((SECONDS / total) * 100) / 100, fps: Math.round(((SECONDS * 30) / total) * 10) / 10,
    profile, sizeMB: file ? Math.round(statSync(join(OUT, file)).size / 1e5) / 10 : null, done: text.replace(/\s+/g, ' ').slice(0, 220), samples
  }
  console.log(JSON.stringify(result, null, 2))
  writeFileSync(join(ROOT, 'test-out', `bench-export-${SECONDS}s${BLUR ? '-blur' : ''}${TAG}.json`), JSON.stringify(result, null, 2))
  if (!result.ok) code = 1
} catch (e) {
  console.error('falhou:', e)
  code = 1
} finally {
  try { ws?.close() } catch {}
  app.kill()
  await sleep(1500)
  if (settingsBefore && hash(readFileSync(SETTINGS)) !== hash(settingsBefore)) {
    writeFileSync(SETTINGS, settingsBefore)
    console.log('settings.json restaurado')
  } else console.log('settings.json intocado')
  rmSync(BENCH, { recursive: true, force: true })
}
process.exit(code)
