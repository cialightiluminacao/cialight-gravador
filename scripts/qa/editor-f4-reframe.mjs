// QA do "Reenquadrar" (F4 Task 6) via CDP, com eventos de ponteiro/teclado sintéticos despachados no elemento real sob
// o ponto (document.elementFromPoint) — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f4-reframe.mjs            → abre o app (CIALIGHT_QA=editor-fixture, CIALIGHT_RAW_DIR=test-out/raw),
//                                                    testa e fecha
//   node scripts/qa/editor-f4-reframe.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// Confere: o botão "Reenquadrar" abre o painel não modal (9:16 por padrão) com o quadro novo desenhado no
// visualizador; clique no visualizador marca pontos de foco no playhead (lista editável: ir, trocar, remover;
// marcador no quadro); a janela da prévia segue os pontos (suave entre eles); "Caber inteiro" esconde os pontos; o
// transporte continua com o painel aberto; com a região do efeito fora do quadro novo o painel lista o aviso (sem o
// selo "continuam sobre o mesmo conteúdo"); com ela dentro, o selo diz "será ancorado"; pontos agrupados por clipe;
// "Este projeto" aplica em um passo de desfazer; "Criar cópia" (padrão) grava "<nome> (Vertical)" numa pasta própria
// (com os proxies) e a abre, com o original intacto. Screenshots em docs/qa/editor-f4/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__rf; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
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
window.__rf = (() => {
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

const PROJECTS = join(ROOT, 'test-out', 'Projetos')
let copyId = null

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
  const v = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && i.visual).id`)
  // a prévia é agendada (fora do clique): espera o "Calculando…" sumir e o visualizador pegar a prévia nova
  const panel = () => ev(`for (let i = 0; i < 100 && document.querySelector('[data-reframe-pending]'); i++) await T.wait(50)
    await T.wait(80); const R = window.__qaEditor.reframe; const d = document.querySelector('[data-reframe-dialog]'); const w = document.querySelector('[data-reframe-window]')
    const pts = (w?.getAttribute('points') || '').split(' ').filter(Boolean).map((s) => s.split(',').map(Number))
    const ov = T.el('[data-viewer-overlay]').getBoundingClientRect()
    const xs = pts.map((p) => p[0] / ov.width), ys = pts.map((p) => p[1] / ov.height)
    return { open: !!d, text: d?.textContent ?? '', win: pts.length ? { cx: (Math.min(...xs) + Math.max(...xs)) / 2, w: Math.max(...xs) - Math.min(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : null,
      list: [...document.querySelectorAll('[data-focus-point]')].map((e) => +e.getAttribute('data-focus-point')), here: document.querySelectorAll('[data-focus-marker="here"]').length,
      markers: document.querySelectorAll('[data-focus-marker]').length, points: R.getState().points,
      groups: [...document.querySelectorAll('[data-focus-group]')].map((g) => g.getAttribute('data-focus-group')),
      shield: !!document.querySelector('[data-reframe-privacy]'), warnings: document.querySelector('[data-reframe-warnings]')?.textContent ?? '' }`)
  const seg = `const seg = (label) => [...document.querySelectorAll('[data-reframe-dialog] button')].find((b) => b.textContent.trim() === label);`

  console.log('privacidade: um blur desenhado sobre o vídeo')
  const fx = await ev(`await T.seek(0.5e6); await T.key('b'); await T.drag(T.toScreen(1250, 760), T.toScreen(1450, 860)); await T.wait(150); const id = T.st().selection[0]; await T.key('b'); T.st().select([]); await T.settle(); return id`)
  check('efeito desenhado (B) sobre o vídeo', !!fx, fx)

  console.log('abrir o painel')
  {
    await ev(`await T.seek(2e6); await T.click(T.el('[data-reframe-open]')); await T.wait(400); return 1`)
    const r = await panel()
    // vídeo 16:9 em 'cover' no 9:16: a camada tem 3413 px de largura; a janela, 1080/3413 do quadro atual e a altura toda
    check('painel aberto (9:16, Preencher, Criar cópia) com o quadro novo no centro do visualizador', r.open && r.text.includes('Reenquadrar') && r.text.includes('1080×1920') && !!r.win && Math.abs(r.win.cx - 0.5) < 0.01 && Math.abs(r.win.w - 1080 / 3413.33) < 0.01 && r.win.y0 < 0.01 && r.win.y1 > 0.99, r)
    check('efeito fora do quadro novo (centro): o aviso aparece e o selo "continuam sobre o mesmo conteúdo" não', !r.shield && r.warnings.includes('fora do novo quadro'), { shield: r.shield, warnings: r.warnings })
    check('sem pontos: o centro do clipe', r.text.includes('Sem pontos'), r.text)
    await shot('f4-reframe-01-painel.png')
  }

  console.log('marcar pontos de foco')
  {
    const a = await ev(`const p0 = T.past(); const c = T.toScreen(1500, 540); await T.clickAt(c.x, c.y); await T.wait(200); return { p0, past: T.past(), sel: T.st().selection }`)
    const r = await panel()
    check('clique no visualizador marca o ponto no playhead (2 s, 78 % × 50 %), sem editar o projeto nem selecionar', JSON.stringify(r.list) === JSON.stringify([2e6]) && r.here === 1 && a.past === a.p0 && a.sel.length === 0 && Math.abs(r.points[v][0].x - 1500 / 1920) < 0.002, { a, r })
    check('a janela da prévia centraliza o ponto marcado', !!r.win && Math.abs(r.win.cx - 1500 / 1920) < 0.01, r.win)
    check('com o efeito dentro do quadro novo: sem avisos, selo "será ancorado"; pontos agrupados no clipe', r.shield && r.text.includes('1 será ancorado') && !r.warnings && JSON.stringify(r.groups) === JSON.stringify([v]), { shield: r.shield, warnings: r.warnings, groups: r.groups })
    await shot('f4-reframe-02-foco.png')
    await ev(`await T.seek(6e6); const c = T.toScreen(400, 540); await T.clickAt(c.x, c.y); await T.wait(200); return 1`)
    const b = await panel()
    check('segundo ponto em 6 s (lista em ordem de tempo)', JSON.stringify(b.list) === JSON.stringify([2e6, 6e6]) && !!b.win && Math.abs(b.win.cx - 400 / 1920) < 0.01, b)
    await ev(`await T.seek(4e6); return 1`)
    const m = await panel()
    check('no meio (4 s) a câmera está entre os dois pontos (suave)', !!m.win && Math.abs(m.win.cx - (1500 + 400) / 2 / 1920) < 0.01 && m.here === 0 && m.markers === 2, m)
    await shot('f4-reframe-03-entre-pontos.png')
    const c = await ev(`await T.seek(6e6); const c = T.toScreen(600, 400); await T.clickAt(c.x, c.y); await T.wait(150)
      const n = window.__qaEditor.reframe.getState().points['${v}']
      await T.click(T.el('[data-focus-point="6000000"] button[aria-label^="Remover"]')); await T.wait(150)
      return { replaced: n.length === 2 && Math.abs(n[1].x - 600 / 1920) < 0.002, after: window.__qaEditor.reframe.getState().points['${v}'].map((p) => p.localUs) }`)
    check('clicar de novo no mesmo instante troca o ponto; o X remove', c.replaced && JSON.stringify(c.after) === JSON.stringify([2e6]), c)
    const g = await ev(`await T.seek(0); await T.click(T.el('[data-focus-point="2000000"] button')); await T.wait(300); return T.st().playheadUs`)
    check('clicar no tempo do ponto leva o playhead até ele', Math.abs(g - 2e6) < 40_000, g)
  }

  console.log('modo e proporção')
  {
    const r = await ev(`${seg}
      await T.click(seg('Caber inteiro')); await T.wait(200)
      const contain = { points: !!document.querySelector('[data-reframe-points]'), mode: window.__qaEditor.reframe.getState().mode }
      await T.click(seg('Preencher')); await T.click(seg('1:1')); await T.wait(200)
      const text = document.querySelector('[data-reframe-dialog]').textContent
      await T.click(seg('9:16')); await T.wait(200)
      return { contain, square: text.includes('1080×1080') }`)
    check('"Caber inteiro" esconde os pontos de foco; 1:1 mostra 1080×1080', r.contain.mode === 'contain' && !r.contain.points && r.square, r)
    const k = await ev(`const before = T.st().playheadUs; await T.key('ArrowRight'); await T.wait(100); return { moved: T.st().playheadUs > before, open: !!document.querySelector('[data-reframe-dialog]') }`)
    check('com o painel aberto o transporte continua (→ anda o playhead)', k.moved && k.open, k)
  }

  console.log('aplicar neste projeto (um passo de desfazer)')
  {
    const r = await ev(`${seg}
      await T.click(seg('Este projeto')); await T.wait(100); const p0 = T.past()
      for (let i = 0; i < 40 && T.toasts().length; i++) await T.wait(250)
      await T.click(T.el('[data-reframe-apply]')); await T.wait(600)
      const p = T.st().project; const it = T.item('${v}'); const f = T.item('${fx}')
      return { p0, past: T.past(), canvas: [p.canvas.width, p.canvas.height], fit: it.visual.fit, x: it.visual.transform.x.value, anchored: f.attach?.mediaItemId, open: !!document.querySelector('[data-reframe-dialog]'), toast: T.toasts().find((t) => t.includes('reenquadrado')) }`)
    check('aplicado: quadro 1080×1920, vídeo em cover, efeito ancorado, painel fechado, um passo', r.past === r.p0 + 1 && r.canvas[0] === 1080 && r.canvas[1] === 1920 && r.fit === 'cover' && r.anchored === v && !r.open && !!r.toast, r)
    await ev(`await T.seek(2e6); await T.wait(600); return 1`)
    await shot('f4-reframe-04-aplicado.png')
    const u = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); const p = T.st().project; return { canvas: [p.canvas.width, p.canvas.height], fit: T.item('${v}').visual.fit, attach: !!T.item('${fx}').attach }`)
    check('Ctrl+Z volta tudo (1920×1080, sem âncora)', u.canvas[0] === 1920 && u.canvas[1] === 1080 && !u.attach, u)
  }

  console.log('criar cópia (padrão)')
  {
    const src = await ev(`return T.st().project.id`)
    // o aviso do passo anterior some antes (fica no canto, por cima do rodapé do painel)
    await ev(`for (let i = 0; i < 40 && T.toasts().length; i++) await T.wait(250); await T.seek(2e6); await T.click(T.el('[data-reframe-open]')); await T.wait(300); const c = T.toScreen(1500, 540); await T.clickAt(c.x, c.y); await T.wait(150)
      await T.click(T.el('[data-reframe-apply]')); return 1`)
    let r = null
    for (let i = 0; i < 40; i++) {
      r = await ev(`const s = window.__qaEditor?.store.getState(); const p = s?.project; const all = p ? p.tracks.flatMap((t) => t.items) : []
        return p ? { id: p.id, name: p.name, canvas: [p.canvas.width, p.canvas.height], origin: p.originSessionId ?? null, x: all.find((i) => i.id === '${v}')?.visual.transform.x.value, fx: all.find((i) => i.id === '${fx}')?.attach?.mediaItemId, toast: [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).find((t) => t.includes('Cópia criada')) } : null`)
      if (r && r.id !== src) break
      await sleep(500)
    }
    check('a cópia "Projeto de teste do editor (Vertical)" abre no editor em 1080×1920, com o foco e o efeito ancorado', !!r && r.id !== src && r.name === 'Projeto de teste do editor (Vertical)' && r.canvas[0] === 1080 && r.canvas[1] === 1920 && r.fx === v && Math.abs(r.x - (0.5 - ((1500 / 1920 - 0.5) * 3413.33) / 1080)) < 0.01 && !!r.toast, r)
    copyId = r?.id !== src ? r?.id : null
    const orig = await ev(`const p = await window.api.project.load('${src}'); return { canvas: [p.canvas.width, p.canvas.height], attach: p.tracks.flatMap((t) => t.items).some((i) => i.attach) }`)
    check('o original continua 1920×1080, sem mudanças', orig.canvas[0] === 1920 && orig.canvas[1] === 1080 && !orig.attach, orig)
    const dir = join(PROJECTS, copyId ?? '-')
    const ls = (d, sub) => (existsSync(join(d, sub)) ? readdirSync(join(d, sub)).sort() : [])
    const derived = ['proxies', 'cache'].map((sub) => [ls(join(PROJECTS, src), sub), ls(dir, sub)])
    const status = await ev(`return window.__qaEditor.store.getState().project.assets.map((a) => a.status)`)
    check('pasta própria com os derivados do original (proxies/cache), sem reprocessar a mídia', existsSync(join(dir, 'project.json')) && derived.every(([a, b]) => JSON.stringify(a) === JSON.stringify(b)) && derived[1][0].length > 0 && status.every((x) => x === 'ready'), { dir, derived, status })
    for (let i = 0; i < 60; i++) {
      const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]')`)
      if (ok) break
      await sleep(500)
    }
    await ev(HELPERS + '; return 1')
    await ev(`await T.seek(2e6); await T.wait(800); return 1`)
    await shot('f4-reframe-05-copia.png')
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
  // a cópia criada fica na pasta de teste (test-out/Projetos): apaga ao fim
  if (copyId) {
    await sleep(500)
    try {
      rmSync(join(PROJECTS, copyId), { recursive: true, force: true })
    } catch {
      // algum arquivo ainda preso: fica na pasta de teste
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
