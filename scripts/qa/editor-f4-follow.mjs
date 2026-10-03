// QA do "Ancorar ao clipe" (F4 Task 4) via CDP, com eventos de ponteiro/teclado sintéticos despachados no elemento real
// sob o ponto (document.elementFromPoint) — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f4-follow.mjs            → abre o app (CIALIGHT_QA=editor-fixture, CIALIGHT_RAW_DIR=test-out/raw),
//                                                   testa e fecha
//   node scripts/qa/editor-f4-follow.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// Confere: zoom num clipe com blur vinculado → toast com "Ancorar efeito ao clipe" e "Ver efeito" (botões com foco
// visível); ancorar grava attach (um passo de desfazer, sem keys) e a região na tela acompanha o conteúdo — inclusive
// depois de um segundo zoom feito mais tarde, sem novo aviso; inspetor com a chave "Ancorado ao clipe: <nome>"; arrastar
// a região no visualizador grava relativo ao conteúdo; desligar a chave desancora (assa keys do quadro, sem aviso);
// sem âncora, o aviso do inspetor traz "Ancorar ao clipe"; efeito solto + Ken Burns → "Vincular e ancorar" (toast e
// inspetor), que vincula ao grupo do clipe e ancora; clipe desativado → aviso attachLost. Screenshots em docs/qa/editor-f4/.
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__zm; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
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
window.__zm = (() => {
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
  const keys = (id, k) => (item(id).visual.transform[k].keys || []).map((x) => [x.tUs, +x.value.toFixed(6), x.ease])
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(400); await settle() }
  /** px do canvas do projeto → px de tela (overlay do visualizador). */
  const toScreen = (x, y) => { const r = el('[data-viewer-overlay]').getBoundingClientRect(); const k = r.width / st().project.canvas.width; return { x: r.left + x * k, y: r.top + y * k } }
  const zoomBtn = () => el('[data-viewer-toolbar] button[aria-label^="Zoom"], [data-viewer-toolbar] button[aria-label="Sair do Zoom"]')
  const drawBtn = () => el('[data-viewer-toolbar] button[aria-label*="Desenhar região"]')
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  /** Valor num campo do NumberField (digitação + blur = commit). */
  const typeInto = async (input, text) => {
    input.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(); input.blur(); await settle()
  }
  /** Média RGB de 5×5 px do quadro do preview em torno de (x, y) px do canvas do projeto (o worker desenha no tamanho da tela). */
  const framePatch = async (x, y) => {
    const r = window.__qaEditor.engine.render
    const k = (r.size.width * r.size.dpr) / st().project.canvas.width
    const px = await r.readPixels(Math.round(x * k) - 2, Math.round(y * k) - 2, 5, 5)
    const m = [0, 0, 0]
    for (let i = 0; i < 25; i++) for (let c = 0; c < 3; c++) m[c] += px[i * 4 + c] / 25
    return m.map(Math.round)
  }
  return { st, settle, wait, el, all, center, topAt, clickAt, click, drag, key, items, item, keys, past, seek, toScreen, zoomBtn, drawBtn, toasts, typeInto, framePatch }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 768)
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`localStorage.setItem('editor.timelineHeight', '260'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]')`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
  await ev(`window.__fl = {
    region: (id) => { const r = window.__zm.item(id).region; return ['x', 'y', 'w', 'h', 'rotation'].map((k) => (r[k].keys || []).length) },
    warnings: () => [...document.querySelectorAll('[data-privacy-warnings] p')].map((p) => p.textContent),
    followBtn: () => document.querySelector('[data-follow-motion]'),
    toastBtn: (label) => [...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === label),
    attachRow: () => document.querySelector('[data-attach-row]'),
    outline: (id) => {
      const e = document.querySelector('[data-region-outline="' + id + '"], [data-region-handles="' + id + '"], [data-region-inactive="' + id + '"]')
      if (!e) return null
      const r = e.getBoundingClientRect(); const o = window.__zm.el('[data-viewer-overlay]').getBoundingClientRect(); const k = o.width / window.__zm.st().project.canvas.width
      return { cx: (r.left + r.width / 2 - o.left) / k, cy: (r.top + r.height / 2 - o.top) / k, w: r.width / k, h: r.height / k }
    },
    // pose do clipe no instante (camada em tela cheia): ponto p do conteúdo vai a x·W + s·(p − W/2)
    pose: (id, t) => {
      const tr = window.__zm.item(id).visual.transform
      const ev = (a) => { const k = a.keys; if (!k || !k.length) return a.value; if (t <= k[0].tUs) return k[0].value; if (t >= k[k.length - 1].tUs) return k[k.length - 1].value; return null }
      return { s: ev(tr.scale), x: ev(tr.x), y: ev(tr.y) }
    }
  }; return 1`)
  const v = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && i.visual).id`)
  await ev(`T.st().select([]); return 1`)
  const near = (a, b) => Math.abs(a - b) < 20
  /** Contorno da região no fim do último zoom do clipe × o ponto (450, 400) e o tamanho 300×200 levados pela pose. */
  const followsAtEnd = async (fx) => {
    const g = await ev(`const s = T.keys('${v}', 'scale'); const end = s[s.length - 1][0]; await T.seek(end); await T.wait(300); return { box: __fl.outline('${fx}'), pose: __fl.pose('${v}', end) }`)
    const { s, x, y } = g.pose
    const ex = { cx: x * 1920 + s * (450 - 960), cy: y * 1080 + s * (400 - 540), w: 300 * s, h: 200 * s }
    return { ok: !!g.box && near(g.box.cx, ex.cx) && near(g.box.cy, ex.cy) && near(g.box.w, ex.w) && near(g.box.h, ex.h), got: g.box, ex }
  }

  console.log('zoom num clipe com blur vinculado: oferta "Ancorar efeito ao clipe"')
  let fx
  {
    // blur desenhado (B) a 0,5 s: centro (450, 400), 300×200 px, vinculado ao vídeo; zoom 4× em (480, 300) a 2 s
    const r = await ev(`await T.seek(0.5e6); await T.key('b'); await T.drag(T.toScreen(300, 300), T.toScreen(600, 500)); await T.wait(150)
      const fx = T.st().selection[0]; const linked = !!T.item(fx).linkId && T.item(fx).linkId === T.item('${v}').linkId
      await T.key('z'); await T.seek(2e6); await T.drag(T.toScreen(240, 165), T.toScreen(720, 380)); await T.wait(500)
      const toast = T.toasts().find((t) => t.includes('privacidade'))
      const btn = __fl.toastBtn('Ancorar efeito ao clipe')
      return { fx, linked, toast, anchor: !!btn, view: !!__fl.toastBtn('Ver efeito'), focusRing: !!btn && btn.className.includes('focus-visible:ring-2'), s: T.keys('${v}', 'scale').length }`)
    fx = r.fx
    check('zoom com blur vinculado: toast com "Ancorar efeito ao clipe" e "Ver efeito" (foco visível)', r.linked && r.s > 0 && !!r.toast && r.toast.includes('não acompanha o zoom') && r.anchor && r.view && r.focusRing, r)
    await shot('f4-follow-01-oferta.png')
    const a = await ev(`const p0 = T.past(); await T.click(__fl.toastBtn('Ancorar efeito ao clipe')); await T.wait(400)
      return { p0, past: T.past(), attach: T.item('${fx}').attach?.mediaItemId, keys: __fl.region('${fx}'), toast: T.toasts().find((t) => t.includes('ancorado')) }`)
    check('ancorar: attach no vídeo, um passo de desfazer, sem keys na região, toast de confirmação', a.past === a.p0 + 1 && a.attach === v && a.keys.every((n) => n === 0) && !!a.toast, a)
    const f = await followsAtEnd(fx)
    check('a região na tela acompanha o conteúdo no fim do zoom (centro e tamanho pela escala, ±1 % do quadro)', f.ok, f)
    await ev(`T.st().select(['${fx}']); const s = T.keys('${v}', 'scale'); await T.seek(Math.round((s[0][0] + s[1][0]) / 2)); await T.wait(300); return 1`)
    await shot('f4-follow-02-ancorado.png')
  }

  console.log('zoom posterior: a âncora acompanha sozinha')
  {
    const r = await ev(`T.st().select([]); await T.settle(); await T.seek(5e6); await T.drag(T.toScreen(300, 250), T.toScreen(700, 470)); await T.wait(500)
      return { toast: T.toasts().filter((t) => t.includes('privacidade')).length, s: T.keys('${v}', 'scale').length, attach: T.item('${fx}').attach?.mediaItemId }`)
    check('segundo zoom mais tarde: nenhum aviso novo para o efeito ancorado', r.s >= 4 && r.attach === v && r.toast <= 1, r)
    const f = await followsAtEnd(fx)
    check('…e a região acompanha o fim do novo zoom sem nenhuma edição no efeito', f.ok, f)
    await ev(`await T.key('z'); return 1`)
    await shot('f4-follow-03-zoom-posterior.png')
  }

  console.log('inspetor: chave "Ancorado ao clipe", arrastar relativo ao conteúdo, desancorar')
  {
    const r = await ev(`const s = T.keys('${v}', 'scale'); await T.seek(s[s.length - 1][0]); T.st().select(['${fx}']); await T.settle(); await T.wait(300)
      const row = __fl.attachRow(); const sw = row?.querySelector('[role="switch"]'); row?.scrollIntoView({ block: 'center' }); await T.wait(150)
      return { text: row?.textContent, on: sw?.getAttribute('aria-checked'), warnings: __fl.warnings() }`)
    check('inspetor: "Ancorado ao clipe: <nome do clipe>" ligado, sem avisos de movimento', !!r.text && r.text.includes('Ancorado ao clipe: testsrc2-voz.mp4') && r.on === 'true' && !r.warnings.some((w) => w.includes('não acompanha')), r)
    await shot('f4-follow-04-inspetor-ancorado.png')
    // arrastar a região +80 px de tela no fim do zoom: o conteúdo anda 80 / escala
    // no fim do 1º zoom (2,5 s; a região fica dentro do quadro): escala = largura na tela (sem a folga de 2 px) ÷ 300
    const d = await ev(`await T.seek(2.5e6); await T.wait(300)
      const b = __fl.outline('${fx}'); const pose = { s: (b.w - 2) / 300 }; const x0 = T.item('${fx}').region.x.value; const w0 = T.item('${fx}').region.w.value; const p0 = T.past()
      const from = T.toScreen(b.cx, b.cy); const to = T.toScreen(b.cx + 80, b.cy)
      await T.drag(from, to); await T.wait(200)
      return { past: T.past(), p0, dx: T.item('${fx}').region.x.value - x0, dw: T.item('${fx}').region.w.value - w0, s: pose.s, keys: __fl.region('${fx}') }`)
    check('arrastar a região ancorada: o conteúdo anda 80 px ÷ escala (fração da fonte), largura igual, um passo', d.past === d.p0 + 1 && Math.abs(d.dx - 80 / (d.s * 1920)) < 0.002 && Math.abs(d.dw) < 1e-9, d)
    await ev(`await T.key('z', { ctrlKey: true }); await T.wait(200); return 1`)
    const off = await ev(`const sw = __fl.attachRow().querySelector('[role="switch"]'); sw.scrollIntoView({ block: 'center' }); await T.wait(150); const p0 = T.past(); await T.click(sw); await T.wait(300)
      return { p0, past: T.past(), attach: T.item('${fx}').attach, keys: __fl.region('${fx}'), warnings: __fl.warnings(), text: __fl.attachRow()?.textContent }`)
    check('desligar a chave desancora: keys do quadro assados (acompanham), sem aviso, um passo', off.past === off.p0 + 1 && !off.attach && off.keys[0] >= 2 && !off.warnings.some((w) => w.includes('não acompanha')) && off.text.includes('Ancorar ao clipe'), off)
    await shot('f4-follow-05-desancorado.png')
    await ev(`await T.key('z', { ctrlKey: true }); await T.wait(200); return 1`)
  }

  console.log('sem âncora: botão "Ancorar ao clipe" no aviso do inspetor')
  {
    // desfaz o 2º zoom e a ancoragem: efeito vinculado sem âncora sob o zoom
    const r = await ev(`await T.key('z', { ctrlKey: true }); await T.key('z', { ctrlKey: true }); await T.wait(200); T.st().select(['${fx}']); await T.settle(); await T.wait(300)
      return { attach: !!T.item('${fx}').attach, warnings: __fl.warnings(), btn: __fl.followBtn()?.textContent, kind: __fl.followBtn()?.dataset.followMotion }`)
    check('sem âncora: aviso com "Ancorar ao clipe"', !r.attach && r.warnings.some((w) => w.includes('a região deste efeito não acompanha')) && r.btn === 'Ancorar ao clipe' && r.kind === 'transformedUnderEffect', r)
    await shot('f4-follow-06-inspetor-aviso.png')
    const a = await ev(`const p0 = T.past(); __fl.followBtn().scrollIntoView({ block: 'center' }); await T.wait(150); await T.click(__fl.followBtn()); await T.wait(300)
      return { p0, past: T.past(), attach: T.item('${fx}').attach?.mediaItemId, warnings: __fl.warnings(), btn: !!__fl.followBtn() }`)
    check('botão do inspetor: ancora (um passo) e o aviso some', a.past === a.p0 + 1 && a.attach === v && !a.warnings.some((w) => w.includes('não acompanha')) && !a.btn, a)
  }

  console.log('âncora perdida: clipe desativado')
  {
    const r = await ev(`T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === '${v}' ? { ...i, enabled: false } : i)) })) }))
      await T.settle(); T.st().select(['${fx}']); await T.settle(); await T.wait(300); __fl.attachRow()?.scrollIntoView({ block: 'center' })
      const inputs = [...__fl.attachRow().parentElement.querySelectorAll('input')]
      return { warnings: __fl.warnings(), text: __fl.attachRow()?.textContent, note: document.querySelector('[data-anchor-unavailable]')?.textContent, inputs: inputs.length, disabled: inputs.every((i) => i.disabled) }`)
    check('clipe desativado: aviso attachLost, chave "clipe apagado ou desativado", campos da região desativados e a nota "Clipe da âncora indisponível"', r.warnings.some((w) => w.includes('estava ancorado')) && r.text.includes('apagado ou desativado') && r.inputs >= 5 && r.disabled && !!r.note && r.note.startsWith('Clipe da âncora indisponível'), r)
    await shot('f4-follow-07-ancora-perdida.png')
    // desfaz: desativar, ancorar, zoom, efeito desenhado
    await ev(`await T.key('Escape'); for (let k = 0; k < 4; k++) await T.key('z', { ctrlKey: true }); await T.wait(200); return 1`)
  }

  console.log('efeito solto + Ken Burns: "Vincular e ancorar"')
  {
    const r = await ev(`if (T.zoomBtn().getAttribute('aria-pressed') === 'true') await T.key('z')
      const clean = !T.item('${fx}') && T.keys('${v}', 'scale').length === 0
      // blur desenhado e desvinculado (efeito solto sobre o vídeo)
      await T.seek(0.5e6); await T.key('b'); await T.drag(T.toScreen(300, 300), T.toScreen(600, 500)); await T.wait(150)
      const fx = T.st().selection[0]; await T.key('Escape')
      T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => { if (i.id !== fx) return i; const { linkId, ...rest } = i; return rest }) })) }))
      await T.settle()
      T.st().select(['${v}']); await T.settle(); await T.wait(300)
      const btn = T.el('button[aria-label="Ken Burns: Aproximar indo para baixo e à direita"]'); btn.scrollIntoView({ block: 'center' }); await T.wait(200)
      await T.click(btn); await T.wait(500)
      return { clean, fx, unlinked: !T.item(fx).linkId, toast: T.toasts().find((t) => t.includes('privacidade')), btn: !!__fl.toastBtn('Vincular e ancorar') }`)
    fx = r.fx
    check('Ken Burns com efeito solto sobre o clipe: toast com "Vincular e ancorar"', r.clean && r.unlinked && !!r.toast && r.btn, r)
    await shot('f4-follow-08-solto-toast.png')
    const i = await ev(`T.st().select(['${fx}']); await T.settle(); await T.wait(300)
      return { warnings: __fl.warnings(), btn: __fl.followBtn()?.textContent, kind: __fl.followBtn()?.dataset.followMotion, attach: !!T.item('${fx}').attach }`)
    check('inspetor do efeito solto: aviso unlinkedOverMoving com "Vincular e ancorar" (não ancora sozinho)', i.warnings.some((w) => w.includes('não vinculado')) && i.btn === 'Vincular e ancorar' && i.kind === 'unlinkedOverMoving' && !i.attach, i)
    const a = await ev(`const p0 = T.past(); const group = T.item('${v}').linkId; __fl.followBtn().scrollIntoView({ block: 'center' }); await T.wait(150); await T.click(__fl.followBtn()); await T.wait(300)
      return { p0, past: T.past(), group, link: T.item('${fx}').linkId, videoLink: T.item('${v}').linkId, attach: T.item('${fx}').attach?.mediaItemId, warnings: __fl.warnings(), btn: !!__fl.followBtn() }`)
    check('"Vincular e ancorar": entra no grupo do clipe (o clipe mantém o vínculo), ancora, sem avisos, um passo', a.past === a.p0 + 1 && !!a.group && a.link === a.group && a.videoLink === a.group && a.attach === v && a.warnings.length === 0 && !a.btn, a)
    await ev(`await T.seek(8e6); return 1`)
    await shot('f4-follow-09-vinculado-ancorado.png')
    await ev(`await T.key('Escape'); for (let k = 0; k < 4; k++) await T.key('z', { ctrlKey: true }); return 1`)
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
