// QA do "Ajustar efeitos ao movimento" (F4 Task 4) via CDP, com eventos de ponteiro/teclado sintéticos despachados no
// elemento real sob o ponto (document.elementFromPoint) — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f4-follow.mjs            → abre o app (CIALIGHT_QA=editor-fixture, CIALIGHT_RAW_DIR=test-out/raw),
//                                                   testa e fecha
//   node scripts/qa/editor-f4-follow.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// Confere: zoom num clipe com blur vinculado → toast com "Ajustar efeitos ao movimento" e "Ver efeito"; a ação grava
// keys na região (um passo de desfazer) e o aviso do inspetor some; a região na tela acompanha o conteúdo (contorno da
// região no visualizador × o ponto do conteúdo levado pelo zoom); botão "Ajustar efeito ao movimento" no inspetor do
// efeito; efeito solto + Ken Burns → aviso unlinkedOverMoving com "Vincular e ajustar" (toast e inspetor), que vincula
// ao grupo do clipe e ajusta. Screenshots em docs/qa/editor-f4/.
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
    outline: (id) => {
      const e = document.querySelector('[data-region-outline="' + id + '"], [data-region-handles="' + id + '"], [data-region-inactive="' + id + '"]')
      if (!e) return null
      const r = e.getBoundingClientRect(); const o = window.__zm.el('[data-viewer-overlay]').getBoundingClientRect(); const k = o.width / window.__zm.st().project.canvas.width
      return { cx: (r.left + r.width / 2 - o.left) / k, cy: (r.top + r.height / 2 - o.top) / k, w: r.width / k, h: r.height / k }
    }
  }; return 1`)
  const v = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && i.visual).id`)
  await ev(`T.st().select([]); return 1`)

  console.log('zoom num clipe com blur vinculado: oferta "Ajustar efeitos ao movimento"')
  let fx
  {
    // blur desenhado (B) a 0,5 s: centro (450, 400), 300×200 px, vinculado ao vídeo; zoom 4× em (480, 300) a 2 s
    const r = await ev(`await T.seek(0.5e6); await T.key('b'); await T.drag(T.toScreen(300, 300), T.toScreen(600, 500)); await T.wait(150)
      const fx = T.st().selection[0]; const linked = !!T.item(fx).linkId && T.item(fx).linkId === T.item('${v}').linkId
      await T.key('z'); await T.seek(2e6); await T.drag(T.toScreen(240, 165), T.toScreen(720, 380)); await T.wait(500)
      const toast = T.toasts().find((t) => t.includes('privacidade'))
      return { fx, linked, toast, adjust: !!__fl.toastBtn('Ajustar efeitos ao movimento'), view: !!__fl.toastBtn('Ver efeito'), s: T.keys('${v}', 'scale').length }`)
    fx = r.fx
    check('zoom com blur vinculado: toast com "Ajustar efeitos ao movimento" e "Ver efeito"', r.linked && r.s > 0 && !!r.toast && r.adjust && r.view, r)
    await shot('f4-follow-01-oferta.png')
    const a = await ev(`const p0 = T.past(); await T.click(__fl.toastBtn('Ajustar efeitos ao movimento')); await T.wait(400)
      return { p0, past: T.past(), keys: __fl.region('${fx}'), toast: T.toasts().find((t) => t.includes('ajustado')) }`)
    check('ajustar: keys na região do efeito (x/y/w/h), um passo de desfazer, toast de confirmação', a.past === a.p0 + 1 && a.keys[0] >= 2 && a.keys[2] >= 2 && !!a.toast, a)
    // no fim do zoom: o centro da região (450, 400) e o tamanho 300×200 levados pela escala/posição do clipe
    const g = await ev(`T.st().select(['${fx}']); const s = T.keys('${v}', 'scale'); const end = s[s.length - 1]; await T.seek(end[0]); await T.wait(300)
      return { box: __fl.outline('${fx}'), warnings: __fl.warnings(), btn: !!__fl.followBtn(), s: end[1], x: T.keys('${v}', 'x').at(-1)[1], y: T.keys('${v}', 'y').at(-1)[1] }`)
    // camada em tela cheia: ponto p do conteúdo vai a x·W + s·(p − W/2)
    const ex = { cx: g.x * 1920 + g.s * (450 - 960), cy: g.y * 1080 + g.s * (400 - 540), w: 300 * g.s, h: 200 * g.s }
    const near = (a, b) => Math.abs(a - b) < 20
    check('a região na tela acompanha o conteúdo no fim do zoom (centro e tamanho pela escala, ±1 % do quadro)', !!g.box && near(g.box.cx, ex.cx) && near(g.box.cy, ex.cy) && near(g.box.w, ex.w) && near(g.box.h, ex.h), { got: g.box, ex })
    check('inspetor do efeito ajustado: sem aviso de movimento nem botão', !g.warnings.some((w) => w.includes('se move')) && !g.btn, g)
    await ev(`const s = T.keys('${v}', 'scale'); await T.seek(Math.round((s[0][0] + s[1][0]) / 2)); return 1`)
    await shot('f4-follow-02-ajustado.png')
  }

  console.log('botão no inspetor do efeito')
  {
    const r = await ev(`await T.key('Escape'); await T.key('z', { ctrlKey: true }); await T.wait(200); T.st().select(['${fx}']); await T.settle(); await T.wait(300)
      return { keys: __fl.region('${fx}'), warnings: __fl.warnings(), btn: __fl.followBtn()?.textContent, kind: __fl.followBtn()?.dataset.followMotion }`)
    check('Ctrl+Z desfaz o ajuste; o inspetor mostra o aviso com "Ajustar efeito ao movimento"', r.keys.every((n) => n === 0) && r.warnings.some((w) => w.includes('a região deste efeito não acompanha')) && r.btn === 'Ajustar efeito ao movimento' && r.kind === 'transformedUnderEffect', r)
    await shot('f4-follow-03-inspetor-aviso.png')
    const a = await ev(`const p0 = T.past(); __fl.followBtn().scrollIntoView({ block: 'center' }); await T.wait(150); await T.click(__fl.followBtn()); await T.wait(300)
      return { p0, past: T.past(), keys: __fl.region('${fx}'), warnings: __fl.warnings(), btn: !!__fl.followBtn() }`)
    check('botão do inspetor: ajusta (um passo) e o aviso some', a.past === a.p0 + 1 && a.keys[0] >= 2 && !a.warnings.some((w) => w.includes('não acompanha')) && !a.btn, a)
    // desfaz: ajuste, zoom e o efeito desenhado
    await ev(`await T.key('Escape'); for (let k = 0; k < 3; k++) await T.key('z', { ctrlKey: true }); await T.wait(200); return 1`)
  }

  console.log('efeito solto + Ken Burns: "Vincular e ajustar"')
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
      return { clean, fx, unlinked: !T.item(fx).linkId, toast: T.toasts().find((t) => t.includes('sem vínculo')), btn: !!__fl.toastBtn('Vincular e ajustar') }`)
    fx = r.fx
    check('Ken Burns com efeito solto sobre o clipe: toast "sem vínculo" com "Vincular e ajustar"', r.clean && r.unlinked && !!r.toast && r.btn, r)
    await shot('f4-follow-04-solto-toast.png')
    const i = await ev(`T.st().select(['${fx}']); await T.settle(); await T.wait(300)
      return { warnings: __fl.warnings(), btn: __fl.followBtn()?.textContent, kind: __fl.followBtn()?.dataset.followMotion, keys: __fl.region('${fx}') }`)
    check('inspetor do efeito solto: aviso unlinkedOverMoving com "Vincular e ajustar" (não ajusta sozinho)', i.warnings.some((w) => w.includes('não vinculado')) && i.btn === 'Vincular e ajustar' && i.kind === 'unlinkedOverMoving' && i.keys.every((n) => n === 0), i)
    await shot('f4-follow-05-solto-inspetor.png')
    const a = await ev(`const p0 = T.past(); const group = T.item('${v}').linkId; __fl.followBtn().scrollIntoView({ block: 'center' }); await T.wait(150); await T.click(__fl.followBtn()); await T.wait(300)
      return { p0, past: T.past(), group, link: T.item('${fx}').linkId, videoLink: T.item('${v}').linkId, keys: __fl.region('${fx}'), warnings: __fl.warnings(), btn: !!__fl.followBtn() }`)
    check('"Vincular e ajustar": entra no grupo do clipe (o clipe mantém o vínculo), keys na região, sem avisos, um passo', a.past === a.p0 + 1 && !!a.group && a.link === a.group && a.videoLink === a.group && a.keys[2] >= 2 && a.warnings.length === 0 && !a.btn, a)
    await ev(`await T.seek(8e6); return 1`)
    await shot('f4-follow-06-vinculado-ajustado.png')
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
