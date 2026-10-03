// QA da fila de exportações PERSISTENTE (G4, Task 1) via CDP, com mídia sintética (fixture do editor):
//  A) enfileira 2 exportações, grava o arquivo (test-out/export-queue.json), RECARREGA o app → toast "Retomar N
//     exportações pendentes" → Retomar → todas terminam (arquivos finais, nenhum .part) e o arquivo esvazia;
//  B) enfileira, recarrega, deixa um .part velho de um item (e um alheio) → Descartar → arquivo vazio, .part do item
//     apagado, o alheio intocado;
//  C) sair do editor com a fila ativa → "Sair e interromper": itens continuam no arquivo; reabrir o editor oferece
//     retomar de novo; Descartar limpa;
//  D) atalho de gravação (toggleRecord) no editor com a fila ativa → confirmação; "Continuar exportando" = fica no
//     editor, nada grava (a fase continua 'idle');
//  E) NADA é gravado no %APPDATA%\cialight-gravador (export-queue.json ausente/igual, settings.json intocado).
// Teclas/cliques sintéticos (CDP), nunca entrada do SO.
//
// uso (depois de `npm run build`, sob o lock):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "node scripts/qa/editor-g4-queue.mjs"
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'
import { guardSettings } from './settingsGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9336'
const OUT = join(ROOT, 'test-out', 'qa-g4-queue')
const QFILE = join(ROOT, 'test-out', 'export-queue.json')
const APPDATA_DIR = join(process.env.APPDATA ?? '', 'cialight-gravador')
const REAL_QFILE = join(APPDATA_DIR, 'export-queue.json')
const SETTINGS = join(APPDATA_DIR, 'settings.json')

rmSync(OUT, { recursive: true, force: true })
rmSync(QFILE, { force: true })
mkdirSync(OUT, { recursive: true })
const guard = guardSettings(SETTINGS)
const realBefore = existsSync(REAL_QFILE) ? statSync(REAL_QFILE).mtimeMs : null

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

const DLG = `document.querySelector('[role="dialog"]')`
const setInput = (sel, value) => `{
  const el = ${DLG}.querySelector(${JSON.stringify(sel)})
  if (!el) throw new Error('campo não encontrado: ' + ${JSON.stringify(sel)})
  el.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.blur()
}`
const clickText = (text) => `{
  const el = [...${DLG}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
  if (!el) throw new Error('não achei o botão ' + ${JSON.stringify(text)})
  el.click()
}`
const toasts = () => ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`)
const readQueueFile = () => {
  try {
    return JSON.parse(readFileSync(QFILE, 'utf8'))
  } catch {
    return null
  }
}
async function waitFor(fn, ms = 60000, step = 200) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(step)
  }
}
const waitToast = (needle, ms = 20000) => waitFor(async () => ((await toasts()).includes(needle) ? true : null), ms)

async function waitNavigate() {
  for (let i = 0; i < 80 && !(await ev(`return typeof window.__navigate === 'function'`).catch(() => false)); i++) await sleep(500)
}
async function openEditor() {
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(400)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`).catch(() => false)
    if (ok) break
    await sleep(1000)
  }
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; return 1`)
  await sleep(500)
}
// enfileira vídeos (youtube1080, Tudo) pelo diálogo, sem deixar o primeiro terminar antes do arquivo ser lido
async function enqueue(names) {
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(500)
  await ev(`${clickText('Vídeo')}; return 1`)
  await sleep(200)
  await ev(`${DLG}.querySelector('[data-preset="youtube1080"]').click(); return 1`)
  await ev(`${clickText('Tudo')}; return 1`)
  await sleep(200)
  for (const n of names) {
    await ev(`${setInput('[data-export-name]', n)}; return 1`)
    await sleep(120)
    await ev(`${DLG}.querySelector('[data-export-enqueue]').click(); return 1`)
    await sleep(250)
  }
  await key('Escape', 'Escape', 27)
  await sleep(300)
}
async function reload() {
  await send('Page.reload', {})
  await sleep(1500)
  await waitNavigate()
}
const finals = () => readdirSync(OUT).filter((f) => f.endsWith('.mp4'))
const parts = () => readdirSync(OUT).filter((f) => f.endsWith('.part'))

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false })
  await waitNavigate()

  // ---- A) recarrega com a fila ativa → oferta → Retomar ----
  await openEditor()
  await enqueue(['g4a-um.mp4', 'g4a-dois.mp4'])
  const fileA = await waitFor(() => {
    const f = readQueueFile()
    return f?.items?.length >= 1 ? f : null
  }, 10000, 50)
  check('o arquivo da fila (test-out/export-queue.json) foi gravado, versão 1, com os itens ativos', fileA?.version === 1 && fileA.items.length >= 1, fileA && { v: fileA.version, n: fileA.items.length })
  console.log(`  itens no arquivo antes de recarregar: ${fileA?.items?.map((i) => i.request.fileName).join(', ')}`)
  const nA = fileA?.items?.length ?? 0
  await reload()
  const offered = await waitToast('exportaç')
  const tA = await toasts()
  const wantA = `Retomar ${nA} ${nA === 1 ? 'exportação pendente' : 'exportações pendentes'}`
  check(`ao reabrir, toast "${wantA}" com Retomar e Descartar`, !!offered && tA.includes(wantA) && tA.includes('Retomar') && tA.includes('Descartar'), tA)
  const expected = fileA.items.map((i) => i.request.fileName.replace(/\.mp4$/, ''))
  await ev(`[...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === 'Retomar').click(); return 1`)
  const ended = await waitFor(() => {
    const f = readQueueFile()
    return f && f.items.length === 0 && finals().length >= expected.length && parts().length === 0 ? true : null
  }, 120000, 500)
  check('Retomar: todos terminam (arquivos finais, nenhum .part) e o arquivo esvazia', !!ended, { finals: finals(), parts: parts(), file: readQueueFile()?.items?.length })
  check('os arquivos finais têm o nome pedido', expected.every((e) => finals().some((f) => f.startsWith(e))), { expected, finals: finals() })
  await sleep(500)
  check('o toast de oferta some depois de retomar', !(await toasts()).includes('Retomar'), await toasts())

  // ---- B) Descartar: apaga o .part do item e esvazia o arquivo ----
  await openEditor()
  await enqueue(['g4b-um.mp4', 'g4b-dois.mp4'])
  const fileB = await waitFor(() => {
    const f = readQueueFile()
    return f?.items?.length >= 1 ? f : null
  }, 10000, 50)
  // o app é recarregado: um .part velho de um item da fila (deixado por uma queda) e um alheio
  await reload()
  await waitToast('exportaç')
  writeFileSync(join(OUT, 'g4b-um.mp4.part'), 'velho')
  writeFileSync(join(OUT, 'alheio.mp4.part'), 'não é nosso')
  // com a fila do arquivo anterior ainda sem retomar, esvaziar a que o QA gerou em B? não: descartar o que há
  const tB = await toasts()
  check('B: toast de oferta presente antes de descartar', tB.includes('Descartar'), tB)
  await ev(`[...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === 'Descartar').click(); return 1`)
  const cleared = await waitFor(() => (readQueueFile()?.items?.length === 0 ? true : null), 10000, 100)
  check('Descartar: o arquivo da fila fica vazio', !!cleared, readQueueFile())
  check('Descartar: o .part do item foi apagado e o alheio ficou', !existsSync(join(OUT, 'g4b-um.mp4.part')) && existsSync(join(OUT, 'alheio.mp4.part')), readdirSync(OUT))
  check('B: nada foi exportado (descartado)', !finals().some((f) => f.startsWith('g4b-')) || fileB.items.length < 2, finals())
  rmSync(join(OUT, 'alheio.mp4.part'), { force: true })

  // ---- C) sair do editor com a fila ativa: interrompe, itens ficam salvos; reabrir oferece retomar ----
  await openEditor()
  await ev(`window.__qaEditor.queue.clearFinished(); return 1`)
  await enqueue(['g4c-um.mp4', 'g4c-dois.mp4', 'g4c-tres.mp4'])
  await ev(`document.querySelector('button[aria-label="Voltar aos projetos"]').click(); return 1`)
  await sleep(500)
  const leaveText = await ev(`return document.querySelector('[data-queue-leave]')?.textContent ?? null`)
  check('sair com a fila ativa: texto novo ("interrompe… ficam salvas… retomá-las depois")', !!leaveText && /Sair interrompe a(s)? exporta/.test(leaveText) && leaveText.includes('retomá-la'), leaveText)
  await ev(`[...document.querySelector('[data-queue-leave]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sair e interromper').click(); return 1`)
  await sleep(1200)
  const fileC = readQueueFile()
  check('"Sair e interromper": os itens interrompidos continuam no arquivo (≥ 2) e o editor fechou', (fileC?.items?.length ?? 0) >= 2 && (await ev(`return !document.querySelector('[data-editor-topbar]')`)) === true, fileC && fileC.items.map((i) => i.request.fileName))
  await sleep(1500)
  check('nenhum .part de itens interrompidos fica na pasta de saída', parts().length === 0, parts())
  await openEditor()
  const offerC = await waitToast('exportaç')
  const tC = await toasts()
  check('reabrir o editor com itens guardados: oferta "Retomar N exportações pendentes"', !!offerC && /Retomar \d+ exporta/.test(tC), tC)
  await ev(`[...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === 'Descartar').click(); return 1`)
  check('Descartar (C): arquivo vazio', !!(await waitFor(() => (readQueueFile()?.items?.length === 0 ? true : null), 10000, 100)), readQueueFile())

  // ---- D) atalho de gravação no editor com a fila ativa: confirmação; cancelar = nada muda ----
  await enqueue(['g4d-um.mp4', 'g4d-dois.mp4'])
  await ev(`window.api.recording.sendCommand('toggleRecord'); return 1`)
  const dlg = await waitFor(async () => ((await ev(`return !!document.querySelector('[data-queue-leave]')`)) ? true : null), 5000, 100)
  check('atalho de gravação com a fila ativa: pergunta antes de sair do editor', !!dlg, null)
  await ev(`[...document.querySelector('[data-queue-leave]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continuar exportando').click(); return 1`)
  await sleep(600)
  const phase = await ev(`return { editor: !!document.querySelector('[data-editor-topbar]'), active: window.__qaEditor.queue.active() }`)
  check('"Continuar exportando": continua no editor com a fila intacta (nada gravou)', phase.editor && phase.active, phase)
  // confirmar: interrompe a fila, sai do editor e só então grava (a contagem regressiva de 3 s basta; cancela em seguida)
  await ev(`const src = (await window.api.sources.list()).screens[0]; if (!src) throw new Error('sem fonte de tela'); window.__qa.store.getState().setSelectedSource(src); return 1`)
  await ev(`window.api.recording.sendCommand('toggleRecord'); return 1`)
  await waitFor(async () => ((await ev(`return !!document.querySelector('[data-queue-leave]')`)) ? true : null), 5000, 100)
  await ev(`[...document.querySelector('[data-queue-leave]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sair e interromper').click(); return 1`)
  const rec = await waitFor(async () => {
    const st = await ev(`const s = window.__qa.store.getState(); return { screen: s.screen, phase: s.phase }`)
    return st.phase === 'countdown' || st.phase === 'recording' ? st : null
  }, 15000, 100)
  check('"Sair e interromper" pelo atalho: sai do editor e a gravação começa (contagem/gravando)', !!rec && rec.screen === 'recording', rec)
  await ev(`await window.__qa.controller.cancelRecording(); return 1`)
  await waitFor(async () => ((await ev(`return window.__qa.store.getState().phase`)) === 'idle' ? true : null), 15000, 100)
  const fileD = readQueueFile()
  check('D: a fila interrompida ficou no arquivo (g4d-*)', (fileD?.items ?? []).some((i) => i.request.fileName.startsWith('g4d-')), fileD?.items?.map((i) => i.request.fileName))
  await sleep(1000)

  // ---- E) nada no %APPDATA% real ----
  const realAfter = existsSync(REAL_QFILE) ? statSync(REAL_QFILE).mtimeMs : null
  check('%APPDATA%\\cialight-gravador\\export-queue.json não foi criado/alterado pelo teste', realBefore === realAfter, { realBefore, realAfter })
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
