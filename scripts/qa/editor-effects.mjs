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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f2')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')

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
  const down = (target, x, y, mods) => target.dispatchEvent(pe('pointerdown', x, y, mods))
  const move = (x, y, mods) => window.dispatchEvent(pe('pointermove', x, y, mods))
  const up = (x, y, mods) => window.dispatchEvent(pe('pointerup', x, y, mods))
  async function drag(target, from, to, opts = {}) {
    const steps = opts.steps ?? 8
    down(target, from.x, from.y, opts.mods)
    for (let i = 1; i <= steps; i++) move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, opts.mods)
    await settle()
    if (opts.release !== false) { up(to.x, to.y, opts.mods); await settle() }
  }
  const click = async (target, p, mods) => { down(target, p.x, p.y, mods); up(p.x, p.y, mods); await settle() }
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
  return { st, settle, el, overlay, at, center, down, move, up, drag, click, key, items, effects, fx, region, past, seek, tool, rowMatches }
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
    const r = await ev(`await T.drag(T.overlay(), T.at(0.2, 0.2), T.at(0.45, 0.5)); const fx = T.effects(); const last = fx[fx.length - 1]; return { past: T.past(), n: fx.length, id: last?.id, effect: last?.effect, track: last?.track, start: last?.startUs, sel: T.st().selection, region: last ? T.region(last.id) : null }`)
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
    const r = await ev(`await T.drag(T.overlay(), T.at(0.6, 0.55), T.at(0.85, 0.9), { mods: { shiftKey: true } }); const last = T.effects().at(-1); return { past: T.past(), id: last.id, effect: last.effect, region: T.region(last.id) }`)
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
    await ev(`await T.click(T.overlay(), T.at(0.325, 0.35)); return 1`)
    check('clique na região seleciona o efeito', (await ev(`return T.st().selection`)).join() === rectId, null)
    await ev(`await T.click(T.overlay(), T.at(0.1, 0.9)); return 1`)
    check('clique fora seleciona o vídeo abaixo', (await ev(`return T.st().selection`)).join() === videoId, null)
    await ev(`await T.click(T.overlay(), T.at(0.325, 0.35)); return 1`)
  }

  console.log('mover, redimensionar, girar (1 passo por gesto)')
  const r0 = await ev(`return T.region('${rectId}')`)
  const steps = [r0]
  {
    const p0 = await ev(`return T.past()`)
    const r = await ev(`const o = T.overlay().getBoundingClientRect(); await T.drag(T.el('[data-region-handles]'), T.at(0.325, 0.35), { x: T.at(0.325, 0.35).x + o.width * 0.1, y: T.at(0.325, 0.35).y + o.height * 0.05 }); return { past: T.past(), r: T.region('${rectId}') }`)
    check('mover: +0,10 / +0,05, tamanho igual, 1 passo', near(r.r.x, r0.x + 0.1, 0.003) && near(r.r.y, r0.y + 0.05, 0.003) && near(r.r.w, r0.w, 1e-9) && r.past === p0 + 1, { r0, r })
    steps.push(r.r)
  }
  {
    const p0 = await ev(`return T.past()`)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="se"]')); const o = T.overlay().getBoundingClientRect(); await T.drag(T.el('[data-region-handle="se"]'), h, { x: h.x + o.width * 0.05, y: h.y + o.height * 0.1 }); return { past: T.past(), r: T.region('${rectId}') }`)
    const prev = steps.at(-1)
    check('canto: cresce +0,05 × +0,10 com o canto oposto parado, 1 passo', near(r.r.w, prev.w + 0.05, 0.004) && near(r.r.h, prev.h + 0.1, 0.004) && near(r.r.x - r.r.w / 2, prev.x - prev.w / 2, 0.002) && near(r.r.y - r.r.h / 2, prev.y - prev.h / 2, 0.002) && r.past === p0 + 1, { prev, r })
    steps.push(r.r)
  }
  {
    const prev = steps.at(-1)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="e"]')); const o = T.overlay().getBoundingClientRect(); await T.drag(T.el('[data-region-handle="e"]'), h, { x: h.x + o.width * 0.05, y: h.y }, { mods: { altKey: true } }); return { past: T.past(), r: T.region('${rectId}') }`)
    check('borda com Alt: a partir do centro (+0,10 de largura, centro parado)', near(r.r.w, prev.w + 0.1, 0.004) && near(r.r.x, prev.x, 0.002) && near(r.r.h, prev.h, 1e-9), { prev, r })
    steps.push(r.r)
  }
  {
    const prev = steps.at(-1)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="se"]')); const o = T.overlay().getBoundingClientRect(); await T.drag(T.el('[data-region-handle="se"]'), h, { x: h.x + o.width * 0.08, y: h.y + o.height * 0.01 }, { mods: { shiftKey: true } }); return { past: T.past(), r: T.region('${rectId}') }`)
    const ar = (x) => (x.w * 16) / (x.h * 9)
    check('canto com Shift: mantém a proporção', near(ar(r.r), ar(prev), 0.01) && r.r.w > prev.w, { prev, r, before: ar(prev), after: ar(r.r) })
    steps.push(r.r)
  }
  {
    const prev = steps.at(-1)
    const r = await ev(`const h = T.center(T.el('[data-region-handle="rotate"]')); const box = T.el('[data-region-handles]').getBoundingClientRect(); const c = { x: box.left + box.width / 2, y: box.top + box.height / 2 }; const d = c.y - h.y; await T.drag(T.el('[data-region-handle="rotate"]'), h, { x: c.x + d, y: c.y + 2 }, { mods: { shiftKey: true } }); return { past: T.past(), r: T.region('${rectId}') }`)
    check('girar com Shift: 90°, centro e tamanho iguais', r.r.rotation === 90 && near(r.r.x, prev.x, 1e-9) && near(r.r.w, prev.w, 1e-9), { prev, r })
    steps.push(r.r)
    await sleep(400)
    await shot('effects-04-girada.png')
  }

  console.log('guias com snap e Esc cancelando')
  {
    // gira de volta para 0 para as bordas também grudarem
    await ev(`T.st().undo(); await T.settle(); return 1`)
    const r = await ev(`const p0 = T.past(); const reg = T.region('${rectId}'); const from = T.at(reg.x, reg.y); const to = T.at(0.503, 0.3); await T.drag(T.el('[data-region-handles]'), from, to, { release: false }); const guide = document.querySelectorAll('[data-guide]').length; return { p0, guide, live: T.region('${rectId}') }`)
    await sleep(300)
    await shot('effects-05-guia.png')
    const after = await ev(`const to = T.at(0.503, 0.3); T.up(to.x, to.y); await T.settle(); return { past: T.past(), r: T.region('${rectId}') }`)
    check('centro gruda em 0,5 com guia visível', r.guide >= 1 && after.r.x === 0.5 && after.past === r.p0 + 1, { r, after })
    const esc = await ev(`const p0 = T.past(); const reg = T.region('${rectId}'); const from = T.at(reg.x, reg.y); await T.drag(T.el('[data-region-handles]'), from, T.at(0.2, 0.7), { release: false }); const moved = T.region('${rectId}'); await T.key('Escape'); T.up(0, 0); await T.settle(); return { past: T.past(), p0, moved, r: T.region('${rectId}'), reg }`)
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
    const r = await ev(`await T.seek(2_000_000); const logo = T.items().find((i) => i.assetId === 'a_qa_logo'); const p0 = T.past(); const o = T.overlay().getBoundingClientRect(); const from = T.at(0.84, 0.22); await T.drag(T.overlay(), from, { x: from.x - o.width * 0.2, y: from.y }); const after = T.items().find((i) => i.id === logo.id); const past = T.past(); T.st().undo(); await T.settle(); const undone = T.items().find((i) => i.id === logo.id); return { sel: T.st().selection, x0: logo.visual.transform.x.value, x1: after.visual.transform.x.value, x2: undone.visual.transform.x.value, p0, past, id: logo.id }`)
    check('arrastar o PiP move a mídia (1 passo) e desfazer volta', r.sel.join() === r.id && near(r.x1, r.x0 - 0.2, 0.003) && r.past === r.p0 + 1 && r.x2 === r.x0, r)
  }

  console.log('keyframes: mover em dois instantes, interpolação no store e nos pixels')
  {
    const T1 = 2_000_000
    const T2 = 4_000_000
    await ev(`await T.seek(${T1}); const t = window.__qaEditor.store; document.querySelector('[data-viewer-toolbar] button').click(); await T.settle(); document.querySelector('[data-viewer-toolbar] [aria-label^="Tarja"]').click(); await T.settle(); return 1`)
    const id = await ev(`await T.drag(T.overlay(), T.at(0.2, 0.4), T.at(0.3, 0.6)); await T.key('Escape'); return T.effects().at(-1).id`)
    // cor de teste e keyframes ligados em x/y (o painel de keyframes é da Task 4): key no instante atual
    await ev(`const s = T.st(); s.apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => i.id !== '${id}' ? i : { ...i, color: '#12ff34', feather: 0, region: { ...i.region, x: { value: i.region.x.value, keys: [{ tUs: 0, value: i.region.x.value, ease: 'linear' }] }, y: { value: i.region.y.value, keys: [{ tUs: 0, value: i.region.y.value, ease: 'linear' }] } } }) })) })); await T.seek(${T1}); return 1`)
    check('losango de keyframe no playhead (t1)', await ev(`return !!document.querySelector('[data-keyframe-indicator]')`), null)
    // mover em t1: atualiza o key existente (sem criar outro)
    const m1 = await ev(`const p0 = T.past(); const reg = T.region('${id}'); await T.drag(T.el('[data-region-handles]'), T.at(reg.x, reg.y), T.at(reg.x - 0.05, reg.y)); const f = T.fx('${id}'); return { p0, past: T.past(), keys: f.region.x.keys, ykeys: f.region.y.keys, r: T.region('${id}') }`)
    check('t1: key de x atualizado (1 key), 1 passo', m1.keys.length === 1 && near(m1.keys[0].value, 0.2, 0.003) && m1.past === m1.p0 + 1, m1)
    await ev(`await T.seek(${T2}); return 1`)
    check('sem losango fora de keyframe (t2)', !(await ev(`return !!document.querySelector('[data-keyframe-indicator]')`)), null)
    const m2 = await ev(`const p0 = T.past(); const reg = T.region('${id}'); await T.drag(T.el('[data-region-handles]'), T.at(reg.x, reg.y), T.at(0.8, 0.45)); const f = T.fx('${id}'); return { p0, past: T.past(), keys: f.region.x.keys, ykeys: f.region.y.keys, w: f.region.w, r: T.region('${id}') }`)
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
  }

  await viewport(1920, 1080)
  await sleep(600)
  await ev(`await T.seek(2_000_000); await T.key('b'); return 1`)
  await sleep(400)
  const ov = await ev(`const a = T.el('[data-viewer-toolbar]').getBoundingClientRect(); const b = T.overlay().getBoundingClientRect(); return { bar: [a.left, a.right], frame: [b.left, b.right] }`)
  check('1920×1080: a barra não cobre o quadro', ov.bar[1] <= ov.frame[0], ov)
  await shot('effects-09-1920x1080.png')
  await ev(`await T.key('Escape'); return 1`)
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
