// QA do editor de curvas e das linhas de keyframes (F4 Task 2) via CDP, com eventos de ponteiro/teclado sintéticos
// despachados no elemento real sob o ponto (document.elementFromPoint) — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f4-keyframes.mjs            → abre o app (CIALIGHT_QA=editor-fixture,
//                                                       CIALIGHT_RAW_DIR=test-out/raw), testa e fecha
//   node scripts/qa/editor-f4-keyframes.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// A fixture é mídia sintética (testsrc2 + voz sintética + PNG). Confere no store e na tela: seta que expande o
// item, uma linha por propriedade animada (cores por ease, mini-curva), clique/Shift/caixa para selecionar,
// arrastar o grupo (um passo de desfazer), Delete, Ctrl+C/Ctrl+V no playhead, editor de curvas (losango com o
// botão direito e ◇ do inspetor, também desativado/bloqueado; presets; alças com x preso e y livre, por teclado),
// seleção mista (combinado + linha), colar parcial, atalhos com o popover aberto, linha combinada intacta, o custo
// por evento ao arrastar um losango e o projeto reaberto recolhido. Screenshots em docs/qa/editor-f4/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f4')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const S = 1_000_000

mkdirSync(SHOTS, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

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
async function ev(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__kf; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// helpers da página: eventos no elemento real sob o ponto, leitura do store
const HELPERS = `
window.__kf = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel) => [...document.querySelectorAll(sel)]
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const pe = (type, x, y, mods) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...(mods || {}) })
  const me = (type, x, y, mods) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: type === 'contextmenu' ? 2 : 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1, ...(mods || {}) })
  /** Clique completo no elemento real sob o ponto (pointer + mouse + click). */
  const clickAt = async (x, y, mods) => {
    const t = topAt(x, y)
    t.dispatchEvent(pe('pointerdown', x, y, mods)); t.dispatchEvent(me('mousedown', x, y, mods))
    window.dispatchEvent(pe('pointerup', x, y, mods)); t.dispatchEvent(me('mouseup', x, y, mods)); t.dispatchEvent(me('click', x, y, mods))
    await settle()
    return t
  }
  const click = async (e, mods) => { const c = center(e); return clickAt(c.x, c.y, mods) }
  const rightClick = async (e) => { const c = center(e); const t = topAt(c.x, c.y); t.dispatchEvent(me('contextmenu', c.x, c.y)); await settle(); await wait(250); return t }
  /** Arrasto: pointerdown no elemento sob o ponto; movimentos e soltura na janela (como os gestos ouvem). */
  async function drag(from, to, opts = {}) {
    const steps = opts.steps ?? 8
    const t = topAt(from.x, from.y)
    t.dispatchEvent(pe('pointerdown', from.x, from.y, opts.mods))
    for (let i = 1; i <= steps; i++) window.dispatchEvent(pe('pointermove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, opts.mods))
    await settle()
    if (opts.release !== false) { window.dispatchEvent(pe('pointerup', to.x, to.y, opts.mods)); await settle() }
    return t
  }
  const key = async (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items)
  const item = (id) => items().find((i) => i.id === id)
  const keysOf = (id, group, k) => (item(id).visual[group][k].keys || []).map((x) => [x.tUs, x.value, typeof x.ease === 'object' ? x.ease.bezier : x.ease])
  const past = () => st().history.past.length
  const xOf = (us) => { const r = el('[data-timeline-ruler]').getBoundingClientRect(); const s = st(); return r.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6 }
  const lanes = (id) => document.querySelector('[data-lanes-item="' + id + '"]')
  const laneKey = (id, path, tUs) => el('[data-lanes-item="' + id + '"] [data-lane-key="' + tUs + '"][data-path="' + path + '"]')
  const laneRow = (id, path) => el('[data-lanes-item="' + id + '"] [data-lane-path="' + path + '"]')
  const sel = () => window.__qaKfSel ? window.__qaKfSel() : null
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(200); await settle() }
  return { st, settle, wait, el, all, center, topAt, clickAt, click, rightClick, drag, key, items, item, keysOf, past, xOf, lanes, laneKey, laneRow, sel, seek }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 768)
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`localStorage.setItem('editor.timelineHeight', '330'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!s.project.assets.find((a) => a.id === 'a_qa_video')?.filmstrip`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
  const v = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && i.visual).id`)
  // preparo: X (linear) 1 s → 4 s, escala ('in') 1 s → 4 s, opacidade 2 s → 5 s (um passo; o QA é da interface)
  await ev(`const s = T.st(); s.select([]); s.setZoom(100); s.setScroll(0)
    s.apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => i.id !== '${v}' ? i : { ...i, visual: { ...i.visual, transform: { ...i.visual.transform,
      x: { value: 0.5, keys: [{ tUs: 1e6, value: 0.3, ease: 'linear' }, { tUs: 4e6, value: 0.7, ease: 'linear' }] },
      scale: { value: 1, keys: [{ tUs: 1e6, value: 1, ease: 'in' }, { tUs: 4e6, value: 1.5, ease: 'linear' }] },
      opacity: { value: 1, keys: [{ tUs: 2e6, value: 1, ease: 'linear' }, { tUs: 5e6, value: 0.2, ease: 'linear' }] } } } }) })) }))
    await T.seek(0); return 1`)
  await sleep(500)

  console.log('expandir o item (seta)')
  {
    const r = await ev(`const row = () => T.el('[data-track-id="' + T.st().project.tracks.find((t) => t.items.some((i) => i.id === '${v}')).id + '"]').parentElement.getBoundingClientRect().height
      const h0 = row(); const btn = T.el('[data-item-id="${v}"] [data-expand-item]'); const label0 = btn.getAttribute('aria-label')
      await T.click(btn); await T.wait(150)
      const paths = T.all('[data-lanes-item="${v}"] [data-lane-path]').map((e) => e.dataset.lanePath)
      return { h0, h1: row(), label0, expanded: btn.getAttribute('aria-expanded'), paths, sel: T.st().selection, labels: T.all('[data-lanes-item="${v}"] [data-lane-path] > span.truncate').map((e) => e.textContent) }`)
    check('seta no item: "Mostrar keyframes por propriedade" e aria-expanded', r.label0 === 'Mostrar keyframes por propriedade' && r.expanded === 'true', r)
    check('uma linha por propriedade animada, na ordem (X, escala, opacidade), com os nomes', JSON.stringify(r.paths) === JSON.stringify(['transform.x', 'transform.scale', 'transform.opacity']) && JSON.stringify(r.labels) === JSON.stringify(['Posição X', 'Escala', 'Opacidade']), r)
    check('a faixa ganha 3 × 22 px + 4 px', r.h1 - r.h0 === 3 * 22 + 4, r)
    check('clicar na seta não seleciona nem move o item', r.sel.length === 0, r.sel)
    const c = await ev(`const bg = (path, t) => getComputedStyle(T.laneKey('${v}', path, t).firstElementChild).backgroundColor
      return { lin: bg('transform.x', 1e6), inn: bg('transform.scale', 1e6), curves: T.all('[data-lanes-item="${v}"] [data-lane-path="transform.scale"] svg path').map((p) => [p.getAttribute('stroke'), p.getAttribute('d').split('L').length]) }`)
    check('losangos na cor do ease (linear cinza-claro, suavizar entrada azul)', c.lin === 'rgb(199, 206, 217)' && c.inn === 'rgb(94, 200, 255)', c)
    check('mini-curva: trecho "suavizar entrada" desenhado em polilinha azul + trechos planos', c.curves.some(([s, n]) => s === '#5ec8ff' && n > 8) && c.curves.some(([s]) => s.startsWith('rgba')), c.curves)
    await shot('f4-kf-01-linhas.png')
  }

  console.log('clique, Shift+clique e arrastar o grupo')
  {
    const r = await ev(`await T.click(T.laneKey('${v}', 'transform.x', 1e6)); await T.wait(150)
      const a = { ph: T.st().playheadUs, sel: T.st().selection, selected: T.laneKey('${v}', 'transform.x', 1e6).dataset.selected ?? null }
      await T.click(T.laneKey('${v}', 'transform.opacity', 2e6), { shiftKey: true })
      const b = { selected: T.all('[data-lanes-item="${v}"] [data-selected]').map((e) => e.dataset.path + '@' + e.dataset.laneKey) }
      return { a, b }`)
    check('clique no losango leva o playhead ao key (1 s) e o seleciona (item selecionado)', r.a.ph === S && r.a.sel.length === 1 && r.a.sel[0] === v && r.a.selected === 'true', r.a)
    check('Shift+clique soma outro losango à seleção', JSON.stringify(r.b.selected.sort()) === JSON.stringify(['transform.opacity@2000000', 'transform.x@1000000']), r.b)
    const d = await ev(`const p0 = T.past(); const k = T.center(T.laneKey('${v}', 'transform.x', 1e6))
      await T.drag(k, { x: k.x + 50, y: k.y }, { release: false }); const label = document.querySelector('[data-drag-label]')?.textContent ?? null
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: k.x + 50, clientY: k.y, pointerId: 1 })); await T.settle()
      return { p0, past: T.past(), label, x: T.keysOf('${v}', 'transform', 'x'), o: T.keysOf('${v}', 'transform', 'opacity'), s: T.keysOf('${v}', 'transform', 'scale'), tx: !!T.st().txBase,
        selected: T.all('[data-lanes-item="${v}"] [data-selected]').map((e) => e.dataset.path + '@' + e.dataset.laneKey).sort() }`)
    check('arrastar: X@1 s e opacidade@2 s andam +0,5 s juntos; escala@1 s fica', d.x[0][0] === 1.5 * S && d.x[1][0] === 4 * S && d.o[0][0] === 2.5 * S && d.o[1][0] === 5 * S && d.s[0][0] === S, d)
    check('dica com o instante durante o arraste; um passo de desfazer; seleção acompanha', d.label?.startsWith('Keyframe:') && d.past === d.p0 + 1 && !d.tx && JSON.stringify(d.selected) === JSON.stringify(['transform.opacity@2500000', 'transform.x@1500000']), d)
    const u = await ev(`await T.key('z', { ctrlKey: true }); return { x: T.keysOf('${v}', 'transform', 'x'), o: T.keysOf('${v}', 'transform', 'opacity') }`)
    check('Ctrl+Z desfaz o arraste do grupo', u.x[0][0] === S && u.o[0][0] === 2 * S, u)
  }

  console.log('caixa nas linhas + Delete')
  {
    const r = await ev(`const rx = T.laneRow('${v}', 'transform.x').getBoundingClientRect(); const rs = T.laneRow('${v}', 'transform.scale').getBoundingClientRect()
      await T.drag({ x: T.xOf(0.5e6), y: rx.top + 4 }, { x: T.xOf(4.5e6), y: rs.top + 18 })
      const sel = T.all('[data-lanes-item="${v}"] [data-selected]').map((e) => e.dataset.path + '@' + e.dataset.laneKey).sort()
      const p0 = T.past(); await T.key('Delete')
      return { sel, p0, past: T.past(), item: !!T.item('${v}'), x: T.keysOf('${v}', 'transform', 'x'), s: T.keysOf('${v}', 'transform', 'scale'), o: T.keysOf('${v}', 'transform', 'opacity'),
        paths: T.all('[data-lanes-item="${v}"] [data-lane-path]').map((e) => e.dataset.lanePath) }`)
    check('caixa seleciona os keys das linhas e do intervalo cruzados', JSON.stringify(r.sel) === JSON.stringify(['transform.scale@1000000', 'transform.scale@4000000', 'transform.x@1000000', 'transform.x@4000000']), r.sel)
    check('Delete remove só esses keys (o item fica), um passo; linhas sem keys somem', r.item && r.x.length === 0 && r.s.length === 0 && r.o.length === 2 && r.past === r.p0 + 1 && JSON.stringify(r.paths) === JSON.stringify(['transform.opacity']), r)
    await ev(`await T.key('z', { ctrlKey: true }); return 1`)
  }

  console.log('Ctrl+C / Ctrl+V de keyframes no playhead')
  {
    const r = await ev(`const ro = T.laneRow('${v}', 'transform.opacity').getBoundingClientRect()
      await T.drag({ x: T.xOf(1.5e6), y: ro.top + 6 }, { x: T.xOf(5.5e6), y: ro.top + 14 })
      const sel = T.all('[data-lanes-item="${v}"] [data-selected]').map((e) => e.dataset.path + '@' + e.dataset.laneKey)
      await T.key('c', { ctrlKey: true }); await T.seek(7e6); const p0 = T.past(); await T.key('v', { ctrlKey: true })
      return { sel, p0, past: T.past(), o: T.keysOf('${v}', 'transform', 'opacity'), n: T.items().length }`)
    check('copiou os 2 keys de opacidade', r.sel.length === 2, r.sel)
    check('colou a partir de 7 s com a distância mantida (7 s e 10 s), sem duplicar itens, um passo', JSON.stringify(r.o.map((k) => [k[0], k[1]])) === JSON.stringify([[2 * S, 1], [5 * S, 0.2], [7 * S, 1], [10 * S, 0.2]]) && r.past === r.p0 + 1, r)
    await ev(`await T.key('z', { ctrlKey: true }); return 1`)
  }

  console.log('colar keyframes parcial (item sem as propriedades)')
  {
    const r = await ev(`const a = T.items().find((i) => i.assetId === 'a_qa_video' && !i.visual).id; await T.seek(7e6); T.st().select(['${v}', a]); await T.settle()
      const p0 = T.past(); await T.key('v', { ctrlKey: true }); await T.wait(200)
      const toasts = T.all('[data-sonner-toast]').map((t) => t.textContent)
      const out = { p0, past: T.past(), o: T.keysOf('${v}', 'transform', 'opacity').map((k) => k[0]), toasts }
      await T.key('z', { ctrlKey: true }); T.st().select(['${v}']); await T.settle(); return out`)
    check('cola só no clipe com opacidade (7 s e 10 s), um passo; aviso "Colado em 1 de 2 itens"', JSON.stringify(r.o) === JSON.stringify([2 * S, 5 * S, 7 * S, 10 * S]) && r.past === r.p0 + 1 && r.toasts.some((t) => t.includes('Colado em 1 de 2 itens (1 sem essas propriedades).')), r)
  }

  console.log('editor de curvas (botão direito no losango)')
  {
    const r = await ev(`await T.seek(0); await T.rightClick(T.laneKey('${v}', 'transform.scale', 1e6))
      const pop = document.querySelector('[data-curve-editor]')
      return { open: !!pop, text: pop?.textContent ?? '', pressed: T.all('[data-curve-editor] [data-curve-preset][aria-pressed="true"]').map((b) => b.dataset.curvePreset), presets: T.all('[data-curve-editor] [data-curve-preset]').map((b) => b.textContent.trim()) }`)
    check('abre o popover "Curva — Escala" com o trecho 1 s → 4 s', r.open && r.text.includes('Curva — Escala') && r.text.includes('00:01:00 → 00:04:00'), r.text)
    check('presets Linear/Segurar/Suavizar entrada/Suavizar saída/Suavizar ambos/Overshoot; o atual (entrada) marcado', JSON.stringify(r.presets) === JSON.stringify(['Linear', 'Segurar', 'Suavizar entrada', 'Suavizar saída', 'Suavizar ambos', 'Overshoot']) && JSON.stringify(r.pressed) === JSON.stringify(['in']), r)
    await shot('f4-kf-02-curva-entrada.png')
    const o = await ev(`const p0 = T.past(); await T.click(T.el('[data-curve-editor] [data-curve-preset="overshoot"]')); await T.wait(100)
      return { p0, past: T.past(), s: T.keysOf('${v}', 'transform', 'scale'), color: getComputedStyle(T.laneKey('${v}', 'transform.scale', 1e6).firstElementChild).backgroundColor, pressed: T.all('[data-curve-editor] [data-curve-preset][aria-pressed="true"]').map((b) => b.dataset.curvePreset) }`)
    check('Overshoot: bezier (0,34; 1,56; 0,64; 1) no key de 1 s, um passo; losango roxo', JSON.stringify(o.s[0][2]) === JSON.stringify([0.34, 1.56, 0.64, 1]) && o.past === o.p0 + 1 && o.color === 'rgb(192, 140, 255)' && o.pressed[0] === 'overshoot', o)
    await shot('f4-kf-03-curva-overshoot.png')
    // alça 1: para fora do gráfico (x < 0 e muito acima) → x preso em 0 e y em 2; depois para um ponto interno
    const h = await ev(`const p0 = T.past(); const g = T.el('[data-curve-editor] [data-curve-graph]').getBoundingClientRect(); const c = T.center(T.el('[data-curve-editor] [data-curve-handle="1"]'))
      await T.drag(c, { x: g.left - 80, y: g.top - 400 }, { release: false }); const mid = T.keysOf('${v}', 'transform', 'scale')[0][2]; const tx = !!T.st().txBase
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: g.left - 80, clientY: g.top - 400, pointerId: 1 })); await T.settle()
      const after = T.keysOf('${v}', 'transform', 'scale')[0][2]
      const c2 = T.center(T.el('[data-curve-editor] [data-curve-handle="2"]'))
      await T.drag(c2, { x: g.left + g.width * 0.5, y: g.top + g.height * 0.5 })
      return { p0, past: T.past(), mid, tx, after, end: T.keysOf('${v}', 'transform', 'scale')[0][2], readout: T.el('[data-curve-editor] [data-curve-values]').textContent }`)
    check('arrastar a alça 1 para fora: x preso em 0 e y preso em 2 (transação aberta durante o arraste)', h.tx && h.mid[0] === 0 && h.mid[1] === 2 && JSON.stringify(h.after) === JSON.stringify(h.mid), h)
    check('alça 2 no meio do gráfico: x2 ≈ 0,5; x1/y1 mantidos; um passo por arraste', Math.abs(h.end[2] - 0.5) < 0.03 && h.end[0] === 0 && h.end[1] === 2 && h.past === h.p0 + 2, h)
    check('valores da bezier mostrados', h.readout.startsWith('bezier(0,00; 2,00;'), h.readout)
    await shot('f4-kf-04-curva-alcas.png')
    const esc = await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await T.settle(); await T.wait(250); return { open: !!document.querySelector('[data-curve-editor]'), sel: T.st().selection }`)
    check('Esc fecha o editor de curvas (sem mexer na seleção)', !esc.open && esc.sel.includes(v), esc)
    const shape = await ev(`return T.all('[data-lanes-item="${v}"] [data-lane-path="transform.scale"] svg path').map((p) => p.getAttribute('stroke'))`)
    check('mini-curva da escala agora roxa (curva personalizada)', shape.includes('#c08cff'), shape)
  }

  console.log('◇ do inspetor com o botão direito')
  {
    const r = await ev(`await T.seek(2.5e6); T.st().select(['${v}']); await T.settle(); await T.wait(200)
      const tab = [...document.querySelectorAll('[aria-label="Inspetor"] [role="tab"]')].find((x) => x.textContent.trim() === 'Vídeo'); if (tab) await T.click(tab); await T.wait(200)
      const kf = T.el('[aria-label="Inspetor"] [data-kf-path="transform.opacity"] [data-kf="toggle"]')
      await T.rightClick(kf); const pop = document.querySelector('[data-curve-editor]')
      return { open: !!pop, text: pop?.textContent ?? '', pressed: T.all('[data-curve-editor] [data-curve-preset][aria-pressed="true"]').map((b) => b.dataset.curvePreset) }`)
    check('abre a curva do trecho em que o playhead está (opacidade 2 s → 5 s, linear)', r.open && r.text.includes('Curva — Opacidade') && r.text.includes('00:02:00 → 00:05:00') && r.pressed[0] === 'linear', r)
    await shot('f4-kf-05-curva-inspetor.png')
    const s = await ev(`const p0 = T.past(); await T.click(T.el('[data-curve-editor] [data-curve-preset="hold"]')); await T.wait(100)
      const path = T.el('[data-curve-editor] [data-curve-path]').getAttribute('d')
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await T.settle(); await T.wait(200)
      return { p0, past: T.past(), o: T.keysOf('${v}', 'transform', 'opacity'), path }`)
    check('Segurar: ease "hold" no key de 2 s (degrau no gráfico), um passo', s.o[0][2] === 'hold' && s.o[1][2] === 'linear' && s.past === s.p0 + 1 && s.path.split('L').length === 3, s)
  }

  console.log('seleção mista (combinado + linha)')
  {
    const r = await ev(`await T.seek(0); T.st().select(['${v}']); await T.settle()
      await T.click(T.el('[data-item-id="${v}"] [data-keyframe="1000000"]')); await T.click(T.laneKey('${v}', 'transform.opacity', 2e6), { shiftKey: true })
      // a escala em 1 s aparece selecionada por causa do combinado: arrastá-la leva o grupo inteiro
      const shown = T.laneKey('${v}', 'transform.scale', 1e6).dataset.selected ?? null
      const p0 = T.past(); const k = T.center(T.laneKey('${v}', 'transform.scale', 1e6))
      await T.drag(k, { x: k.x + 50, y: k.y })
      const out = { shown, p0, past: T.past(), x: T.keysOf('${v}', 'transform', 'x').map((k) => k[0]), s: T.keysOf('${v}', 'transform', 'scale').map((k) => k[0]), o: T.keysOf('${v}', 'transform', 'opacity').map((k) => k[0]) }
      await T.key('z', { ctrlKey: true }); return out`)
    check('arrastar a linha selecionada pelo combinado move combinado + opacidade juntos (+0,5 s), um passo', r.shown === 'true' && JSON.stringify(r.x) === JSON.stringify([1.5 * S, 4 * S]) && JSON.stringify(r.s) === JSON.stringify([1.5 * S, 4 * S]) && JSON.stringify(r.o) === JSON.stringify([2.5 * S, 5 * S]) && r.past === r.p0 + 1, r)
    const c = await ev(`await T.click(T.el('[data-item-id="${v}"] [data-keyframe="1000000"]')); await T.click(T.laneKey('${v}', 'transform.opacity', 2e6), { shiftKey: true })
      const before = T.all('[data-lanes-item="${v}"] [data-selected]').length
      await T.click(T.laneKey('${v}', 'transform.x', 1e6)); await T.wait(100)
      return { before, after: T.all('[data-lanes-item="${v}"] [data-selected]').map((e) => e.dataset.path + '@' + e.dataset.laneKey), combined: !!document.querySelector('[data-item-id="${v}"] [data-keyframe="1000000"] .ring-accent') }`)
    check('clique sem arrastar num losango da seleção: fica só ele', c.before === 3 && JSON.stringify(c.after) === JSON.stringify(['transform.x@1000000']) && !c.combined, c)
    const a = await ev(`return T.laneKey('${v}', 'transform.x', 1e6).getAttribute('aria-label') + ' | ' + T.laneKey('${v}', 'transform.x', 1e6).getAttribute('role')`)
    check('losango acessível: role=button e rótulo com propriedade, instante e valor', a === 'Keyframe de Posição X em 1,00 s: 30%, curva Linear | button', a)
  }

  console.log('atalhos e teclado com o editor de curvas aberto')
  {
    const r = await ev(`await T.rightClick(T.laneKey('${v}', 'transform.scale', 1e6)); const e0 = T.keysOf('${v}', 'transform', 'scale')[0][2]
      await T.click(T.el('[data-curve-editor] [data-curve-preset="linear"]')); const e1 = T.keysOf('${v}', 'transform', 'scale')[0][2]
      await T.key('z', { ctrlKey: true }); const e2 = T.keysOf('${v}', 'transform', 'scale')[0][2]
      const p0 = T.past(); await T.key('Delete')
      return { e0, e1, e2, open: !!document.querySelector('[data-curve-editor]'), labelled: document.getElementById(T.el('[data-curve-editor]').getAttribute('aria-labelledby'))?.textContent, del: T.past() - p0, keys: T.keysOf('${v}', 'transform', 'scale').length }`)
    check('Ctrl+Z passa com o editor aberto (desfaz o preset) e ele continua aberto', r.e1 === 'linear' && JSON.stringify(r.e2) === JSON.stringify(r.e0) && r.open, r)
    check('Delete não passa (nada apagado); popover rotulado pelo título', r.del === 0 && r.keys === 2 && r.labelled === 'Curva — Escala', r)
    const k = await ev(`const h = T.el('[data-curve-editor] [data-curve-handle="1"]'); h.focus(); const b0 = T.keysOf('${v}', 'transform', 'scale')[0][2]; const p0 = T.past(); const ph = T.st().playheadUs
      for (let i = 0; i < 3; i++) h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true })); await T.settle(); const tx = !!T.st().txBase
      h.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true, cancelable: true })); await T.settle()
      return { focused: document.activeElement === h, tab: h.getAttribute('tabindex'), b0, b1: T.keysOf('${v}', 'transform', 'scale')[0][2], tx, dp: T.past() - p0, ph: T.st().playheadUs === ph, label: h.getAttribute('aria-label') }`)
    check('alça focável; setas: x1 +0,03 e y1 −0,1 numa transação, um passo ao soltar; playhead parado', k.focused && k.tab === '0' && k.tx && Math.abs(k.b1[0] - Math.min(1, k.b0[0] + 0.03)) < 1e-9 && Math.abs(k.b1[1] - Math.max(-1, k.b0[1] - 0.1)) < 1e-9 && k.dp === 1 && k.ph, k)
    check('rótulo da alça com os valores', k.label.startsWith('Alça de saída do keyframe: tempo '), k.label)
    await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await T.settle(); await T.wait(200); return 1`)
  }

  console.log('◇ desativado + faixa bloqueada: curva só leitura')
  {
    const tid = await ev(`return T.st().project.tracks.find((t) => t.items.some((i) => i.id === '${v}')).id`)
    const r = await ev(`const lock = (on) => T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === '${tid}' ? { ...t, locked: on } : t)) }))
      lock(true); T.st().select(['${v}']); await T.seek(12e6); await T.wait(200)
      const kf = T.el('[aria-label="Inspetor"] [data-kf-path="transform.opacity"] [data-kf="toggle"]'); const disabled = kf.disabled
      await T.rightClick(kf); const pop = document.querySelector('[data-curve-editor]')
      const out = { disabled, open: !!pop, text: pop?.textContent ?? '', presetsDisabled: T.all('[data-curve-editor] [data-curve-preset]').every((b) => b.disabled), handleTab: T.all('[data-curve-editor] [data-curve-handle]').map((h) => h.getAttribute('tabindex')) }
      return out`)
    await shot('f4-kf-07-curva-bloqueada.png')
    await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await T.settle(); await T.wait(200)
      T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === '${tid}' ? { ...t, locked: false } : t)) })); await T.seek(0); return 1`)
    check('botão direito com o ◇ desativado abre a curva (último key: opacidade a partir de 5 s)', r.disabled && r.open && r.text.includes('Curva — Opacidade') && r.text.includes('a partir de 00:05:00'), r)
    check('faixa bloqueada: aviso, presets desativados, alças fora do Tab', r.text.includes('Faixa bloqueada') && r.presetsDisabled && r.handleTab.every((t) => t === '-1'), r)
  }

  console.log('linha combinada (todas as propriedades no instante)')
  {
    const r = await ev(`const k = T.el('[data-item-id="${v}"] [data-keyframe="1000000"]'); await T.click(k); await T.wait(100)
      const lanesSel = T.all('[data-lanes-item="${v}"] [data-selected]').map((e) => e.dataset.path + '@' + e.dataset.laneKey).sort()
      const p0 = T.past(); await T.key('Delete')
      return { lanesSel, p0, past: T.past(), x: T.keysOf('${v}', 'transform', 'x').map((k) => k[0]), s: T.keysOf('${v}', 'transform', 'scale').map((k) => k[0]), o: T.keysOf('${v}', 'transform', 'opacity').map((k) => k[0]) }`)
    check('clicar no losango combinado de 1 s destaca X e escala de 1 s nas linhas', JSON.stringify(r.lanesSel) === JSON.stringify(['transform.scale@1000000', 'transform.x@1000000']), r.lanesSel)
    check('Delete no combinado remove os keys do instante em todas as propriedades, um passo', JSON.stringify(r.x) === JSON.stringify([4 * S]) && JSON.stringify(r.s) === JSON.stringify([4 * S]) && r.o.length === 2 && r.past === r.p0 + 1, r)
    await ev(`await T.key('z', { ctrlKey: true }); return 1`)
  }

  console.log('custo por evento arrastando um losango da linha')
  {
    const r = await ev(`await T.seek(0); const k = T.center(T.laneKey('${v}', 'transform.x', 4e6)); const lanesEl = T.el('[data-timeline-lanes]')
      const t = T.topAt(k.x, k.y); t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: k.x, clientY: k.y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: k.x + 4, clientY: k.y, buttons: 1, pointerId: 1 })); await T.settle()
      const times = []
      for (let i = 1; i <= 60; i++) {
        const t0 = performance.now()
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: k.x + 4 + (i % 30) * 3, clientY: k.y, buttons: 1, pointerId: 1 }))
        await Promise.resolve(); lanesEl.getBoundingClientRect(); document.body.offsetHeight
        times.push(performance.now() - t0)
      }
      await T.settle(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); await T.settle()
      return { times, x: T.keysOf('${v}', 'transform', 'x').map((k) => k[0]), tx: !!T.st().txBase }`)
    const t = [...r.times].sort((a, b) => a - b)
    const avg = t.reduce((a, b) => a + b, 0) / t.length
    console.log(`  por evento: média ${avg.toFixed(2)} ms, p95 ${t[Math.floor(t.length * 0.95)].toFixed(2)} ms, máx ${t[t.length - 1].toFixed(2)} ms`)
    check('média < 8 ms por evento arrastando o losango com o item expandido', avg < 8, { avg })
    check('Esc cancela o arraste do losango (keys no lugar, sem transação)', JSON.stringify(r.x) === JSON.stringify([S, 4 * S]) && !r.tx, r)
  }

  console.log('copiar itens: aviso e menu Copiar/Colar')
  {
    const r = await ev(`T.st().select(['${v}']); await T.settle(); await T.key('Escape'); T.st().select(['${v}']); await T.settle()
      await T.key('c', { ctrlKey: true }); await T.wait(200); const toasts = T.all('[data-sonner-toast]').map((t) => t.textContent)
      const e = T.el('[data-item-id="${v}"]'); const rr = e.getBoundingClientRect(); const x = rr.left + 140, y = rr.top + rr.height / 2
      T.topAt(x, y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 })); await T.settle(); await T.wait(300)
      const menu = T.all('[data-timeline-menu] [role="menuitem"]').map((m) => m.textContent)
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await T.settle(); await T.wait(200)
      return { toasts, menu }`)
    check('Ctrl+C de itens avisa "Item copiado"', r.toasts.some((t) => t.includes('Item copiado')), r.toasts)
    check('menu do item: Copiar (Ctrl+C) e Colar (Ctrl+V)', r.menu.some((t) => t.includes('Copiar') && t.includes('Ctrl+C')) && r.menu.some((t) => t.includes('Colar') && t.includes('Ctrl+V')), r.menu)
  }

  console.log('recolher')
  {
    const r = await ev(`const btn = T.el('[data-item-id="${v}"] [data-expand-item]'); await T.click(btn); await T.wait(150); return { lanes: !!T.lanes('${v}'), expanded: btn.getAttribute('aria-expanded') }`)
    check('a seta recolhe as linhas', !r.lanes && r.expanded === 'false', r)
    await shot('f4-kf-06-recolhido.png')
  }

  console.log('desfazer tudo')
  {
    const r = await ev(`let n = 0; while (T.st().canUndo && n < 40) { await T.key('z', { ctrlKey: true }); n++ } return { n, x: T.keysOf('${v}', 'transform', 'x').length }`)
    check('Ctrl+Z até o início (sem keys de X)', r.x === 0, r)
  }

  console.log('carregar o projeto começa recolhido')
  {
    await ev(`await T.click(T.el('[data-item-id="${v}"] [data-expand-item]')); await T.wait(150); window.__navigate('projects'); return 1`)
    await sleep(800)
    await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
    for (let i = 0; i < 60; i++) {
      if (await ev(`return !!document.querySelector('[data-item-id="${v}"]')`)) break
      await sleep(500)
    }
    await ev(HELPERS + '; return 1')
    const r = await ev(`await T.wait(300); return { lanes: !!T.lanes('${v}'), expanded: T.el('[data-item-id="${v}"] [data-expand-item]').getAttribute('aria-expanded') }`)
    check('reabrir o projeto: nenhum item expandido', !r.lanes && r.expanded === 'false', r)
  }
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
  // settings.json do usuário: restaura se o teste mexeu
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
