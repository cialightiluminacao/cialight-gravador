// QA das regiões de efeito no visualizador (F2 Task 3) via CDP, com eventos de ponteiro/teclado
// sintéticos despachados nos elementos (nunca entrada do sistema operacional).
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-effects.mjs            → abre o app (CIALIGHT_QA=editor-fixture,
//                                                   CIALIGHT_RAW_DIR=test-out/raw), testa e fecha
//   node scripts/qa/editor-effects.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// A fixture é mídia sintética (testsrc2 + PNG), sem gravação da área de trabalho. Confere no store:
// ferramenta B, desenhar retângulo e elipse (Shift), mover, redimensionar (Shift/Alt), girar, guias
// com snap, Esc cancelando, clique fora seleciona a mídia, desfazer (1 passo por gesto); com keyframes
// ligados, mover em dois instantes e conferir a interpolação no store e nos pixels (readPixels).
// Screenshots em docs/qa/editor-f2/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f2')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')

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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__fx; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
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
let task4 = null // efeito desativado (Task 4) para conferir na exportação
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

// helpers da página: eventos sintéticos no visualizador, leitura do store e dos pixels do compositor
const HELPERS = `
window.__fx = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const overlay = () => el('[data-viewer-overlay]')
  /** Ponto do quadro (fração 0–1) em coordenadas de tela. */
  const at = (fx, fy) => { const r = overlay().getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy } }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y, mods) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...(mods || {}) })
  /** Elemento real mais ao topo no ponto (como o navegador escolheria o alvo de um clique de verdade). */
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const down = (x, y, mods) => topAt(x, y).dispatchEvent(pe('pointerdown', x, y, mods))
  const move = (x, y, mods) => window.dispatchEvent(pe('pointermove', x, y, mods))
  const up = (x, y, mods) => window.dispatchEvent(pe('pointerup', x, y, mods))
  async function drag(from, to, opts = {}) {
    const steps = opts.steps ?? 8
    down(from.x, from.y, opts.mods)
    for (let i = 1; i <= steps; i++) move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, opts.mods)
    await settle()
    if (opts.release !== false) { up(to.x, to.y, opts.mods); await settle() }
  }
  const click = async (p, mods) => { down(p.x, p.y, mods); up(p.x, p.y, mods); await settle() }
  const key = async (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.name })))
  const effects = () => items().filter((i) => i.type === 'effect')
  const fx = (id) => effects().find((i) => i.id === id)
  const ev = (a, local) => {
    const k = a.keys
    if (!k || !k.length) return a.value
    if (local <= k[0].tUs) return k[0].value
    if (local >= k[k.length - 1].tUs) return k[k.length - 1].value
    let i = 0
    while (i < k.length - 2 && local >= k[i + 1].tUs) i++
    return k[i].value + (k[i + 1].value - k[i].value) * ((local - k[i].tUs) / (k[i + 1].tUs - k[i].tUs))
  }
  /** Região avaliada no playhead (valores normalizados). */
  const region = (id) => { const f = fx(id); const l = st().playheadUs - f.startUs; const r = f.region; return { x: ev(r.x, l), y: ev(r.y, l), w: ev(r.w, l), h: ev(r.h, l), rotation: ev(r.rotation, l), shape: r.shape } }
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await new Promise((r) => setTimeout(r, 350)); await settle() }
  const tool = () => document.querySelector('[data-viewer-toolbar] button').getAttribute('aria-pressed') === 'true'
  /** Linha y (fração) do quadro renderizado: colunas cujo pixel bate com rgb (±tol). */
  async function rowMatches(fy, rgb, tol = 3) {
    const c = window.__qaEditor.engine.canvas
    const W = c.width, H = c.height
    const y = Math.round(fy * H)
    const px = await window.__qaEditor.engine.render.readPixels(0, y, W, 1)
    const cols = []
    for (let x = 0; x < W; x++) {
      const i = x * 4
      if (Math.abs(px[i] - rgb[0]) <= tol && Math.abs(px[i + 1] - rgb[1]) <= tol && Math.abs(px[i + 2] - rgb[2]) <= tol) cols.push(x)
    }
    return { W, H, count: cols.length, first: cols[0] ?? -1, last: cols[cols.length - 1] ?? -1, mid: cols.length ? (cols[0] + cols[cols.length - 1]) / 2 / W : -1 }
  }
  /** Campo do inspetor por rótulo: digita o valor e confirma (blur), como o usuário. */
  const setField = async (label, value) => {
    const input = el('[aria-label="Inspetor"] input[aria-label="' + label + '"]')
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
    await settle()
  }
  /** Botão de keyframe (prev | toggle | next) de uma propriedade no inspetor. */
  const kf = (path, which) => el('[aria-label="Inspetor"] [data-kf-path="' + path + '"] [data-kf="' + which + '"]')
  /** Clique completo (pointerdown, pointerup, click) no elemento real mais ao topo sobre o centro de e. */
  const clickEl = async (e) => {
    e.scrollIntoView({ block: 'nearest' })
    const c = center(e)
    const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y))
    t.dispatchEvent(pe('pointerup', c.x, c.y))
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: c.x, clientY: c.y, button: 0 }))
    await settle()
  }
  const diamonds = (id) => [...document.querySelectorAll('[data-item-id="' + id + '"] [data-keyframe]')]
  const diamond = (id, tUs) => el('[data-item-id="' + id + '"] [data-keyframe="' + tUs + '"]')
  const keysOf = (a) => (a.keys || []).map((k) => [k.tUs, Math.round(k.value * 1e6) / 1e6])
  const menuItem = (text) => [...document.querySelectorAll('[data-timeline-menu] [role="menuitem"]')].find((x) => x.textContent.includes(text))
  /** Menu de contexto (botão direito) no item da timeline, no elemento real sob o ponto. */
  const contextMenu = async (id) => {
    const r = el('[data-item-id="' + id + '"]').getBoundingClientRect()
    const x = r.left + Math.min(40, r.width / 2), y = r.top + 8
    topAt(x, y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
    await settle()
    await new Promise((res) => setTimeout(res, 250))
  }
  return { st, settle, el, topAt, overlay, at, center, down, move, up, drag, click, key, items, effects, fx, region, past, seek, tool, rowMatches, setField, kf, clickEl, diamonds, diamond, keysOf, menuItem, contextMenu }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 768)
  await ev(`localStorage.setItem('editor.timelineHeight', '260'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
  const videoId = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && i.visual).id`)
  await ev(`T.st().select([]); await T.seek(2_000_000); return 1`)
  await sleep(600)

  console.log('ferramenta Desenhar região (B)')
  {
    await ev(`await T.key('b'); return 1`)
    check('B liga a ferramenta', await ev(`return T.tool()`), null)
    const ov = await ev(`const a = T.el('[data-viewer-toolbar]').getBoundingClientRect(); const b = T.overlay().getBoundingClientRect(); return { bar: [a.left, a.top, a.right, a.bottom], frame: [b.left, b.top, b.right, b.bottom] }`)
    check('a barra de ferramentas não cobre o quadro', ov.bar[2] <= ov.frame[0], ov)
    await shot('effects-01-ferramenta.png')
  }

  let rectId = null
  console.log('desenhar retângulo')
  {
    const before = await ev(`return { past: T.past(), n: T.effects().length }`)
    const r = await ev(`await T.drag(T.at(0.2, 0.2), T.at(0.45, 0.5)); const fx = T.effects(); const last = fx[fx.length - 1]; return { past: T.past(), n: fx.length, id: last?.id, effect: last?.effect, track: last?.track, start: last?.startUs, sel: T.st().selection, region: last ? T.region(last.id) : null }`)
    rectId = r.id
    check('um efeito novo, um passo de desfazer', r.n === before.n + 1 && r.past === before.past + 1, { before, r })
    check('blur na faixa "Efeitos", no playhead', r.effect === 'blur' && r.track === 'Efeitos' && r.start === 2_000_000, r)
    check('região do arraste', r.region && near(r.region.x, 0.325, 0.004) && near(r.region.y, 0.35, 0.004) && near(r.region.w, 0.25, 0.004) && near(r.region.h, 0.3, 0.004) && r.region.shape === 'rect', r.region)
    check('efeito desenhado fica selecionado', r.sel.length === 1 && r.sel[0] === r.id, r.sel)
    await sleep(400)
    await shot('effects-02-retangulo.png')
  }

  let ellipseId = null
  console.log('desenhar elipse (Pixelizar + Shift)')
  {
    await ev(`document.querySelector('[data-viewer-toolbar] [aria-label="Pixelizar"]').click(); await T.settle(); return 1`)
    const before = await ev(`return T.past()`)
    const r = await ev(`await T.drag(T.at(0.6, 0.55), T.at(0.85, 0.9), { mods: { shiftKey: true } }); const last = T.effects().at(-1); return { past: T.past(), id: last.id, effect: last.effect, region: T.region(last.id) }`)
    ellipseId = r.id
    check('pixelização em elipse (Shift), um passo', r.past === before + 1 && r.effect === 'pixelate' && r.region.shape === 'ellipse', r)
    check('região da elipse', near(r.region.x, 0.725, 0.004) && near(r.region.y, 0.725, 0.004), r.region)
    await sleep(400)
    await shot('effects-03-elipse.png')
    await ev(`await T.key('Escape'); return 1`)
    check('Esc sai da ferramenta e mantém a seleção', !(await ev(`return T.tool()`)) && (await ev(`return T.st().selection[0]`)) === ellipseId, null)
  }

  console.log('selecionar (efeitos por cima) e clique fora seleciona a mídia')
  {
    await ev(`await T.click(T.at(0.325, 0.35)); return 1`)
    check('clique na região seleciona o efeito', (await ev(`return T.st().selection`)).join() === rectId, null)
    await ev(`await T.click(T.at(0.1, 0.9)); return 1`)
    check('clique fora seleciona o vídeo abaixo', (await ev(`return T.st().selection`)).join() === videoId, null)
    // com o vídeo de tela cheia selecionado, as alças dele não podem tapar a região
    const r = await ev(`const top = T.topAt(T.at(0.325, 0.35).x, T.at(0.325, 0.35).y); const hasMedia = !!document.querySelector('[data-media-handles]'); const p0 = T.past(); const reg0 = T.region('${rectId}'); const from = T.at(0.325, 0.35); await T.drag(from, { x: from.x + 30, y: from.y + 20 }); const reg1 = T.region('${rectId}'); const sel = T.st().selection; const past = T.past(); T.st().undo(); await T.settle(); return { hasMedia, top: top.tagName + '.' + (top.dataset ? Object.keys(top.dataset).join() : ''), sel, past, p0, reg0, reg1, back: T.region('${rectId}') }`)
    check('vídeo selecionado: clicar e arrastar a região seleciona e move o efeito', r.hasMedia && r.sel.join() === rectId && r.reg1.x > r.reg0.x && r.past === r.p0 + 1 && r.back.x === r.reg0.x, r)
    await ev(`await T.click(T.at(0.325, 0.35)); return 1`)
  }

  console.log('mover, redimensionar, girar (1 passo por gesto)')
  const r0 = await ev(`return T.region('${rectId}')`)
  const steps = [r0]
  {
    const p0 = await ev(`return T.past()`)
    const r = await ev(`const o = T.overlay().getBoundingClientRect(); await T.drag(T.at(0.325, 0.35), { x: T.at(0.325, 0.35).x + o.width * 0.1, y: T.at(0.325, 0.35).y + o.height * 0.05 }); return { past: T.past(), r: T.region('${rectId}') }`)
    check('mover: +0,10 / +0,05, tamanho igual, 1 passo', near(r.r.x, r0.x + 0.1, 0.003) && near(r.r.y, r0.y + 0.05, 0.003) && near(r.r.w, r0.w, 1e-9) && r.past === p0 + 1, { r0, r })
    steps.push(r.r)
  }
  {
    const p0 = await ev(`return T.past()`)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="se"]')); const o = T.overlay().getBoundingClientRect(); await T.drag(h, { x: h.x + o.width * 0.05, y: h.y + o.height * 0.1 }); return { past: T.past(), r: T.region('${rectId}') }`)
    const prev = steps.at(-1)
    check('canto: cresce +0,05 × +0,10 com o canto oposto parado, 1 passo', near(r.r.w, prev.w + 0.05, 0.004) && near(r.r.h, prev.h + 0.1, 0.004) && near(r.r.x - r.r.w / 2, prev.x - prev.w / 2, 0.002) && near(r.r.y - r.r.h / 2, prev.y - prev.h / 2, 0.002) && r.past === p0 + 1, { prev, r })
    steps.push(r.r)
  }
  {
    const prev = steps.at(-1)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="e"]')); const o = T.overlay().getBoundingClientRect(); await T.drag(h, { x: h.x + o.width * 0.05, y: h.y }, { mods: { altKey: true } }); return { past: T.past(), r: T.region('${rectId}') }`)
    check('borda com Alt: a partir do centro (+0,10 de largura, centro parado)', near(r.r.w, prev.w + 0.1, 0.004) && near(r.r.x, prev.x, 0.002) && near(r.r.h, prev.h, 1e-9), { prev, r })
    steps.push(r.r)
  }
  {
    const prev = steps.at(-1)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="se"]')); const o = T.overlay().getBoundingClientRect(); await T.drag(h, { x: h.x + o.width * 0.08, y: h.y + o.height * 0.01 }, { mods: { shiftKey: true } }); return { past: T.past(), r: T.region('${rectId}') }`)
    const ar = (x) => (x.w * 16) / (x.h * 9)
    check('canto com Shift: mantém a proporção', near(ar(r.r), ar(prev), 0.01) && r.r.w > prev.w, { prev, r, before: ar(prev), after: ar(r.r) })
    steps.push(r.r)
  }
  {
    const prev = steps.at(-1)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="rotate"]')); const box = T.el('[data-region-handles]').getBoundingClientRect(); const c = { x: box.left + box.width / 2, y: box.top + box.height / 2 }; const d = c.y - h.y; await T.drag(h, { x: c.x + d, y: c.y + 2 }, { mods: { shiftKey: true } }); return { past: T.past(), r: T.region('${rectId}') }`)
    check('girar com Shift: 90°, centro e tamanho iguais', r.r.rotation === 90 && near(r.r.x, prev.x, 1e-9) && near(r.r.w, prev.w, 1e-9), { prev, r })
    steps.push(r.r)
    await sleep(400)
    await shot('effects-04-girada.png')
  }

  console.log('guias com snap e Esc cancelando')
  {
    // gira de volta para 0 para as bordas também grudarem
    await ev(`T.st().undo(); await T.settle(); return 1`)
    const r = await ev(`const p0 = T.past(); const reg = T.region('${rectId}'); const from = T.at(reg.x, reg.y); const to = T.at(0.503, 0.3); await T.drag(from, to, { release: false }); const guide = document.querySelectorAll('[data-guide]').length; return { p0, guide, live: T.region('${rectId}') }`)
    await sleep(300)
    await shot('effects-05-guia.png')
    const after = await ev(`const to = T.at(0.503, 0.3); T.up(to.x, to.y); await T.settle(); return { past: T.past(), r: T.region('${rectId}') }`)
    check('centro gruda em 0,5 com guia visível', r.guide >= 1 && after.r.x === 0.5 && after.past === r.p0 + 1, { r, after })
    const esc = await ev(`const p0 = T.past(); const reg = T.region('${rectId}'); const from = T.at(reg.x, reg.y); await T.drag(from, T.at(0.2, 0.7), { release: false }); const moved = T.region('${rectId}'); await T.key('Escape'); T.up(0, 0); await T.settle(); return { past: T.past(), p0, moved, r: T.region('${rectId}'), reg }`)
    check('Esc cancela o arraste (nada no histórico, região original)', esc.past === esc.p0 && esc.r.x === esc.reg.x && esc.moved.x !== esc.reg.x, esc)
  }

  console.log('desfazer: um passo por gesto')
  {
    // histórico agora: retângulo, elipse, mover, canto, Alt, Shift, (girar desfeito), snap
    const r = await ev(`const out = []; for (let i = 0; i < 7; i++) { T.st().undo(); await T.settle(); const f = T.fx('${rectId}'); out.push({ n: T.effects().length, r: f ? T.region('${rectId}') : null }) } return out`)
    const exp = [steps[4], steps[3], steps[2], steps[1], steps[0]]
    const okSteps = exp.every((e, i) => r[i].r && near(r[i].r.x, e.x, 1e-9) && near(r[i].r.w, e.w, 1e-9) && near(r[i].r.h, e.h, 1e-9))
    check('cada desfazer volta exatamente um gesto (snap, Shift, Alt, canto, mover)', okSteps, { r: r.slice(0, 5), exp })
    check('depois some a elipse e então o retângulo', r[5].n === 1 && r[6].n === 0, r.slice(5))
  }

  console.log('mídia continua manipulável (F1, mesmo gesto do visualizador)')
  {
    const r = await ev(`await T.seek(2_000_000); const logo = T.items().find((i) => i.assetId === 'a_qa_logo'); const p0 = T.past(); const o = T.overlay().getBoundingClientRect(); const from = T.at(0.84, 0.22); await T.drag(from, { x: from.x - o.width * 0.2, y: from.y }); const after = T.items().find((i) => i.id === logo.id); const past = T.past(); T.st().undo(); await T.settle(); const undone = T.items().find((i) => i.id === logo.id); return { sel: T.st().selection, x0: logo.visual.transform.x.value, x1: after.visual.transform.x.value, x2: undone.visual.transform.x.value, p0, past, id: logo.id }`)
    check('arrastar o PiP move a mídia (1 passo) e desfazer volta', r.sel.join() === r.id && near(r.x1, r.x0 - 0.2, 0.003) && r.past === r.p0 + 1 && r.x2 === r.x0, r)
  }

  console.log('keyframes: mover em dois instantes, interpolação no store e nos pixels')
  {
    const T1 = 2_000_000
    const T2 = 4_000_000
    await ev(`await T.seek(${T1}); const t = window.__qaEditor.store; document.querySelector('[data-viewer-toolbar] button').click(); await T.settle(); document.querySelector('[data-viewer-toolbar] [aria-label^="Tarja"]').click(); await T.settle(); return 1`)
    const id = await ev(`await T.drag(T.at(0.2, 0.4), T.at(0.3, 0.6)); await T.key('Escape'); return T.effects().at(-1).id`)
    // cor de teste e keyframes ligados em x/y (o painel de keyframes é da Task 4): key no instante atual
    await ev(`const s = T.st(); s.apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => i.id !== '${id}' ? i : { ...i, color: '#12ff34', feather: 0, region: { ...i.region, x: { value: i.region.x.value, keys: [{ tUs: 0, value: i.region.x.value, ease: 'linear' }] }, y: { value: i.region.y.value, keys: [{ tUs: 0, value: i.region.y.value, ease: 'linear' }] } } }) })) })); await T.seek(${T1}); return 1`)
    check('losango de keyframe no playhead (t1)', await ev(`return !!document.querySelector('[data-keyframe-indicator]')`), null)
    // mover em t1: atualiza o key existente (sem criar outro)
    const m1 = await ev(`const p0 = T.past(); const reg = T.region('${id}'); await T.drag(T.at(reg.x, reg.y), T.at(reg.x - 0.05, reg.y)); const f = T.fx('${id}'); return { p0, past: T.past(), keys: f.region.x.keys, ykeys: f.region.y.keys, r: T.region('${id}') }`)
    check('t1: key de x atualizado (1 key), 1 passo', m1.keys.length === 1 && near(m1.keys[0].value, 0.2, 0.003) && m1.past === m1.p0 + 1, m1)
    await ev(`await T.seek(${T2}); return 1`)
    check('sem losango fora de keyframe (t2)', !(await ev(`return !!document.querySelector('[data-keyframe-indicator]')`)), null)
    const m2 = await ev(`const p0 = T.past(); const reg = T.region('${id}'); await T.drag(T.at(reg.x, reg.y), T.at(0.8, 0.45)); const f = T.fx('${id}'); return { p0, past: T.past(), keys: f.region.x.keys, ykeys: f.region.y.keys, w: f.region.w, r: T.region('${id}') }`)
    check('t2: key novo em x e y; w continua fixo; 1 passo', m2.keys.length === 2 && m2.keys[1].tUs === T2 - T1 && near(m2.keys[1].value, 0.8, 0.003) && m2.ykeys.length === 2 && near(m2.ykeys[1].value, 0.45, 0.003) && !m2.w.keys && m2.past === m2.p0 + 1, m2)
    check('losango no playhead (t2)', await ev(`return !!document.querySelector('[data-keyframe-indicator]')`), null)
    await sleep(300)
    await shot('effects-06-keyframe-t2.png')
    // meio do caminho
    const mid = await ev(`await T.seek(${(T1 + T2) / 2}); return T.region('${id}')`)
    const x1 = m1.keys[0].value
    const x2 = m2.keys[1].value
    check('store: em (t1+t2)/2 a região está no meio', near(mid.x, (x1 + x2) / 2, 1e-6), { mid, x1, x2 })
    await sleep(500)
    const px = await ev(`return await T.rowMatches(${mid.y}, [0x12, 0xff, 0x34])`)
    check('pixels: tarja centrada no meio (±0,01) com a largura da região', px.count > 0 && near(px.mid, (x1 + x2) / 2, 0.01) && near(px.count / px.W, mid.w, 0.01), { px, expected: (x1 + x2) / 2, w: mid.w })
    const pxT1 = await ev(`await T.seek(${T1}); await new Promise((r) => setTimeout(r, 400)); return await T.rowMatches(${m1.r.y}, [0x12, 0xff, 0x34])`)
    check('pixels: em t1 a tarja está no key 1', near(pxT1.mid, x1, 0.01), { pxT1, x1 })
    await ev(`T.st().select([]); await T.seek(${(T1 + T2) / 2}); return 1`)
    await sleep(500)
    await shot('effects-07-interpolado.png')
    await ev(`T.st().select(['${id}']); await T.settle(); return 1`)
    await sleep(300)
    await shot('effects-08-interpolado-selecionado.png')

    console.log('desativado / faixa bloqueada')
    const patch = (fn) => `T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (${fn})) })); await T.settle(); await new Promise((r) => setTimeout(r, 300)); await T.settle();`
    const off = await ev(`${patch(`({ ...t, items: t.items.map((i) => (i.id === '${id}' ? { ...i, enabled: false } : i)) })`)} T.st().select(['${id}']); await T.settle(); return { inactive: !!document.querySelector('[data-region-inactive]'), tag: document.querySelector('[data-region-inactive]')?.textContent, handles: document.querySelectorAll('[data-region-handle]').length }`)
    check('desativado selecionado: contorno cinza com "Desativado" e sem alças', off.inactive && off.tag === 'Desativado' && off.handles === 0, off)
    await shot('effects-10-desativado.png')
    const locked = await ev(`${patch(`t.items.some((i) => i.id === '${id}') ? { ...t, locked: true, items: t.items.map((i) => (i.id === '${id}' ? { ...i, enabled: undefined } : i)) } : t`)} T.st().select([]); await T.settle(); const reg = T.region('${id}'); await T.click(T.at(reg.x, reg.y)); return { sel: T.st().selection }`)
    check('faixa bloqueada: clique na região seleciona a mídia abaixo, não o efeito', locked.sel.length === 1 && locked.sel[0] !== id, locked)
  }


  console.log('Task 4: inspetor do efeito, botões de keyframe, losangos, Alt+K, [ ], ativar/desativar')
  {
    const A = 1_000_000
    // efeito novo (blur) embaixo, longe da tarja verde; a faixa "Efeitos" está bloqueada → "Efeitos 2"
    await ev(`await T.seek(${A}); T.st().select([]); await T.key('b'); document.querySelector('[data-viewer-toolbar] [aria-label^="Blur"]').click(); await T.settle(); return 1`)
    const E = await ev(`await T.drag(T.at(0.3, 0.75), T.at(0.6, 0.92)); await T.key('Escape'); return T.effects().at(-1).id`)
    await sleep(400)
    const panel = await ev(`const ins = T.el('[aria-label="Inspetor"]'); return { text: ins.textContent, paths: [...ins.querySelectorAll('[data-kf-path]')].map((e) => e.dataset.kfPath), track: T.fx('${E}').track }`)
    check('inspetor do efeito: tipo, forma, intensidade, borda, inverter, escopo, região com keyframes', ['Blur', 'Pixelizar', 'Tarja', 'Retângulo', 'Elipse', 'Intensidade', 'Borda suave', 'Borrar tudo menos a região', 'Tudo abaixo', 'Só a faixa abaixo', 'Ajustar ao quadro inteiro'].every((w) => panel.text.includes(w)) && ['strength', 'region.x', 'region.y', 'region.w', 'region.h', 'region.rotation'].every((p) => panel.paths.includes(p)) && !panel.text.includes('próxima versão'), panel)
    await shot('effects-11-inspetor.png')

    // keyframes pelo inspetor: ◇ em A, valor em A+2 s cria o 2º key
    const k1 = await ev(`const p0 = T.past(); await T.clickEl(T.kf('strength', 'toggle')); await T.clickEl(T.kf('region.x', 'toggle')); return { p0, past: T.past(), s: T.keysOf(T.fx('${E}').strength), x: T.keysOf(T.fx('${E}').region.x), pressed: T.kf('strength', 'toggle').getAttribute('aria-pressed') }`)
    check('◇ cria key no playhead (intensidade e X), 1 passo cada, botão marcado', k1.past === k1.p0 + 2 && k1.s.length === 1 && k1.s[0][0] === 0 && k1.x.length === 1 && k1.pressed === 'true', k1)
    const k2 = await ev(`await T.seek(${A + 2_000_000}); const p0 = T.past(); const pressed = T.kf('strength', 'toggle').getAttribute('aria-pressed'); await T.setField('Intensidade', 20); await T.setField('Posição X', 70); return { p0, past: T.past(), pressed, s: T.keysOf(T.fx('${E}').strength), x: T.keysOf(T.fx('${E}').region.x), w: T.fx('${E}').region.w }`)
    check('fora de key: ◇ vazio; editar campo animado cria o key (1 passo por campo); largura segue fixa', k2.pressed === 'false' && k2.past === k2.p0 + 2 && JSON.stringify(k2.s) === JSON.stringify([[0, 60], [2_000_000, 20]]) && k2.x.length === 2 && k2.x[1][0] === 2_000_000 && k2.x[1][1] === 0.7 && !k2.w.keys, k2)
    const nav = await ev(`await T.clickEl(T.kf('strength', 'prev')); await new Promise((r) => setTimeout(r, 200)); const a = T.st().playheadUs; const prevOff = T.kf('strength', 'prev').disabled; await T.clickEl(T.kf('strength', 'next')); await new Promise((r) => setTimeout(r, 200)); return { a, b: T.st().playheadUs, prevOff, nextOff: T.kf('strength', 'next').disabled }`)
    check('◀ ▶ navegam entre os keys (e desabilitam nas pontas)', nav.a === A && nav.b === A + 2_000_000 && nav.prevOff && nav.nextOff, nav)
    await sleep(300)
    await shot('effects-12-keyframes-inspetor.png')

    // losangos na timeline
    const d0 = await ev(`return T.diamonds('${E}').map((d) => Number(d.dataset.keyframe))`)
    check('timeline: um losango por instante com key (0 e 2 s)', JSON.stringify(d0) === JSON.stringify([0, 2_000_000]), d0)
    const dc = await ev(`await T.seek(${A + 500_000}); await T.clickEl(T.diamond('${E}', 0)); await new Promise((r) => setTimeout(r, 200)); return { ph: T.st().playheadUs, sel: T.st().selection }`)
    check('clicar no losango leva o playhead ao key', dc.ph === A && dc.sel.join() === E, dc)
    const dd = await ev(`const pps = T.st().zoomPxPerSec; const p0 = T.past(); const c = T.center(T.diamond('${E}', 2000000)); await T.drag(c, { x: c.x + pps * 0.5, y: c.y + 6 }); const f = T.fx('${E}'); return { p0, past: T.past(), s: T.keysOf(f.strength), x: T.keysOf(f.region.x), d: T.diamonds('${E}').map((d) => Number(d.dataset.keyframe)) }`)
    const moved = dd.s[1]?.[0]
    check('arrastar o losango muda o instante dos keys (todas as propriedades), 1 passo', dd.past === dd.p0 + 1 && Math.abs(moved - 2_500_000) <= 34_000 && dd.x[1][0] === moved && dd.s[1][1] === 20 && dd.d[1] === moved, dd)
    const dl = await ev(`const c = T.center(T.diamond('${E}', ${moved})); const pps = T.st().zoomPxPerSec; await T.drag(c, { x: c.x + pps * 99, y: c.y }); const f = T.fx('${E}'); const out = { s: T.keysOf(f.strength), dur: f.durationUs }; T.st().undo(); await T.settle(); return out`)
    check('arraste limitado ao fim do item', dl.s[1][0] === dl.dur, dl)
    const dcol = await ev(`const c = T.center(T.diamond('${E}', ${moved})); const z = T.center(T.diamond('${E}', 0)); await T.drag(c, { x: z.x + 1, y: c.y }); const f = T.fx('${E}'); const out = { s: T.keysOf(f.strength), x: T.keysOf(f.region.x) }; T.st().undo(); await T.settle(); return out`)
    check('soltar sobre outro key o substitui (um key só, com o valor arrastado)', dcol.s.length === 1 && dcol.s[0][1] === 20 && dcol.x.length === 1 && dcol.x[0][1] === 0.7, dcol)
    await ev(`await T.clickEl(T.diamond('${E}', ${moved})); return 1`)
    await sleep(200)
    await shot('effects-13-losangos.png')
    const del = await ev(`const p0 = T.past(); await T.key('Delete'); const f = T.fx('${E}'); return { p0, past: T.past(), exists: !!f, s: f ? T.keysOf(f.strength) : null, x: f ? T.keysOf(f.region.x) : null }`)
    check('Delete com losango selecionado remove os keys do instante (o item fica)', del.exists && del.past === del.p0 + 1 && del.s.length === 1 && del.x.length === 1, del)
    await ev(`T.st().undo(); await T.settle(); return 1`)
    const stale = await ev(`await T.seek(${A + 1_500_000}); T.st().select(['${E}']); await T.key('k', { altKey: true }); await T.clickEl(T.diamond('${E}', 1500000)); T.st().undo(); await T.settle(); const n0 = T.effects().length; await T.key('Delete'); const gone = !T.fx('${E}'); T.st().undo(); await T.settle(); return { n0, gone, back: !!T.fx('${E}'), d: T.diamonds('${E}').map((d) => Number(d.dataset.keyframe)) }`)
    check('losango sem key depois de desfazer: a seleção do losango cai e Delete apaga o item', stale.gone && stale.back && JSON.stringify(stale.d) === JSON.stringify([0, moved]), stale)

    // Alt+K e [ ]
    const ak = await ev(`T.st().select(['${E}']); await T.seek(${A + 1_000_000}); const p0 = T.past(); await T.key('k', { altKey: true }); const f = T.fx('${E}'); const on = { y: T.keysOf(f.region.y), w: T.keysOf(f.region.w), x: T.keysOf(f.region.x), playing: T.st().playing }; await T.key('k', { altKey: true }); const g = T.fx('${E}'); return { p0, past: T.past(), on, off: { y: g.region.y, x: T.keysOf(g.region.x) } }`)
    check('Alt+K liga keys da região no playhead (todas) e desliga de novo; não toca/pausa', ak.on.y.length === 1 && ak.on.y[0][0] === 1_000_000 && ak.on.w.length === 1 && ak.on.x.length === 3 && !ak.off.y.keys && ak.off.x.length === 2 && ak.past === ak.p0 + 2 && !ak.on.playing, ak)
    const br = await ev(`await T.seek(${A + 1_000_000}); await T.key(']'); await new Promise((r) => setTimeout(r, 200)); const n = T.st().playheadUs; await T.key('['); await new Promise((r) => setTimeout(r, 200)); const p = T.st().playheadUs; await T.key('['); await new Promise((r) => setTimeout(r, 200)); return { n, p, p2: T.st().playheadUs }`)
    check('] / [ vão ao próximo/anterior keyframe', br.n === A + moved && br.p === A && br.p2 === A, { br, expected: A + moved })

    // keyframe em vídeo (transformação) e áudio (volume): botão do inspetor e losango na timeline
    const vk = await ev(`await T.seek(3_000_000); T.st().select(['${videoId}']); await T.settle(); await new Promise((r) => setTimeout(r, 200)); const p0 = T.past(); await T.clickEl(T.kf('transform.opacity', 'toggle')); const v = T.items().find((i) => i.id === '${videoId}'); const out = { p0, past: T.past(), keys: T.keysOf(v.visual.transform.opacity), d: T.diamonds('${videoId}').length, paths: [...document.querySelectorAll('[aria-label="Inspetor"] [data-kf-path]')].map((e) => e.dataset.kfPath) }; T.st().undo(); await T.settle(); return out`)
    check('vídeo: ◇ de opacidade cria key e o losango aparece no item de vídeo', vk.past === vk.p0 + 1 && vk.keys.length === 1 && vk.d === 1 && ['transform.x', 'transform.y', 'transform.scale', 'transform.rotation', 'transform.opacity'].every((p) => vk.paths.includes(p)), vk)
    const au = await ev(`const music = T.items().find((i) => i.assetId === 'a_qa_music' && !i.visual); await T.seek(music.startUs + 1_000_000); T.st().select([music.id]); await T.settle(); await new Promise((r) => setTimeout(r, 200)); const p0 = T.past(); await T.clickEl(T.kf('audio.volume', 'toggle')); const m = T.items().find((i) => i.id === music.id); await new Promise((r) => setTimeout(r, 150)); return { p0, past: T.past(), keys: T.keysOf(m.audio.volume), d: T.diamonds(music.id).length }`)
    check('áudio: ◇ de volume cria key e o losango aparece no item de áudio', au.past === au.p0 + 1 && au.keys.length === 1 && au.d === 1, au)
    await ev(`T.el('[data-timeline-lanes]').scrollTop = 9999; await T.settle(); return 1`)
    await sleep(200)
    await shot('effects-14-losango-audio.png')
    await ev(`T.el('[data-timeline-lanes]').scrollTop = 0; T.st().undo(); await T.settle(); return 1`)

    // menu: Converter em Tarja (marrom) e Desativar; Shift+E; some no preview
    await ev(`await T.seek(${A + 1_000_000}); T.st().select(['${E}']); await T.settle(); return 1`)
    const menu = await ev(`await T.contextMenu('${E}'); return [...document.querySelectorAll('[data-timeline-menu] [role="menuitem"]')].map((x) => x.textContent)`)
    check('menu do efeito: Desativar (Shift+E) e Converter em', menu.some((t) => t.includes('Desativar') && t.includes('Shift+E')) && menu.some((t) => t.includes('Converter em')), menu)
    await ev(`const sub = T.menuItem('Converter em'); sub.click(); await T.settle(); await new Promise((r) => setTimeout(r, 300)); return 1`)
    await shot('effects-15-menu-converter.png')
    const conv = await ev(`const p0 = T.past(); const it = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim().startsWith('Tarja')); it.click(); await T.settle(); await new Promise((r) => setTimeout(r, 200)); const f = T.fx('${E}'); return { p0, past: T.past(), effect: f.effect, feather: f.feather, strength: f.strength }`)
    check('Converter em → Tarja: tipo trocado, borda suave 0, sem keys de intensidade, 1 passo', conv.effect === 'solid' && conv.feather === 0 && !conv.strength.keys && conv.past === conv.p0 + 1, conv)
    await ev(`const c = T.el('[aria-label="Inspetor"] input[type="color"]'); c.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(c, '#a05020'); c.dispatchEvent(new Event('input', { bubbles: true })); c.blur(); await T.settle(); await new Promise((r) => setTimeout(r, 400)); return 1`)
    const reg = await ev(`return T.region('${E}')`)
    const on1 = await ev(`return await T.rowMatches(${reg.y}, [0xa0, 0x50, 0x20])`)
    check('tarja marrom no preview', (await ev(`return T.fx('${E}').color`)) === '#a05020' && near(on1.count / on1.W, reg.w, 0.01), { on1, reg })
    const off = await ev(`const p0 = T.past(); await T.key('E', { shiftKey: true }); await new Promise((r) => setTimeout(r, 400)); return { p0, past: T.past(), enabled: T.fx('${E}').enabled, ui: !!document.querySelector('[data-item-id="${E}"][data-disabled]'), toggle: document.querySelector('[aria-label="Inspetor"] [aria-label="Ativar efeito"]')?.getAttribute('aria-checked'), warn: document.querySelector('[data-privacy-warnings]')?.textContent ?? '' }`)
    const off1 = await ev(`return await T.rowMatches(${reg.y}, [0xa0, 0x50, 0x20])`)
    check('Shift+E desativa (1 passo): item apagado na timeline, chave do inspetor desligada, aviso de privacidade', off.enabled === false && off.past === off.p0 + 1 && off.ui && off.toggle === 'false' && off.warn.includes('desativado'), off)
    check('desativado some do preview', off1.count === 0, off1)
    await shot('effects-16-desativado.png')
    // vídeo com áudio vinculado: Shift+E desativa os dois (o som some junto); Alt+Shift+E só o vídeo
    const link = await ev(`const v = T.items().find((i) => i.id === '${videoId}'); const a = T.items().find((i) => i.linkId && i.linkId === v.linkId && i.id !== v.id); T.st().select([v.id]); await T.settle(); const p0 = T.past(); await T.key('E', { shiftKey: true }); const both = [T.items().find((i) => i.id === v.id).enabled, T.items().find((i) => i.id === a.id).enabled]; const past = T.past(); T.st().undo(); await T.settle(); await T.key('E', { shiftKey: true, altKey: true }); const alt = [T.items().find((i) => i.id === v.id).enabled, T.items().find((i) => i.id === a.id).enabled ?? true]; T.st().undo(); await T.settle(); T.st().select([]); return { audio: !!a, both, alt, p0, past }`)
    check('Shift+E no vídeo vinculado desativa o áudio junto (1 passo); Alt+Shift+E só o vídeo', link.audio && link.both[0] === false && link.both[1] === false && link.past === link.p0 + 1 && link.alt[0] === false && link.alt[1] === true, link)
    // efeito em faixa bloqueada: nenhum controle do inspetor edita
    const lockedUi = await ev(`const g = T.effects().find((f) => f.color === '#12ff34'); T.st().select([g.id]); await T.settle(); await new Promise((r) => setTimeout(r, 200)); const ins = T.el('[aria-label="Inspetor"]'); const editable = [...ins.querySelectorAll('button, input')].filter((e) => !e.disabled && !['prev', 'next'].includes(e.dataset.kf ?? '')).map((e) => e.getAttribute('aria-label') || e.textContent.trim()); T.st().select([]); return editable`)
    check('faixa bloqueada: controles do inspetor do efeito desabilitados (só ◀ ▶ navegam)', lockedUi.length === 0, lockedUi)
    // cursor de mover sobre a mídia selecionada (o corpo das alças não captura o ponteiro)
    const cur = await ev(`T.st().select(['${videoId}']); await T.settle(); const hover = (fx, fy) => { const p = T.at(fx, fy); T.topAt(p.x, p.y).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x, clientY: p.y, pointerType: 'mouse', buttons: 0 })); return T.overlay().style.cursor }; const media = hover(0.1, 0.5); const green = T.region(T.effects().find((f) => f.color === '#12ff34').id); const lockedRegion = hover(green.x, green.y); T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.locked ? { ...t, locked: false } : t)) })); await T.settle(); const onRegion = hover(green.x, green.y); T.st().undo(); await T.settle(); T.st().select([]); await T.settle(); const unselected = hover(0.1, 0.5); return { media, lockedRegion, onRegion, unselected }`)
    check('cursor de mover sobre a mídia selecionada (região bloqueada deixa passar; região clicável e sem seleção não)', cur.media === 'move' && cur.lockedRegion === 'move' && cur.onRegion === '' && cur.unselected === '', cur)
    // linha da tarja verde (ativa, faixa bloqueada) no mesmo instante, para o controle positivo
    const greenY = await ev(`return T.region(T.effects().find((f) => f.color === '#12ff34').id).y`)
    task4 = { E, reg, tUs: A + 1_000_000, greenY }
  }

  await viewport(1920, 1080)
  await sleep(600)
  await ev(`await T.seek(2_000_000); await T.key('b'); return 1`)
  await sleep(400)
  const ov = await ev(`const a = T.el('[data-viewer-toolbar]').getBoundingClientRect(); const b = T.overlay().getBoundingClientRect(); return { bar: [a.left, a.right], frame: [b.left, b.right] }`)
  check('1920×1080: a barra não cobre o quadro', ov.bar[1] <= ov.frame[0], ov)
  await shot('effects-09-1920x1080.png')
  await ev(`await T.key('Escape'); return 1`)

  console.log('exportação: o efeito desativado não aparece; a tarja verde (ativa) sim')
  if (task4) {
    const OUT = join(ROOT, 'test-out', 'qa-effects-export')
    rmSync(OUT, { recursive: true, force: true })
    mkdirSync(OUT, { recursive: true })
    await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; T.st().select([]); return 1`)
    await ev(`[...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar')).click(); await new Promise((r) => setTimeout(r, 500)); [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('WhatsApp')).click(); await new Promise((r) => setTimeout(r, 200)); [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Exportar').click(); return 1`)
    let text = ''
    for (let i = 0; i < 1200; i++) {
      text = await ev(`return document.querySelector('[role="dialog"]')?.textContent ?? ''`)
      if (text.includes('Vídeo exportado') || text.includes('falhou')) break
      await sleep(100)
    }
    const files = readdirSync(OUT).filter((f) => f.endsWith('.mp4'))
    check('exportação concluída', text.includes('Vídeo exportado') && files.length === 1, { text: text.slice(0, 200), files })
    if (files.length === 1) {
      const W = 1280, H = 720
      const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(task4.tUs / 1e6 + 0.02), '-i', join(OUT, files[0]), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 })
      // só dentro da largura da região (o testsrc2 tem barras de cor parecidas fora dela)
      const count = (fy, rgb, tol, fx0 = 0, fx1 = 1) => {
        const y = Math.round(fy * H)
        let n = 0
        for (let x = Math.round(fx0 * W); x < Math.round(fx1 * W); x++) {
          const i = (y * W + x) * 3
          if (Math.abs(raw[i] - rgb[0]) <= tol && Math.abs(raw[i + 1] - rgb[1]) <= tol && Math.abs(raw[i + 2] - rgb[2]) <= tol) n++
        }
        return n
      }
      const r = task4.reg
      const span = Math.round(r.w * W)
      const offPx = count(r.y, [0xa0, 0x50, 0x20], 24, r.x - r.w / 2, r.x + r.w / 2)
      const green = count(task4.greenY, [0x12, 0xff, 0x34], 40)
      console.log(`    marrom na região: ${offPx}/${span} px; verde: ${green} px`)
      check('exportação: tarja desativada ausente (região), tarja ativa presente', offPx < span * 0.05 && green > W * 0.05, { offPx, span, green })
    }
    await ev(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => /Fechar|Concluir/.test(b.textContent) || b.getAttribute('aria-label') === 'Fechar')?.click(); return 1`)
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
