// QA do diálogo de exportação do editor (Task 12) via CDP, com cliques sintéticos despachados nos
// elementos (nunca entrada do sistema operacional).
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-export.mjs   → abre o app (CIALIGHT_QA=editor-fixture, CIALIGHT_RAW_DIR=test-out/raw),
//                                          exporta a fixture no preset WhatsApp para test-out/qa-export e fecha
//
// Screenshots em docs/qa/editor-f1/: formulário, Reels 9:16 desativado em projeto 16:9, progresso e concluído.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9334'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f1')
const OUT = join(ROOT, 'test-out', 'qa-export')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')

mkdirSync(SHOTS, { recursive: true })
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw' },
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
  for (let i = 0; i < 90; i++) {
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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// clique no botão/elemento cujo texto contém `text` (dentro de `scope`)
const CLICK = (scope, text) => `{
  const root = ${scope === 'dialog' ? `document.querySelector('[role="dialog"]')` : 'document'}
  const el = [...root.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))
  if (!el) throw new Error('não achei o botão ' + ${JSON.stringify(text)})
  el.click()
}`
const dialogText = `return document.querySelector('[role="dialog"]')?.textContent ?? ''`

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`)
    if (ok) break
    await sleep(1000)
  }
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; return 1`)
  await sleep(800)

  await ev(`${CLICK('header', 'Exportar')}; return 1`)
  await sleep(500)
  let text = await ev(dialogText)
  check('diálogo abre com os presets (F7)', ['YouTube 1080p', 'WhatsApp (até 64 MB)', 'Original (máxima)', 'Instagram Reels/Stories (9:16)'].every((p) => text.includes(p)), text)
  check('nome padrão = nome do projeto', await ev(`return document.querySelector('[role="dialog"] input').value`) === 'Projeto de teste do editor.mp4', null)
  check('estimativa de tamanho visível', /≈ [\d.,]+ MB/.test(text), text)
  await shot('export-dialog.png')

  // F7: o preset 9:16 fica desativado com o motivo num projeto 16:9 (nunca tarja/corte silenciosos)
  const reels = await ev(`const b = document.querySelector('[role="dialog"] [data-preset="reels"]'); return { disabled: b.disabled, title: b.title }`)
  check('Reels/Stories 9:16 em projeto 16:9: desativado com o motivo', reels.disabled === true && reels.title.includes('O projeto não é 9:16'), reels)
  await shot('export-dialog-vertical.png')

  await ev(`${CLICK('dialog', 'WhatsApp')}; return 1`)
  await sleep(200)
  text = await ev(dialogText)
  check('WhatsApp: 1280×720', text.includes('1280×720'), text)
  await ev(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Exportar').click(); return 1`)
  let sawProgress = false
  for (let i = 0; i < 600; i++) {
    text = await ev(dialogText)
    if (!sawProgress && /\d+%/.test(text) && text.includes('tempo real')) {
      sawProgress = true
      await shot('export-progress.png')
    }
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(100)
  }
  check('progresso com % e velocidade (× tempo real)', sawProgress, null)
  check('concluído sem erro', text.includes('Vídeo exportado') && text.includes('Abrir pasta') && text.includes('Copiar arquivo'), text)
  await shot('export-done.png')
  const files = readdirSync(OUT)
  check('arquivo final na pasta, sem .part', files.length === 1 && files[0] === 'Projeto de teste do editor.mp4', files)
  const playing = await ev(`return window.__qaEditor.store.getState().playing`)
  check('preview pausado/ocioso após exportar', playing === false, playing)
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
} finally {
  try {
    ws?.close()
  } catch {
    // ignorar
  }
  try {
    execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // já saiu
  }
  if (settingsBefore) {
    await sleep(500)
    const now = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
    if (!now || !now.equals(settingsBefore)) {
      writeFileSync(SETTINGS, settingsBefore)
      console.log('settings.json restaurado')
    } else console.log('settings.json intocado')
  }
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
