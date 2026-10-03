// QA do aviso de FONTE AUSENTE (G4, Task 4) via CDP, com o projeto sintético do editor (fixture):
//  textos com a família "Fonte Que Não Existe G4" → aviso no inspetor e no diálogo de exportação; "Trocar para
//  Manrope" some com o aviso (um passo de desfazer, toast com "Ctrl+Z desfaz."); Ctrl+Z (Input.dispatchKeyEvent,
//  nunca entrada do SO) traz o aviso de volta. Fontes instaladas (Arial) e a do app não geram aviso.
//
// uso (depois de `npm run build`, sob o lock):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "node scripts/qa/editor-g4-font.mjs"
import { spawn, execFileSync } from 'child_process'
import { join, resolve } from 'path'
import electronPath from 'electron'
import { guardSettings } from './settingsGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9337'
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const MISSING = 'Fonte Que Não Existe G4'
const MSG = `A fonte “${MISSING}” não está instalada; usando a fonte padrão sem serifa.`

const guard = guardSettings(SETTINGS)
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
async function key(k, code, vk, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(step)
  }
}
const st = `window.__qaEditor.store.getState()`
const DLG = `document.querySelector('[role="dialog"]')`
const notices = (scope) => ev(`return [...(${scope}).querySelectorAll('[data-missing-font]')].map((n) => n.textContent.trim())`)
const fonts = () => ev(`return ${st}.project.tracks.flatMap((t) => t.items).filter((i) => i.type === 'text').map((i) => i.style.font)`)
const past = () => ev(`return ${st}.history.past.length`)
const toasts = () => ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
const clickIn = (scope, text) =>
  ev(`const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('sem botão ' + ${JSON.stringify(text)}); b.click(); return 1`)
const setFont = (id, font) =>
  ev(`${st}.apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === ${JSON.stringify(id)} ? { ...i, style: { ...i.style, font: ${JSON.stringify(font)} } } : i)) })) })); return 1`)
const openExport = async () => {
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await waitFor(() => ev(`return !!${DLG}`))
  await sleep(500)
}

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 80 && !(await ev(`return typeof window.__navigate === 'function'`).catch(() => false)); i++) await sleep(500)
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(400)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`).catch(() => false)
    if (ok) break
    await sleep(1000)
  }
  await sleep(500)

  // dois textos (atalho T = título no playhead): um com a fonte ausente, outro com Arial (instalada)
  const ids = []
  for (let n = 0; n < 2; n++) {
    await ev(`document.activeElement?.blur?.(); ${st}.setPlayhead(${n * 4_000_000}); return 1`)
    await key('t', 'KeyT', 84)
    ids.push(await waitFor(() => ev(`return ${st}.selection[0] ?? null`)))
    await sleep(200)
  }
  check('dois textos criados', !!ids[0] && !!ids[1] && ids[0] !== ids[1], ids)
  await setFont(ids[1], 'Arial')
  await setFont(ids[0], MISSING)
  await ev(`${st}.select([${JSON.stringify(ids[0])}]); return 1`)
  const pastBase = await past()

  // ---- inspetor ----
  const n1 = await waitFor(async () => {
    const n = await notices('document')
    return n.length ? n : null
  })
  check('inspetor: aviso de fonte ausente com o texto exato', n1?.length === 1 && n1[0].includes(MSG), n1)
  check('inspetor: botão "Trocar para Manrope" presente', await ev(`return [...document.querySelectorAll('[data-missing-font] button')].some((b) => b.textContent.trim() === 'Trocar para Manrope')`))
  check('aviso é role="status"', await ev(`return document.querySelector('[data-missing-font]').getAttribute('role') === 'status'`))
  await ev(`${st}.select([${JSON.stringify(ids[1])}]); return 1`)
  await sleep(300)
  check('texto com Arial (instalada): sem aviso no inspetor', (await notices('document')).length === 0, await notices('document'))
  await ev(`${st}.select([${JSON.stringify(ids[0])}]); return 1`)
  await sleep(300)

  // ---- exportação ----
  await openExport()
  const n2 = await notices(DLG)
  check('exportação: aviso para a fonte ausente (uma linha; a do Arial não aparece)', n2.length === 1 && n2[0].includes(MSG), n2)
  await key('Escape', 'Escape', 27)
  await sleep(500)

  // ---- trocar no inspetor ----
  await clickIn('document', 'Trocar para Manrope')
  await sleep(400)
  const f1 = await fonts()
  check('Trocar: o texto selecionado virou Manrope Variable e o Arial ficou', f1.includes('Manrope Variable') && f1.includes('Arial') && !f1.includes(MISSING), f1)
  check('um único passo de desfazer', (await past()) === pastBase + 1, await past())
  check('aviso sumiu do inspetor', (await notices('document')).length === 0)
  const t1 = await toasts()
  check('toast "Fonte trocada para Manrope" com "Ctrl+Z desfaz."', t1.includes('Fonte trocada para Manrope') && t1.includes('Ctrl+Z desfaz.'), t1)
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('z', 'KeyZ', 90, 2)
  const back = await waitFor(async () => ((await notices('document')).length ? true : null))
  check('Ctrl+Z (CDP): o aviso volta e a fonte ausente também', !!back && (await fonts()).includes(MISSING), await fonts())

  // ---- trocar na exportação (todos os textos da família) ----
  await setFont(ids[1], MISSING)
  const pastB = await past()
  await openExport()
  const n3 = await notices(DLG)
  check('exportação: uma linha para a família repetida em 2 textos', n3.length === 1, n3)
  await clickIn(DLG, 'Trocar para Manrope')
  await sleep(400)
  const f2 = await fonts()
  check('exportação: todos os textos da família trocados num só passo', !f2.includes(MISSING) && (await past()) === pastB + 1, { f2, past: await past() })
  check('exportação: aviso some do diálogo', (await notices(DLG)).length === 0)
  check('o diálogo continua aberto (exportar não é bloqueado)', await ev(`return !!${DLG}`))
  await key('Escape', 'Escape', 27)
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
  await sleep(500)
  failures += guard.finish()
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
