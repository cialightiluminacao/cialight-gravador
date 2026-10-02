// QA da ferramenta de zoom/pan e do Ken Burns (F4 Task 3) via CDP, com eventos de ponteiro/teclado sintéticos
// despachados no elemento real sob o ponto (document.elementFromPoint) — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f4-zoom.mjs            → abre o app (CIALIGHT_QA=editor-fixture, CIALIGHT_RAW_DIR=test-out/raw),
//                                                 testa e fecha
//   node scripts/qa/editor-f4-zoom.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// Confere: atalho Z (liga/desliga, exclusivo com B, Esc sai, Shift+Z não liga), opções no popover (duração, voltar
// ao normal), arraste do enquadramento-alvo com prévia na proporção do quadro, keys de escala/posição no clipe de cima
// sob o ponto (logo sobre o vídeo), um passo de desfazer, o conteúdo do centro do retângulo no centro do quadro no
// fim (pixels do visualizador), aviso de privacidade com efeito vinculado ("Ver efeito" seleciona o efeito, que mostra
// o aviso) e Ken Burns no inspetor. Screenshots em docs/qa/editor-f4/.
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
  const v = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && i.visual).id`)
  const logo = await ev(`return T.items().find((i) => i.assetId === 'a_qa_logo').id`)
  await ev(`T.st().select([]); await T.seek(2e6); return 1`)

  console.log('atalho Z, exclusivo com B, Esc sai')
  {
    const r = await ev(`const p = () => T.zoomBtn().getAttribute('aria-pressed')
      const draw = () => T.drawBtn().getAttribute('aria-pressed')
      await T.key('z'); const a = { zoom: p(), cross: T.el('[data-viewer-overlay]').className.includes('cursor-crosshair'), opts: !!document.querySelector('[data-viewer-toolbar] button[aria-label="Opções do zoom"]') }
      await T.key('b'); const b = { zoom: p(), draw: draw() }
      await T.key('z'); const c = { zoom: p(), draw: draw() }
      await T.key('Escape'); const d = { zoom: p() }
      await T.key('Z', { shiftKey: true }); const e = { zoom: p() }
      await T.key('z'); return { a, b, c, d, e, label: T.zoomBtn().getAttribute('aria-label') }`)
    check('Z liga a ferramenta Zoom (cursor em cruz, botão de opções aparece)', r.a.zoom === 'true' && r.a.cross && r.a.opts, r.a)
    check('B troca para Desenhar região (Zoom desliga) e Z volta', r.b.zoom === 'false' && r.b.draw === 'true' && r.c.zoom === 'true' && r.c.draw === 'false', r)
    check('Esc sai da ferramenta; Shift+Z (ajustar a timeline) não liga o Zoom', r.d.zoom === 'false' && r.e.zoom === 'false', r)
  }

  console.log('opções no popover')
  {
    await ev(`await T.click(T.el('[data-viewer-toolbar] button[aria-label="Opções do zoom"]')); await T.wait(300); return 1`)
    const r = await ev(`const pop = T.el('[data-zoom-settings]'); const inputs = () => [...pop.querySelectorAll('input')]
      const before = inputs().length
      await T.typeInto(inputs()[0], '0,5')
      await T.click(pop.querySelector('[aria-label="Voltar ao normal depois"]')); await T.wait(100)
      const after = inputs().length
      await T.typeInto(inputs()[1], '1')
      return { before, after, text: pop.textContent, values: inputs().map((i) => i.value) }`)
    check('popover: duração, curva, sem bordas; "voltar ao normal" mostra o campo de N s', r.before === 1 && r.after === 2 && r.text.includes('Duração') && r.text.includes('Curva') && r.text.includes('Sem bordas pretas') && JSON.stringify(r.values) === JSON.stringify(['0,5', '1,0']), r)
    await shot('f4-zoom-01-opcoes.png')
    await ev(`document.activeElement?.blur?.(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await T.wait(300); return 1`)
    const z = await ev(`return { open: !!document.querySelector('[data-zoom-settings]'), zoom: T.zoomBtn().getAttribute('aria-pressed') }`)
    check('Esc fecha o popover sem sair da ferramenta', !z.open && z.zoom === 'true', z)
  }

  console.log('arrastar o enquadramento-alvo no vídeo')
  {
    // alvo: de (240, 165) a (720, 380) px do canvas — o lado maior (480 px = 0,25 do quadro) manda: 4×, centro (480, 300)
    const r = await ev(`const p0 = T.past(); const a = T.toScreen(240, 165); const b = T.toScreen(720, 380)
      await T.drag(a, b, { release: false })
      const prev = T.el('[data-zoom-rect]'); const pr = prev.getBoundingClientRect(); const ov = T.el('[data-viewer-overlay]').getBoundingClientRect()
      return { p0, w: pr.width / ov.width, h: pr.height / ov.height, label: prev.textContent, unchanged: T.keys('${v}', 'scale').length === 0 }`)
    check('prévia na proporção do quadro (lado maior manda) com o fator; o clipe não muda durante o arraste', Math.abs(r.w - 0.25) < 0.01 && Math.abs(r.h - 0.25) < 0.01 && r.label === '4,0×' && r.unchanged, r)
    await shot('f4-zoom-02-retangulo.png')
    const d = await ev(`const b = T.toScreen(720, 380); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: b.x, clientY: b.y, pointerId: 1 })); await T.settle(); await T.wait(200)
      return { past: T.past(), sel: T.st().selection, s: T.keys('${v}', 'scale'), x: T.keys('${v}', 'x'), y: T.keys('${v}', 'y'), logo: T.keys('${logo}', 'scale'), tx: !!T.st().txBase, zoom: T.zoomBtn().getAttribute('aria-pressed'), rect: !!document.querySelector('[data-zoom-rect]') }`)
    check('soltar: um passo de desfazer, clipe selecionado, prévia some, ferramenta continua ligada', d.past === r.p0 + 1 && d.sel.length === 1 && d.sel[0] === v && !d.tx && d.zoom === 'true' && !d.rect, d)
    check('keys de escala no vídeo: 2 s → 2,5 s (4×, suavizar ambos), segura 1 s, volta em 0,5 s; logo intocado', JSON.stringify(d.s.map((k) => k[0])) === JSON.stringify([2e6, 2.5e6, 3.5e6, 4e6]) && Math.abs(d.s[1][1] - 4) < 1e-6 && d.s[3][1] === 1 && d.s[0][2] === 'inOut' && d.logo.length === 0, d)
    check('x/y levam o centro do retângulo ao centro do quadro (x = 0,5 + 4·(0,5 − 0,25); y = 0,5 + 4·(0,5 − 300/1080))', Math.abs(d.x[1][1] - 1.5) < 1e-3 && Math.abs(d.y[1][1] - (0.5 + 4 * (0.5 - 300 / 1080))) < 1e-3, { x: d.x, y: d.y })
  }

  console.log('quadro no fim do zoom (pixels do visualizador)')
  {
    // mesmo instante (2,5 s) com e sem o zoom: o centro do quadro com zoom = o centro do retângulo sem zoom
    const r = await ev(`await T.seek(2.5e6); const zoomed = await T.framePatch(960, 540)
      const center = await T.framePatch(480, 300)
      await T.key('z', { ctrlKey: true }); await T.seek(2.5e6); const plain = await T.framePatch(480, 300)
      const undone = T.keys('${v}', 'scale').length === 0
      await T.key('z', { ctrlKey: true, shiftKey: true }); await T.seek(2.5e6)
      return { zoomed, plain, center, undone }`)
    const diff = Math.max(...r.zoomed.map((c, i) => Math.abs(c - r.plain[i])))
    check('o conteúdo no centro do retângulo aparece no centro do quadro no fim (mesma cor ±20)', diff <= 20, { ...r, diff })
    check('Ctrl+Z desfaz o zoom inteiro (e Ctrl+Shift+Z refaz)', r.undone, r)
    await shot('f4-zoom-03-resultado.png')
    await ev(`await T.key('z', { ctrlKey: true }); return 1`)
  }

  console.log('clipe de cima sob o ponto: o logo')
  {
    const r = await ev(`await T.seek(2e6); const c = T.toScreen(1613, 238); const p0 = T.past()
      await T.drag({ x: c.x - 40, y: c.y - 30 }, { x: c.x + 40, y: c.y + 30 })
      await T.wait(150)
      return { p0, past: T.past(), logo: T.keys('${logo}', 'scale'), video: T.keys('${v}', 'scale'), sel: T.st().selection }`)
    check('arraste começando no logo grava os keys no logo (o de cima), não no vídeo', r.logo.length >= 2 && r.video.length === 0 && r.sel[0] === logo && r.past === r.p0 + 1, r)
    await ev(`await T.key('z', { ctrlKey: true }); return 1`)
  }

  console.log('privacidade: efeito vinculado ao clipe')
  let fxId
  {
    // região desenhada (B) a 0,5 s cria o blur vinculado ao vídeo
    const r = await ev(`await T.seek(0.5e6); await T.key('b'); await T.drag(T.toScreen(300, 300), T.toScreen(600, 500)); await T.wait(150)
      const fx = T.st().selection[0]; const linked = !!T.item(fx).linkId && T.item(fx).linkId === T.item('${v}').linkId
      await T.key('z'); await T.drag(T.toScreen(200, 200), T.toScreen(1100, 700)); await T.wait(500)
      const toast = T.toasts().find((t) => t.includes('privacidade'))
      const btn = T.all('[data-sonner-toast] button').find((b) => b.textContent.trim() === 'Ver efeito')
      return { fx, linked, toast, hasBtn: !!btn, sel: T.st().selection, s: T.keys('${v}', 'scale').length }`)
    fxId = r.fx
    check('zoom num clipe com blur vinculado avisa (toast com "Ver efeito")', r.linked && r.s > 0 && !!r.toast && r.toast.includes('não acompanha o zoom') && r.hasBtn, r)
    await shot('f4-zoom-04-aviso-privacidade.png')
    const s = await ev(`const btn = T.all('[data-sonner-toast] button').find((b) => b.textContent.trim() === 'Ver efeito'); await T.click(btn); await T.wait(400)
      return { sel: T.st().selection, panel: document.body.textContent.includes('a região deste efeito não acompanha') }`)
    check('"Ver efeito" seleciona o efeito, cujo inspetor mostra o aviso transformedUnderEffect', s.sel.length === 1 && s.sel[0] === fxId && s.panel, s)
    await shot('f4-zoom-05-efeito-aviso.png')
    await ev(`await T.key('Escape'); await T.key('Escape'); await T.key('z', { ctrlKey: true }); await T.key('z', { ctrlKey: true }); return 1`)
  }

  console.log('Ken Burns no inspetor')
  {
    const r = await ev(`if (T.zoomBtn().getAttribute('aria-pressed') === 'true') await T.key('z')
      await T.seek(0.5e6); T.st().select(['${v}']); await T.settle(); await T.wait(300)
      const fxGone = !T.item('${fxId}')
      const btn = T.el('button[aria-label="Ken Burns: Aproximar indo para baixo e à direita"]'); btn.scrollIntoView({ block: 'center' }); await T.wait(200)
      const p0 = T.past(); await T.click(btn); await T.wait(150)
      const item = T.item('${v}')
      return { fxGone, p0, past: T.past(), s: T.keys('${v}', 'scale'), x: T.keys('${v}', 'x'), y: T.keys('${v}', 'y'), dur: item.durationUs }`)
    check('desfazer tirou o efeito de teste', r.fxGone, r)
    check('Ken Burns: escala 1 → 1,15 do início ao fim do clipe, um passo', JSON.stringify(r.s.map((k) => k[0])) === JSON.stringify([0, r.dur]) && r.s[0][1] === 1 && Math.abs(r.s[1][1] - 1.15) < 1e-6 && r.past === r.p0 + 1, r)
    check('Ken Burns ↘: o centro vai a 0,425 (canto inferior direito da camada parado no do quadro)', Math.abs(r.x[1][1] - 0.425) < 1e-6 && Math.abs(r.y[1][1] - 0.425) < 1e-6, { x: r.x, y: r.y })
    await ev(`await T.seek(9e6); return 1`)
    await shot('f4-zoom-06-ken-burns.png')
    await ev(`await T.key('z', { ctrlKey: true }); return 1`)
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
