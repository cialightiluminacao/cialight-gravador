// E2E do editor F4 (keyframes e movimento) via CDP, com eventos sintéticos despachados no elemento real sob o ponto
// (document.elementFromPoint), nunca entrada do sistema operacional.
//
// Gera um vídeo 1920×1080 de 8 s (mídia sintética): fundo liso escuro, um "CPF 123.456" branco parado em (1180, 400)
// e um quadrado verde (marcador do foco) de 100 px centrado em (1400, 540), logo abaixo do texto (no 9:16 o foco fica
// no centro fora do zoom; durante o zoom, o alvo do zoom fica no centro e o texto continua no quadro). No app: cria um projeto pela tela de
// Projetos, importa o vídeo e o solta na linha do tempo; desenha (B) um blur sobre o CPF (vinculado ao clipe,
// intensidade 80); com a ferramenta Zoom (Z: ida 0,5 s, volta depois de 1 s) arrasta o enquadramento 2× em volta do
// texto aos 2 s → o aviso de privacidade oferece "Ancorar efeito ao clipe", que ancora o blur; no inspetor do vídeo
// põe Pop na entrada e Desfoque na saída; no editor de curvas (botão direito no losango da escala aos 2 s) arrasta uma
// alça → curva personalizada (bezier); exporta "YouTube 1080p". Depois "Reenquadrar" → 9:16, ponto de foco no marcador,
// "Criar cópia" (padrão) e exporta a cópia em "Instagram Reels/Stories (9:16)". Com o ffmpeg: dimensões e durações das duas
// exportações; o marcador no centro do 9:16 fora do zoom e, no meio do zoom, onde o alvo do zoom no centro o leva; e o texto sob o blur ilegível durante todo o
// zoom (ida com a curva personalizada, parado, volta) nas DUAS exportações — métrica de legibilidade do F2 (contraste
// local p99−p1 após caixa 3 px < 0,15 × o da fonte; variância do laplaciano < 0,2 × a da fonte), na caixa do texto
// levada à tela pela região do efeito ancorado no instante (o contorno do visualizador, effectRegionAt).
//
// uso (depois de `npm run build`):  node scripts/qa/editor-f4-e2e.mjs
// Tudo em test-out/e2e-f4 (CIALIGHT_RAW_DIR=test-out/e2e-f4/raw → projetos em test-out/e2e-f4/Projetos, exportações
// em test-out/e2e-f4/export-*). Screenshots em docs/qa/editor-f4/e2e-*.png. settings.json do usuário é restaurado se mudar.
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9337'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f4')
const E2E = join(ROOT, 'test-out', 'e2e-f4')
const RAW_REL = 'test-out/e2e-f4/raw'
const MEDIA = join(E2E, 'media')
const OUT_H = join(E2E, 'export-horizontal')
const OUT_V = join(E2E, 'export-vertical')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const W = 1920
const H = 1080
const FPS = 30
const DUR_S = 8
const S = 1_000_000
const frameUs = (n) => Math.round((n * S) / FPS)
// texto e marcador na fonte
const TEXT = { text: 'CPF 123.456', x: 1180, y: 400, size: 64, band: [360, 480] } // a faixa termina antes do marcador (y ≥ 490)
const MARK = { x: 1350, y: 490, w: 100, h: 100 } // centro (1400, 540)
// zoom: retângulo de 960 px (2×) com centro (1380, 430), aos 2 s; ida 0,5 s, parado 1 s, volta 0,5 s → 2 s a 4 s
const ZOOM_AT = 2 * S
const ZOOM_RECT = [[900, 160], [1860, 700]]
// quadros medidos: antes, toda a ida (curva personalizada), parado, toda a volta, depois
const ZOOM_FRAMES = [60, 62, 64, 66, 68, 70, 72, 74, 75, 80, 90, 100, 105, 106, 108, 110, 112, 114, 116, 118, 119]
const OTHER_FRAMES = [30, 150]
const STRENGTH = 80

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

// ---- mídia sintética ----
const FONT = "fontfile='C\\:/Windows/Fonts/consola.ttf'"
function makeVideo() {
  rmSync(E2E, { recursive: true, force: true })
  for (const d of [MEDIA, OUT_H, OUT_V]) mkdirSync(d, { recursive: true })
  const file = join(MEDIA, 'cpf-e-marcador.mp4')
  const vf = `drawtext=${FONT}:text='${TEXT.text}':fontsize=${TEXT.size}:fontcolor=white:x=${TEXT.x}:y=${TEXT.y},drawbox=x=${MARK.x}:y=${MARK.y}:w=${MARK.w}:h=${MARK.h}:color=0x22c55e:t=fill`
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1e293b:s=${W}x${H}:r=${FPS}:d=${DUR_S}`, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '30', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', file])
  return file
}

// ---- quadros e métricas (ffmpeg; as contas do F2, com largura/altura do arquivo) ----
function frame(file, n, fmt = 'gray') {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 64 << 20 })
}
/** Caixa dos pixels claros (texto branco) numa faixa do quadro cinza w×h. */
function textBox(gray, w, band) {
  let x0 = w, y0 = 1e9, x1 = -1, y1 = -1
  for (let y = band[0]; y < band[1]; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > 128) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}
function boxValues(gray, w, h, b, pad) {
  const xa = Math.max(1, b.x0 - pad), xb = Math.min(w - 2, b.x1 + pad), ya = Math.max(1, b.y0 - pad), yb = Math.min(h - 2, b.y1 + pad)
  return { xa, xb, ya, yb }
}
/** Contraste local (F2): caixa 3×3 na luminância e p99 − p1 dentro da caixa + pad. */
function localContrast(gray, w, h, b, pad = 4) {
  const { xa, xb, ya, yb } = boxValues(gray, w, h, b, pad)
  const vals = []
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += gray[(y + dy) * w + x + dx]
      vals.push(s / 9)
    }
  }
  vals.sort((p, q) => p - q)
  const at = (q) => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))]
  return at(0.99) - at(0.01)
}
/** Variância do laplaciano (4-vizinhos) dentro da caixa + pad. */
function lapVar(gray, w, h, b, pad = 4) {
  const { xa, xb, ya, yb } = boxValues(gray, w, h, b, pad)
  let n = 0, s = 0, s2 = 0
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const i = y * w + x
      const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      n++
      s += l
      s2 += l * l
    }
  }
  return s2 / n - (s / n) ** 2
}
function meanIn(gray, w, b) {
  let s = 0, n = 0
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { s += gray[y * w + x]; n++ }
  return s / n
}
/** Centro e caixa dos pixels verdes (o marcador 0x22c55e) num quadro rgb24 w×h. */
function greenBlob(rgb, w, h) {
  let sx = 0, sy = 0, n = 0, x0 = w, x1 = -1, y0 = h, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
      if (g > 120 && g - r > 60 && g - b > 40) { sx += x + 0.5; sy += y + 0.5; n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    }
  }
  return n ? { cx: sx / n, cy: sy / n, n, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null
}
function probe(file) {
  const p = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
  const vs = p.streams.find((s) => s.codec_type === 'video')
  return { codec: vs?.codec_name, width: vs?.width, height: vs?.height, duration: Number(p.format.duration) }
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__f4; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 300000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await sleep(300)
  // a captura pode não voltar com a janela sem pintar (coberta/minimizada pelo uso da máquina): não trava o E2E
  const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(20000).then(() => null)])
  if (!r?.result?.data) return console.log(`  (sem captura: ${name})`)
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}

// helpers da página: eventos no elemento real mais ao topo sob o ponto (como um clique de verdade), leitura do store
const HELPERS = `
window.__f4 = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel, root = document) => { const e = root.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel, root = document) => [...root.querySelectorAll(sel)]
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const pe = (type, x, y, mods) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...(mods || {}) })
  const me = (type, x, y, mods) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: type === 'contextmenu' ? 2 : 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1, ...(mods || {}) })
  const clickAt = async (x, y, mods) => {
    const t = topAt(x, y)
    t.dispatchEvent(pe('pointerdown', x, y, mods)); t.dispatchEvent(me('mousedown', x, y, mods))
    window.dispatchEvent(pe('pointerup', x, y, mods)); t.dispatchEvent(me('mouseup', x, y, mods)); t.dispatchEvent(me('click', x, y, mods))
    await settle()
    return t
  }
  const click = async (e, mods) => { e.scrollIntoView({ block: 'nearest' }); const c = center(e); return clickAt(c.x, c.y, mods) }
  const rightClick = async (e) => { const c = center(e); const t = topAt(c.x, c.y); t.dispatchEvent(me('contextmenu', c.x, c.y)); await settle(); await wait(250); return t }
  async function drag(from, to, opts = {}) {
    const steps = opts.steps ?? 10
    const t = topAt(from.x, from.y)
    t.dispatchEvent(pe('pointerdown', from.x, from.y))
    for (let i = 1; i <= steps; i++) window.dispatchEvent(pe('pointermove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps))
    await settle()
    window.dispatchEvent(pe('pointerup', to.x, to.y)); await settle()
    return t
  }
  const key = async (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items)
  const item = (id) => items().find((i) => i.id === id)
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(350); await settle() }
  const toScreen = (x, y) => { const r = el('[data-viewer-overlay]').getBoundingClientRect(); const k = r.width / st().project.canvas.width; return { x: r.left + x * k, y: r.top + y * k } }
  const xOf = (us) => { const r = el('[data-timeline-ruler]').getBoundingClientRect(); const s = st(); return r.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6 }
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const setValue = (input, value) => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })) }
  const typeInto = async (input, text) => { setValue(input, text); await settle(); input.blur(); await settle() }
  const setField = async (label, value) => typeInto(el('[aria-label="Inspetor"] input[aria-label="' + label + '"]'), value)
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  const dialog = () => document.querySelector('[role="dialog"]')
  /** Contorno da região do efeito no visualizador (effectRegionAt), em px do canvas do projeto. */
  const outline = (id) => {
    const e = document.querySelector('[data-region-outline="' + id + '"], [data-region-handles="' + id + '"]')
    if (!e) return null
    const r = e.getBoundingClientRect(); const o = el('[data-viewer-overlay]').getBoundingClientRect(); const k = o.width / st().project.canvas.width
    return { x0: (r.left - o.left) / k, y0: (r.top - o.top) / k, x1: (r.right - o.left) / k, y1: (r.bottom - o.top) / k }
  }
  const grid = () => el('[data-anim-grid]')
  const section = () => grid().closest('section')
  const card = (preset) => section().querySelector('[data-anim-card="' + preset + '"]')
  const sideTab = async (label) => { const b = all('button, [role="radio"]', section()).find((x) => x.textContent.trim() === label); await click(b); await wait(150) }
  return { st, settle, wait, el, all, center, topAt, clickAt, click, rightClick, drag, key, items, item, past, seek, toScreen, xOf, button, setValue, typeInto, setField, toasts, dialog, outline, grid, section, card, sideTab }
})()
'ok'`

async function waitEditor() {
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]')`)
    if (ok) break
    await sleep(500)
  }
  await ev(HELPERS + '; return 1')
}

/** Contornos da região do efeito nos quadros medidos (no projeto aberto). */
async function outlines(fx, frames) {
  return ev(`T.st().select([]); await T.settle(); const out = {}
    for (const n of ${JSON.stringify(frames)}) { await T.seek(Math.round(n * 1e6 / ${FPS})); await T.wait(80); out[n] = T.outline('${fx}') }
    return out`)
}

/** Exporta pelo diálogo com o preset `label` para `dir` (vazia); devolve o .mp4 ou null. */
async function exportWith(label, dir, shotName) {
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(dir)}; await T.click([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(500)
    await T.click([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))); return 1`)
  const dlg = await ev(`const d = T.dialog(); return { text: d?.textContent ?? '', privacy: d?.querySelector('[data-privacy-warnings]')?.textContent ?? null }`)
  console.log(`  diálogo: ${dlg.text.slice(0, 160)}… avisos: ${dlg.privacy}`)
  await shot(shotName)
  await ev(`await T.click(T.button('Exportar', T.dialog())); return 1`)
  let text = ''
  const t0 = Date.now()
  for (let i = 0; i < 1500; i++) {
    text = await ev(`return T.dialog()?.textContent ?? ''`)
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(200)
  }
  console.log(`  exportação "${label}": ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  check(`exportação "${label}" concluída`, text.includes('Vídeo exportado'), text.slice(0, 300))
  await ev(`if (T.dialog()) { await T.click(T.button('Fechar', T.dialog())); await T.wait(300) } return 1`)
  const files = readdirSync(dir).filter((x) => x.endsWith('.mp4'))
  check(`um .mp4 em ${dir.split(/[\\/]/).pop()}, sem .part`, files.length === 1 && readdirSync(dir).length === 1, readdirSync(dir))
  return files.length === 1 ? join(dir, files[0]) : null
}

/**
 * Legibilidade do CPF em cada quadro medido: a caixa do texto na fonte (quadro cinza) vai à tela pelo mapa linear
 * entre a região do efeito na fonte (`rSrc`, sem zoom) e o contorno da região no instante (`outl[n]`, ancorada:
 * acompanha o conteúdo), presa ao quadro de saída.
 */
function legibility(video, out, w, h, rSrc, outl, frames) {
  const rows = []
  for (const n of frames) {
    const src = frame(video, n)
    const dst = frame(out, n)
    const tb = textBox(src, W, TEXT.band)
    const ro = outl[n]
    if (!tb || !ro) { rows.push({ n, error: 'sem caixa', tb, ro }); continue }
    const kx = (ro.x1 - ro.x0) / (rSrc.x1 - rSrc.x0), ky = (ro.y1 - ro.y0) / (rSrc.y1 - rSrc.y0)
    const mapped = { x0: Math.round(ro.x0 + (tb.x0 - rSrc.x0) * kx), y0: Math.round(ro.y0 + (tb.y0 - rSrc.y0) * ky), x1: Math.round(ro.x0 + (tb.x1 - rSrc.x0) * kx), y1: Math.round(ro.y0 + (tb.y1 - rSrc.y0) * ky) }
    const box = { x0: Math.max(6, mapped.x0), y0: Math.max(6, mapped.y0), x1: Math.min(w - 7, mapped.x1), y1: Math.min(h - 7, mapped.y1) }
    if (box.x1 - box.x0 < 20 || box.y1 - box.y0 < 10) { rows.push({ n, error: 'texto fora do quadro', mapped }); continue }
    const c0 = localContrast(src, W, H, tb), c1 = localContrast(dst, w, h, box)
    const l0 = lapVar(src, W, H, tb), l1 = lapVar(dst, w, h, box)
    // a caixa levada à tela está sobre o texto borrado (mancha mais clara que o fundo ao redor do quadro)
    const bg = meanIn(dst, w, { x0: 2, y0: 2, x1: 40, y1: 40 })
    rows.push({ n, scale: +kx.toFixed(3), box, cSrc: +c0.toFixed(1), cOut: +c1.toFixed(1), c: +(c1 / c0).toFixed(3), lap: +(l1 / l0).toFixed(4), lift: +(meanIn(dst, w, box) - bg).toFixed(1) })
  }
  return rows
}

async function main() {
  console.log('gerando o vídeo de teste (drawtext + marcador)…')
  const video = makeVideo()
  const tb0 = textBox(frame(video, 0), W, TEXT.band)
  const mk0 = greenBlob(frame(video, 0, 'rgb24'), W, H)
  console.log(`  CPF ${JSON.stringify(tb0)}; marcador ${JSON.stringify(mk0)}`)
  check('fonte: CPF desenhado e marcador verde centrado em (1400, 540)', !!tb0 && !!mk0 && near(mk0.cx, 1400, 1) && near(mk0.cy, 540, 1), { tb0, mk0 })

  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    // CIALIGHT_QA (qualquer valor) libera o lock de instância única (o app instalado pode estar aberto) e pula o probe adiado
    env: { ...process.env, CIALIGHT_QA: 'e2e-f4', CIALIGHT_RAW_DIR: RAW_REL },
    stdio: 'ignore'
  })
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await ev(HELPERS + '; return 1')

  console.log('Projetos → Novo projeto, importar e soltar o vídeo')
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`localStorage.setItem('editor.timelineHeight', '300'); window.__navigate('projects'); return 1`)
  await sleep(800)
  await ev(`await T.click(T.button('Novo projeto')); await T.wait(300); const d = T.dialog(); T.setValue(d.querySelector('input'), 'E2E movimento'); await T.settle(); await T.click(T.button('Criar e abrir', d)); return 1`)
  for (let i = 0; i < 60; i++) {
    if (await ev(`return !!window.__qaEditor?.store.getState().project`)) break
    await sleep(500)
  }
  await ev(HELPERS + '; return 1')
  const srcProject = await ev(`const p = T.st().project; return { id: p.id, name: p.name, w: p.canvas.width, h: p.canvas.height }`)
  check('projeto novo "E2E movimento" aberto em 1920×1080', srcProject.name === 'E2E movimento' && srcProject.w === W && srcProject.h === H, srcProject)
  const imp = await ev(`const a = await window.__qaEditor.importPaths(${JSON.stringify([video])}); return a.map((x) => x.id)`)
  const assetId = imp[0]
  for (let i = 0; i < 90; i++) {
    if (await ev(`return T.st().project.assets.every((a) => a.status === 'ready')`)) break
    await sleep(1000)
  }
  const placed = await ev(`const lanes = T.el('[data-timeline-lanes]').getBoundingClientRect(); const dt = new DataTransfer(); dt.setData('application/x-cialight-asset', '${assetId}')
    const x = T.xOf(0) + 2, y = lanes.top + 10; T.topAt(x, y).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })); await T.settle()
    await T.key('Z', { shiftKey: true }); T.st().select([]); return T.items().filter((i) => i.assetId === '${assetId}' && i.visual).map((i) => ({ id: i.id, start: i.startUs, dur: i.durationUs }))`)
  check('vídeo de 8 s na linha do tempo em 0', placed.length === 1 && placed[0].start === 0 && near(placed[0].dur, DUR_S * S, 40_000), placed)
  const v = placed[0]?.id

  console.log('blur desenhado (B) sobre o CPF: vinculado ao clipe')
  const R = { x0: tb0.x0 - 40, y0: tb0.y0 - 30, x1: tb0.x1 + 40, y1: tb0.y1 + 30 }
  const fxr = await ev(`await T.seek(0); await T.key('b'); await T.drag(T.toScreen(${R.x0}, ${R.y0}), T.toScreen(${R.x1}, ${R.y1})); await T.wait(150)
    const fx = T.st().selection[0]; await T.key('b')
    await T.setField('Intensidade', ${STRENGTH})
    const f = T.item(fx); return { fx, effect: f?.effect, start: f?.startUs, dur: f?.durationUs, linked: !!f?.linkId && f.linkId === T.item('${v}').linkId, strength: f?.strength.value }`)
  const fx = fxr.fx
  check(`blur sobre o CPF no clipe inteiro (0 → 8 s), vinculado ao vídeo, intensidade ${STRENGTH}`, fxr.effect === 'blur' && fxr.start === 0 && near(fxr.dur, placed[0].dur, 1) && fxr.linked && fxr.strength === STRENGTH, fxr)
  const rSrc = await ev(`T.st().select([]); await T.settle(); await T.seek(1.5e6); return T.outline('${fx}')`)
  check('região na fonte cobre o CPF', !!rSrc && rSrc.x0 <= tb0.x0 - 20 && rSrc.x1 >= tb0.x1 + 20 && rSrc.y0 <= tb0.y0 - 15 && rSrc.y1 >= tb0.y1 + 15, { rSrc, tb0 })

  console.log('zoom 2× em volta do texto (ida 0,5 s, volta depois de 1 s) → "Ancorar efeito ao clipe"')
  {
    await ev(`await T.key('z'); await T.click(T.el('[data-viewer-toolbar] button[aria-label="Opções do zoom"]')); await T.wait(300)
      const pop = T.el('[data-zoom-settings]'); const inputs = () => [...pop.querySelectorAll('input')]
      await T.typeInto(inputs()[0], '0,5')
      if (inputs().length === 1) { await T.click(pop.querySelector('[aria-label="Voltar ao normal depois"]')); await T.wait(100) }
      await T.typeInto(inputs()[1], '1')
      document.activeElement?.blur?.(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await T.wait(300); return 1`)
    const z = await ev(`await T.seek(${ZOOM_AT}); const p0 = T.past()
      await T.drag(T.toScreen(${ZOOM_RECT[0][0]}, ${ZOOM_RECT[0][1]}), T.toScreen(${ZOOM_RECT[1][0]}, ${ZOOM_RECT[1][1]})); await T.wait(600)
      const keys = (T.item('${v}').visual.transform.scale.keys || []).map((k) => [k.tUs, +k.value.toFixed(4)])
      return { p0, past: T.past(), keys, toast: T.toasts().find((t) => t.includes('privacidade')) ?? null, anchor: !!document.querySelector('[data-follow-toast="anchor"]') }`)
    check('zoom: keys de escala 2 s → 2,5 s (2×) → 3,5 s → 4 s, um passo de desfazer', z.past === z.p0 + 1 && JSON.stringify(z.keys.map((k) => k[0])) === JSON.stringify([2e6, 2.5e6, 3.5e6, 4e6]) && near(z.keys[1][1], 2, 1e-3) && z.keys[3][1] === 1, z)
    check('aviso de privacidade com "Ancorar efeito ao clipe"', !!z.toast && z.toast.includes('não acompanha') && z.anchor, z)
    await shot('e2e-f4-01-zoom-aviso.png')
    const a = await ev(`const p0 = T.past(); await T.click(T.el('[data-follow-toast="anchor"]')); await T.wait(400); await T.key('z')
      const f = T.item('${fx}'); return { p0, past: T.past(), canRedo: T.st().canRedo, attach: f.attach?.mediaItemId ?? null, zoom: document.querySelector('[data-viewer-toolbar] button[aria-label^="Zoom"]')?.getAttribute('aria-pressed') }`)
    // F6 (C1): ancorar pelo toast do zoom ancora na pose de antes do zoom e refaz o zoom, no lugar do passo do zoom —
    // zoom + âncora = um passo de desfazer (o histórico não cresce)
    check('ancorado ao vídeo (zoom + âncora num passo só, no lugar do passo do zoom); ferramenta Zoom desligada', a.attach === v && a.past === a.p0 && !a.canRedo && a.zoom === 'false', a)
    await ev(`await T.seek(3e6); return 1`)
    await shot('e2e-f4-02-ancorado-no-zoom.png')
  }

  console.log('animações: Pop na entrada, Desfoque na saída')
  {
    const showPanel = `T.st().select(['${v}']); await T.settle(); await T.wait(300)
      const tab = [...document.querySelectorAll('[aria-label="Inspetor"] [role="tab"]')].find((x) => x.textContent.trim() === 'Vídeo'); if (tab && tab.getAttribute('data-state') !== 'active') { await T.click(tab); await T.wait(200) }
      T.grid().scrollIntoView({ block: 'center' }); await T.wait(250);`
    const r = await ev(`${showPanel} await T.sideTab('Entrada'); await T.click(T.card('pop')); await T.wait(300)
      await T.sideTab('Saída'); await T.click(T.card('blur')); await T.wait(300)
      const vis = T.item('${v}').visual; return { in: vis.animIn ?? null, out: vis.animOut ?? null, offer: !!document.querySelector('[data-follow-toast="anchor"]') }`)
    check('animIn pop e animOut blur (0,5 s); o efeito já ancorado não pede âncora de novo', r.in?.preset === 'pop' && r.out?.preset === 'blur' && r.in.durationUs === 500000 && r.out.durationUs === 500000 && !r.offer, r)
    await shot('e2e-f4-03-animacoes.png')
  }

  console.log('curva personalizada no keyframe de escala dos 2 s')
  {
    const r = await ev(`T.st().select([]); await T.settle(); await T.seek(0)
      const exp = T.el('[data-item-id="${v}"] [data-expand-item]'); if (exp.getAttribute('aria-expanded') !== 'true') { await T.click(exp); await T.wait(200) }
      const k = T.el('[data-lanes-item="${v}"] [data-lane-key="${ZOOM_AT}"][data-path="transform.scale"]')
      await T.rightClick(k); const pop = T.el('[data-curve-editor]')
      const g = T.el('[data-curve-graph]', pop).getBoundingClientRect(); const h2 = T.center(T.el('[data-curve-handle="2"]', pop)); const p0 = T.past()
      await T.drag(h2, { x: g.left + g.width * 0.15, y: g.top + g.height * 0.1 })
      const ease = T.item('${v}').visual.transform.scale.keys.find((x) => x.tUs === ${ZOOM_AT}).ease
      const title = pop.textContent
      return { p0, past: T.past(), ease, title }`)
    check('editor de curvas da escala aberto; alça arrastada grava bezier personalizada (um passo)', r.title.includes('Curva — Escala') && Array.isArray(r.ease?.bezier ?? r.ease) && r.past === r.p0 + 1, r)
    await shot('e2e-f4-04-curva.png')
    await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await T.settle(); await T.wait(250); return 1`)
  }

  console.log('exportar o projeto horizontal (YouTube 1080p)')
  const outlH = await outlines(fx, [...ZOOM_FRAMES, ...OTHER_FRAMES])
  const outH = await exportWith('YouTube 1080p', OUT_H, 'e2e-f4-05-exportar-horizontal.png')

  console.log('Reenquadrar → 9:16, foco no marcador, criar cópia')
  let copyId = null
  {
    const r0 = await ev(`for (let i = 0; i < 60 && T.toasts().length; i++) await T.wait(250)
      T.st().select([]); await T.seek(1e6); await T.click(T.el('[data-reframe-open]')); await T.wait(400)
      const c = T.toScreen(${MARK.x + MARK.w / 2}, ${MARK.y + MARK.h / 2}); await T.clickAt(c.x, c.y); await T.wait(250)
      const d = document.querySelector('[data-reframe-dialog]'); return { open: !!d, text: d?.textContent ?? '', points: window.__qaEditor.reframe.getState().points['${v}'] ?? [] }`)
    check('painel em 9:16 (1080×1920), Criar cópia, ponto de foco no marcador em 1 s', r0.open && r0.text.includes('1080×1920') && r0.points.length === 1 && near(r0.points[0].x, 1400 / W, 0.003) && near(r0.points[0].y, 540 / H, 0.003), r0)
    await shot('e2e-f4-06-reenquadrar.png')
    // o botão fica no rodapé do painel (a nota do zoom o alonga): sem toast por cima e com a prévia pronta
    // toast parado (o sonner pausa o tempo com a janela sem foco) por cima do rodapé do painel: fecha pelo X
    await ev(`for (const b of document.querySelectorAll('[data-sonner-toast] [data-close-button]')) b.click()
      for (let i = 0; i < 60 && T.toasts().length; i++) await T.wait(250)
      for (let i = 0; i < 100 && document.querySelector('[data-reframe-pending]'); i++) await T.wait(50)
      T.el('[data-reframe-apply]').scrollIntoView({ block: 'nearest' }); await T.wait(100)
      await T.click(T.el('[data-reframe-apply]')); return 1`)
    let c = null
    for (let i = 0; i < 60; i++) {
      c = await ev(`const p = window.__qaEditor?.store.getState()?.project; return p ? { id: p.id, name: p.name, w: p.canvas.width, h: p.canvas.height } : null`)
      if (c && c.id !== srcProject.id) break
      await sleep(500)
    }
    copyId = c?.id !== srcProject.id ? c?.id : null
    check('a cópia "E2E movimento (Vertical)" abre em 1080×1920', !!copyId && c.name === 'E2E movimento (Vertical)' && c.w === 1080 && c.h === 1920, c)
    await waitEditor()
    const orig = await ev(`const p = await window.api.project.load('${srcProject.id}'); return { w: p.canvas.width, h: p.canvas.height }`)
    check('o original continua 1920×1080', orig.w === W && orig.h === H, orig)
    const k = await ev(`const f = T.item('${fx}'); const vv = T.item('${v}'); return { attach: f?.attach?.mediaItemId ?? null, in: vv?.visual.animIn?.preset, out: vv?.visual.animOut?.preset, bez: (vv?.visual.transform.scale.keys || []).some((x) => Array.isArray(x.ease?.bezier ?? x.ease)) }`)
    check('na cópia: blur ancorado, animações e curva personalizada preservadas', k.attach === v && k.in === 'pop' && k.out === 'blur' && k.bez, k)
    await ev(`await T.seek(3e6); await T.wait(400); return 1`)
    await shot('e2e-f4-07-copia-vertical.png')
  }
  const outlV = await outlines(fx, [...ZOOM_FRAMES, ...OTHER_FRAMES])
  const outV = await exportWith('Instagram Reels/Stories (9:16)', OUT_V, 'e2e-f4-08-exportar-vertical.png')
  if (!outH || !outV) return

  console.log('conferência com o ffmpeg')
  const pH = probe(outH), pV = probe(outV)
  console.log(`  horizontal ${JSON.stringify(pH)}; vertical ${JSON.stringify(pV)}`)
  check('horizontal: H.264 1920×1080, ≈ 8 s', pH.codec === 'h264' && pH.width === W && pH.height === H && near(pH.duration, DUR_S, 0.15), pH)
  check('vertical: H.264 1080×1920, ≈ 8 s', pV.codec === 'h264' && pV.width === 1080 && pV.height === 1920 && near(pV.duration, DUR_S, 0.15), pV)

  const marks = [...OTHER_FRAMES, 90].map((n) => ({ n, blob: greenBlob(frame(outV, n, 'rgb24'), 1080, 1920) }))
  console.log(`  marcador no 9:16: ${JSON.stringify(marks)}`)
  // no meio do zoom (2×), o alvo dele (centro do retângulo arrastado) fica no centro do 9:16: o marcador, deslocado dele
  const K = (1920 / 1080) * 2, zc = [(ZOOM_RECT[0][0] + ZOOM_RECT[1][0]) / 2, (ZOOM_RECT[0][1] + ZOOM_RECT[1][1]) / 2]
  const at = (m) => (m.n === 90 ? [540 + (1400 - zc[0]) * K, 960 + (540 - zc[1]) * K, 8] : [540, 960, 4])
  check('9:16: o marcador (ponto de foco) no centro do quadro (540, 960) ± 4 px, 178 px de lado ± 4, fora do zoom; no meio do zoom, o alvo do zoom no centro (marcador deslocado dele ± 8 px), 356 ± 6', marks.every((m) => m.blob && near(m.blob.cx, at(m)[0], at(m)[2]) && near(m.blob.cy, at(m)[1], at(m)[2]) && near(m.blob.w, m.n === 90 ? 355.6 : 177.8, m.n === 90 ? 6 : 4)), marks)

  for (const [tag, out, w, h, outl] of [['horizontal', outH, W, H, outlH], ['vertical', outV, 1080, 1920, outlV]]) {
    const rows = legibility(video, out, w, h, rSrc, outl, [...ZOOM_FRAMES, ...OTHER_FRAMES])
    console.log(`  CPF (${tag}): ${JSON.stringify(rows)}`)
    const zoomRows = rows.filter((r) => ZOOM_FRAMES.includes(r.n))
    const maxScale = Math.max(...zoomRows.map((r) => r.scale ?? 0))
    check(`${tag}: a região ancorada acompanha o zoom (escala da região na tela chega a ≥ 1,9× a da fonte${tag === 'vertical' ? ' × 1920/1080' : ''}; ${maxScale})`, maxScale >= 1.9 * (tag === 'vertical' ? 1920 / 1080 : 1), maxScale)
    check(`${tag}: CPF ilegível em todos os ${rows.length} quadros medidos, ${zoomRows.length} durante o zoom (contraste local saída/fonte < 0,15; laplaciano < 0,2; fonte nítida)`, rows.every((r) => !r.error && r.c < 0.15 && r.lap < 0.2 && r.cSrc > 150), rows.map((r) => r.error ? [r.n, r.error] : [r.n, r.c, r.lap]))
    check(`${tag}: a caixa medida está sobre a mancha do texto borrado (mais clara que o fundo em todos os quadros)`, rows.every((r) => !r.error && r.lift > 3), rows.map((r) => [r.n, r.lift]))
  }
  for (const [name, file, n] of [['e2e-f4-09-quadro-horizontal-zoom.png', outH, 90], ['e2e-f4-10-quadro-vertical-zoom.png', outV, 90], ['e2e-f4-11-quadro-vertical-foco.png', outV, 30]]) {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${n}),scale=-2:540`, '-frames:v', '1', '-update', '1', join(SHOTS, name)])
    console.log(`  📷 ${name}`)
  }
  writeFileSync(join(E2E, 'e2e-f4-result.json'), JSON.stringify({ outH, outV, pH, pV, marks, rSrc, outlH, outlV }, null, 2))
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    await shot('e2e-f4-erro.png')
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
