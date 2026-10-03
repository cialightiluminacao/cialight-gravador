// QA G4 Task 5: Enter/F2 entram na edição direta do texto selecionado, Esc sai (CDP; teclas via Input.dispatchKeyEvent, nunca entrada do SO).
// uso (depois de `npm run build`; SEMPRE sob o lock): node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "node scripts/qa/editor-g4-textkeys.mjs"
// Confere: F2/Enter com um texto selecionado abrem a edição (F2 fora do playhead leva o cursor ao início); Enter no editor
// = nova linha; Esc sai sem aplicar; Ctrl+Enter grava em um passo; 2 selecionados/nenhum/mídia = nada; faixa bloqueada = aviso.
// Compara o sha256 do settings.json antes/depois.
import { spawn, execFileSync } from 'child_process'
import { guardSettings } from './settingsGuard.mjs'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-g4')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')

mkdirSync(SHOTS, { recursive: true })
const settings = guardSettings(SETTINGS)

let app = null
if (!ATTACH) {
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw' },
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

/** Avalia `body` (corpo de função async, com os helpers em `T`) na página e devolve o valor. */
async function ev(body, opts = {}) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__ft; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000, ...opts })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  [captura] ${name}`)
}
/** Clique via CDP (Input.dispatchMouseEvent: entrada da página, não do sistema operacional) — dá ativação do usuário. */
async function cdpClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
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

// helpers da página
const HELPERS = `
window.__ft = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel) => [...document.querySelectorAll(sel)]
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const pe = (type, x, y, mods) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...(mods || {}) })
  const me = (type, x, y, mods) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1, ...(mods || {}) })
  const clickAt = async (x, y, mods) => {
    const t = topAt(x, y)
    t.dispatchEvent(pe('pointerdown', x, y, mods)); t.dispatchEvent(me('mousedown', x, y, mods))
    window.dispatchEvent(pe('pointerup', x, y, mods)); t.dispatchEvent(me('mouseup', x, y, mods)); t.dispatchEvent(me('click', x, y, mods))
    await settle()
    return t
  }
  const click = async (e, mods) => { const c = center(e); return clickAt(c.x, c.y, mods) }
  const dblclickAt = async (x, y) => {
    const t = topAt(x, y)
    for (const n of [1, 2]) {
      t.dispatchEvent(pe('pointerdown', x, y)); t.dispatchEvent(me('mousedown', x, y))
      window.dispatchEvent(pe('pointerup', x, y)); t.dispatchEvent(me('mouseup', x, y)); t.dispatchEvent(me('click', x, y))
    }
    t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 2 }))
    await settle()
    return t
  }
  async function drag(from, to, opts = {}) {
    const steps = opts.steps ?? 8
    const t = topAt(from.x, from.y)
    t.dispatchEvent(pe('pointerdown', from.x, from.y, opts.mods))
    for (let i = 1; i <= steps; i++) window.dispatchEvent(pe('pointermove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, opts.mods))
    await settle()
    if (opts.release !== false) { window.dispatchEvent(pe('pointerup', to.x, to.y, opts.mods)); await settle() }
    return t
  }
  const key = async (k, mods, target) => { (target || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items)
  const item = (id) => items().find((i) => i.id === id)
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(500); await settle() }
  const toScreen = (x, y) => { const r = el('[data-viewer-overlay]').getBoundingClientRect(); const k = r.width / st().project.canvas.width; return { x: r.left + x * k, y: r.top + y * k } }
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  const typeInto = async (input, text) => {
    input.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(); input.blur(); await settle()
  }
  const setNative = (e, v) => {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v)
  }
  /** RGBA do retângulo (x, y, w, h em px do canvas do projeto) no quadro do preview. */
  const region = async (x, y, w, h) => {
    const r = window.__qaEditor.engine.render
    const k = (r.size.width * r.size.dpr) / st().project.canvas.width
    return r.readPixels(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
  }
  const framePatch = async (x, y) => {
    const px = await region(x - 4, y - 4, 9, 9)
    const n = px.length / 4
    const m = [0, 0, 0]
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) m[c] += px[i * 4 + c] / n
    return m.map(Math.round)
  }
  /** Quantos pixels diferem (canal máx > thr) entre dois buffers. */
  const diffCount = (a, b, thr = 24) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) { if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > thr) n++ } return n }
  /** Caixa (px do canvas) do item selecionado pelas alças do visualizador. */
  const handleBox = (id) => {
    const h = el('[data-media-handles="' + id + '"]'); const o = el('[data-viewer-overlay]').getBoundingClientRect(); const k = o.width / st().project.canvas.width
    const r = h.getBoundingClientRect()
    return { x: (r.left - o.left) / k, y: (r.top - o.top) / k, w: r.width / k, h: r.height / k }
  }
  /** Quadro do preview com o item escondido (transação cancelada: não mexe no histórico). */
  const withoutItem = async (id, fn) => {
    st().begin()
    st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === id ? { ...i, enabled: false } : i)) })) }), { transient: true })
    await settle(); await wait(700)
    const r = await fn()
    st().cancelTx(); await settle(); await wait(700)
    return r
  }
  const undoTo = async (n) => { for (let i = 0; i < 80 && past() > n; i++) await key('z', { ctrlKey: true }) }
  const tab = async (label) => { const t = all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').find((x) => x.textContent.trim() === label); if (!t) throw new Error('aba ' + label); t.dispatchEvent(pe('pointerdown', 0, 0)); t.dispatchEvent(me('mousedown', 0, 0)); t.click(); await settle(); await wait(150) }
  const lanesRect = () => el('[data-timeline-lanes]').getBoundingClientRect()
  /** Ponto da tela para o instante t (µs) na faixa trackId (centro da altura da faixa). */
  const lanePoint = (us, trackId) => {
    const s = st(); const lr = el('[data-track-id="' + trackId + '"]').getBoundingClientRect()
    return { x: lr.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6, y: lr.top + lr.height / 2 }
  }
  /** Arrasta um cartão da biblioteca: dragstart no cartão (grava o MIME) → dragover/drop no ponto. */
  const dragCard = async (card, pt, opts = {}) => {
    const dt = new DataTransfer()
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const target = topAt(pt.x, pt.y)
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, dataTransfer: dt })
    target.dispatchEvent(over)
    await settle()
    const highlight = document.querySelector('[data-cut-highlight]')?.getAttribute('data-cut-highlight') ?? null
    if (opts.dropEffectOnly) { target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, dataTransfer: dt })); await settle(); return { types: [...dt.types], highlight, accepted: over.defaultPrevented } }
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, dataTransfer: dt }))
    await settle()
    return { types: [...dt.types], highlight, accepted: over.defaultPrevented }
  }
  const videoTrack = () => st().project.tracks.find((t) => t.kind === 'video')
  const inspector = () => el('aside[aria-label="Inspetor"]')
  return { st, settle, wait, el, all, center, topAt, clickAt, click, dblclickAt, drag, key, items, item, past, seek, toScreen, toasts, typeInto, setNative, region, framePatch, diffCount, handleBox, withoutItem, undoTo, tab, lanesRect, lanePoint, dragCard, videoTrack, inspector, pe, me }
})()
'ok'`

/** Tecla de verdade pela página (Input.dispatchKeyEvent: o alvo é o elemento focado, como no teclado). */
const VK = { Enter: 13, F2: 113, Escape: 27, Control: 17 }
async function pressKey(key, { ctrl = false } = {}) {
  const base = { key, code: key, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key], modifiers: ctrl ? 2 : 0 }
  await send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...base, ...(key === 'Enter' && !ctrl ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(350)
}

async function main() {
  await connect()
  await send('Page.enable')
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

  console.log('0. dois textos (Título e Subtítulo) arrastados para a linha do tempo')
  const ids = []
  for (const [preset, at] of [['title', 2e6], ['subtitle', 8e6]]) {
    const r = await ev(`await T.tab('Texto'); await T.seek(${at}); const before = T.items().filter((i) => i.type === 'text').map((i) => i.id)
      await T.dragCard(T.el('[data-text-preset="${preset}"]'), T.lanePoint(${at}, T.videoTrack().id)); await T.wait(300)
      return T.items().filter((i) => i.type === 'text' && !before.includes(i.id)).map((i) => i.id)`)
    ids.push(r[0])
  }
  const [A, B] = ids
  check('dois textos criados', !!A && !!B && A !== B, ids)
  const state = (id) => ev(`const ta = document.querySelector('[data-text-editor]'); const it = T.item('${id}')
    return { open: !!ta, focused: !!ta && document.activeElement === ta, value: ta?.value, text: it.text, start: it.startUs, playhead: T.st().playheadUs, past: T.past(), sel: T.st().selection.slice(), toasts: T.toasts() }`)
  const blurAll = () => ev(`document.activeElement?.blur?.(); return 1`)

  console.log('1. F2 com o texto selecionado FORA do playhead: cursor vai ao início e o editor abre')
  {
    await ev(`await T.seek(0); T.st().select(['${A}']); await T.settle(); return 1`)
    await blurAll()
    const s0 = await state(A)
    await pressKey('F2')
    await sleep(500)
    const s = await state(A)
    check('F2 abre a textarea focada, com o texto inteiro selecionado', s.open && s.focused && s.value === s0.text, s)
    check('o playhead foi levado ao início do texto', s.playhead === s.start, s)
    await send('Input.insertText', { text: 'Digitado por F2' })
    await sleep(150)
    await pressKey('Enter') // Enter dentro do editor = nova linha, não confirma
    const mid = await state(A)
    check('Enter dentro do editor insere nova linha e o editor continua aberto', mid.open && mid.value === 'Digitado por F2\n', mid)
    await pressKey('Escape')
    const e = await state(A)
    check('Esc sai do editor sem aplicar (semântica existente: cancela), sem passo de desfazer, texto original', !e.open && e.text === s0.text && e.past === s0.past, e)
    check('Esc não desmarcou o item (a tecla é da caixa)', e.sel[0] === A, e)
  }

  console.log('2. Enter com o texto selecionado: abre; digitar + Ctrl+Enter grava em UM passo; atalhos voltam depois')
  {
    const s0 = await state(A)
    await pressKey('Enter')
    await sleep(400)
    const s = await state(A)
    check('Enter (foco no quadro, após Esc) abre a edição de novo', s.open && s.focused, s)
    await send('Input.insertText', { text: 'Texto novo via Enter' })
    await pressKey('Enter', { ctrl: true })
    await sleep(300)
    const e = await state(A)
    check('Ctrl+Enter grava o texto no projeto em UM passo de desfazer e fecha', !e.open && e.text === 'Texto novo via Enter' && e.past === s0.past + 1, e)
    await pressKey('Enter')
    await pressKey('Escape')
    const m0 = await ev(`return T.st().project.markers?.length ?? 0`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', text: 'm', windowsVirtualKeyCode: 77 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 })
    await sleep(300)
    const m1 = await ev(`return T.st().project.markers?.length ?? 0`)
    check('depois do Esc os atalhos do editor voltam a funcionar (M adiciona marcador)', m1 === m0 + 1, { m0, m1 })
    await ev(`T.st().undo(); await T.settle(); return 1`)
  }

  console.log('3. dois itens selecionados: Enter/F2 não fazem nada')
  {
    await ev(`T.st().select(['${A}', '${B}']); await T.settle(); return 1`)
    await blurAll()
    const s0 = await state(A)
    await pressKey('Enter')
    await pressKey('F2')
    const s = await state(A)
    check('nenhuma edição aberta, playhead e histórico intactos, sem toast', !s.open && s.playhead === s0.playhead && s.past === s0.past && s.toasts.length === s0.toasts.length, { s0, s })
  }

  console.log('4. nenhum selecionado / item não-texto: nada acontece')
  {
    await ev(`T.st().select([]); await T.settle(); return 1`)
    await pressKey('Enter')
    check('sem seleção: sem editor', !(await state(A)).open)
    const mid = await ev(`const m = T.items().find((i) => i.type === 'media'); T.st().select([m.id]); await T.settle(); return m.id`)
    await pressKey('F2')
    check('mídia selecionada: sem editor', !(await state(A)).open, mid)
  }

  console.log('5. faixa bloqueada: aviso e nada abre')
  {
    const tid = await ev(`const t = T.st().project.tracks.find((t) => t.items.some((i) => i.id === '${A}')); T.st().select(['${A}']); T.st().apply((p) => ({ ...p, tracks: p.tracks.map((x) => (x.id === t.id ? { ...x, locked: true } : x)) })); await T.settle(); return t.id`)
    await blurAll()
    await pressKey('F2')
    const s = await state(A)
    check('faixa bloqueada: editor não abre e o aviso aparece', !s.open && s.toasts.some((t) => /bloqueada/.test(t)), s)
    await ev(`T.st().apply((p) => ({ ...p, tracks: p.tracks.map((x) => (x.id === '${tid}' ? { ...x, locked: false } : x)) })); await T.settle(); return 1`)
  }
  await shot('g4-textkeys.png')

  console.log('6. ferramenta do visualizador ativa (Desenhar região): o pedido é descartado com aviso e não fica pendente')
  {
    await ev(`const it = T.item('${A}'); await T.seek(it.startUs + 100000); T.st().select(['${A}']); await T.settle(); document.querySelector('button[aria-label^="Desenhar região"]').click(); await T.settle(); await T.wait(300); return document.querySelector('button[aria-label="Sair de Desenhar região"]') ? 1 : 0`)
    await blurAll()
    const n0 = (await state(A)).toasts.filter((t) => /Não foi possível editar o texto agora/.test(t)).length
    await pressKey('F2')
    const s = await state(A)
    check('Desenhar região ativo: editor não abre e o aviso "Não foi possível editar o texto agora." aparece', !s.open && s.toasts.filter((t) => /Não foi possível editar o texto agora/.test(t)).length > n0, s)
    await ev(`document.querySelector('button[aria-label="Sair de Desenhar região"]').click(); await T.settle(); const it = T.item('${A}'); await T.seek(it.startUs + 200000); await T.settle(); await T.wait(300); return 1`)
    check('saindo da ferramenta, o editor NÃO abre sozinho (nenhum pedido pendente)', !(await state(A)).open)
  }

}


/** ev sem os helpers (antes de existirem). */
async function ev0(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
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
  if (app) {
    try {
      execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // já saiu
    }
  }
  // settings.json do usuário: compara o hash antes/depois. Diferente = restaura o backup e confere o hash de novo.
  // Falha se o conteúdo mudou em qualquer chave além de `pip`: a tela Preparar do app (aberta ao iniciar) regrava a
  // geometria do PiP da câmera quando a janela é redimensionada pela emulação de viewport do CDP — efeito do app, que
  // nada tem a ver com o editor, intermitente e idêntico nos outros scripts de QA. Esse caso é restaurado e só avisa.
  await sleep(800)
  failures += settings.finish() // settingsGuard.mjs: restaura e confere o hash; só `pip` (regravado pelo app) é tolerado
  console.log(failures ? `\n${failures} falha(s) em ${checks} verificações` : `\ntudo OK (${checks} verificações)`)
  process.exit(failures ? 1 : 0)
}
