// QA das Legendas e do SRT (F5 Task 6) via CDP, com eventos sintéticos despachados nos elementos reais da página —
// nunca entrada do sistema operacional. Os diálogos de abrir/salvar SRT são trocados por caminhos fixos de teste em
// test-out/qa-captions (CIALIGHT_QA_SRT_OPEN / CIALIGHT_QA_SRT_SAVE, aceitos só fora do pacote e com CIALIGHT_QA): a
// leitura (detecção de codificação) e a gravação (UTF-8 com BOM) são as do main.
//
// uso (depois de `npm run build`; SEMPRE sob o lock das execuções do Electron):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs node scripts/qa/editor-f5-captions.mjs
//   node scripts/qa/editor-f5-captions.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333 (e os env)
//
// Confere: (1) aba Legendas vazia; (2) "Nova legenda no playhead" + Enter no texto da última cria a próxima no playhead
// e foca nela (um passo por gesto); (3) editar início/fim em mm:ss,mmm (inválido e sobreposição avisam e não mudam);
// (4) clicar numa linha leva o playhead ao início; (5) estilo comum (fundo, posição vertical) muda todas num passo e os
// pixels do preview; (6) importar SRT Windows-1252 com blocos quebrados: substituir/acrescentar, avisos no toast e no
// resumo, um passo de desfazer; (7) exportar SRT (UTF-8 com BOM, conteúdo esperado); (8) exportação de vídeo com
// "Salvar arquivo .srt ao lado" no intervalo I–O (tempos deslocados) e a escolha lembrada na sessão; (9) textos pt-BR.
// Compara o sha256 do settings.json antes/depois. Screenshots em docs/qa/editor-f5/ (só mídia sintética).
import { spawn, execFileSync } from 'child_process'
import { guardSettings } from './settingsGuard.mjs'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'
import { guardShot } from './shotGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f5')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const QA = join(ROOT, 'test-out', 'qa-captions')
const SRT_IN = join(QA, 'importar.srt')
const SRT_OUT = join(QA, 'exportado.srt')
const EXPORT_DIR = join(QA, 'video')
const S = 1_000_000

mkdirSync(SHOTS, { recursive: true })
rmSync(QA, { recursive: true, force: true })
mkdirSync(EXPORT_DIR, { recursive: true })

// SRT de teste em Windows-1252 (sem BOM): acentos, aspas curvas, travessão, tags, um bloco ilegível, um com fim antes
// do início e duas cues sobrepostas
const CP1252 = { '“': 0x93, '”': 0x94, '—': 0x97 }
const cp1252 = (s) => Buffer.from([...s].map((ch) => CP1252[ch] ?? ch.charCodeAt(0)))
const SRT_TEXT = [
  '1', '00:00:07,000 --> 00:00:08,500', 'Importada: ação e coração', '',
  '2', '00:00:08,500 --> 00:00:10,000', '<i>Segunda</i> — “aspas”', '',
  'lixo sem tempo', '',
  '4', '00:00:11,000 --> 00:00:10,000', 'fim antes do início', '',
  '5', '00:00:10,000 --> 00:00:12,000', '{\\an8}Terceira, sobreposta', '',
  '6', '00:00:11,500 --> 00:00:13,000', 'Quarta', ''
].join('\r\n')
writeFileSync(SRT_IN, cp1252(SRT_TEXT))

const settings = guardSettings(SETTINGS)

let app = null
if (!ATTACH) {
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw', CIALIGHT_QA_SRT_OPEN: SRT_IN, CIALIGHT_QA_SRT_SAVE: SRT_OUT },
    stdio: 'ignore'
  })
}

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
          } else if (m.method === 'Runtime.exceptionThrown') console.log(`  [página] exceção: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`)
          else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log(`  [página] erro: ${m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 600)}`)
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

/** Avalia `body` (corpo de função async, com os helpers em `T`) na página e devolve o valor. */
async function ev(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__cq; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await guardShot(send)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  [captura] ${name}`)
}
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}

let failures = 0
let checks = 0
function check(name, ok, detail) {
  checks++
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// SRT canônico (o mesmo formato de src/shared/editor/srt.ts serializeSrt) para comparar o arquivo gravado
const p2 = (n, w = 2) => String(n).padStart(w, '0')
const srtTime = (us) => {
  const t = Math.round(us / 1000)
  return `${p2(Math.floor(t / 3_600_000))}:${p2(Math.floor(t / 60_000) % 60)}:${p2(Math.floor(t / 1000) % 60)},${p2(t % 1000, 3)}`
}
const serialize = (cues) => cues.map((c, i) => `${i + 1}\r\n${srtTime(c.startUs)} --> ${srtTime(c.endUs)}\r\n${c.text.split('\n').join('\r\n')}\r\n`).join('\r\n')
const readSrt = (f) => {
  const b = readFileSync(f)
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  return { bom, text: b.subarray(bom ? 3 : 0).toString('utf8') }
}

const HELPERS = `
window.__cq = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel, root = document) => { const e = root.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel, root = document) => [...root.querySelectorAll(sel)]
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const click = async (e) => {
    const { x, y } = center(e)
    e.dispatchEvent(pe('pointerdown', x, y)); e.dispatchEvent(me('mousedown', x, y))
    e.dispatchEvent(pe('pointerup', x, y)); e.dispatchEvent(me('mouseup', x, y)); e.dispatchEvent(me('click', x, y))
    await settle()
  }
  const key = async (k, mods, target) => { (target || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const setNative = (e, v) => {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v)
    e.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(500); await settle() }
  // toasts já vistos ficam de fora (nunca remover os nós do sonner: o React dele quebra)
  const seen = new WeakSet()
  const toasts = () => all('[data-sonner-toast]').filter((t) => !seen.has(t)).map((t) => t.textContent)
  const clearToasts = async () => { for (const t of all('[data-sonner-toast]')) seen.add(t); await settle() }
  const capTrack = () => st().project.tracks.find((t) => t.role === 'captions')
  const caps = () => (capTrack()?.items ?? []).map((i) => ({ id: i.id, s: i.startUs, e: i.startUs + i.durationUs, text: i.text, enabled: i.enabled !== false, bg: i.style.background ?? null, y: i.visual.transform.y.value }))
  const row = (id) => el('[data-caption-id="' + id + '"]')
  const panel = () => el('[data-captions-panel]')
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const dialog = () => document.querySelector('[role="dialog"]')
  const tab = async (label) => { const t = all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').find((x) => x.textContent.trim() === label); if (!t) throw new Error('aba ' + label); t.dispatchEvent(pe('pointerdown', 0, 0)); t.dispatchEvent(me('mousedown', 0, 0)); t.click(); await settle(); await wait(150) }
  const region = async (x, y, w, h) => {
    const r = window.__qaEditor.engine.render
    const k = (r.size.width * r.size.dpr) / st().project.canvas.width
    return r.readPixels(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
  }
  const diffCount = (a, b, thr = 24) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) { if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > thr) n++ } return n }
  /** Digita no elemento focado (textarea/input) e tecla Enter nele. */
  const typeEnter = async (text) => { const a = document.activeElement; setNative(a, text); await settle(); await key('Enter', {}, a); await settle(); await wait(100); await settle() }
  return { st, settle, wait, el, all, click, key, setNative, past, seek, toasts, clearToasts, capTrack, caps, row, panel, button, dialog, tab, region, diffCount, typeEnter }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await viewport(1366, 900)
  for (let i = 0; i < 60 && !(await ev0(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev0(`localStorage.setItem('editor.timelineHeight', '260'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev0(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev0(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]')`)
    if (ok) break
    await sleep(1000)
  }
  await ev0(HELPERS + '; return 1')

  // ------------------------------------------------------------------ 1
  console.log('1. aba Legendas (vazia)')
  {
    const r = await ev(`await T.tab('Legendas'); const p = T.panel()
      return { tabs: T.all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').map((x) => x.textContent.trim()), empty: p.textContent.includes('Nenhuma legenda ainda'), buttons: T.all('button', p).map((b) => b.textContent.trim()), caps: T.caps().length }`)
    check('abas: … Transições, Legendas, Modelos', JSON.stringify(r.tabs) === JSON.stringify(['Mídia', 'Áudio', 'Gravações', 'Efeitos', 'Texto', 'Transições', 'Legendas', 'Modelos']), r.tabs)
    check('estado vazio e botões pt-BR (Nova legenda no playhead, Importar SRT…, Exportar SRT…)', r.empty && r.caps === 0 && ['Nova legenda no playhead', 'Importar SRT…', 'Exportar SRT…'].every((b) => r.buttons.includes(b)), r)
    await shot('f5-captions-01-vazia.png')
  }

  // ------------------------------------------------------------------ 2
  console.log('2. Nova legenda no playhead + Enter cria a próxima e foca nela')
  let ids
  {
    const r = await ev(`const p0 = T.past(); await T.seek(${1 * S}); await T.click(T.el('[data-caption-add]')); await T.wait(150); await T.settle()
      const c = T.caps(); const a = document.activeElement
      const focus1 = a?.matches('[data-caption-text]') && a.closest('[data-caption-id]')?.getAttribute('data-caption-id') === c[0]?.id
      const selected = a ? a.value.slice(a.selectionStart, a.selectionEnd) : null
      await T.typeEnter('Olá, mundo')
      const after1 = T.caps()
      return { p0, c, focus1, selected, after1, past: T.past() }`)
    check('nova legenda em 1 s, 2 s, foco no texto com "Nova legenda" selecionado', r.c.length === 1 && r.c[0].s === S && r.c[0].e === 3 * S && r.focus1 && r.selected === 'Nova legenda', r)
    check('Enter na última (playhead dentro dela): texto gravado e a próxima logo depois (3 s)', r.after1.length === 2 && r.after1[0].text === 'Olá, mundo' && r.after1[1].s === 3 * S, r.after1)
    // playhead adiante (como tocando): a próxima nasce no playhead
    const r2 = await ev(`const a = document.activeElement
      const focusNew = a?.closest('[data-caption-id]')?.getAttribute('data-caption-id') === T.caps()[1].id
      T.setNative(a, 'Segunda legenda'); await T.settle()
      await T.seek(${6 * S})
      await T.key('Enter', {}, a); await T.settle(); await T.wait(100); await T.settle()
      const b = document.activeElement
      const focus3 = b?.closest('[data-caption-id]')?.getAttribute('data-caption-id') === T.caps()[2]?.id
      await T.typeEnter('Terceira')
      document.activeElement?.blur?.(); await T.settle()
      return { focusNew, focus3, caps: T.caps(), past: T.past() }`)
    // a 4ª nasceu com o último Enter (logo depois da 3ª: playhead dentro dela): sai pelo botão excluir (um passo)
    const r3 = await ev(`const before = T.caps(); document.activeElement?.blur?.(); await T.click(T.el('[data-caption-id="' + before[3].id + '"] [data-caption-delete]')); await T.wait(150); return { before, caps: T.caps(), past: T.past() }`)
    // Enter na última = um gesto: desfazer tira a legenda nova E o texto confirmado juntos (refeito em seguida)
    const r4 = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(150); const undone = T.caps().map((c) => c.text)
      await T.key('z', { ctrlKey: true }); await T.wait(150); const undone2 = T.caps().map((c) => c.text)
      await T.key('z', { ctrlKey: true, shiftKey: true }); await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(150)
      return { undone, undone2, caps: T.caps().map((c) => c.text), past: T.past() }`)
    check('foco passa para a legenda criada a cada Enter', r2.focusNew && r2.focus3, r2)
    check('playhead adiante (6 s): a 3ª nasce no playhead; a 4ª logo depois da 3ª (8 s)', r2.caps[2]?.s === 6 * S && r2.caps[3]?.s === 8 * S, r2.caps)
    check('textos gravados: Olá, mundo / Segunda legenda / Terceira', JSON.stringify(r2.caps.slice(0, 3).map((c) => c.text)) === JSON.stringify(['Olá, mundo', 'Segunda legenda', 'Terceira']), r2.caps)
    check('um passo por gesto: botão + 3 × (Enter = texto e próxima legenda) = 4 passos', r2.past - r.p0 === 4, { p0: r.p0, past: r2.past })
    check('excluir a 4ª legenda ("Nova legenda") num passo', r3.before.length === 4 && r3.before[3].text === 'Nova legenda' && r3.caps.length === 3 && r3.past === r2.past + 1, r3)
    check('desfazer o Enter: volta a legenda criada e o texto juntos ("Terceira" → "Nova legenda", 3 → 2 legendas)', JSON.stringify(r4.undone) === JSON.stringify(['Olá, mundo', 'Segunda legenda', 'Terceira', 'Nova legenda']) && JSON.stringify(r4.undone2) === JSON.stringify(['Olá, mundo', 'Segunda legenda', 'Nova legenda']) && JSON.stringify(r4.caps) === JSON.stringify(['Olá, mundo', 'Segunda legenda', 'Terceira']), r4)
    ids = r3.caps.map((c) => c.id)
    await shot('f5-captions-02-lista.png')
  }

  // ------------------------------------------------------------------ 3
  console.log('3. editar início/fim (mm:ss,mmm)')
  {
    const r = await ev(`await T.clearToasts(); const p0 = T.past()
      const field = (id, f) => T.el('[data-caption-id="' + id + '"] [data-caption-time="' + f + '"]')
      const edit = async (id, f, v) => { const i = field(id, f); i.focus(); T.setNative(i, v); await T.key('Enter', {}, i); await T.wait(120); await T.settle() }
      await edit(${JSON.stringify(ids[1])}, 'start', '00:03,200')
      const ok = T.caps()[1]; const p1 = T.past(); const shown = field(${JSON.stringify(ids[1])}, 'start').value
      await edit(${JSON.stringify(ids[1])}, 'end', 'abc')
      const bad = { cap: T.caps()[1], toasts: T.toasts(), value: field(${JSON.stringify(ids[1])}, 'end').value, past: T.past() }
      await T.clearToasts()
      await edit(${JSON.stringify(ids[0])}, 'end', '00:04,000')
      const ov = { cap: T.caps()[0], toasts: T.toasts(), value: field(${JSON.stringify(ids[0])}, 'end').value, past: T.past() }
      return { p0, ok, p1, shown, bad, ov }`)
    check('início da 2ª → 3,2 s (fim mantido em 5 s) num passo; campo mostra 00:03,200', r.ok.s === 3.2 * S && r.ok.e === 5 * S && r.p1 === r.p0 + 1 && r.shown === '00:03,200', r)
    check('tempo ilegível: aviso "Tempo inválido", nada muda, campo volta ao valor', r.bad.cap.e === 5 * S && r.bad.past === r.p1 && r.bad.toasts.some((t) => t.includes('Tempo inválido')) && r.bad.value === '00:05,000', r.bad)
    check('fim da 1ª sobre a 2ª: aviso de sobreposição, nada muda', r.ov.cap.e === 3 * S && r.ov.past === r.p1 && r.ov.toasts.some((t) => t.includes('sobreporia')) && r.ov.value === '00:03,000', r.ov)
    await ev(`await T.clearToasts(); return 1`)
  }

  // ------------------------------------------------------------------ 4
  console.log('4. clicar numa linha leva o playhead ao início')
  {
    const r = await ev(`await T.seek(0); await T.click(T.el('[data-caption-id="${ids[2]}"] span')); await T.wait(400)
      return { ph: T.st().playheadUs, sel: T.st().selection }`)
    check('playhead no início da 3ª legenda (6 s) e ela selecionada', r.ph === 6 * S && JSON.stringify(r.sel) === JSON.stringify([ids[2]]), r)
    // teclado: focar o campo de início também leva o playhead (sem mouse)
    const k = await ev(`await T.seek(0); T.el('[data-caption-id="${ids[1]}"] [data-caption-time="start"]').focus(); await T.settle(); await T.wait(400); const r = { ph: T.st().playheadUs, sel: T.st().selection }; document.activeElement?.blur?.(); await T.settle(); return r`)
    check('focar o início da 2ª pelo teclado leva o playhead a 3,2 s e a seleciona', k.ph === 3.2 * S && JSON.stringify(k.sel) === JSON.stringify([ids[1]]), k)
  }

  // ------------------------------------------------------------------ 5
  console.log('5. estilo comum (fundo, posição vertical)')
  {
    const r = await ev(`const p0 = T.past(); await T.seek(${6.5 * S}); await T.wait(500)
      const W = T.st().project.canvas.width, H = T.st().project.canvas.height
      const box = () => T.region(W * 0.3, H * 0.86, W * 0.4, H * 0.05)
      const before = await box()
      await T.click(T.el('button[role="switch"][aria-label="Fundo das legendas"]')); await T.wait(700); await T.settle()
      const off = { caps: T.caps(), past: T.past(), px: await box() }
      await T.click(T.el('button[role="switch"][aria-label="Fundo das legendas"]')); await T.wait(300)
      const on = { caps: T.caps(), past: T.past() }
      const pos = T.all('input[aria-label="Posição vertical"]', T.panel())[0]
      pos.focus(); await T.key('ArrowUp', {}, pos); pos.blur(); await T.settle()
      const moved = { caps: T.caps(), past: T.past() }
      return { p0, diff: T.diffCount(before, off.px), off, on, moved }`)
    check('desligar o fundo: todas sem fundo, um passo, o preview muda', r.off.caps.every((c) => c.bg === null) && r.off.past === r.p0 + 1 && r.diff > 50, { past: r.off.past, p0: r.p0, diff: r.diff })
    check('religar o fundo: #000000b3 em todas, um passo', r.on.caps.every((c) => c.bg === '#000000b3') && r.on.past === r.p0 + 2, r.on)
    check('posição vertical +1 % em todas (0,88 → 0,89), um passo', r.moved.caps.every((c) => Math.abs(c.y - 0.89) < 1e-9) && r.moved.past === r.p0 + 3, r.moved)
  }

  // ------------------------------------------------------------------ 6
  console.log('6. importar SRT (Windows-1252, blocos quebrados): substituir e acrescentar')
  {
    const r = await ev(`await T.clearToasts(); const p0 = T.past(); await T.click(T.el('[data-caption-import]')); await T.wait(800); await T.settle()
      const d = T.dialog(); return { p0, dialog: d?.textContent ?? null }`)
    check('já há legendas: pergunta Substituir/Acrescentar', !!r.dialog && r.dialog.includes('O projeto já tem 3 legendas') && r.dialog.includes('Substituir') && r.dialog.includes('Acrescentar') && r.dialog.includes('importar.srt'), r.dialog)
    await shot('f5-captions-03-importar-pergunta.png')
    const rep = await ev(`await T.click(T.el('[data-import-mode="replace"]')); await T.wait(400); await T.settle()
      return { caps: T.caps(), past: T.past(), toasts: T.toasts(), summary: document.querySelector('[data-import-warnings]')?.textContent ?? null }`)
    check('substituir: 4 legendas com acentos/aspas do Windows-1252 e sem tags', JSON.stringify(rep.caps.map((c) => [c.s / S, c.e / S, c.text])) === JSON.stringify([[7, 8.5, 'Importada: ação e coração'], [8.5, 10, 'Segunda — “aspas”'], [10, 11.5, 'Terceira, sobreposta'], [11.5, 13, 'Quarta']]), rep.caps)
    check('substituir mantém o estilo comum (fundo e posição 0,89)', rep.caps.every((c) => c.bg === '#000000b3' && Math.abs(c.y - 0.89) < 1e-9), rep.caps)
    check('importação = um passo de desfazer', rep.past === r.p0 + 1, { p0: r.p0, past: rep.past })
    check('toast com a contagem e os avisos (bloco 3 ilegível, bloco 4 fim antes do início, bloco 5 sobreposto)', rep.toasts.some((t) => t.includes('4 legendas importadas de “importar.srt”') && t.includes('Bloco 3') && t.includes('Bloco 4') && t.includes('Bloco 5')), rep.toasts)
    check('resumo dos avisos na aba (3 avisos)', !!rep.summary && rep.summary.includes('3 avisos ao importar “importar.srt”'), rep.summary)
    await shot('f5-captions-04-importado.png')
    const app = await ev(`await T.clearToasts(); document.activeElement?.blur?.(); await T.key('z', { ctrlKey: true }); await T.wait(200)
      const undone = T.caps().map((c) => c.text)
      await T.click(T.el('[data-caption-import]')); await T.wait(800); await T.settle()
      await T.click(T.el('[data-import-mode="append"]')); await T.wait(400); await T.settle()
      return { undone, caps: T.caps(), toasts: T.toasts(), summary: document.querySelector('[data-import-warnings]')?.textContent ?? null }`)
    check('desfazer volta às 3 legendas manuais', JSON.stringify(app.undone) === JSON.stringify(['Olá, mundo', 'Segunda legenda', 'Terceira']), app.undone)
    check('acrescentar: 3 + 4 = 7; a 1ª importada (7 s) colidia com a 3ª manual (até 8 s) → começa em 8 s', app.caps.length === 7 && app.caps[3].text === 'Importada: ação e coração' && app.caps[3].s === 8 * S && app.caps[3].e === 8.5 * S, app.caps)
    check('aviso da colisão: toast com 3 avisos + "… e mais 1 aviso"; resumo com os 4 (inclui a colisão)', app.toasts.some((t) => t.includes('e mais 1 aviso')) && !!app.summary && app.summary.includes('4 avisos') && app.summary.includes('colidia com outra legenda'), { toasts: app.toasts, summary: app.summary })
  }

  // ------------------------------------------------------------------ 7
  console.log('7. exportar SRT')
  let cues
  {
    const r = await ev(`await T.clearToasts(); await T.click(T.el('[data-caption-export]')); for (let i = 0; i < 40 && !T.toasts().some((t) => t.includes('exportadas')); i++) await T.wait(100)
      return { toasts: T.toasts(), cues: T.caps().filter((c) => c.enabled).map((c) => ({ startUs: c.s, endUs: c.e, text: c.text })) }`)
    cues = r.cues
    check('toast "7 legendas exportadas" com o caminho', r.toasts.some((t) => t.includes('7 legendas exportadas') && t.includes('exportado.srt')), r.toasts)
    const got = existsSync(SRT_OUT) ? readSrt(SRT_OUT) : null
    check('arquivo gravado em UTF-8 com BOM', !!got?.bom, got)
    check('conteúdo = SRT canônico das legendas (acentos preservados)', got?.text === serialize(cues), { got: got?.text, want: serialize(cues) })
  }

  // ------------------------------------------------------------------ 8
  console.log('8. exportação de vídeo: Legendas [x] Queimar [x] .srt ao lado (intervalo I–O)')
  {
    // faixa Legendas oculta: "Queimar" desligado e explicado
    const hid = await ev(`window.__qaEditor.exportDir = ${JSON.stringify(EXPORT_DIR)}; const tid = T.capTrack().id; T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === tid ? { ...t, hidden: true } : t)) })); await T.settle()
      await T.click([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(600)
      const d = T.dialog(); const b = d?.querySelector('[data-caption-burn]'); return { disabled: b?.disabled, checked: b?.checked, hint: d?.querySelector('[data-caption-hidden-hint]')?.textContent ?? null }`)
    await shot('f5-captions-05b-exportar-faixa-oculta.png')
    hid.hiddenAfter = await ev(`await T.click(T.button('Cancelar', T.dialog())); await T.wait(300); await T.key('z', { ctrlKey: true }); await T.wait(150); return T.capTrack().hidden`)
    check('faixa Legendas oculta: "Queimar no vídeo" desligado e desabilitado, com a explicação; desfazer volta a mostrar', hid.disabled === true && hid.checked === false && !!hid.hint && hid.hint.includes('oculta') && hid.hiddenAfter === false, hid)
    // um .srt do usuário com o nome padrão: a exportação vira " (2)" e o .srt dele fica intacto
    writeFileSync(join(EXPORT_DIR, 'Projeto de teste do editor.srt'), 'legendas do usuário')
    const r = await ev(`await T.clearToasts(); window.__qaEditor.exportDir = ${JSON.stringify(EXPORT_DIR)}; T.st().setInOut(${0.5 * S}, ${4.5 * S}); T.st().select([])
      await T.click([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(600)
      const d = T.dialog(); const g = d?.querySelector('[data-export-captions]')
      return { group: g?.textContent ?? null, burn: d?.querySelector('[data-caption-burn]')?.checked, srt: d?.querySelector('[data-caption-srt]')?.checked }`)
    check('diálogo mostra "Legendas: Queimar no vídeo / Salvar arquivo .srt ao lado" (padrão: queimar sim, .srt não)', !!r.group && r.group.includes('Queimar no vídeo') && r.group.includes('Salvar arquivo .srt ao lado') && r.burn === true && r.srt === false, r)
    await ev(`await T.click(T.dialog().querySelector('[data-caption-srt]')); await T.click([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith('WhatsApp'))); return 1`)
    await shot('f5-captions-05-exportar-opcoes.png')
    await ev(`await T.click(T.button('Exportar', T.dialog())); return 1`)
    let text = ''
    for (let i = 0; i < 900; i++) {
      text = await ev(`return T.dialog()?.textContent ?? ''`)
      if (text.includes('Vídeo exportado') || text.includes('falhou')) break
      await sleep(200)
    }
    check('exportação concluída', text.includes('Vídeo exportado'), text.slice(0, 300))
    const done = await ev(`return { srt: T.dialog()?.querySelector('[data-export-srt]')?.textContent ?? null, toasts: T.toasts() }`)
    await shot('f5-captions-06-exportado.png')
    const files = readdirSync(EXPORT_DIR)
    const mp4 = files.find((f) => f.endsWith('.mp4'))
    check('.srt do usuário com o mesmo nome: vídeo numerado " (2)" e o .srt dele intacto', mp4 === 'Projeto de teste do editor (2).mp4' && readFileSync(join(EXPORT_DIR, 'Projeto de teste do editor.srt'), 'utf8') === 'legendas do usuário', files)
    const srtFile = mp4 ? join(EXPORT_DIR, mp4.replace(/\.mp4$/i, '.srt')) : null
    check('.srt ao lado do .mp4, mesmo nome', !!srtFile && existsSync(srtFile), files)
    check('tela de concluído e toast mostram o .srt', !!done.srt && done.srt.includes('.srt') && done.toasts.some((t) => t.includes('Legendas salvas ao lado do vídeo')), done)
    if (srtFile && existsSync(srtFile)) {
      // trecho I–O [0,5; 4,5) s: legendas cortadas nas bordas e deslocadas (0 = 0,5 s)
      const want = cues.map((c) => ({ startUs: Math.max(c.startUs, 0.5 * S) - 0.5 * S, endUs: Math.min(c.endUs, 4.5 * S) - 0.5 * S, text: c.text })).filter((c) => c.endUs - c.startUs >= 1000)
      const got = readSrt(srtFile)
      check('.srt do trecho I–O: tempos deslocados e cortados (UTF-8 com BOM)', got.bom && got.text === serialize(want), { got: got.text, want: serialize(want) })
    }
    const again = await ev(`await T.click(T.button('Fechar', T.dialog())); await T.wait(400)
      await T.click([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(600)
      const d = T.dialog(); const r = { burn: d?.querySelector('[data-caption-burn]')?.checked, srt: d?.querySelector('[data-caption-srt]')?.checked }
      await T.click(T.button('Cancelar', d)); await T.wait(300); T.st().setInOut(null, null); return r`)
    check('a escolha é lembrada na sessão (queimar sim, .srt sim)', again.burn === true && again.srt === true, again)
  }

  // ------------------------------------------------------------------ 9
  console.log('9. textos pt-BR com acentos')
  {
    const r = await ev(`const p = T.panel()
      return { labels: T.all('[aria-label]', p).map((e) => e.getAttribute('aria-label')), text: p.textContent }`)
    const want = ['Início da legenda 1', 'Fim da legenda 1', 'Texto da legenda 1', 'Excluir a legenda 1', 'Fundo das legendas', 'Posição vertical']
    check('rótulos acessíveis em pt-BR (Início/Fim/Texto/Excluir/Fundo/Posição vertical)', want.every((w) => r.labels.includes(w)), r.labels.slice(0, 12))
    check('seção "Estilo das legendas" com Fonte, Tamanho, Cor do texto, Fundo, Posição vertical', ['Estilo das legendas', 'Fonte', 'Tamanho', 'Cor do texto', 'Fundo', 'Posição vertical'].every((w) => r.text.includes(w)), r.text.slice(-300))
    // excluir: um passo
    const del = await ev(`const p0 = T.past(); const n = T.caps().length; await T.click(T.el('[data-caption-delete]')); await T.wait(200); return { p0, n, after: T.caps().length, past: T.past() }`)
    check('excluir a 1ª legenda: um passo', del.after === del.n - 1 && del.past === del.p0 + 1, del)
    await shot('f5-captions-07-final.png')
  }
}

async function ev0(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    await shot('f5-captions-erro.png')
  } catch {
    // sem janela
  }
} finally {
  try {
    ws?.close()
  } catch {
    // ignorar
  }
  if (app) {
    try {
      execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // já saiu
    }
  }
  // settings.json do usuário: compara o hash antes/depois. Diferente = restaura o backup e confere o hash de novo.
  // Só `pip` mudando é tolerado (a tela Preparar regrava a geometria do PiP quando a emulação de viewport do CDP
  // redimensiona a janela — efeito do app, intermitente e igual nos outros scripts de QA): restaurado e só avisa.
  await sleep(800)
  failures += settings.finish() // settingsGuard.mjs: restaura e confere o hash; só `pip` (regravado pelo app) é tolerado
  console.log(failures ? `\n${failures} falha(s) em ${checks} verificações` : `\ntudo OK (${checks} verificações)`)
  process.exit(failures ? 1 : 0)
}
