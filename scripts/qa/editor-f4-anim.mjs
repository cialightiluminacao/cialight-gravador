// QA do painel de animações de entrada/saída (F4 Task 5) via CDP, com eventos sintéticos despachados no elemento real
// sob o ponto (document.elementFromPoint) — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f4-anim.mjs            → abre o app (CIALIGHT_QA=editor-fixture, CIALIGHT_RAW_DIR=test-out/raw),
//                                                 testa e fecha
//   node scripts/qa/editor-f4-anim.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// Confere: grade de cartões (entrada/saída/combinação) com a prévia em miniatura animada (CSS); escolher um preset é um
// passo de desfazer; duração e curva; o quadro do visualizador (invisível no 1º instante do pop; o desfoque de saída
// derruba a energia de detalhe); a combinação grava os dois lados; oferta de ancorar o efeito vinculado ao escolher
// uma animação com movimento (e nenhuma com o desfoque); o mesmo painel num item de texto. Screenshots em docs/qa/editor-f4/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f4')
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__an; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
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

// helpers da página: eventos no elemento real sob o ponto, leitura do store e dos pixels do preview
const HELPERS = `
window.__an = (() => {
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
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(400); await settle() }
  /** px do canvas do projeto → px de tela (overlay do visualizador). */
  const toScreen = (x, y) => { const r = el('[data-viewer-overlay]').getBoundingClientRect(); const k = r.width / st().project.canvas.width; return { x: r.left + x * k, y: r.top + y * k } }
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  /** Valor num campo do NumberField (digitação + blur = commit). */
  const typeInto = async (input, text) => {
    input.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(); input.blur(); await settle()
  }
  /** Média RGB de 5×5 px do quadro do preview em torno de (x, y) px do canvas do projeto. */
  const framePatch = async (x, y) => {
    const r = window.__qaEditor.engine.render
    const k = (r.size.width * r.size.dpr) / st().project.canvas.width
    const px = await r.readPixels(Math.round(x * k) - 2, Math.round(y * k) - 2, 5, 5)
    const m = [0, 0, 0]
    for (let i = 0; i < 25; i++) for (let c = 0; c < 3; c++) m[c] += px[i * 4 + c] / 25
    return m.map(Math.round)
  }
  /** Energia de detalhe (média de ΔL² entre vizinhos, métrica do F2) num quadrado de lado s px do canvas do projeto em (x, y). */
  const frameDetail = async (x, y, s) => {
    const r = window.__qaEditor.engine.render
    const k = (r.size.width * r.size.dpr) / st().project.canvas.width
    const n = Math.round(s * k)
    const px = await r.readPixels(Math.round((x - s / 2) * k), Math.round((y - s / 2) * k), n, n)
    const L = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    let e = 0, c = 0
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = (j * n + i) * 4; e += (L(a) - L(a + 4)) ** 2 + (L(a) - L(a + n * 4)) ** 2; c++ }
    return e / c
  }
  const grid = () => el('[data-anim-grid]')
  const section = () => grid().closest('section')
  const card = (preset) => section().querySelector('[data-anim-card="' + preset + '"]')
  const sideTab = async (label) => { const b = [...section().querySelectorAll('button, [role="radio"]')].find((x) => x.textContent.trim() === label); await click(b); await wait(150) }
  const anims = (id) => { const v = item(id).visual; return { in: v.animIn ?? null, out: v.animOut ?? null } }
  /** Desfaz até o histórico voltar a n passos. */
  const undoTo = async (n) => { for (let i = 0; i < 50 && past() > n; i++) await key('z', { ctrlKey: true }) }
  return { undoTo, st, settle, wait, el, all, center, topAt, clickAt, click, drag, key, items, item, past, seek, toScreen, toasts, typeInto, framePatch, frameDetail, grid, section, card, sideTab, anims }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 900)
  await ev(`localStorage.setItem('editor.timelineHeight', '220'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]')`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
  const v = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && i.visual).id`)
  const past0 = await ev(`return T.past()`)
  // seleciona o vídeo, aba Vídeo do inspetor e rola até o painel de animação
  const showPanel = `T.st().select(['${v}']); await T.settle(); await T.wait(300)
    const tab = [...document.querySelectorAll('[aria-label="Inspetor"] [role="tab"]')].find((x) => x.textContent.trim() === 'Vídeo'); if (tab && tab.getAttribute('data-state') !== 'active') { await T.click(tab); await T.wait(200) }
    T.grid().scrollIntoView({ block: 'center' }); await T.wait(250);`

  console.log('grade de cartões no inspetor do vídeo')
  {
    const r = await ev(`await T.seek(2e6); ${showPanel}
      const cards = [...T.grid().querySelectorAll('[data-anim-card]')]
      const text = T.section().textContent
      return { n: cards.length, labels: cards.map((c) => c.getAttribute('aria-label')), none: T.card('none').getAttribute('aria-pressed'), tabs: text.includes('Entrada') && text.includes('Saída') && text.includes('Combinação'), anims: T.anims('${v}') }`)
    check('11 cartões (Nenhuma + 10 presets), Entrada/Saída/Combinação; sem animação → "Nenhuma" marcado', r.n === 11 && r.none === 'true' && r.tabs && !r.anims.in && !r.anims.out && JSON.stringify(r.labels) === JSON.stringify(['Nenhuma', 'Fade', 'Esquerda', 'Direita', 'Cima', 'Baixo', 'Zoom', 'Pop', 'Girar', 'Bater', 'Desfoque']), r)
    await shot('f4-anim-01-painel.png')
  }

  console.log('entrada: pop, duração e curva')
  {
    const r = await ev(`const p0 = T.past(); await T.click(T.card('pop')); await T.wait(200)
      const cs = getComputedStyle(T.card('pop').querySelector('[data-anim-thumb]'))
      return { p0, past: T.past(), anims: T.anims('${v}'), pressed: T.card('pop').getAttribute('aria-pressed'), none: T.card('none').getAttribute('aria-pressed'), name: cs.animationName, dur: cs.animationDuration, iter: cs.animationIterationCount }`)
    check('Pop: animIn { pop, 0,5 s } em um passo de desfazer; cartão marcado', r.past === r.p0 + 1 && r.anims.in?.preset === 'pop' && r.anims.in?.durationUs === 500000 && r.anims.in?.ease === undefined && r.pressed === 'true' && r.none === 'false', r)
    check('prévia em miniatura: animação CSS do preset em laço no cartão marcado', r.name === 'anim-thumb-in-pop' && r.dur === '2.4s' && r.iter === 'infinite', r)
    const d = await ev(`await T.typeInto(T.section().querySelector('input[aria-label="Duração"]'), '1,2'); await T.wait(150)
      return { anims: T.anims('${v}'), value: T.section().querySelector('input[aria-label="Duração"]').value }`)
    check('duração 1,2 s', d.anims.in?.durationUs === 1200000 && d.value === '1,20', d)
    // curva: abre o seletor (Radix) e escolhe "Linear"
    const c = await ev(`const trig = T.section().querySelector('button[role="combobox"]'); trig.scrollIntoView({ block: 'center' }); await T.wait(100)
      const c0 = T.center(trig)
      trig.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: c0.x, clientY: c0.y, button: 0, pointerType: 'mouse', pointerId: 1 })); await T.wait(300)
      const opts = [...document.querySelectorAll('[role="option"]')]
      const lin = opts.find((o) => o.textContent.trim() === 'Linear')
      if (lin) { lin.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1 })); lin.click() }
      await T.wait(300)
      return { opts: opts.map((o) => o.textContent.trim()), anims: T.anims('${v}'), shown: T.section().querySelector('button[role="combobox"]').textContent.trim() }`)
    check('curva: 6 opções (padrão do preset, linear, suavizar…, overshoot) e "Linear" gravada', c.opts.length === 6 && c.opts[0] === 'Padrão do preset' && c.anims.in?.ease === 'linear' && c.shown === 'Linear', c)
    await ev(`T.grid().scrollIntoView({ block: 'center' }); await T.wait(200); return 1`)
    await shot('f4-anim-02-entrada-pop.png')
    // visualizador: no 1º instante do clipe o pop é invisível (fundo); em repouso o vídeo aparece
    const px = await ev(`await T.seek(0); const start = await T.framePatch(960, 540); await T.seek(3e6); const rest = await T.framePatch(960, 540)
      return { start, rest }`)
    check('visualizador: no 1º instante o vídeo com pop não aparece (fundo preto); depois aparece', Math.max(...px.start) <= 8 && Math.max(...px.rest) > 30, px)
  }

  console.log('saída: desfoque')
  {
    const r = await ev(`${showPanel} await T.sideTab('Saída'); const p0 = T.past(); await T.click(T.card('blur')); await T.wait(200)
      return { p0, past: T.past(), anims: T.anims('${v}'), name: getComputedStyle(T.card('blur').querySelector('[data-anim-thumb]')).animationName, popPressed: T.card('pop').getAttribute('aria-pressed') }`)
    check('Saída → Desfoque: animOut { blur, 0,5 s }; a entrada continua pop; miniatura da saída', r.past === r.p0 + 1 && r.anims.out?.preset === 'blur' && r.anims.out?.durationUs === 500000 && r.anims.in?.preset === 'pop' && r.name === 'anim-thumb-out-blur' && r.popPressed === 'false', r)
    const dur = await ev(`return T.item('${v}').durationUs`)
    // meio da saída (0,25 s antes do fim): 10 px de desfoque, opacidade 1 — energia de detalhe × a do mesmo quadro sem a saída
    const e = await ev(`const t = ${dur} - 250000; await T.seek(t); const blurred = await T.frameDetail(640, 540, 400)
      await T.key('z', { ctrlKey: true }); await T.seek(t); const plain = await T.frameDetail(640, 540, 400); const undone = !T.anims('${v}').out
      await T.key('z', { ctrlKey: true, shiftKey: true }); await T.seek(t); await T.wait(200)
      return { blurred, plain, undone, redone: T.anims('${v}').out?.preset ?? null }`)
    check('visualizador: no meio da saída o quadro está desfocado (energia de detalhe < 40 % da do mesmo quadro sem a saída); Ctrl+Z / Ctrl+Shift+Z', e.blurred < 0.4 * e.plain && e.undone && e.redone === 'blur', e)
    await ev(`${showPanel} await T.sideTab('Saída'); return 1`)
    await shot('f4-anim-03-saida-desfoque.png')
  }

  console.log('combinação')
  {
    const r = await ev(`await T.seek(2e6); ${showPanel} await T.sideTab('Combinação')
      const before = { none: T.card('none').getAttribute('aria-pressed'), anyPressed: [...T.grid().querySelectorAll('[data-anim-card]')].some((c) => c.getAttribute('aria-pressed') === 'true'), note: T.section().textContent.includes('Entrada e saída diferentes') }
      const p0 = T.past(); await T.click(T.card('zoom')); await T.wait(200)
      return { before, p0, past: T.past(), anims: T.anims('${v}'), pressed: T.card('zoom').getAttribute('aria-pressed') }`)
    check('combinação com entrada ≠ saída: nada marcado e a nota', r.before.none === 'false' && !r.before.anyPressed && r.before.note, r.before)
    check('Combinação → Zoom: entrada e saída iguais (zoom, 1,2 s, linear — da entrada) num passo; cartão marcado', r.past === r.p0 + 1 && JSON.stringify(r.anims.in) === JSON.stringify(r.anims.out) && r.anims.in?.preset === 'zoom' && r.anims.in?.durationUs === 1200000 && r.anims.in?.ease === 'linear' && r.pressed === 'true', r)
    await shot('f4-anim-04-combinacao.png')
    const n = await ev(`await T.click(T.card('none')); await T.wait(150); return T.anims('${v}')`)
    check('Combinação → Nenhuma tira as duas', !n.in && !n.out, n)
    // volta ao começo: sem animações no vídeo
    await ev(`await T.undoTo(${past0}); return 1`)
    const z = await ev(`return T.anims('${v}')`)
    check('desfazer volta o vídeo sem animações', !z.in && !z.out, z)
  }

  console.log('privacidade: efeito vinculado sem âncora + animação com movimento')
  {
    const r = await ev(`await T.seek(0.5e6); T.st().select([]); await T.settle(); await T.key('b'); await T.drag(T.toScreen(300, 300), T.toScreen(600, 500)); await T.wait(150)
      const fx = T.st().selection[0]; const linked = !!T.item(fx).linkId && T.item(fx).linkId === T.item('${v}').linkId
      await T.key('Escape'); await T.wait(100)
      ${showPanel} await T.sideTab('Entrada'); await T.click(T.card('rotate')); await T.wait(500)
      const toast = T.toasts().find((t) => t.includes('privacidade'))
      return { fx, linked, toast, hasAnchor: !!document.querySelector('[data-follow-toast="anchor"]'), anims: T.anims('${v}') }`)
    check('Girar num clipe com blur vinculado sem âncora: aviso "não acompanha a animação" com "Ancorar efeito ao clipe"', r.linked && r.anims.in?.preset === 'rotate' && !!r.toast && r.toast.includes('não acompanha a animação') && r.hasAnchor, r)
    await shot('f4-anim-05-aviso-privacidade.png')
    const a = await ev(`await T.click(document.querySelector('[data-follow-toast="anchor"]')); await T.wait(300); return { attach: T.item('${r.fx}').attach?.mediaItemId ?? null }`)
    check('"Ancorar efeito ao clipe": o efeito passa a seguir o clipe (âncora no vídeo)', a.attach === v, a)
    // desfoque não move: sem oferta (desfaz a âncora e o girar; o efeito continua)
    const b = await ev(`await T.key('z', { ctrlKey: true }); await T.key('z', { ctrlKey: true }); await T.wait(200)
      document.querySelectorAll('[data-sonner-toast]').forEach((t) => t.remove())
      ${showPanel} await T.sideTab('Entrada'); await T.click(T.card('blur')); await T.wait(400)
      return { toasts: T.toasts().filter((t) => t.includes('privacidade')).length, anims: T.anims('${v}'), fx: !!T.item('${r.fx}'), attach: T.item('${r.fx}')?.attach ?? null }`)
    check('Desfoque de entrada (não move) não oferece âncora', b.toasts === 0 && b.anims.in?.preset === 'blur' && b.fx && !b.attach, b)
    await ev(`await T.undoTo(${past0}); return 1`)
    const left = await ev(`return { fx: !!T.item('${r.fx}'), anims: T.anims('${v}') }`)
    check('desfazer tira o efeito de teste e as animações', !left.fx && !left.anims.in, left)
  }

  console.log('mesmo painel num item de texto')
  {
    const r = await ev(`T.st().apply((p) => ({ ...p, tracks: [...p.tracks, { id: 't_qa_text', kind: 'video', name: 'Texto', muted: false, hidden: false, locked: false, volume: 1, items: [{ id: 'i_qa_text', type: 'text', startUs: 0, durationUs: 4e6, text: 'Olá', style: { font: 'Manrope', size: { value: 64 }, weight: 700, color: '#ffffff', align: 'center', lineHeight: 1.2 }, visual: { transform: { x: { value: 0.5 }, y: { value: 0.5 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }, crop: { l: { value: 0 }, t: { value: 0 }, r: { value: 0 }, b: { value: 0 } }, fit: 'contain', fadeInUs: 0, fadeOutUs: 0 } }] }] }))
      T.st().select(['i_qa_text']); await T.settle(); await T.wait(300)
      T.grid().scrollIntoView({ block: 'center' }); await T.wait(200)
      await T.click(T.card('bounce')); await T.wait(200)
      return { anims: T.anims('i_qa_text'), pressed: T.card('bounce').getAttribute('aria-pressed'), toasts: T.toasts().filter((t) => t.includes('privacidade')).length }`)
    check('texto: o inspetor mostra o mesmo painel; Bater grava a entrada do texto (sem oferta de âncora)', r.anims.in?.preset === 'bounce' && r.anims.in?.durationUs === 500000 && r.pressed === 'true' && r.toasts === 0, r)
    await shot('f4-anim-06-texto.png')
    await ev(`await T.undoTo(${past0}); T.st().select([]); return 1`)
    const left = await ev(`return { text: !!T.items().find((i) => i.id === 'i_qa_text'), anims: T.anims('${v}') }`)
    check('desfazer devolve o projeto ao estado inicial (sem texto, sem animações no vídeo)', !left.text && !left.anims.in && !left.anims.out, left)
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
