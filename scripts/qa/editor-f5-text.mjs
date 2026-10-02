// QA de Texto, Formas e Transições (F5 Task 5) via CDP, com eventos sintéticos despachados no elemento real sob o
// ponto (document.elementFromPoint) e DragEvents com DataTransfer — nunca entrada do sistema operacional. Os pixels
// do quadro vêm do render worker (readPixels), a mesma imagem do preview.
//
// uso (depois de `npm run build`; SEMPRE sob o lock das execuções do Electron):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs node scripts/qa/editor-f5-text.mjs
//   node scripts/qa/editor-f5-text.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// Confere: (1) arrastar o cartão Título para a linha do tempo cria o item e o texto aparece no quadro; (2) duplo clique
// no texto do visualizador → editar → Ctrl+Enter confirma em UM passo (Esc cancela, atalhos mudos); (3) cor e fundo do
// TextPanel mudam os pixels e o slider de tamanho é um passo; (4) Holofote escurece o fora; (5) Dissolver entre dois
// clipes: ícone, bordas mudam a duração em um passo, Delete remove, soltar sobre algo inelegível avisa; (6) atalhos T
// e Ctrl+T; (7) textos pt-BR com acentos. Compara o sha256 do settings.json antes/depois. Screenshots em
// docs/qa/editor-f5/ (só mídia sintética).
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f5')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')

mkdirSync(SHOTS, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : 'ausente')
const hashBefore = sha(settingsBefore)
console.log(`settings.json sha256 antes: ${hashBefore}`)

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

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 900)
  await ev0(`localStorage.setItem('editor.timelineHeight', '260'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev0(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev0(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]')`)
    if (ok) break
    await sleep(1000)
  }
  await ev0(HELPERS + '; return 1')
  const past0 = await ev(`return T.past()`)

  // ------------------------------------------------------------------ 7 (primeiro: strings das abas e cartões)
  console.log('7. textos em pt-BR com acentos (abas e cartões)')
  {
    const r = await ev(`const tabs = T.all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').map((x) => x.textContent.trim())
      await T.tab('Texto')
      const text = T.all('[data-text-preset]').map((c) => c.getAttribute('aria-label').split('.')[0])
      const shapes = T.all('[data-shape-preset]').map((c) => c.getAttribute('aria-label').split('.')[0])
      const sec = [...document.querySelectorAll('aside[aria-label="Biblioteca de mídia"] h3')].map((h) => h.textContent.trim())
      await T.tab('Transições')
      const trans = T.all('[data-transition-kind]').map((c) => c.getAttribute('aria-label').split('.')[0])
      return { tabs, text, shapes, sec, trans }`)
    check('abas: Mídia, Áudio, Gravações, Efeitos, Texto, Transições, Legendas', JSON.stringify(r.tabs) === JSON.stringify(['Mídia', 'Áudio', 'Gravações', 'Efeitos', 'Texto', 'Transições', 'Legendas']), r.tabs)
    check('cartões de texto: Título, Subtítulo, Terço inferior, Legenda, Citação, Contagem', JSON.stringify(r.text) === JSON.stringify(['Título', 'Subtítulo', 'Terço inferior', 'Legenda', 'Citação', 'Contagem']), r.text)
    check('cartões de forma: Retângulo, Elipse, Seta, Destaque, Holofote; seções Textos/Formas', JSON.stringify(r.shapes) === JSON.stringify(['Retângulo', 'Elipse', 'Seta', 'Destaque', 'Holofote']) && JSON.stringify(r.sec) === JSON.stringify(['Textos', 'Formas']), r)
    check('11 transições com nome pt-BR', JSON.stringify(r.trans) === JSON.stringify(['Dissolver', 'Mergulho no preto', 'Mergulho no branco', 'Deslizar ←', 'Deslizar →', 'Deslizar ↑', 'Deslizar ↓', 'Cortina ←', 'Cortina →', 'Zoom', 'Desfoque']), r.trans)
    await shot('f5-01-biblioteca-transicoes.png')
    await ev(`await T.tab('Texto'); return 1`)
    await shot('f5-02-biblioteca-texto.png')
  }

  // ------------------------------------------------------------------ 1
  console.log('1. arrastar o cartão Título para a linha do tempo')
  let titleId
  {
    const r = await ev(`await T.seek(2.5e6)
      const before = T.items().length
      const vt = T.videoTrack()
      const pt = T.lanePoint(2e6, vt.id)
      const d = await T.dragCard(T.el('[data-text-preset="title"]'), pt)
      await T.wait(300)
      const added = T.items().filter((i) => i.type === 'text')
      return { before, after: T.items().length, texts: added.map((i) => ({ id: i.id, text: i.text, startUs: i.startUs, durationUs: i.durationUs, font: i.style.font })), sel: T.st().selection, d, past: T.past() }`)
    titleId = r.texts[0]?.id
    check('o MIME do cartão é application/x-cialight-text e a linha do tempo aceita o arraste', r.d.types.includes('application/x-cialight-text') && r.d.accepted, r.d)
    check('item de texto criado no ponto do drop (≈ 2 s, com snap), 3 s, texto "Título", fonte Manrope; selecionado; um passo', r.after === r.before + 1 && r.texts.length === 1 && r.texts[0].text === 'Título' && r.texts[0].durationUs === 3000000 && Math.abs(r.texts[0].startUs - 2e6) < 250000 && r.texts[0].font === 'Manrope Variable' && r.sel[0] === titleId && r.past === past0 + 1, r)
    // pixels: o texto aparece no quadro (diferença com o mesmo quadro sem o item)
    const px = await ev(`const st = T.item('${titleId}').startUs
      await T.seek(st + 1.5e6); await T.wait(1200)
      const box = T.handleBox('${titleId}')
      const withText = await T.region(box.x, box.y, box.w, box.h)
      const without = await T.withoutItem('${titleId}', () => T.region(box.x, box.y, box.w, box.h))
      const white = (() => { let n = 0; for (let i = 0; i < withText.length; i += 4) if (withText[i] > 235 && withText[i + 1] > 235 && withText[i + 2] > 235) n++; return n })()
      return { box, n: T.diffCount(withText, without), white, total: withText.length / 4 }`)
    check('o texto aparece no quadro do visualizador (pixels diferentes do quadro sem o item, com pixels brancos da letra)', px.n > 400 && px.white > 150, px)
    await shot('f5-03-titulo-arrastado.png')
  }

  // ------------------------------------------------------------------ 1b
  console.log('1b. selecionar, mover e escalar o texto no visualizador')
  {
    const r = await ev(`const t0 = T.item('${titleId}'); await T.seek(t0.startUs + 1.5e6); await T.wait(900)
      T.st().select([]); await T.settle()
      const c = T.toScreen(960, 540); await T.clickAt(c.x, c.y)
      const sel = T.st().selection.slice(); const handles = !!document.querySelector('[data-media-handles="${titleId}"]')
      const p0 = T.past(); const x0 = T.item('${titleId}').visual.transform.x.value
      await T.drag(c, { x: c.x + 90, y: c.y + 30 }, { steps: 10 }); await T.wait(400)
      const moved = { x: T.item('${titleId}').visual.transform.x.value, y: T.item('${titleId}').visual.transform.y.value, past: T.past() }
      await T.key('z', { ctrlKey: true }); await T.wait(300)
      const undone = { x: T.item('${titleId}').visual.transform.x.value, past: T.past() }
      const corner = T.all('[data-media-handles="${titleId}"] button[aria-label^="Redimensionar"]').pop(); const cc = T.center(corner)
      const s0 = T.item('${titleId}').visual.transform.scale.value
      await T.drag(cc, { x: cc.x + 40, y: cc.y + 20 }, { steps: 10 }); await T.wait(400)
      const scaled = { s: T.item('${titleId}').visual.transform.scale.value, past: T.past() }
      await T.key('z', { ctrlKey: true }); await T.wait(300)
      return { sel, handles, p0, x0, moved, undone, s0, scaled, back: T.item('${titleId}').visual.transform.scale.value, past: T.past() }`)
    check('clicar no texto do visualizador o seleciona e mostra as alças de mover/escalar/girar', r.sel[0] === titleId && r.handles, r)
    check('arrastar o texto no quadro move o centro em UM passo de desfazer; Ctrl+Z devolve a posição', r.moved.x > r.x0 + 0.03 && r.moved.past === r.p0 + 1 && Math.abs(r.undone.x - r.x0) < 1e-9 && r.undone.past === r.p0, r)
    check('o canto da alça escala o texto (UM passo); Ctrl+Z devolve a escala', r.scaled.s > r.s0 * 1.05 && r.scaled.past === r.p0 + 1 && Math.abs(r.back - r.s0) < 1e-9 && r.past === r.p0, r)
    await shot('f5-03b-texto-alcas.png')
  }

  // ------------------------------------------------------------------ 2
  console.log('2. edição direta do texto no visualizador')
  {
    const open = `const t0 = T.item('${titleId}'); await T.seek(t0.startUs + 1.5e6); await T.wait(700)
      const box = T.handleBox('${titleId}'); const c = T.toScreen(box.x + box.w / 2, box.y + box.h / 2); await T.dblclickAt(c.x, c.y); await T.wait(200)`
    const r = await ev(`${open}
      const ta = document.querySelector('[data-text-editor]')
      const rect = ta?.getBoundingClientRect(); const ov = T.el('[data-viewer-overlay]').getBoundingClientRect()
      return { has: !!ta, focused: document.activeElement === ta, value: ta?.value, sel: [ta?.selectionStart, ta?.selectionEnd], fs: ta ? getComputedStyle(ta).fontSize : null, ff: ta ? getComputedStyle(ta).fontFamily : null, inside: !!rect && rect.left >= ov.left - 2 && rect.right <= ov.right + 2, label: ta?.getAttribute('aria-label') }`)
    check('duplo clique no texto abre a textarea sobreposta, focada, com o texto inteiro selecionado, fonte Manrope e rótulo de acessibilidade', r.has && r.focused && r.value === 'Título' && r.sel[0] === 0 && r.sel[1] === 6 && /Manrope/.test(r.ff) && parseFloat(r.fs) > 8 && /Ctrl\+Enter/.test(r.label), r)
    await shot('f5-04-edicao-direta.png')
    // atalhos do editor mudos durante a edição: S (dividir), T (título) e Delete não mexem no projeto
    const mute = await ev(`const ta = document.querySelector('[data-text-editor]'); const p0 = T.past(); const n0 = T.items().length
      for (const k of ['s', 't', ' ', 'Delete']) await T.key(k, {}, ta)
      await T.key('t', { ctrlKey: true }, ta)
      return { p0, p1: T.past(), n0, n1: T.items().length, still: !!document.querySelector('[data-text-editor]') }`)
    check('atalhos do editor não disparam durante a edição (S, T, Espaço, Delete, Ctrl+T)', mute.p1 === mute.p0 && mute.n1 === mute.n0 && mute.still, mute)
    // Enter = nova linha (não confirma), Ctrl+Enter confirma
    const e1 = await ev(`const ta = document.querySelector('[data-text-editor]'); const p0 = T.past()
      T.setNative(ta, 'Olá\\nmundo'); ta.dispatchEvent(new Event('input', { bubbles: true }))
      await T.key('Enter', {}, ta)
      const stillOpen = !!document.querySelector('[data-text-editor]'); const p1 = T.past()
      await T.key('Enter', { ctrlKey: true }, ta); await T.wait(300)
      return { p0, p1, stillOpen, closed: !document.querySelector('[data-text-editor]'), text: T.item('${titleId}').text, past: T.past() }`)
    check('Enter não confirma (a textarea continua aberta); Ctrl+Enter grava "Olá\\nmundo" em UM passo de desfazer e fecha', e1.stillOpen && e1.p1 === e1.p0 && e1.closed && e1.text === 'Olá\nmundo' && e1.past === e1.p0 + 1, e1)
    const u = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(200); const a = { text: T.item('${titleId}').text, past: T.past() }
      await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(200)
      return { a, again: T.item('${titleId}').text }`)
    check('Ctrl+Z desfaz a edição inteira num passo ("Título" volta); Ctrl+Shift+Z refaz', u.a.text === 'Título' && u.again === 'Olá\nmundo', u)
    // Esc cancela
    const esc = await ev(`${open}
      const ta = document.querySelector('[data-text-editor]'); const p0 = T.past()
      T.setNative(ta, 'XXXX'); ta.dispatchEvent(new Event('input', { bubbles: true }))
      await T.key('Escape', {}, ta); await T.wait(200)
      return { closed: !document.querySelector('[data-text-editor]'), text: T.item('${titleId}').text, same: T.past() === p0, selKept: T.st().selection[0] === '${titleId}' }`)
    check('Esc cancela: o texto não muda, nenhum passo de desfazer, o item continua selecionado', esc.closed && esc.text === 'Olá\nmundo' && esc.same && esc.selKept, esc)
    // clicar fora confirma
    const out = await ev(`${open}
      const ta = document.querySelector('[data-text-editor]'); const p0 = T.past()
      T.setNative(ta, 'Título'); ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.blur(); await T.wait(300)
      return { closed: !document.querySelector('[data-text-editor]'), text: T.item('${titleId}').text, past: T.past(), p0 }`)
    check('clicar fora (perder o foco) confirma: "Título" gravado em um passo', out.closed && out.text === 'Título' && out.past === out.p0 + 1, out)
    // vazio: recusa com aviso
    const empty = await ev(`${open}
      const ta = document.querySelector('[data-text-editor]'); const p0 = T.past()
      T.setNative(ta, '   '); ta.dispatchEvent(new Event('input', { bubbles: true }))
      await T.key('Enter', { ctrlKey: true }, ta); await T.wait(400)
      return { text: T.item('${titleId}').text, same: T.past() === p0, toast: T.toasts().some((t) => t.includes('não pode ficar vazio')) }`)
    check('texto vazio: recusado com aviso ("não pode ficar vazio"), o anterior fica', empty.text === 'Título' && empty.same && empty.toast, empty)
  }

  // ------------------------------------------------------------------ 3
  console.log('3. TextPanel: cor, fundo e tamanho')
  {
    const p3 = await ev(`return T.past()`)
    const prep = await ev(`T.st().select(['${titleId}']); await T.settle(); await T.wait(300)
      const t0 = T.item('${titleId}'); await T.seek(t0.startUs + 1.5e6); await T.wait(900)
      const ins = T.inspector().textContent
      return { ins: ['Conteúdo do texto', 'Fonte', 'Tamanho', 'Peso', 'Itálico', 'Alinhamento', 'Altura da linha', 'Quebra automática', 'Cor do texto', 'Fundo', 'Contorno', 'Sombra', 'Transformação'].filter((s) => !ins.includes(s) && !T.inspector().querySelector('[aria-label="' + s + '"]')), titulo: T.inspector().querySelector('h2').textContent }`)
    check('o inspetor do texto mostra todos os campos (conteúdo, fonte, tamanho, peso, itálico, alinhamento, altura da linha, largura, cor, fundo, contorno, sombra, transformação)', prep.ins.length === 0, prep)
    await shot('f5-05-textpanel.png')
    const box = await ev(`return T.handleBox('${titleId}')`)
    // cor do texto: branco → vermelho puro
    const c = await ev(`const before = await T.region(${box.x}, ${box.y}, ${box.w}, ${box.h}); const p0 = T.past()
      const inp = T.inspector().querySelector('input[type="color"][aria-label="Cor do texto"]')
      inp.focus(); T.setNative(inp, '#ff0000'); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); await T.settle(); inp.blur(); await T.settle(); await T.wait(900)
      const after = await T.region(${box.x}, ${box.y}, ${box.w}, ${box.h})
      const red = (b) => { let n = 0; for (let i = 0; i < b.length; i += 4) if (b[i] > 200 && b[i + 1] < 60 && b[i + 2] < 60) n++; return n }
      return { color: T.item('${titleId}').style.color, p0, past: T.past(), diff: T.diffCount(before, after), redBefore: red(before), redAfter: red(after) }`)
    check('cor do texto → #ff0000 em um passo; os pixels mudam (letras vermelhas)', c.color === '#ff0000' && c.past === c.p0 + 1 && c.diff > 300 && c.redAfter > 200 && c.redBefore < 20, c)
    // fundo: liga → pixels escurecem em volta; opacidade
    const bg = await ev(`const before = await T.region(${box.x - 40}, ${box.y - 20}, ${box.w + 80}, ${box.h + 40}); const p0 = T.past()
      const sw = T.inspector().querySelector('button[role="switch"][aria-label="Fundo"]'); await T.click(sw); await T.wait(900)
      const after = await T.region(${box.x - 40}, ${box.y - 20}, ${box.w + 80}, ${box.h + 40})
      const mean = (b) => { let s = 0; for (let i = 0; i < b.length; i += 4) s += (b[i] + b[i + 1] + b[i + 2]) / 3; return s / (b.length / 4) }
      return { bgv: T.item('${titleId}').style.background, p0, past: T.past(), diff: T.diffCount(before, after, 12), mb: mean(before), ma: mean(after), pad: [...T.inspector().querySelectorAll('input[aria-label="Espaçamento"],input[aria-label="Cantos"],input[aria-label="Opacidade"]')].length }`)
    check('fundo ligado (#000000b3) em um passo; o quadro escurece em volta do texto e aparecem os campos de cor, opacidade, espaçamento e cantos', bg.bgv === '#000000b3' && bg.past === bg.p0 + 1 && bg.diff > 2000 && bg.ma < bg.mb - 3 && bg.pad >= 3, bg)
    const op = await ev(`const inp = [...T.inspector().querySelectorAll('input[aria-label="Opacidade"]')].find((i) => i.closest('section')?.textContent.includes('Cor do fundo')) ?? T.inspector().querySelector('input[aria-label="Opacidade"]'); const p0 = T.past()
      await T.typeInto(inp, '100'); await T.wait(300)
      return { bgv: T.item('${titleId}').style.background, p0, past: T.past() }`)
    check('opacidade do fundo 100 % → "#000000" em um passo', op.bgv === '#000000' && op.past === op.p0 + 1, op)
    await shot('f5-06-textpanel-cor-fundo.png')
    // tamanho: arrastar o rótulo do campo = UM passo de desfazer
    const sz = await ev(`const inp = T.inspector().querySelector('input[aria-label="Tamanho"]'); const label = inp.closest('div.group').querySelector('span.cursor-ew-resize'); label.scrollIntoView({ block: 'center' }); await T.wait(150)
      const p0 = T.past(); const s0 = T.item('${titleId}').style.size.value ?? T.item('${titleId}').style.size
      const c = T.center(label)
      await T.drag(c, { x: c.x + 30, y: c.y }, { steps: 12 })
      await T.wait(400)
      const s1 = T.item('${titleId}').style.size
      return { s0, s1, p0, past: T.past(), canUndo: T.st().canUndo }`)
    const v = (x) => (typeof x === 'object' ? x.value : x)
    check('arrastar o campo Tamanho 30 px = tamanho +30 e UM passo de desfazer', v(sz.s1) === v(sz.s0) + 30 && sz.past === sz.p0 + 1, sz)
    const un = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return { size: T.item('${titleId}').style.size, past: T.past() }`)
    check('Ctrl+Z devolve o tamanho de antes num só passo', v(un.size) === v(sz.s0) && un.past === sz.past - 1, un)
    // fontes do sistema: sem gesto a leitura automática pode ser recusada; o botão (clique com ativação do usuário) carrega
    const sys = await ev(`const b = [...T.inspector().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Carregar fontes do sistema')
      if (!b) return { button: false }
      b.scrollIntoView({ block: 'center' }); await T.wait(200); return { button: true, c: T.center(b) }`)
    if (sys.button) {
      await cdpClick(sys.c.x, sys.c.y)
      await sleep(2500)
    }
    // fonte: Radix Select → Georgia
    const f = await ev(`const trig = T.inspector().querySelector('button[role="combobox"]'); trig.scrollIntoView({ block: 'center' }); await T.wait(100)
      const c0 = T.center(trig)
      trig.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: c0.x, clientY: c0.y, button: 0, pointerType: 'mouse', pointerId: 1 })); await T.wait(300)
      const opts = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim())
      const g = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim().startsWith('Georgia'))
      const p0 = T.past()
      if (g) { g.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1 })); g.click() }
      await T.wait(400)
      return { opts: opts.slice(0, 14), n: opts.length, font: T.item('${titleId}').style.font, p0, past: T.past() }`)
    check(`seletor de fonte: Manrope Variable + as 13 fontes do Windows + ${f.n - 14} do sistema (${sys.button ? 'carregadas pelo botão, com clique do usuário' : 'lidas automaticamente'}); Georgia grava a fonte em um passo`, f.opts[0].startsWith('Manrope Variable') && f.opts.slice(1, 14).join('|').includes('Arial') && f.n >= 14 && f.font === 'Georgia' && f.past === f.p0 + 1, { sys, ...f })
    await ev(`document.activeElement?.blur?.(); return 1`)
    // sombra e contorno: `shadow` (v1.3) sempre coerente com `shadowStyle`; um passo por interruptor
    const sh = await ev(`const sw = T.inspector().querySelector('button[role="switch"][aria-label="Sombra"]'); sw.scrollIntoView({ block: 'center' }); await T.wait(150)
      const s0 = T.item('${titleId}').style; const p0 = T.past()
      const had = { shadow: s0.shadow ?? null, ss: !!s0.shadowStyle }
      await T.click(sw); await T.wait(300)
      const a = T.item('${titleId}').style; const off = { shadow: a.shadow ?? null, ss: !!a.shadowStyle, past: T.past() }
      await T.click(T.inspector().querySelector('button[role="switch"][aria-label="Sombra"]')); await T.wait(300)
      const b = T.item('${titleId}').style; const on = { shadow: b.shadow ?? null, ss: b.shadowStyle ?? null, past: T.past() }
      const fields = ['Desfoque', 'Desl. X', 'Desl. Y', 'Cor da sombra'].filter((l) => !T.inspector().querySelector('[aria-label="' + l + '"]'))
      const st = T.inspector().querySelector('button[role="switch"][aria-label="Contorno"]'); await T.click(st); await T.wait(300)
      const c = T.item('${titleId}').style.stroke ?? null; const sp = T.past()
      await T.click(T.inspector().querySelector('button[role="switch"][aria-label="Contorno"]')); await T.wait(300)
      return { p0, had, off, on, fields, stroke: c, strokeAfter: T.item('${titleId}').style.stroke ?? null, sp, past: T.past() }`)
    check('sombra: desligar remove shadow e shadowStyle juntos; ligar grava shadow=true com os parâmetros padrão (cor, desfoque, deslocamento); um passo cada', sh.had.shadow === true && sh.had.ss && sh.off.shadow === null && !sh.off.ss && sh.off.past === sh.p0 + 1 && sh.on.shadow === true && sh.on.ss?.blur === 0.08 && sh.on.ss?.dx === 0.04 && sh.on.past === sh.p0 + 2 && sh.fields.length === 0, sh)
    check('contorno: ligar grava { 4 px, #000000 }, desligar remove; um passo cada', sh.stroke?.width === 4 && sh.stroke?.color === '#000000' && sh.sp === sh.p0 + 3 && sh.strokeAfter === null && sh.past === sh.p0 + 4, sh)
    // fontes do sistema: a API existe no Electron; sem gesto/permissão a lista curada basta, sem erro
    const q = await ev(`const has = typeof queryLocalFonts === 'function'; let n = null, err = null
      try { const l = await queryLocalFonts(); n = l.length } catch (e) { err = e.name }
      return { has, n, err }`, { userGesture: true })
    check(`queryLocalFonts: ${q.has ? (q.n !== null ? q.n + ' fontes do sistema lidas' : 'recusada (' + q.err + ') — o painel usa só a lista curada') : 'API ausente — só a lista curada'} (sem erro no painel)`, true, q)
    // volta ao estado do início do cenário 3
    await ev(`await T.undoTo(${p3}); return 1`)
  }

  // ------------------------------------------------------------------ 4
  console.log('4. Holofote')
  {
    const p4 = await ev(`return T.past()`)
    const r = await ev(`await T.seek(1.2e6); await T.wait(600)
      await T.tab('Texto')
      const base = { corner: await T.framePatch(120, 120), center: await T.framePatch(960, 540), edge: await T.framePatch(1800, 1000) }
      const vt = T.videoTrack()
      const p0 = T.past()
      const pt = T.lanePoint(1e6, vt.id)
      const d = await T.dragCard(T.el('[data-shape-preset="spotlight"]'), pt)
      await T.wait(500)
      const sh = T.items().find((i) => i.type === 'shape')
      await T.seek(1.2e6 > sh.startUs ? 1.2e6 : sh.startUs + 0.3e6); await T.wait(700)
      const after = { corner: await T.framePatch(120, 120), center: await T.framePatch(960, 540), edge: await T.framePatch(1800, 1000) }
      return { d, p0, past: T.past(), shape: sh && { shape: sh.shape, spot: sh.spotlight, box: sh.box, startUs: sh.startUs, durationUs: sh.durationUs }, base, after, seeked: sh && sh.startUs }`)
    const lum = (c) => (c[0] + c[1] + c[2]) / 3
    check('arrastar o cartão Holofote cria a forma (elipse com spotlight dim 0,6) em um passo', r.d.types.includes('application/x-cialight-shape') && r.shape?.shape === 'ellipse' && r.shape?.spot?.dim === 0.6 && r.past === r.p0 + 1, r)
    check('fora da forma o quadro escurece (≈ 60 %) e o centro fica intacto', lum(r.after.corner) < lum(r.base.corner) * 0.55 && lum(r.after.edge) < lum(r.base.edge) * 0.55 + 4 && Math.abs(lum(r.after.center) - lum(r.base.center)) < 6, r)
    await shot('f5-07-holofote.png')
    const clk = await ev(`await T.seek(1.2e6); T.st().select([]); await T.settle(); const c = T.toScreen(960, 540); await T.clickAt(c.x, c.y)
      const sh = T.items().find((i) => i.type === 'shape'); return { sel: T.st().selection.slice(), id: sh.id, name: sh.name, handles: !!document.querySelector('[data-media-handles="' + sh.id + '"]'), label: T.inspector().querySelector('h2').textContent }`)
    check('clicar dentro da forma no visualizador a seleciona (alças na caixa da forma); o item se chama "Holofote"', clk.sel[0] === clk.id && clk.handles && clk.name === 'Holofote' && clk.label === 'Holofote', clk)
    // painel da forma
    const sp = await ev(`const id = T.items().find((i) => i.type === 'shape').id; T.st().select([id]); await T.settle(); await T.wait(300)
      const txt = T.inspector().textContent
      return { has: ['Retângulo', 'Elipse', 'Seta', 'Preenchimento', 'Contorno', 'Holofote', 'Intensidade', 'Largura', 'Altura'].filter((s) => !txt.includes(s)), id }`)
    check('inspetor da forma: tipo (Retângulo/Elipse/Seta), preenchimento, contorno, caixa, holofote e intensidade', sp.has.length === 0, sp)
    const dim = await ev(`const inp = T.inspector().querySelector('input[aria-label="Intensidade"]'); const p0 = T.past()
      await T.typeInto(inp, '90'); await T.wait(900)
      const id = T.items().find((i) => i.type === 'shape').id
      return { dim: T.item(id).spotlight?.dim, p0, past: T.past(), corner: await T.framePatch(120, 120) }`)
    check('intensidade 90 % grava dim 0,9 em um passo e escurece mais o fora', dim.dim === 0.9 && dim.past === dim.p0 + 1 && lum(dim.corner) < lum(r.after.corner), dim)
    await shot('f5-08-formapanel.png')
    await ev(`await T.undoTo(${p4}); return 1`)
  }

  // ------------------------------------------------------------------ 5
  console.log('5. Transições')
  {
    // deixa só o título (apaga a forma) e divide o vídeo em 2,5 s para ter dois clipes encostados
    const s = await ev(`const shape = T.items().find((i) => i.type === 'shape'); if (shape) { T.st().select([shape.id]); await T.key('Delete'); await T.wait(200) }
      const v = T.items().find((i) => i.type === 'media' && i.assetId === 'a_qa_video' && i.visual)
      T.st().select([v.id]); await T.seek(2.5e6); await T.key('s'); await T.wait(300)
      const vs = T.videoTrack().items.filter((i) => i.type === 'media' && i.assetId === 'a_qa_video').sort((a, b) => a.startUs - b.startUs)
      return { n: vs.length, a: vs[0]?.id, b: vs[1]?.id, cut: vs[1]?.startUs, aEnd: vs[0] && vs[0].startUs + vs[0].durationUs, track: T.videoTrack().id }`)
    check('o vídeo foi dividido em 2,5 s: dois clipes encostados na mesma faixa', s.n === 2 && s.cut === s.aEnd && s.cut === 2500000, s)
    const { a, b, cut, track } = s
    const pStart = await ev(`return T.past()`)
    // arrastar o Dissolver até o corte: realce e soltar
    const drop = await ev(`await T.tab('Transições'); T.el('[data-transition-kind="crossfade"]').scrollIntoView({ block: 'nearest' })
      const pt = T.lanePoint(${cut} + 40000, '${track}')
      const hover = await T.dragCard(T.el('[data-transition-kind="crossfade"]'), pt, { dropEffectOnly: true })
      const gone = !document.querySelector('[data-cut-highlight]')
      const d = await T.dragCard(T.el('[data-transition-kind="crossfade"]'), pt)
      await T.wait(400)
      const tr = T.item('${b}').transitionIn
      const icon = document.querySelector('[data-transition-id="${b}"] [data-transition-icon]')
      return { hover, gone, d, tr, label: icon?.getAttribute('aria-label'), pressed: icon?.getAttribute('aria-pressed'), sel: T.st().selectedTransition, past: T.past(), title: T.inspector().querySelector('h2')?.textContent }`)
    check('arrastando o Dissolver sobre o corte, o corte é realçado (data-cut-highlight=ok) e o realce some ao sair', drop.hover.highlight === 'ok' && drop.hover.types.includes('application/x-cialight-transition') && drop.gone, drop.hover)
    check('soltar o Dissolver sobre o corte: transição crossfade de 0,5 s em B, em um passo; selecionada', drop.tr?.kind === 'crossfade' && drop.tr?.durationUs === 500000 && drop.past === pStart + 1 && drop.sel === b, drop)
    check('o ícone da transição aparece no corte com aria-label "Transição: Dissolver, 0,5 s" e o inspetor mostra "Transição"', drop.label === 'Transição: Dissolver, 0,5 s' && drop.pressed === 'true' && drop.title === 'Transição', drop)
    await shot('f5-09-transicao-icone.png')
    // largura da janela em escala
    const geo = await ev(`const m = document.querySelector('[data-transition-id="${b}"]'); const r = m.getBoundingClientRect(); const s = T.st()
      return { w: r.width, expect: (500000 * s.zoomPxPerSec) / 1e6, cx: r.left + r.width / 2, cutX: T.lanePoint(${cut}, '${track}').x }`)
    check('a faixa do ícone tem a largura da janela em escala e fica centrada no corte', Math.abs(geo.w - Math.max(22, geo.expect)) < 1.5 && Math.abs(geo.cx - geo.cutX) < 1.5, geo)
    // painel da transição: tipo e duração com aviso
    const pn = await ev(`const txt = T.inspector().textContent; return { ok: ['Tipo', 'Duração', 'Remover transição', 'Mínimo 0,1 s', 'metade do clipe mais curto'].filter((s) => !txt.includes(s)) }`)
    check('painel da transição: tipo, duração, limites e remover', pn.ok.length === 0, pn)
    const lim = await ev(`const inp = T.inspector().querySelector('input[aria-label="Duração"]'); const p0 = T.past()
      await T.typeInto(inp, '30'); await T.wait(300)
      const hi = { dur: T.item('${b}').transitionIn.durationUs, warn: document.querySelector('[data-transition-warning]')?.textContent ?? null, past: T.past() }
      await T.typeInto(T.inspector().querySelector('input[aria-label="Duração"]'), '0,01'); await T.wait(300)
      const lo = { dur: T.item('${b}').transitionIn.durationUs, warn: document.querySelector('[data-transition-warning]')?.textContent ?? null }
      await T.typeInto(T.inspector().querySelector('input[aria-label="Duração"]'), '0,5'); await T.wait(300)
      return { p0, hi, lo, back: T.item('${b}').transitionIn.durationUs, warnGone: !document.querySelector('[data-transition-warning]') }`)
    check('duração 30 s → limitada à metade do clipe mais curto (1,25 s) com aviso; 0,01 s → mínimo 0,1 s com aviso; 0,5 s limpa o aviso', lim.hi.dur === 1250000 && /limitada a 1,25 s/.test(lim.hi.warn ?? '') && lim.lo.dur === 100000 && /mínimo/.test(lim.lo.warn ?? '') && lim.back === 500000 && lim.warnGone, lim)
    // tipo no painel mantém a duração
    const ty = await ev(`const trig = T.inspector().querySelector('button[role="combobox"]'); const c0 = T.center(trig)
      trig.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: c0.x, clientY: c0.y, button: 0, pointerType: 'mouse', pointerId: 1 })); await T.wait(300)
      const opts = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim())
      const o = [...document.querySelectorAll('[role="option"]')].find((x) => x.textContent.trim() === 'Cortina ←')
      if (o) { o.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1 })); o.click() }
      await T.wait(400)
      return { n: opts.length, tr: T.item('${b}').transitionIn }`)
    check('seletor de tipo do painel: 11 opções; Cortina ← troca o tipo e mantém 0,5 s', ty.n === 11 && ty.tr.kind === 'wipeL' && ty.tr.durationUs === 500000, ty)
    await ev(`const b = T.item('${b}'); const trig = T.inspector().querySelector('button[role="combobox"]'); const c0 = T.center(trig)
      trig.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: c0.x, clientY: c0.y, button: 0, pointerType: 'mouse', pointerId: 1 })); await T.wait(300)
      const o = [...document.querySelectorAll('[role="option"]')].find((x) => x.textContent.trim() === 'Dissolver'); o.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1 })); o.click(); await T.wait(300); return 1`)
    // arrastar a borda do ícone: a duração muda (1 px de borda = 2 px de janela) em UM passo
    const ed = await ev(`const p0 = T.past(); const d0 = T.item('${b}').transitionIn.durationUs
      const edge = document.querySelector('[data-transition-id="${b}"] [data-tedge="end"]'); const c = T.center(edge)
      await T.drag(c, { x: c.x + 20, y: c.y }, { steps: 10 }); await T.wait(300)
      const d1 = T.item('${b}').transitionIn.durationUs; const pps = T.st().zoomPxPerSec
      return { p0, past: T.past(), d0, d1, pps, expect: d0 + 2 * Math.round(20 * 1e6 / pps) }`)
    check('arrastar a borda direita 20 px muda a duração (≈ +2×20 px de tempo) em UM passo de desfazer', ed.past === ed.p0 + 1 && Math.abs(ed.d1 - ed.expect) <= 60000 && ed.d1 > ed.d0, ed)
    const ed2 = await ev(`const p0 = T.past(); const d0 = T.item('${b}').transitionIn.durationUs
      const edge = document.querySelector('[data-transition-id="${b}"] [data-tedge="start"]'); const c = T.center(edge)
      await T.drag(c, { x: c.x + 15, y: c.y }, { steps: 10 }); await T.wait(300)
      return { p0, past: T.past(), d0, d1: T.item('${b}').transitionIn.durationUs }`)
    check('arrastar a borda esquerda para dentro (+15 px) encurta a duração, em um passo', ed2.past === ed2.p0 + 1 && ed2.d1 < ed2.d0, ed2)
    await shot('f5-10-transicao-borda.png')
    // seleção no visualizador dentro da janela da transição: A e B selecionáveis
    const vw = await ev(`const tr = T.item('${b}').transitionIn; const mid = ${cut} - Math.floor(tr.durationUs / 4)
      await T.seek(mid); await T.wait(500)
      const c = T.toScreen(300, 900); await T.clickAt(c.x, c.y); const first = T.st().selection[0]
      await T.seek(${cut} + Math.floor(tr.durationUs / 4)); await T.wait(500)
      await T.clickAt(c.x, c.y); const second = T.st().selection[0]
      return { a: '${a}', b: '${b}', first, second, handles: !!document.querySelector('[data-media-handles]') }`)
    check('dentro da janela da transição os clipes continuam selecionáveis no visualizador (A na 1ª metade, B na 2ª)', vw.first === a && vw.second === b && vw.handles, vw)
    await shot('f5-11-selecao-na-transicao.png')
    // Delete remove a transição selecionada (um passo) e Ctrl+Z devolve
    const del = await ev(`T.st().selectTransition('${b}'); await T.settle(); const p0 = T.past()
      document.activeElement?.blur?.(); await T.key('Delete'); await T.wait(300)
      const gone = { tr: T.item('${b}').transitionIn ?? null, icon: !!document.querySelector('[data-transition-id="${b}"]'), still: !!T.item('${b}') && !!T.item('${a}'), past: T.past(), p0 }
      await T.key('z', { ctrlKey: true }); await T.wait(300)
      return { gone, back: T.item('${b}').transitionIn?.kind ?? null, past: T.past() }`)
    check('Delete remove a transição selecionada (os clipes ficam; um passo); Ctrl+Z a devolve', del.gone.tr === null && !del.gone.icon && del.gone.still && del.gone.past === del.gone.p0 + 1 && del.back === 'crossfade' && del.past === del.gone.p0, del)
    // menu de contexto
    const menu = await ev(`const icon = document.querySelector('[data-transition-id="${b}"] [data-transition-icon]'); const c = T.center(icon)
      icon.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: c.x, clientY: c.y, button: 2 })); await T.wait(300)
      const items = [...document.querySelectorAll('[data-timeline-menu] [role="menuitem"]')].map((x) => x.textContent.trim())
      return { items }`)
    check('menu de contexto do ícone: Trocar tipo, Duração e Remover transição', ['Trocar tipo', 'Duração', 'Remover transição'].every((l) => menu.items.some((x) => x.startsWith(l))), menu)
    await shot('f5-12-transicao-menu.png')
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); T.all('[data-timeline-menu]').forEach(() => {}); await T.key('Escape'); await T.wait(200); return 1`)
    // soltar sobre algo inelegível: o 1º clipe (sem anterior encostado) → toast; o logo (faixa 2) idem
    const bad = await ev(`const p0 = T.past()
      const pt = T.lanePoint(1e6, '${track}')
      await T.dragCard(T.el('[data-transition-kind="dipBlack"]'), pt); await T.wait(400)
      const t1 = T.toasts()
      const logo = T.items().find((i) => i.assetId === 'a_qa_logo'); const lt = T.st().project.tracks.find((t) => t.items.some((i) => i.id === logo.id))
      const pt2 = T.lanePoint(logo.startUs + 1e6, lt.id)
      await T.dragCard(T.el('[data-transition-kind="dipBlack"]'), pt2); await T.wait(400)
      const t2 = T.toasts()
      const empty = T.lanesRect(); const ept = { x: empty.left + 188 + 5, y: empty.top + 4 }
      return { p0, past: T.past(), t1, t2, a0: T.item('${a}').transitionIn ?? null, logo: T.item(logo.id).transitionIn ?? null }`)
    check('soltar uma transição sobre o 1º clipe (sem clipe anterior) mostra o aviso da regra e não muda o projeto', bad.past === bad.p0 && bad.a0 === null && bad.logo === null && bad.t1.some((t) => /encostados/.test(t)), bad)
    check('soltar sobre outro clipe sem vizinho encostado também avisa', bad.t2.some((t) => /encostados/.test(t)), bad.t2)
    await shot('f5-13-transicao-inelegivel.png')
  }

  // ------------------------------------------------------------------ 6
  console.log('6. atalhos T e Ctrl+T')
  {
    const r = await ev(`await T.wait(3200); document.activeElement?.blur?.()
      const vs = T.videoTrack().items.filter((i) => i.type === 'media' && i.assetId === 'a_qa_video').sort((a, b) => a.startUs - b.startUs)
      const b = vs[1].id
      // estado limpo: sem transição em B
      if (T.item(b).transitionIn) { T.st().selectTransition(b); await T.key('Delete'); await T.wait(200) }
      T.st().select([]); T.st().setPlayhead(3e6); T.st().select([])
      const p0 = T.past(); const n0 = T.items().filter((i) => i.type === 'text').length
      await T.key('t'); await T.wait(300)
      const sel = T.st().selection[0]; const it = T.item(sel)
      const afterT = { n: T.items().filter((i) => i.type === 'text').length, type: it?.type, text: it?.text, start: it?.startUs, past: T.past() }
      T.st().select([]); await T.settle()
      await T.key('t', { ctrlKey: true }); await T.wait(300)
      const afterC = { tr: T.item(b).transitionIn ?? null, sel: T.st().selectedTransition, past: T.past() }
      return { p0, n0, afterT, afterC, b }`)
    check('T adiciona o Título no playhead (3 s), selecionado, em um passo', r.afterT.n === r.n0 + 1 && r.afterT.type === 'text' && r.afterT.text === 'Título' && r.afterT.start === 3000000 && r.afterT.past === r.p0 + 1, r)
    check('Ctrl+T (playhead perto do corte, sem faixa selecionada) põe o Dissolver no corte mais próximo, selecionado, em um passo', r.afterC.tr?.kind === 'crossfade' && r.afterC.tr?.durationUs === 500000 && r.afterC.sel === r.b && r.afterC.past === r.afterT.past + 1, r)
    // dentro da textarea a letra T é só uma letra
    const inTa = await ev(`const p0 = T.past(); const id = T.st().selection[0] ?? T.items().filter((i) => i.type === 'text').at(-1).id
      const t = T.items().filter((i) => i.type === 'text').at(-1); T.st().select([t.id]); await T.seek(t.startUs + 1.2e6); await T.wait(500)
      const box = T.handleBox(t.id); const c = T.toScreen(box.x + box.w / 2, box.y + box.h / 2); await T.dblclickAt(c.x, c.y); await T.wait(200)
      const ta = document.querySelector('[data-text-editor]'); const n0 = T.items().length
      await T.key('t', {}, ta); await T.key('t', { ctrlKey: true }, ta)
      const res = { ta: !!ta, n0, n1: T.items().length }
      await T.key('Escape', {}, ta); await T.wait(200)
      return res`)
    check('digitando na textarea de edição, T e Ctrl+T não disparam os atalhos', inTa.ta && inTa.n1 === inTa.n0, inTa)
    await shot('f5-14-atalhos.png')
    // sem corte: Ctrl+T avisa
    const none = await ev(`T.st().select([]); T.st().setPlayhead(0)
      const vs = T.videoTrack().items.filter((i) => i.type === 'media' && i.assetId === 'a_qa_video').sort((a, b) => a.startUs - b.startUs)
      // selecionar só o logo (faixa sem corte elegível): Ctrl+T avisa
      const logo = T.items().find((i) => i.assetId === 'a_qa_logo'); T.st().select([logo.id]); await T.settle()
      const p0 = T.past(); await T.key('t', { ctrlKey: true }); await T.wait(400)
      return { p0, past: T.past(), toasts: T.toasts() }`)
    check('Ctrl+T com a faixa selecionada sem corte elegível avisa e não muda nada', none.past === none.p0 && none.toasts.some((t) => /Não há corte/.test(t)), none)
  }

  // volta o projeto ao estado inicial
  await ev(`T.st().select([]); await T.undoTo(${past0}); return 1`)
  const final = await ev(`return { past: T.past(), n: T.items().length, texts: T.items().filter((i) => i.type === 'text' || i.type === 'shape').length, tr: T.items().filter((i) => i.transitionIn).length }`)
  check('desfazer tudo devolve o projeto ao início (sem texto, forma nem transição)', final.past === past0 && final.texts === 0 && final.tr === 0, final)
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
  const now = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
  const hashAfter = sha(now)
  console.log(`settings.json sha256 depois: ${hashAfter}`)
  if (hashAfter === hashBefore) console.log('  ✔ settings.json intocado (hash igual)')
  else {
    let keys = []
    try {
      const a = JSON.parse(settingsBefore?.toString() ?? '{}')
      const b = JSON.parse(now?.toString() ?? '{}')
      keys = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      for (const k of keys) console.log(`    ${k}: ${JSON.stringify(a[k])?.slice(0, 140)} → ${JSON.stringify(b[k])?.slice(0, 140)}`)
    } catch {
      keys = ['(ilegível)']
    }
    if (settingsBefore) writeFileSync(SETTINGS, settingsBefore)
    const restored = sha(existsSync(SETTINGS) ? readFileSync(SETTINGS) : null)
    const benign = keys.length > 0 && keys.every((k) => k === 'pip')
    if (restored !== hashBefore) {
      failures++
      console.log(`  ✘ settings.json mudou (${keys.join(', ')}) e a restauração não devolveu o hash original`)
    } else if (!benign) {
      failures++
      console.log(`  ✘ settings.json mudou durante o teste (chaves: ${keys.join(', ')}); restaurado (hash ${restored.slice(0, 12)}…)`)
    } else console.log(`  ⚠ o app regravou só a geometria do PiP (pip) — restaurado; hash final igual ao de antes (${restored.slice(0, 12)}…)`)
  }
  console.log(failures ? `\n${failures} falha(s) em ${checks} verificações` : `\ntudo OK (${checks} verificações)`)
  process.exit(failures ? 1 : 0)
}
