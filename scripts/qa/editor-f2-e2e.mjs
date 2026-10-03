// E2E do editor F2 (efeitos de privacidade) via CDP, com eventos sintéticos despachados no elemento real
// sob o ponto (document.elementFromPoint), nunca entrada do sistema operacional.
//
// Gera um vídeo 1920×1080 com "dados sensíveis" desenhados pelo drawtext do ffmpeg: um CPF que atravessa o
// quadro, um número de conta e uma senha parados. No app: cria um projeto pela tela de Projetos, importa o
// vídeo e o solta na linha do tempo; pela aba Efeitos da biblioteca arrasta "Esconder texto" para o
// visualizador sobre o CPF, acerta o tamanho no inspetor, liga os keyframes (Alt+K) e no último quadro
// arrasta a região até o CPF (2 keyframes acompanhando o texto); solta uma Tarja na linha do tempo e um
// Pixelizar por duplo clique, posicionados pelo inspetor (cor da tarja #e11d48). Confere o aviso de
// privacidade no diálogo de exportação (Pixelizar fraco → "Revisar" seleciona e leva o playhead) e exporta
// "YouTube 1080p" (Esconder texto a 60, o piso). No arquivo exportado, com o ffmpeg: contraste local da linha de texto
// (p99−p1 após caixa 3 px) < 0,15 da fonte e energia de alta frequência (variância do laplaciano) na
// caixa do texto cai para < 0,2 da fonte em vários instantes (inclusive o 1º e o último quadro do item) e a tarja tem
// a cor exata (±3). Depois muda a velocidade do clipe para 0,5× (os efeitos criados sobre ele são vinculados e
// acompanham: início, duração e keyframes escalados) e exporta de novo: o CPF segue ilegível nos 12 s inteiros.
//
// uso (depois de `npm run build`):  node scripts/qa/editor-f2-e2e.mjs
// Tudo em test-out/e2e-f2 (CIALIGHT_RAW_DIR=test-out/e2e-f2/raw → projeto em test-out/e2e-f2/Projetos,
// exportação em test-out/e2e-f2/export). Screenshots em docs/qa/editor-f2/e2e-*.png. settings.json do usuário
// é restaurado se mudar.
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9336'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f2')
const E2E = join(ROOT, 'test-out', 'e2e-f2')
const RAW_REL = 'test-out/e2e-f2/raw'
const MEDIA = join(E2E, 'media')
const OUT = join(E2E, 'export')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const W = 1920
const H = 1080
const FPS = 30
const DUR_S = 6
const LAST_FRAME = DUR_S * FPS - 2 // quadro do 2º keyframe (o item termina em 6 s, fim exclusivo)
const END_FRAME = DUR_S * FPS - 1 // último quadro coberto pelo item
const TARJA = [0xe1, 0x1d, 0x48]
// intensidade do "Esconder texto" na exportação: 60 é o piso que tem de deixar ilegível um texto de 47 px
// (o preset é 80); F2_TEXT_STRENGTH troca o valor para calibrar
const TEXT_STRENGTH = Number(process.env.F2_TEXT_STRENGTH ?? 60)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : null)
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
mkdirSync(SHOTS, { recursive: true })

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

// ---- mídia: fundo liso escuro + três textos brancos (o CPF anda 100 px/s para a direita) ----
const FONT = "fontfile='C\\:/Windows/Fonts/consola.ttf'"
const TEXTS = {
  cpf: { text: 'CPF 123.456.789-00', x: '200+100*t', y: 300, size: 72, band: [240, 440], xr: [0, W] },
  conta: { text: 'Conta 98765-4', x: '1180', y: 700, size: 64, band: [640, 820], xr: [1000, W] },
  senha: { text: 'Senha 4821', x: '220', y: 860, size: 64, band: [820, 1000], xr: [0, 1000] }
}
function makeVideo() {
  rmSync(E2E, { recursive: true, force: true })
  mkdirSync(MEDIA, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  const file = join(MEDIA, 'dados-sensiveis.mp4')
  const dt = Object.values(TEXTS)
    .map((t) => `drawtext=${FONT}:text='${t.text}':fontsize=${t.size}:fontcolor=white:x=${t.x}:y=${t.y}`)
    .join(',')
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1e293b:s=${W}x${H}:r=${FPS}:d=${DUR_S}`, '-vf', dt, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '30', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', file])
  return file
}

// ---- quadros com o ffmpeg ----
/** Quadro n (cinza 8 bits ou rgb24) por número: select exato, sem depender da precisão do -ss. */
function frame(file, n, fmt = 'gray') {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 64 << 20 })
}
/** Caixa dos pixels claros (texto branco) numa faixa do quadro cinza. */
function textBox(gray, band, xr) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = band[0]; y < band[1]; y++) {
    for (let x = xr[0]; x < xr[1]; x++) {
      if (gray[y * W + x] > 128) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, cx: (x0 + x1 + 1) / 2 / W, cy: (y0 + y1 + 1) / 2 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H }
}
/**
 * Contraste local máximo da linha de texto (mais perto da leitura humana que o laplaciano): filtro de caixa
 * 3×3 na luminância e p99 − p1 dentro da caixa (inflada de `pad` px). Letras nítidas: ≈ 200 níveis; borrado
 * ilegível: só resta a "mancha" suave.
 */
function localContrast(gray, b, pad = 4) {
  const xa = Math.max(1, b.x0 - pad), xb = Math.min(W - 2, b.x1 + pad), ya = Math.max(1, b.y0 - pad), yb = Math.min(H - 2, b.y1 + pad)
  const vals = []
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += gray[(y + dy) * W + x + dx]
      vals.push(s / 9)
    }
  }
  vals.sort((p, q) => p - q)
  const at = (q) => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))]
  return at(0.99) - at(0.01)
}
/** Variância do laplaciano (4-vizinhos) dentro da caixa (inflada de `pad` px). */
function lapVar(gray, b, pad = 4) {
  const xa = Math.max(1, b.x0 - pad), xb = Math.min(W - 2, b.x1 + pad), ya = Math.max(1, b.y0 - pad), yb = Math.min(H - 2, b.y1 + pad)
  let n = 0, s = 0, s2 = 0
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const i = y * W + x
      const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W]
      n++
      s += l
      s2 += l * l
    }
  }
  return s2 / n - (s / n) ** 2
}

// ---- CDP ----
let app = null
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
async function ev(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__f2; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 300000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await sleep(400)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}

// helpers da página: tudo despachado no elemento real mais ao topo no ponto (como um clique de verdade)
const HELPERS = `
window.__f2 = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel, root = document) => { const e = root.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const pe = (type, x, y, mods) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...(mods || {}) })
  const me = (type, x, y, extra) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...(extra || {}) })
  /** Clique completo no elemento real sob o centro de e (ponteiro + mouse + click). */
  const clickEl = async (e) => {
    e.scrollIntoView({ block: 'nearest' })
    const c = center(e)
    const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y)); t.dispatchEvent(me('mousedown', c.x, c.y, { buttons: 1 }))
    t.dispatchEvent(pe('pointerup', c.x, c.y)); t.dispatchEvent(me('mouseup', c.x, c.y))
    t.dispatchEvent(me('click', c.x, c.y))
    await settle()
  }
  const dblClickEl = async (e) => { await clickEl(e); const c = center(e); topAt(c.x, c.y).dispatchEvent(me('dblclick', c.x, c.y, { detail: 2 })); await settle() }
  /** Arrastar e soltar (HTML5) de src até o ponto: dragstart no cartão, dragover/drop no elemento sob o ponto. */
  const dragDrop = async (src, to) => {
    const dt = new DataTransfer()
    const c = center(src)
    topAt(c.x, c.y).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: c.x, clientY: c.y, dataTransfer: dt }))
    const target = topAt(to.x, to.y)
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: to.x, clientY: to.y, dataTransfer: dt }))
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: to.x, clientY: to.y, dataTransfer: dt })
    target.dispatchEvent(over)
    const accepted = over.defaultPrevented
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: to.x, clientY: to.y, dataTransfer: dt }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await settle()
    return accepted
  }
  const down = (x, y) => topAt(x, y).dispatchEvent(pe('pointerdown', x, y))
  const move = (x, y) => window.dispatchEvent(pe('pointermove', x, y))
  const up = (x, y) => window.dispatchEvent(pe('pointerup', x, y))
  async function drag(from, to, steps = 10) {
    down(from.x, from.y)
    for (let i = 1; i <= steps; i++) move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await settle()
    up(to.x, to.y); await settle()
  }
  const key = async (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const overlay = () => el('[data-viewer-overlay]')
  const at = (fx, fy) => { const r = overlay().getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy } }
  const xOf = (us) => { const r = el('[data-timeline-ruler]').getBoundingClientRect(); const s = st(); return r.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6 }
  const items = () => st().project.tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.name, kind: t.kind })))
  const effects = () => items().filter((i) => i.type === 'effect')
  const fx = (id) => effects().find((i) => i.id === id)
  const evA = (a, local) => {
    const k = a.keys
    if (!k || !k.length) return a.value
    if (local <= k[0].tUs) return k[0].value
    if (local >= k[k.length - 1].tUs) return k[k.length - 1].value
    let i = 0
    while (i < k.length - 2 && local >= k[i + 1].tUs) i++
    return k[i].value + (k[i + 1].value - k[i].value) * ((local - k[i].tUs) / (k[i + 1].tUs - k[i].tUs))
  }
  const region = (id) => { const f = fx(id); const l = st().playheadUs - f.startUs; const r = f.region; return { x: evA(r.x, l), y: evA(r.y, l), w: evA(r.w, l), h: evA(r.h, l) } }
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(350); await settle() }
  const button = (text, root = document) => { const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const setValue = (input, value, evt = 'input') => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value)); input.dispatchEvent(new Event(evt, { bubbles: true })) }
  /** Campo do inspetor por rótulo: digita e confirma (blur), como o usuário. */
  const setField = async (label, value) => { const input = el('[aria-label="Inspetor"] input[aria-label="' + label + '"]'); setValue(input, value); input.blur(); await settle() }
  const keysOf = (a) => (a.keys || []).map((k) => [k.tUs, Math.round(k.value * 1e5) / 1e5])
  const dialog = () => document.querySelector('[role="dialog"]')
  return { st, settle, wait, el, center, topAt, clickEl, dblClickEl, dragDrop, drag, key, overlay, at, xOf, items, effects, fx, region, seek, button, setValue, setField, keysOf, dialog }
})()
'ok'`

async function main() {
  console.log('gerando o vídeo de teste (drawtext)…')
  const video = makeVideo()
  // caixas dos textos na fonte: CPF no 1º e no último quadro (keyframes), conta e senha (paradas)
  const f0 = frame(video, 0)
  const fL = frame(video, LAST_FRAME)
  const cpf0 = textBox(f0, TEXTS.cpf.band, TEXTS.cpf.xr)
  const cpfL = textBox(fL, TEXTS.cpf.band, TEXTS.cpf.xr)
  const conta = textBox(f0, TEXTS.conta.band, TEXTS.conta.xr)
  const senha = textBox(f0, TEXTS.senha.band, TEXTS.senha.xr)
  console.log(`  CPF: ${JSON.stringify(cpf0)} → ${JSON.stringify(cpfL)}; conta ${JSON.stringify(conta)}; senha ${JSON.stringify(senha)}`)
  check('textos desenhados e o CPF anda (≈ 100 px/s)', cpf0 && cpfL && conta && senha && near(cpfL.x0 - cpf0.x0, (100 * LAST_FRAME) / FPS, 3), { cpf0, cpfL })
  const PADW = 0.03, PADH = 0.05
  const tlUs = Math.round((LAST_FRAME * 1e6) / FPS)

  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    // CIALIGHT_QA (qualquer valor) libera o lock de instância única (o app instalado pode estar aberto) e pula o probe adiado
    env: { ...process.env, CIALIGHT_QA: 'e2e-f2', CIALIGHT_RAW_DIR: RAW_REL },
    stdio: 'ignore'
  })
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await ev(HELPERS + '; return 1')

  console.log('Projetos → Novo projeto')
  await ev(`localStorage.setItem('editor.timelineHeight', '260'); window.__navigate('projects'); return 1`)
  await sleep(800)
  await ev(`await T.clickEl(T.button('Novo projeto')); await T.wait(300); const d = T.dialog(); T.setValue(d.querySelector('input'), 'E2E privacidade'); await T.settle(); await T.clickEl(T.button('Criar e abrir', d)); return 1`)
  for (let i = 0; i < 60; i++) {
    if (await ev(`return !!window.__qaEditor?.store.getState().project`)) break
    await sleep(500)
  }
  await ev(HELPERS + '; return 1')
  const proj = await ev(`const p = T.st().project; return { name: p.name, canvas: p.canvas }`)
  check('projeto novo aberto no editor (1920×1080)', proj.name === 'E2E privacidade' && proj.canvas.width === W && proj.canvas.height === H, proj)

  console.log('importar o vídeo e soltar na linha do tempo')
  const imp = await ev(`const a = await window.__qaEditor.importPaths(${JSON.stringify([video])}); return a.map((x) => ({ id: x.id, kind: x.kind }))`)
  const assetId = imp[0]?.id
  for (let i = 0; i < 90; i++) {
    if (await ev(`return T.st().project.assets.every((a) => a.status === 'ready')`)) break
    await sleep(1000)
  }
  const placed = await ev(`const lanes = T.el('[data-timeline-lanes]').getBoundingClientRect(); const dt = new DataTransfer(); dt.setData('application/x-cialight-asset', '${assetId}')
    const x = T.xOf(0) + 2, y = lanes.top + 10; T.topAt(x, y).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })); await T.settle()
    await T.key('Z', { shiftKey: true }); T.st().select([]); return T.items().filter((i) => i.assetId === '${assetId}').map((i) => [i.track, i.startUs, i.durationUs])`)
  check('vídeo de 6 s na faixa de vídeo em 0', placed.length === 1 && placed[0][1] === 0 && near(placed[0][2], DUR_S * 1e6, 40_000), placed)

  console.log('aba Efeitos da biblioteca')
  const tab = await ev(`await T.clickEl([...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === 'Efeitos')); await T.wait(200); return [...document.querySelectorAll('[data-effect-preset]')].map((c) => c.dataset.effectPreset + ':' + c.textContent.trim())`)
  check('seis predefinições na aba Efeitos', tab.length === 6 && ['Blur', 'Pixelizar', 'Tarja', 'Esconder rosto', 'Esconder texto', 'Borrar tudo menos…'].every((l) => tab.some((t) => t.endsWith(':' + l))), tab)
  await ev(`await T.seek(0); return 1`)
  await shot('e2e-01-biblioteca-efeitos.png')

  console.log('Esconder texto: arrastar para o visualizador sobre o CPF (quadro 0)')
  const hide = await ev(`const p0 = T.st().history.past.length
    const ok = await T.dragDrop(T.el('[data-effect-preset="blurText"]'), T.at(${cpf0.cx}, ${cpf0.cy}))
    const f = T.effects().at(-1); return { ok, dp: T.st().history.past.length - p0, id: f?.id, effect: f?.effect, track: f?.track, start: f?.startUs, dur: f?.durationUs, region: f ? T.region(f.id) : null, sel: T.st().selection }`)
  const hideId = hide.id
  check('drop aceito no visualizador; 1 passo de desfazer; selecionado', hide.ok && hide.dp === 1 && hide.sel[0] === hideId, hide)
  check('blur na faixa "Efeitos" em 0, até o fim do clipe', hide.effect === 'blur' && hide.track === 'Efeitos' && hide.start === 0 && near(hide.dur, DUR_S * 1e6, 40_000), hide)
  check('região centrada no ponto solto (preset 0,4 × 0,08)', hide.region && near(hide.region.x, cpf0.cx, 0.004) && near(hide.region.y, cpf0.cy, 0.004) && near(hide.region.w, 0.4, 1e-6) && near(hide.region.h, 0.08, 1e-6), { region: hide.region, cpf0 })
  check('preset Esconder texto com intensidade 80', (await ev(`return T.fx('${hideId}').strength.value`)) === 80, null)
  const link = await ev(`const f = T.fx('${hideId}'); const clip = T.items().find((i) => i.assetId === '${assetId}' && i.kind === 'video'); await T.wait(100)
    return { fx: f.linkId ?? null, clip: clip.linkId ?? null, icon: !!document.querySelector('[data-item-id="${hideId}"] [aria-label="Vinculado"]') }`)
  check('criado sobre o clipe: efeito vinculado a ele, com o ícone de vínculo na linha do tempo', !!link.fx && link.fx === link.clip && link.icon, link)
  const RW = +((cpf0.w + PADW) * 100).toFixed(1), RH = +((cpf0.h + PADH) * 100).toFixed(1)
  await ev(`await T.setField('Largura', ${RW}); await T.setField('Altura', ${RH}); await T.setField('Intensidade', ${TEXT_STRENGTH}); return 1`)
  check(`intensidade ${TEXT_STRENGTH} (o piso verificado abaixo)`, (await ev(`return T.fx('${hideId}').strength.value`)) === TEXT_STRENGTH, null)
  await shot('e2e-02-esconder-texto.png')

  console.log('keyframes: Alt+K no quadro 0, arrastar a região no último quadro')
  const kf = await ev(`await T.key('k', { altKey: true }); await T.seek(${tlUs}); await T.wait(300)
    const r0 = T.region('${hideId}'); const from = T.at(r0.x, r0.y)
    await T.drag(from, T.at(${cpfL.cx}, ${cpfL.cy}), 12); await T.wait(200)
    const dragged = T.region('${hideId}')
    // acerto fino pelo inspetor (as guias do quadro podem imantar o arraste em alguns px)
    await T.setField('Posição X', ${(cpfL.cx * 100).toFixed(2)}); await T.setField('Posição Y', ${(cpfL.cy * 100).toFixed(2)})
    const f = T.fx('${hideId}'); return { dragged, x: T.keysOf(f.region.x), y: T.keysOf(f.region.y), w: T.keysOf(f.region.w) }`)
  console.log(`  arraste levou a região a ${JSON.stringify(kf.dragged)}; keys x ${JSON.stringify(kf.x)} y ${JSON.stringify(kf.y)}`)
  check('arrastar no último quadro moveu a região até o CPF (±0,01)', near(kf.dragged.x, cpfL.cx, 0.01) && near(kf.dragged.y, cpfL.cy, 0.01), { dragged: kf.dragged, cpfL })
  check('2 keyframes em x acompanhando o texto (0 e último quadro)', kf.x.length === 2 && kf.x[0][0] === 0 && kf.x[1][0] === tlUs && near(kf.x[0][1], cpf0.cx, 0.005) && near(kf.x[1][1], cpfL.cx, 0.002), kf)
  const mid = await ev(`await T.seek(${Math.round(tlUs / 2)}); return T.region('${hideId}')`)
  const midBox = textBox(frame(video, LAST_FRAME / 2), TEXTS.cpf.band, TEXTS.cpf.xr)
  check('no meio a região interpolada está sobre o texto (±0,005)', near(mid.x, midBox.cx, 0.005), { mid, midBox })
  await ev(`await T.seek(${tlUs}); return 1`)
  await shot('e2e-03-keyframe-fim.png')

  console.log('Tarja: soltar na linha do tempo em 0; Pixelizar: duplo clique no cartão')
  const tarja = await ev(`await T.seek(0); T.st().select([]); const lanes = T.el('[data-timeline-lanes]').getBoundingClientRect()
    const fxTrack = T.st().project.tracks.find((t) => t.name === 'Efeitos'); const n0 = T.effects().length
    const ok = await T.dragDrop(T.el('[data-effect-preset="solid"]'), { x: T.xOf(0) + 2, y: lanes.top + 10 })
    const f = T.effects().at(-1); return { ok, n: T.effects().length - n0, id: f.id, effect: f.effect, track: f.track, start: f.startUs, dur: f.durationUs, fxTrack: fxTrack.name, tracks: T.st().project.tracks.map((t) => t.name) }`)
  check('Tarja solta na linha do tempo em 0 (faixa "Efeitos" ocupada → "Efeitos 2")', tarja.ok && tarja.n === 1 && tarja.effect === 'solid' && tarja.start === 0 && tarja.track === 'Efeitos 2' && near(tarja.dur, DUR_S * 1e6, 40_000), tarja)
  const solidOk = await ev(`await T.setField('Posição X', ${(conta.cx * 100).toFixed(2)}); await T.setField('Posição Y', ${(conta.cy * 100).toFixed(2)}); await T.setField('Largura', ${((conta.w + PADW) * 100).toFixed(1)}); await T.setField('Altura', ${((conta.h + PADH) * 100).toFixed(1)})
    const c = T.el('[aria-label="Inspetor"] input[aria-label="Cor da tarja"]'); T.setValue(c, '#e11d48'); c.blur(); await T.settle()
    const f = T.fx('${tarja.id}'); return { color: f.color, feather: f.feather, region: T.region(f.id) }`)
  check('tarja #e11d48 sem borda suave sobre a conta', solidOk.color === '#e11d48' && solidOk.feather === 0 && near(solidOk.region.x, conta.cx, 0.001), solidOk)

  const pix = await ev(`T.st().select([]); const n0 = T.effects().length; await T.dblClickEl(T.el('[data-effect-preset="pixelate"]'))
    const f = T.effects().at(-1); return { n: T.effects().length - n0, id: f.id, effect: f.effect, start: f.startUs, region: T.region(f.id), sel: T.st().selection }`)
  check('duplo clique em Pixelizar adiciona no playhead com a região no centro, selecionado', pix.n === 1 && pix.effect === 'pixelate' && pix.start === 0 && near(pix.region.x, 0.5, 1e-9) && near(pix.region.y, 0.5, 1e-9) && pix.sel[0] === pix.id, pix)
  await ev(`await T.setField('Posição X', ${(senha.cx * 100).toFixed(2)}); await T.setField('Posição Y', ${(senha.cy * 100).toFixed(2)}); await T.setField('Largura', ${((senha.w + PADW) * 100).toFixed(1)}); await T.setField('Altura', ${((senha.h + PADH) * 100).toFixed(1)}); return 1`)
  await ev(`await T.seek(3000000); T.st().select([]); return 1`)
  await shot('e2e-04-tres-efeitos.png')

  console.log('aviso de privacidade: Pixelizar fraco → Revisar')
  const warn = await ev(`T.st().select(['${pix.id}']); await T.settle(); await T.setField('Intensidade', 20); T.st().select([]); await T.seek(4000000)
    await T.clickEl([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(500)
    const sec = T.dialog()?.querySelector('[data-privacy-warnings]'); return { text: sec?.textContent ?? null }`)
  check('diálogo lista o aviso (Pixelizar fraco) sem bloquear o Exportar', !!warn.text && warn.text.includes('Pixelado fraco') && warn.text.includes('Pixelizar em 00:00') && (await ev(`return !T.button('Exportar', T.dialog()).disabled`)), warn)
  await shot('e2e-05-aviso-privacidade.png')
  const rev = await ev(`await T.clickEl(T.button('Revisar', T.dialog())); await T.wait(400); return { open: !!T.dialog(), sel: T.st().selection, ph: T.st().playheadUs }`)
  check('Revisar fecha o diálogo, seleciona o efeito e leva o playhead ao começo dele', !rev.open && rev.sel.length === 1 && rev.sel[0] === pix.id && rev.ph === 0, rev)
  await shot('e2e-06-revisar.png')
  await ev(`await T.setField('Intensidade', 50); T.st().select([]); return 1`)

  console.log('exportar YouTube 1080p')
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; await T.clickEl([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(500)
    await T.clickEl([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith('YouTube 1080p'))); return 1`)
  const dlg = await ev(`return { text: T.dialog()?.textContent ?? '', privacy: !!T.dialog()?.querySelector('[data-privacy-warnings]') }`)
  check('YouTube 1080p (1920×1080) e sem avisos com intensidades seguras', dlg.text.includes('1920×1080') && !dlg.privacy, dlg.text.slice(0, 200))
  await shot('e2e-07-exportar.png')
  await ev(`await T.clickEl(T.button('Exportar', T.dialog())); return 1`)
  let text = ''
  const t0 = Date.now()
  for (let i = 0; i < 1500; i++) {
    text = await ev(`return T.dialog()?.textContent ?? ''`)
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(200)
  }
  console.log(`  exportação: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  check('exportação concluída', text.includes('Vídeo exportado'), text.slice(0, 300))
  await shot('e2e-08-exportado.png')

  console.log('conferência do arquivo com o ffmpeg')
  const files = readdirSync(OUT)
  check('um .mp4 na pasta, sem .part', files.length === 1 && files[0].endsWith('.mp4'), files)
  if (files.length !== 1) return
  const out = join(OUT, files[0])
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out], { encoding: 'utf8' }))
  const vs = probe.streams.find((s) => s.codec_type === 'video')
  console.log(`  ${files[0]}: ${(statSync(out).size / 1e6).toFixed(2)} MB, ${Number(probe.format.duration).toFixed(3)} s, ${vs?.codec_name} ${vs?.width}×${vs?.height} ${vs?.color_space}`)
  check('H.264 1920×1080, ≈ 6 s', vs?.codec_name === 'h264' && vs.width === W && vs.height === H && near(Number(probe.format.duration), DUR_S, 0.15), vs)

  // CPF: caixa do texto na fonte em vários quadros; variância do laplaciano na saída / na fonte
  const ratios = []
  for (const n of [0, 5, 40, 75, 90, 120, 160, LAST_FRAME, END_FRAME]) {
    const src = frame(video, n)
    const dst = frame(out, n)
    const box = textBox(src, TEXTS.cpf.band, TEXTS.cpf.xr)
    const vs0 = lapVar(src, box)
    const vd = lapVar(dst, box)
    const c0 = localContrast(src, box)
    const c1 = localContrast(dst, box)
    ratios.push({ n, src: Math.round(vs0), out: Math.round(vd), ratio: +(vd / vs0).toFixed(4), cSrc: +c0.toFixed(1), cOut: +c1.toFixed(1), cRatio: +(c1 / c0).toFixed(3) })
  }
  console.log(`  CPF a ${TEXT_STRENGTH} (laplaciano e contraste local): ${JSON.stringify(ratios)}`)
  check('texto do CPF sem detalhe em 9 instantes, do 1º ao último quadro do item (variância do laplaciano saída/fonte < 0,2; fonte com texto nítido)', ratios.every((r) => r.ratio < 0.2 && r.src > 1000), ratios.map((r) => r.ratio))
  check('texto do CPF ilegível em 9 instantes, do 1º ao último quadro do item (contraste local p99−p1 após caixa 3 px: saída < 0,15 × fonte)', ratios.every((r) => r.cRatio < 0.15 && r.cSrc > 150), ratios.map((r) => [r.cSrc, r.cOut, r.cRatio]))
  const pixR = (() => {
    const src = frame(video, 90)
    const dst = frame(out, 90)
    return +(lapVar(dst, senha) / lapVar(src, senha)).toFixed(4)
  })()
  console.log(`  senha pixelizada (laplaciano saída/fonte): ${pixR}; contraste local saída/fonte ${(localContrast(frame(out, 90), senha) / localContrast(frame(video, 90), senha)).toFixed(3)} (só informativo: os blocos têm bordas duras)`)
  check('senha pixelizada (variância do laplaciano saída/fonte < 0,2)', pixR < 0.2, pixR)
  // fora dos efeitos o quadro segue nítido (o teste não passa por borrar tudo)
  const ctrl = (() => {
    const src = frame(video, 90)
    const dst = frame(out, 90)
    const b = { x0: 100, y0: 520, x1: 1800, y1: 600 } // faixa lisa sem texto nem efeito
    let d = 0
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) d = Math.max(d, Math.abs(src[y * W + x] - dst[y * W + x]))
    return d
  })()
  check('fundo fora dos efeitos inalterado (dif. máx. ≤ 6 no cinza)', ctrl <= 6, ctrl)

  // tarja: centro de cada macrobloco 16×16 inteiro dentro da região, cor exata ±3
  const reg = { x: conta.cx, y: conta.cy, w: conta.w + PADW, h: conta.h + PADH }
  for (const n of [10, 100, 170]) {
    const rgb = frame(out, n, 'rgb24')
    let blocks = 0, worst = 0, worstPx = []
    for (let by = Math.ceil(((reg.y - reg.h / 2) * H) / 16); (by + 1) * 16 <= (reg.y + reg.h / 2) * H; by++) {
      for (let bx = Math.ceil(((reg.x - reg.w / 2) * W) / 16); (bx + 1) * 16 <= (reg.x + reg.w / 2) * W; bx++) {
        const i = ((by * 16 + 8) * W + bx * 16 + 8) * 3
        const px = [rgb[i], rgb[i + 1], rgb[i + 2]]
        const d = Math.max(...px.map((v, c) => Math.abs(v - TARJA[c])))
        blocks++
        if (d >= worst) { worst = d; worstPx = px }
      }
    }
    check(`tarja com a cor exata no quadro ${n} (${blocks} blocos, pior desvio ${worst} em ${worstPx}; esperado ${TARJA} ± 3)`, blocks >= 20 && worst <= 3, { blocks, worst, worstPx })
  }
  // quadro da saída para inspeção visual
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-vf', 'select=eq(n\\,90),scale=960:-2', '-frames:v', '1', '-update', '1', join(SHOTS, 'e2e-09-quadro-exportado.png')])
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', 'select=eq(n\\,90),scale=960:-2', '-frames:v', '1', '-update', '1', join(SHOTS, 'e2e-09-quadro-fonte.png')])
  console.log('  📷 e2e-09-quadro-fonte.png / e2e-09-quadro-exportado.png')

  // ---- velocidade 0,5 no clipe: os efeitos vinculados acompanham (revisão final F2, I3) ----
  console.log('velocidade 0,5× no clipe (Inspetor → Velocidade)')
  const sp = await ev(`if (T.dialog()) { await T.clickEl(T.button('Fechar', T.dialog())); await T.wait(300) }
    T.st().select([]); await T.seek(0); const v = T.items().find((i) => i.assetId === '${assetId}' && i.kind === 'video'); T.st().select([v.id]); await T.settle(); await T.wait(200)
    const insp = T.el('[aria-label="Inspetor"]'); await T.clickEl([...insp.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === 'Velocidade')); await T.wait(200)
    await T.clickEl(T.button('0,5×', insp)); await T.wait(300)
    const c = T.items().find((i) => i.id === v.id); T.st().select([]); await T.settle()
    return { clip: { start: c.startUs, end: c.startUs + c.durationUs, speed: c.speed, link: c.linkId }, fxs: T.effects().map((f) => ({ id: f.id, effect: f.effect, start: f.startUs, end: f.startUs + f.durationUs, link: f.linkId, keys: (f.region.x.keys || []).map((k) => k.tUs) })) }`)
  console.log(`  ${JSON.stringify(sp)}`)
  check('clipe a 0,5×: 12 s', sp.clip.speed === 0.5 && sp.clip.start === 0 && near(sp.clip.end, 2 * DUR_S * 1e6, 80_000), sp.clip)
  check('os 3 efeitos (vinculados ao clipe) cobrem o clipe inteiro: 0 → fim do clipe', sp.fxs.length === 3 && sp.fxs.every((f) => f.link === sp.clip.link && f.start === 0 && f.end === sp.clip.end), sp.fxs)
  const hideSp = sp.fxs.find((f) => f.id === hideId)
  check('keyframes do Esconder texto escalados (0 e 2 × o último quadro)', !!hideSp && hideSp.keys.length === 2 && hideSp.keys[0] === 0 && near(hideSp.keys[1], 2 * tlUs, 2), hideSp)
  await ev(`await T.seek(${Math.round(1.5 * DUR_S * 1e6)}); return 1`)
  await shot('e2e-10-velocidade-meia.png')
  const OUT2 = join(E2E, 'export-velocidade')
  mkdirSync(OUT2, { recursive: true })
  const out2 = await exportHigh(OUT2)
  if (!out2) return
  const p2 = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_format', '-of', 'json', out2], { encoding: 'utf8' }))
  check('exportação a 0,5×: ≈ 12 s', near(Number(p2.format.duration), 2 * DUR_S, 0.2), p2.format.duration)
  // quadro n da saída mostra o quadro ⌊n/2⌋ da fonte (a caixa + 4 px cobre o meio quadro de diferença: 1,7 px)
  const slow = []
  for (const n of [0, 60, 150, 200, 260, 300, 340, 2 * DUR_S * FPS - 1]) {
    const src = frame(video, Math.floor(n / 2))
    const dst = frame(out2, n)
    const box = textBox(src, TEXTS.cpf.band, TEXTS.cpf.xr)
    slow.push({ n, ratio: +(lapVar(dst, box) / lapVar(src, box)).toFixed(4), cRatio: +(localContrast(dst, box) / localContrast(src, box)).toFixed(3) })
  }
  console.log(`  CPF a 0,5×: ${JSON.stringify(slow)}`)
  check('a 0,5× o CPF segue ilegível nos 12 s, inclusive na 2ª metade e no último quadro (contraste < 0,15; laplaciano < 0,2)', slow.every((r) => r.cRatio < 0.15 && r.ratio < 0.2), slow)
  const rgb2 = frame(out2, 300, 'rgb24')
  const ci = ((Math.round(conta.cy * H)) * W + Math.round(conta.cx * W)) * 3
  const tarja2 = [rgb2[ci], rgb2[ci + 1], rgb2[ci + 2]]
  check(`a 0,5× a tarja segue na 2ª metade (quadro 300: ${tarja2}; esperado ${TARJA} ± 3)`, tarja2.every((v, c) => Math.abs(v - TARJA[c]) <= 3), tarja2)
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out2, '-vf', 'select=eq(n\\,300),scale=960:-2', '-frames:v', '1', '-update', '1', join(SHOTS, 'e2e-11-quadro-exportado-meia.png')])
  console.log('  📷 e2e-11-quadro-exportado-meia.png')
  writeFileSync(join(E2E, 'e2e-f2-result.json'), JSON.stringify({ file: files[0], ratios, pixR, ctrl, cpf0, cpfL, conta, senha, textStrength: TEXT_STRENGTH, speed: { sp, slow, tarja2 } }, null, 2))
}

/** Exporta "YouTube 1080p" pelo diálogo para `dir` (vazia); devolve o .mp4 ou null (com o check de falha). */
async function exportHigh(dir) {
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(dir)}; await T.clickEl([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(500)
    await T.clickEl([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith('YouTube 1080p'))); return 1`)
  const privacy = await ev(`return T.dialog()?.querySelector('[data-privacy-warnings]')?.textContent ?? null`)
  check('nova exportação sem avisos de privacidade', privacy === null, privacy)
  await ev(`await T.clickEl(T.button('Exportar', T.dialog())); return 1`)
  let text = ''
  for (let i = 0; i < 1500; i++) {
    text = await ev(`return T.dialog()?.textContent ?? ''`)
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(200)
  }
  check('exportação concluída', text.includes('Vídeo exportado'), text.slice(0, 300))
  await ev(`if (T.dialog()) { await T.clickEl(T.button('Fechar', T.dialog())); await T.wait(300) } return 1`)
  const files = readdirSync(dir).filter((x) => x.endsWith('.mp4'))
  check('um .mp4 na pasta', files.length === 1, readdirSync(dir))
  return files.length === 1 ? join(dir, files[0]) : null
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    await shot('e2e-erro.png')
  } catch {
    // sem janela
  }
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
  if (settingsBefore) {
    await sleep(500)
    const now = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
    if (!now || !now.equals(settingsBefore)) {
      writeFileSync(SETTINGS, settingsBefore)
      console.log('settings.json restaurado')
    } else console.log('settings.json intocado')
    console.log(`settings.json sha256 ${sha(readFileSync(SETTINGS)) === sha(settingsBefore) ? 'igual ao de antes' : 'DIFERENTE'}`)
  }
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
