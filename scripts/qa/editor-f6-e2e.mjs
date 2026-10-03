// E2E do editor F6 (cursor e cliques) via CDP, com eventos sintéticos despachados no elemento real sob o ponto
// (document.elementFromPoint), nunca entrada do sistema operacional.
//
// Gravação: uma sessão no formato exato que o gravador deixa em <brutos>/<id> (session.json no SessionSchema,
// rec.mp4 H.264 só com a faixa de tela, cursor.json no formato do T1), com mídia SINTÉTICA — uma gravação real pelo
// caminho do test:capture filmaria a área de trabalho do usuário (invariante 5: repositório público, screenshots e
// pixels só de mídia sintética; os oráculos de pixel precisam de conteúdo controlado). Daí em diante, só o caminho
// padrão: Histórico → "Editar" → project.fromSession (hasCursor pela sessão) → asset.cursor → a trilha lida pelo
// IPC cursor:readTrack → worker do preview e, na exportação, pelo loadCursorTracks padrão (nada injetado no render).
//
// Vídeo 1280×720, 30 fps, 10 s: fundo 0x1e293b com três caixas coloridas no alto (vermelha, verde, azul); de 4 s em
// diante "CPF 123.456" (Consolas 48, branco) parado em x=200 até 5 s, depois andando para a direita a 120 px/s; de
// 7,0 s a 7,5 s uma faixa cinza opaca cobre a linha do texto (oclusão). Trilha do cursor a 60 Hz: vai de (0,15; 0,15)
// a (0,3; 0,3) até 1 s, clique esquerdo em 1 s, parado até 3 s, depois para (0,85; 0,12) e fica — sempre no alto,
// longe da linha do texto (o cursor sobre a região encerraria o rastreamento, R19/R21).
//
// No app: inspetor do clipe de tela → liga "Realçar cliques" e "Cursor ampliado"; "Zoom automático nos cliques" →
// Pré-visualizar, Cancelar (projeto igual), Pré-visualizar, Aplicar (um passo: Ctrl+Z volta, Ctrl+Shift+Z refaz).
// Blur (B) sobre o CPF aos 4 s → "Seguir conteúdo" até o fim → perda na oclusão (toast com "Ir para", faixa de
// confiança); de novo a partir de 8 s com a região reposicionada sobre o texto → os keys de antes ficam intactos.
// Exporta "Original" pelo diálogo real. Com o ffmpeg: (a) pixels do anel (amarelo #ffd400) no quadro do clique e
// nenhum antes/depois; seta branca do cursor ampliado; (b) bordas do quadro nunca no fundo preto do projeto durante
// o zoom (e o zoom de fato amplia a caixa verde ~1,8×); (c) o CPF ilegível em TODO quadro em que aparece na fonte
// (métrica do F2/T5: contraste local p99−p1 após caixa 3×3 < 0,15 × o da fonte e variância do laplaciano < 0,2 ×).
// C1 (revisão final): zoom automático DEPOIS do "Seguir conteúdo" (Intensidade 1,25×, Duração 6 s: o zoom cobre o
// trecho rastreado e o texto continua no quadro) → toast → "Ancorar" / "Vincular e ancorar" (na pose de antes do zoom e refaz
// o zoom: um passo) → Ctrl+Z / Ctrl+Shift+Z → exporta de novo → o CPF ilegível em TODO quadro, medido na caixa do texto
// levada pela geometria do clipe com o zoom (window.__qaEditor.clipPoint).
//
// uso (depois de `npm run build`, sob o lock):  node scripts/qa/editor-f6-e2e.mjs
// Tudo em test-out/e2e-f6 (CIALIGHT_RAW_DIR=test-out/e2e-f6/raw → projetos em test-out/e2e-f6/Projetos, exportação
// em test-out/e2e-f6/export). Screenshots em docs/qa/editor-f6/e2e-f6-*.png. settings.json do usuário restaurado se mudar.
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9338'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f6')
const E2E = join(ROOT, 'test-out', 'e2e-f6')
const RAW_REL = 'test-out/e2e-f6/raw'
const RAW = join(ROOT, RAW_REL)
const SESSION_ID = 'e2e-f6-gravacao'
const OUT = join(E2E, 'export')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const W = 1280
const H = 720
const FPS = 30
const DUR_S = 10
const NFRAMES = DUR_S * FPS
const S = 1_000_000
const BG = [0x1e, 0x29, 0x3b]
const TEXT = { text: 'CPF 123.456', size: 48, y: 450, appear: 4, moveAt: 5, x0: 200, speed: 120 }
const TEXT_X_EXPR = `if(lt(t,${TEXT.moveAt}),${TEXT.x0},${TEXT.x0}+${TEXT.speed}*(t-${TEXT.moveAt}))`
const OCC = { from: 7.0, to: 7.5, y: 420, h: 120 }
const ROW = { y: 400, h: 160 } // faixa medida (contém o texto e a oclusão)
const BOXES = [
  { x: 80, y: 60, w: 160, h: 100, c: '0xdc2626' },
  { x: 500, y: 120, w: 120, h: 120, c: '0x22c55e' },
  { x: 900, y: 60, w: 200, h: 90, c: '0x3b82f6' }
]
const CLICK = { tMs: 1000, x: 0.3, y: 0.3 }
const FOLLOW_AT = 4 * S // primeiro "Seguir conteúdo" (o blur desenhado com B começa no playhead: o quadro em que o CPF aparece)
const RERUN_AT = 8 * S // segundo, depois da perda
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

// ---- gravação sintética no formato do gravador ----
const FONT = "fontfile='C\\:/Windows/Fonts/consola.ttf'"
/** Posição do cursor (0..1) no instante de mídia t (ms). */
function cursorAtMs(t) {
  const lerp = (a, b, k) => a + (b - a) * Math.min(1, Math.max(0, k))
  if (t <= 1000) return { x: lerp(0.15, CLICK.x, t / 1000), y: lerp(0.15, CLICK.y, t / 1000) }
  if (t <= 3000) return { x: CLICK.x, y: CLICK.y }
  return { x: lerp(CLICK.x, 0.85, (t - 3000) / 600), y: lerp(CLICK.y, 0.12, (t - 3000) / 600) }
}
function makeSession() {
  rmSync(E2E, { recursive: true, force: true })
  const dir = join(RAW, SESSION_ID)
  for (const d of [dir, OUT]) mkdirSync(d, { recursive: true })
  const boxes = BOXES.map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.c}:t=fill`).join(',')
  const vf = `${boxes},drawtext=${FONT}:text='${TEXT.text}':fontsize=${TEXT.size}:fontcolor=white:x='${TEXT_X_EXPR}':y=${TEXT.y}:enable='gte(t,${TEXT.appear})',drawbox=x=0:y=${OCC.y}:w=${W}:h=${OCC.h}:color=0x808080:t=fill:enable='between(t,${OCC.from},${OCC.to})'`
  const rec = join(dir, 'rec.mp4')
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1e293b:s=${W}x${H}:r=${FPS}:d=${DUR_S}`, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '30', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', rec])
  // cursor.json: o formato do T1 (version 1, width/height do vídeo de tela, tMs inteiros estritamente crescentes)
  const samples = []
  for (let i = 0, t = 0; t < DUR_S * 1000; i++, t = Math.round(i * (1000 / 60))) {
    const p = cursorAtMs(t)
    samples.push({ tMs: t, x: +p.x.toFixed(5), y: +p.y.toFixed(5) })
  }
  const cursor = { version: 1, width: W, height: H, samples, clicks: [{ tMs: CLICK.tMs, x: CLICK.x, y: CLICK.y, button: 'left' }] }
  writeFileSync(join(dir, 'cursor.json'), JSON.stringify(cursor))
  const session = {
    version: 1,
    id: SESSION_ID,
    createdAt: new Date().toISOString(),
    state: 'finalized',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor sintético', bounds: { x: 0, y: 0, width: W, height: H }, scaleFactor: 1 },
    video: { width: W, height: H, fps: FPS, codec: 'avc1.640028', bitrate: 8e6 },
    systemAudio: false,
    tracks: { screen: 0 },
    durationMs: DUR_S * 1000,
    pauses: [],
    pip: [],
    strokes: [],
    clearEvents: [],
    markers: [],
    engine: 'webcodecs',
    files: { rec: 'rec.mp4' },
    bytes: statSync(rec).size
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2))
  return { rec, cursor }
}

// ---- quadros e métricas (ffmpeg; as contas do F2/T5) ----
/** Todos os quadros de `file` depois de `vf`, em pix_fmt `fmt`; devolve um array de Buffers (um por quadro). */
function frames(file, vf, w, h, fmt = 'gray') {
  const bpp = fmt === 'gray' ? 1 : 3
  const buf = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-vsync', 'passthrough', '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 1 << 30 })
  const size = w * h * bpp
  const out = []
  for (let o = 0; o + size <= buf.length; o += size) out.push(buf.subarray(o, o + size))
  return out
}
/** Caixa dos pixels claros (texto branco) num quadro cinza w×h. */
function textBox(gray, w, h) {
  let x0 = w, y0 = 1e9, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > 160) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}
function padBox(w, h, b, pad) {
  return { xa: Math.max(1, b.x0 - pad), xb: Math.min(w - 2, b.x1 + pad), ya: Math.max(1, b.y0 - pad), yb: Math.min(h - 2, b.y1 + pad) }
}
/** Contraste local (F2): média 3×3 na luminância e p99 − p1 dentro da caixa + pad. */
function localContrast(gray, w, h, b, pad = 4) {
  const { xa, xb, ya, yb } = padBox(w, h, b, pad)
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
  const { xa, xb, ya, yb } = padBox(w, h, b, pad)
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
// amarelo do anel (#ffd400) já misturado ao fundo pela opacidade que decai: r e g bem acima de b (o fundo, as caixas e o
// branco não passam)
const isYellow = (r, g, b) => r > 80 && r - b > 40 && g - b > 30
const isWhite = (r, g, b) => r > 215 && g > 215 && b > 215
function countRgb(rgb, pred, area) {
  let n = 0
  const { x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1 } = area ?? {}
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * W + x) * 3; if (pred(rgb[i], rgb[i + 1], rgb[i + 2])) n++ }
  return n
}
/** Caixa dos pixels verdes (0x22c55e) num quadro rgb24 W×H. */
function greenBox(rgb) {
  let x0 = W, x1 = -1, y0 = H, y1 = -1, n = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
      if (g > 120 && g - r > 60 && g - b > 40) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    }
  }
  return n ? { w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null
}
function probe(file) {
  const p = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
  const vs = p.streams.find((s) => s.codec_type === 'video')
  return { codec: vs?.codec_name, width: vs?.width, height: vs?.height, duration: Number(p.format.duration), frames: Number(vs?.nb_frames) }
}
/** O texto está coberto no quadro n? (meio quadro de margem: o ffmpeg arredonda o tempo do quadro). */
const occluded = (n) => {
  const t = n / FPS, h = 0.5 / FPS
  if (t > OCC.from + h && t < OCC.to - h) return 'yes'
  if (t < OCC.from - h || t > OCC.to + h) return 'no'
  return 'edge'
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__f6; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 300000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await sleep(300)
  const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(20000).then(() => null)])
  if (!r?.result?.data) return console.log(`  (sem captura: ${name})`)
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}

// helpers da página: eventos no elemento real mais ao topo sob o ponto (como um clique de verdade), leitura do store
const HELPERS = `
window.__f6 = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel, root = document) => { const e = root.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel, root = document) => [...root.querySelectorAll(sel)]
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
  const click = async (e, mods) => { e.scrollIntoView({ block: 'center' }); await settle(); const c = center(e); return clickAt(c.x, c.y, mods) }
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
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const setValue = (input, value) => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })) }
  const typeInto = async (input, text) => { setValue(input, text); await settle(); input.blur(); await settle() }
  const setField = async (label, value) => typeInto(el('[aria-label="Inspetor"] input[aria-label="' + label + '"]'), value)
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  const dialog = () => document.querySelector('[role="dialog"]')
  const insp = () => el('[aria-label="Inspetor"]')
  const section = (title) => { const s = all('section', insp()).find((x) => x.textContent.startsWith(title)); if (!s) throw new Error('não achei a seção ' + title); return s }
  const videoTab = async () => { const tab = all('[role="tab"]', insp()).find((x) => x.textContent.trim() === 'Vídeo'); if (tab && tab.getAttribute('data-state') !== 'active') { await click(tab); await wait(200) } }
  return { st, settle, wait, el, all, center, topAt, clickAt, click, drag, key, items, item, past, seek, toScreen, button, setValue, typeInto, setField, toasts, dialog, insp, section, videoTab }
})()
'ok'`

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
  check('exportação sem aviso de trilha do cursor ilegível', !/trilha do cursor/i.test(text), text.slice(0, 300))
  await ev(`if (T.dialog()) { await T.click(T.button('Fechar', T.dialog())); await T.wait(300) } return 1`)
  const files = readdirSync(dir).filter((x) => x.endsWith('.mp4'))
  check(`um .mp4 em ${dir.split(/[\\/]/).pop()}, sem .part`, files.length === 1 && readdirSync(dir).length === 1, readdirSync(dir))
  return files.length === 1 ? join(dir, files[0]) : null
}

/** Espera o fim do "Seguir conteúdo" (o botão volta) e devolve os toasts novos. */
async function waitFollow(before) {
  for (let i = 0; i < 600; i++) {
    const r = await ev(`const busy = !!document.querySelector('[data-follow-content-panel] [role="status"][aria-live]'); const btn = document.querySelector('[data-follow-content]')
      return { busy, ready: !!btn && !busy, toasts: T.toasts() }`)
    if (r.ready && r.toasts.some((t) => !before.includes(t) && /Rastreamento|Conteúdo seguido|Não foi possível|nada foi aplicado/.test(t))) return r.toasts.filter((t) => !before.includes(t))
    await sleep(250)
  }
  throw new Error('o "Seguir conteúdo" não terminou')
}

const result = {}

async function main() {
  console.log('gravação sintética no formato do gravador (session.json + rec.mp4 + cursor.json)')
  const { rec, cursor } = makeSession()
  const pr = probe(rec)
  check(`fonte: H.264 ${W}×${H}, ${DUR_S} s, ${NFRAMES} quadros; trilha com ${cursor.samples.length} amostras e 1 clique`, pr.codec === 'h264' && pr.width === W && pr.height === H && pr.frames === NFRAMES && cursor.samples.length > 590, { pr, n: cursor.samples.length })

  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    // CIALIGHT_QA (qualquer valor) libera o lock de instância única (o app instalado pode estar aberto) e pula o probe adiado
    env: { ...process.env, CIALIGHT_QA: 'e2e-f6', CIALIGHT_RAW_DIR: RAW_REL },
    stdio: 'ignore'
  })
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await ev(HELPERS + '; return 1')

  console.log('Histórico → Editar (project.fromSession pelo caminho padrão)')
  await ev(`localStorage.setItem('editor.timelineHeight', '260'); window.__navigate('history'); return 1`)
  for (let i = 0; i < 40; i++) {
    if (await ev(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Editar')`)) break
    await sleep(500)
  }
  await shot('e2e-f6-01-historico.png')
  await ev(`await T.click(T.button('Editar')); return 1`)
  let ready = null
  for (let i = 0; i < 180; i++) {
    ready = await ev(`const s = window.__qaEditor?.store.getState(); if (!s?.project) return null; return { ok: s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]'), assets: s.project.assets.map((a) => [a.id, a.status, a.cursor ?? null]) }`)
    if (ready?.ok) break
    await sleep(1000)
  }
  check('editor abriu a gravação e a ingestão terminou', !!ready?.ok, ready)
  await ev(HELPERS + '; return 1')
  const p0 = await ev(`const p = T.st().project; const tr = p.tracks.map((t) => [t.name, t.items.length]); const sc = p.tracks[0].items[0]; const a = p.assets.find((x) => x.id === sc.assetId)
    return { w: p.canvas.width, h: p.canvas.height, tracks: tr, screen: sc.id, cursorRef: a?.cursor ?? null, source: a?.source, fx: sc.cursorFx ?? null }`)
  check('projeto da gravação: faixa "Tela" 1280×720, asset da tela com cursor "cursor.json" (fromSession hasCursor) e cursorFx padrão desligado', p0.w === W && p0.h === H && p0.tracks[0][0] === 'Tela' && p0.cursorRef === 'cursor.json' && p0.source?.sessionId === SESSION_ID && p0.fx && !p0.fx.highlight.enabled && !p0.fx.cursor.enabled, p0)
  const v = p0.screen
  await ev(`await T.key('Z', { shiftKey: true }); T.st().select(['${v}']); await T.settle(); await T.wait(300); await T.videoTab(); return 1`)

  console.log('inspetor da tela: Realçar cliques + Cursor ampliado (trilha pelo IPC padrão)')
  {
    let aside = null
    for (let i = 0; i < 40; i++) {
      aside = await ev(`try { const s = T.section('Cursor e cliques'); return s.textContent } catch { return null }`)
      if (aside?.includes('1 clique gravado')) break
      await sleep(250)
    }
    check('seção "Cursor e cliques" lê a trilha pelo IPC (1 clique gravado)', !!aside?.includes('1 clique gravado'), aside)
    const r = await ev(`const s = T.section('Cursor e cliques'); const p0 = T.past()
      await T.click(T.el('[aria-label="Realçar cliques"]', s)); await T.wait(200)
      await T.click(T.el('[aria-label="Cursor ampliado"]', T.section('Cursor e cliques'))); await T.wait(200)
      const fx = T.item('${v}').cursorFx; return { p0, past: T.past(), hl: fx?.highlight.enabled, cur: fx?.cursor.enabled, color: fx?.highlight.color }`)
    check('realce e cursor ampliado ligados, um passo de desfazer cada', r.hl === true && r.cur === true && r.past === r.p0 + 2 && r.color === '#ffd400', r)
    await ev(`await T.seek(1.2e6); return 1`)
    await shot('e2e-f6-02-cursor-e-cliques.png')
  }

  console.log('zoom automático nos cliques: Pré-visualizar, Cancelar, Pré-visualizar, Aplicar; Ctrl+Z / Ctrl+Shift+Z')
  {
    const az = (body) => ev(`const s = T.section('Zoom automático nos cliques'); ${body}`)
    const hdr = await az(`s.scrollIntoView({ block: 'center' }); await T.wait(200); return s.textContent`)
    check('seção "Zoom automático nos cliques" com 1 clique', hdr.includes('1 clique'), hdr.slice(0, 120))
    const before = await ev(`return { json: JSON.stringify(T.st().project), past: T.past() }`)
    const pv1 = await az(`await T.click(T.button('Pré-visualizar', s)); await T.wait(400)
      const pr = T.st().preview; const sc = pr ? pr.tracks.flatMap((t) => t.items).find((i) => i.id === '${v}') : null
      return { preview: !!pr, scaleKeys: sc?.visual.transform.scale.keys?.length ?? 0, json: JSON.stringify(T.st().project), past: T.past(), status: s.textContent.includes('Pré-visualização (fora do histórico)') }`)
    check('Pré-visualizar: prévia fora do histórico com keys de escala; o projeto e o histórico não mudam', pv1.preview && pv1.scaleKeys >= 2 && pv1.json === before.json && pv1.past === before.past && pv1.status, { ...pv1, json: undefined })
    await ev(`await T.seek(1.6e6); return 1`)
    await shot('e2e-f6-03-zoom-previa.png')
    const c = await az(`await T.click(T.button('Cancelar', s)); await T.wait(300); return { preview: T.st().preview, json: JSON.stringify(T.st().project), past: T.past() }`)
    check('Cancelar: prévia descartada e projeto idêntico ao de antes', c.preview === null && c.json === before.json && c.past === before.past, { preview: !!c.preview, same: c.json === before.json, past: c.past })
    await az(`await T.click(T.button('Pré-visualizar', s)); await T.wait(400); return 1`)
    const ap = await az(`await T.click(T.button('Aplicar', s)); await T.wait(500)
      const sc = T.item('${v}'); const k = sc.visual.transform.scale.keys || []
      return { preview: T.st().preview, past: T.past(), keys: k.map((x) => [x.tUs, +x.value.toFixed(4)]), json: JSON.stringify(T.st().project), toast: T.toasts().find((t) => t.includes('zoom automático')) ?? null }`)
    const maxScale = Math.max(...ap.keys.map((k) => k[1]))
    check(`Aplicar: um passo de desfazer, keys de escala até ${maxScale}× (padrão 1,8×), toast`, ap.preview === null && ap.past === before.past + 1 && near(maxScale, 1.8, 0.01) && !!ap.toast, { ...ap, json: undefined })
    result.zoomKeys = ap.keys
    const u = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past() }`)
    check('Ctrl+Z restaura o projeto de antes do zoom automático', u.json === before.json && u.past === before.past, { same: u.json === before.json, past: u.past })
    const rd = await ev(`await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past() }`)
    check('Ctrl+Shift+Z refaz o zoom automático (mesmo projeto do Aplicar)', rd.json === ap.json && rd.past === ap.past, { same: rd.json === ap.json, past: rd.past })
    await ev(`await T.seek(1.2e6); return 1`)
    await shot('e2e-f6-04-zoom-aplicado.png')
  }

  console.log('blur (B) sobre o CPF aos 4 s → Seguir conteúdo')
  const box120 = textBox(frames(rec, `select=eq(n\\,120),crop=${W}:${ROW.h}:0:${ROW.y}`, W, ROW.h)[0], W, ROW.h)
  const tb = { x0: box120.x0, y0: box120.y0 + ROW.y, x1: box120.x1, y1: box120.y1 + ROW.y }
  const R = { x0: tb.x0 - 12, y0: tb.y0 - 12, x1: tb.x1 + 12, y1: tb.y1 + 12 }
  let fx
  {
    const r = await ev(`T.st().select([]); await T.seek(${FOLLOW_AT}); await T.key('b'); await T.drag(T.toScreen(${R.x0}, ${R.y0}), T.toScreen(${R.x1}, ${R.y1})); await T.wait(200)
      const fx = T.st().selection[0]; await T.key('b'); await T.setField('Intensidade', ${STRENGTH})
      const f = T.item(fx); return { fx, effect: f?.effect, start: f?.startUs, dur: f?.durationUs, strength: f?.strength.value, attach: f?.attach ?? null }`)
    fx = r.fx
    check(`blur sobre o CPF (${JSON.stringify(tb)}) do playhead (4 s) ao fim do clipe, intensidade ${STRENGTH}, não ancorado`, r.effect === 'blur' && r.start === FOLLOW_AT && near(r.start + r.dur, DUR_S * S, 40_000) && r.strength === STRENGTH && !r.attach, r)
    const before = await ev(`return T.toasts()`)
    const t0 = Date.now()
    await ev(`await T.click(T.el('[data-follow-content]')); return 1`)
    await sleep(700)
    const prog = await ev(`const st = document.querySelector('[data-follow-content-panel] [role="status"][aria-live]'); return st ? st.textContent : null`)
    console.log(`  progresso: ${prog}`)
    await shot('e2e-f6-05-seguindo.png')
    const news = await waitFollow(before)
    console.log(`  seguir conteúdo: ${((Date.now() - t0) / 1000).toFixed(1)} s; toasts ${JSON.stringify(news)}`)
    check('progresso "Analisando N de M quadros…" com Cancelar durante a análise', !!prog && /Analisando \d+ de \d+ quadros|Preparando/.test(prog) && prog.includes('Cancelar'), prog)
    const loss = news.find((t) => t.includes('Rastreamento perdido em'))
    const m = loss?.match(/perdido em (\d+):(\d+),(\d)/)
    const lossS = m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10 : null
    check(`toast de perda na oclusão (${OCC.from} s) com "Ir para": ${loss}`, !!loss && lossS !== null && lossS >= OCC.from - 0.15 && lossS <= OCC.from + 0.25 && loss.includes('Ir para'), { news, lossS })
    const k = await ev(`const f = T.item('${fx}'); const r = f.region; const at = (a, tl) => { const t = tl - f.startUs; const ks = a.keys; if (!ks?.length) return a.value; let best = ks[0]; for (const x of ks) if (x.tUs <= t) best = x; return best.value } // keys no tempo LOCAL do efeito
      return { nx: r.x.keys?.length ?? 0, ny: r.y.keys?.length ?? 0, nw: r.w.keys?.length ?? 0, nh: r.h.keys?.length ?? 0, w45: at(r.w, 4.5e6), w9: at(r.w, 9e6), h45: at(r.h, 4.5e6), h9: at(r.h, 9e6), x45: at(r.x, 4.5e6), x65: at(r.x, 6.5e6),
        strip: document.querySelector('[data-item-id="${fx}"] [data-track-strip]')?.getAttribute('aria-label') ?? null, past: T.past() }`)
    const expectKeys = NFRAMES - Math.round(FOLLOW_AT / S * FPS) // um key por quadro analisado (+1 em início−1 µs)
    check(`keys de região por quadro (${k.nx} ≥ ${expectKeys}) em x, y, w e h`, k.nx >= expectKeys && k.ny === k.nx && k.nw === k.nx && k.nh === k.nx, k)
    check('a região acompanhou o texto antes da perda (x aos 6,5 s à direita do de 4,5 s: parado até 5 s, depois 120 px/s × 1,5 s = 180 px)', near((k.x65 - k.x45) * W, 180, 12), { dxPx: (k.x65 - k.x45) * W })
    check('depois da perda a região fica ampliada até o fim (R21: sem recuperação automática)', k.w9 > k.w45 * 1.5 && k.h9 > k.h45 * 1.5, k)
    check('faixa de confiança no item (perdido em …)', !!k.strip && k.strip.includes('perdido em'), k.strip)
    result.follow1 = { news, lossS, k }
    await shot('e2e-f6-06-perda.png')
    const go = await ev(`const t = [...document.querySelectorAll('[data-sonner-toast]')].find((x) => x.textContent.includes('Rastreamento perdido')); const b = t && [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Ir para')
      if (!b) return null; await T.click(b); await T.wait(300); return T.st().playheadUs`)
    check('"Ir para" leva o playhead ao instante da perda', go !== null && lossS !== null && near(go / S, lossS, 0.1), { go, lossS })
  }

  console.log('de novo a partir de 8 s, com a região reposicionada sobre o texto')
  {
    const b240 = textBox(frames(rec, `select=eq(n\\,240),crop=${W}:${ROW.h}:0:${ROW.y}`, W, ROW.h)[0], W, ROW.h)
    const t2 = { x0: b240.x0 - 12, y0: b240.y0 + ROW.y - 12, x1: b240.x1 + 12, y1: b240.y1 + ROW.y + 12 }
    const snap = await ev(`T.st().select(['${fx}']); await T.settle(); await T.seek(${RERUN_AT}); await T.wait(200); return JSON.stringify(T.item('${fx}').region)`)
    await ev(`await T.setField('Posição X', ${(((t2.x0 + t2.x1) / 2 / W) * 100).toFixed(2)}); await T.setField('Posição Y', ${(((t2.y0 + t2.y1) / 2 / H) * 100).toFixed(2)})
      await T.setField('Largura', ${(((t2.x1 - t2.x0) / W) * 100).toFixed(2)}); await T.setField('Altura', ${(((t2.y1 - t2.y0) / H) * 100).toFixed(2)}); return 1`)
    await ev(`await T.seek(${RERUN_AT}); return 1`)
    const before = await ev(`return T.toasts()`)
    await ev(`await T.click(T.el('[data-follow-content]')); return 1`)
    const news = await waitFollow(before)
    console.log(`  segunda passada: toasts ${JSON.stringify(news)}`)
    const cmp = await ev(`const old = JSON.parse(${JSON.stringify(snap)}); const cur = T.item('${fx}').region; const f = T.item('${fx}'); const cut = ${RERUN_AT} - f.startUs - 1; const out = {}
      for (const ch of ['x', 'y', 'w', 'h']) { const a = (old[ch].keys || []).filter((k) => k.tUs < cut); const b = (cur[ch].keys || []).filter((k) => k.tUs < cut); out[ch] = { n: a.length, same: JSON.stringify(a) === JSON.stringify(b), after: (cur[ch].keys || []).filter((k) => k.tUs >= cut + 1).length } }
      return out`)
    check('segunda passada: "Conteúdo seguido" (sem perda de 8 s ao fim)', news.some((t) => t.includes('Conteúdo seguido')) && !news.some((t) => t.includes('perdido')), news)
    check('os keys de antes de 8 s ficam intactos (x, y, w, h) e há keys novos de 8 s em diante', Object.values(cmp).every((c) => c.same && c.n > 100 && c.after >= 59), cmp)
    result.follow2 = { news, cmp, t2 }
    await ev(`await T.seek(8.8e6); return 1`)
    await shot('e2e-f6-07-segunda-passada.png')
  }

  console.log('exportar ("Original", diálogo real; trilha pelo carregamento padrão da exportação)')
  await ev(`T.st().select([]); for (let i = 0; i < 60 && T.toasts().length; i++) await T.wait(250); return 1`)
  const out = await exportWith('Original', OUT, 'e2e-f6-08-exportar.png')
  if (!out) return
  const po = probe(out)
  console.log(`  exportação ${JSON.stringify(po)}`)
  check(`exportação: H.264 ${W}×${H}, ≈ ${DUR_S} s`, po.codec === 'h264' && po.width === W && po.height === H && near(po.duration, DUR_S, 0.15), po)

  console.log('conferência com o ffmpeg')
  // (a) anel no clique: o clique (1000 ms de mídia) aparece em 1,08 s (CURSOR_VIDEO_LAG_MS = 80) e dura 450 ms
  const ring = frames(out, `select='between(n\\,26\\,52)'`, W, H, 'rgb24')
  const yellow = ring.map((f, i) => [26 + i, countRgb(f, isYellow)])
  console.log(`  pixels amarelos por quadro: ${JSON.stringify(yellow)}`)
  const on = yellow.filter(([n]) => n >= 34 && n <= 40)
  const off = yellow.filter(([n]) => n <= 31 || n >= 48)
  check('(a) anel do realce presente nos quadros do clique (34–40: ≥ 40 px amarelos cada) e ausente antes/depois (≤ 31 e ≥ 48: 0)', on.every(([, c]) => c >= 40) && off.every(([, c]) => c === 0), { on, off })
  // seta do cursor ampliado (branca): antes do texto existir, só ela é branca na tela
  const arrow = frames(out, `select='eq(n\\,15)+eq(n\\,60)+eq(n\\,100)'`, W, H, 'rgb24').map((f) => countRgb(f, isWhite))
  const arrowSrc = frames(rec, `select='eq(n\\,15)+eq(n\\,60)+eq(n\\,100)'`, W, H, 'rgb24').map((f) => countRgb(f, isWhite))
  check(`seta do cursor ampliado desenhada (pixels brancos ${JSON.stringify(arrow)}; fonte ${JSON.stringify(arrowSrc)})`, arrow.every((c) => c >= 100) && arrowSrc.every((c) => c === 0), { arrow, arrowSrc })
  // (b) bordas durante o zoom: nunca o fundo preto do projeto (o conteúdo cobre o quadro inteiro)
  const zk = result.zoomKeys
  const z0 = Math.floor((zk[0][0] / S) * FPS), z1 = Math.ceil((zk[zk.length - 1][0] / S) * FPS)
  const strips = [`crop=${W}:2:0:0`, `crop=${W}:2:0:${H - 2}`, `crop=2:${H}:0:0`, `crop=2:${H}:${W - 2}:0`]
  let darkest = 255, darkAt = null
  for (const c of strips) {
    const [cw, ch] = c.slice(5).split(':').map(Number)
    const fr = frames(out, c, cw, ch, 'gray')
    for (let n = z0; n <= Math.min(z1, fr.length - 1); n++) {
      const f = fr[n]
      for (let i = 0; i < f.length; i++) if (f[i] < darkest) { darkest = f[i]; darkAt = { n, strip: c, i } }
    }
  }
  check(`(b) nenhuma borda no fundo preto durante o zoom (quadros ${z0}–${z1}; luma mínima ${darkest} > 20; fundo do vídeo ≈ 40)`, darkest > 20, { darkest, darkAt })
  const g60 = greenBox(frames(out, `select=eq(n\\,60)`, W, H, 'rgb24')[0])
  const gSrc = greenBox(frames(rec, `select=eq(n\\,60)`, W, H, 'rgb24')[0])
  check(`o zoom amplia o conteúdo no quadro 60 (caixa verde ${gSrc?.w} → ${g60?.w} px ≈ 1,8×)`, !!g60 && !!gSrc && near(g60.w / gSrc.w, 1.8, 0.06), { g60, gSrc })
  // (c) CPF ilegível em todo quadro em que aparece na fonte
  const crop = `crop=${W}:${ROW.h}:0:${ROW.y}`
  const src = frames(rec, crop, W, ROW.h)
  const dst = frames(out, crop, W, ROW.h)
  const rows = []
  let skipped = 0
  for (let n = TEXT.appear * FPS; n < NFRAMES; n++) {
    if (occluded(n) !== 'no') { skipped++; continue }
    const b = textBox(src[n], W, ROW.h)
    if (!b) { rows.push({ n, error: 'sem texto na fonte' }); continue }
    const c0 = localContrast(src[n], W, ROW.h, b), c1 = localContrast(dst[n], W, ROW.h, b)
    const l0 = lapVar(src[n], W, ROW.h, b), l1 = lapVar(dst[n], W, ROW.h, b)
    rows.push({ n, cSrc: +c0.toFixed(1), c: +(c1 / c0).toFixed(4), lap: +(l1 / l0).toFixed(5) })
  }
  const bad = rows.filter((r) => r.error || !(r.c < 0.15 && r.lap < 0.2 && r.cSrc >= 120))
  const worst = rows.filter((r) => !r.error).reduce((a, r) => (!a || r.c > a.c ? r : a), null)
  console.log(`  CPF: ${rows.length} quadros medidos + ${skipped} na oclusão; pior ${JSON.stringify(worst)}`)
  check(`(c) CPF ilegível em TODOS os ${rows.length} quadros medidos (4 s → 10 s, fora da oclusão; contraste < 0,15, laplaciano < 0,2, fonte nítida ≥ 120)`, bad.length === 0 && rows.length > 150, bad.slice(0, 10))
  result.legibility = { measured: rows.length, skipped, worst, bad: bad.length }
  for (const [name, n] of [['e2e-f6-09-quadro-clique-zoom.png', 38], ['e2e-f6-10-quadro-blur-seguindo.png', 180], ['e2e-f6-11-quadro-apos-perda.png', 232], ['e2e-f6-12-quadro-segunda-passada.png', 270]]) {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-vf', `select=eq(n\\,${n}),scale=-2:540`, '-frames:v', '1', '-update', '1', join(SHOTS, name)])
    console.log(`  📷 ${name}`)
  }
  writeFileSync(join(E2E, 'e2e-f6-result.json'), JSON.stringify({ out, po, yellow, arrow, darkest, g60, gSrc, ...result }, null, 2))

  console.log('C1: zoom automático depois do "Seguir conteúdo" → ancorar pelo toast → exportar → CPF ilegível em todo quadro')
  {
    await ev(`T.st().select(['${v}']); await T.settle(); await T.wait(300); await T.videoTab(); return 1`)
    // Intensidade no mínimo (1,25×) e Duração no máximo (6 s) pelo teclado do slider (Home / End: valor + commit)
    const sl = await ev(`const s = T.section('Zoom automático nos cliques'); s.scrollIntoView({ block: 'center' }); await T.wait(200)
      const thumb = (label) => { const r = T.el('[aria-label="' + label + '"]', s); return r.getAttribute('role') === 'slider' ? r : r.querySelector('[role="slider"]') }
      for (const [label, key] of [['Intensidade', 'Home'], ['Duração', 'End']]) { const t = thumb(label); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await T.settle(); await T.wait(100) }
      return { intensity: thumb('Intensidade').getAttribute('aria-valuenow'), hold: thumb('Duração').getAttribute('aria-valuenow') }`)
    check('C1: Intensidade 1,25× e Duração 6 s pelo teclado dos sliders', Number(sl.intensity) === 1.25 && Number(sl.hold) === 6000, sl)
    const pre = await ev(`await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past() }`)
    const ap = await ev(`const s = T.section('Zoom automático nos cliques'); await T.click(T.button('Aplicar', s)); await T.wait(700)
      const k = T.item('${v}').visual.transform.scale.keys || []
      return { past: T.past(), keys: k.map((x) => [x.tUs, +x.value.toFixed(4)]), json: JSON.stringify(T.st().project), toast: T.toasts().find((t) => /zooms? automáticos? aplicados?/.test(t)) ?? null, offer: document.querySelector('[data-follow-toast="anchor"]') ? 'anchor' : document.querySelector('[data-follow-toast="link"]') ? 'link' : null }`)
    const maxS = Math.max(...ap.keys.map((k) => k[1])), lastK = ap.keys[ap.keys.length - 1]?.[0] ?? 0
    check(`C1: zoom aplicado (até ${maxS}×, último key em ${(lastK / S).toFixed(2)} s: cobre o trecho rastreado de 4 s), um passo, toast com o aviso de privacidade e a oferta de ancorar (${ap.offer})`, ap.past === pre.past + 1 && near(maxS, 1.25, 0.01) && lastK > 6.5 * S && !!ap.toast && ap.toast.includes('Privacidade:') && !!ap.offer, { ...ap, json: undefined })
    await shot('e2e-f6-13-c1-toast-ancorar.png')
    const lk = await ev(`await T.click(T.el('[data-follow-toast="${ap.offer}"]')); await T.wait(700); const f = T.item('${fx}'); const sc = T.item('${v}')
      return { past: T.past(), attach: f.attach?.mediaItemId ?? null, link: f.linkId ?? null, mlink: sc.linkId ?? null, keys: (sc.visual.transform.scale.keys || []).map((x) => [x.tUs, +x.value.toFixed(4)]), json: JSON.stringify(T.st().project), toasts: T.toasts(), canRedo: T.st().canRedo }`)
    check(`C1: "${ap.offer === 'anchor' ? 'Ancorar efeito ao clipe' : 'Vincular e ancorar'}" troca o passo do zoom por um só (zoom + âncora), efeito ancorado e no grupo do clipe, o mesmo zoom`, lk.past === ap.past && !lk.canRedo && lk.attach === v && !!lk.link && lk.link === lk.mlink && JSON.stringify(lk.keys) === JSON.stringify(ap.keys) && lk.toasts.some((t) => t.includes('ancorado ao clipe')), { ...lk, json: undefined })
    const u = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past() }`)
    check('C1: um Ctrl+Z desfaz zoom e âncora juntos (projeto de antes do zoom)', u.json === pre.json && u.past === pre.past, { same: u.json === pre.json, past: u.past })
    const rd = await ev(`await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past() }`)
    check('C1: Ctrl+Shift+Z refaz zoom + âncora', rd.json === lk.json && rd.past === lk.past, { same: rd.json === lk.json, past: rd.past })
    await ev(`T.st().select([]); for (let i = 0; i < 80 && T.toasts().length; i++) await T.wait(250); return 1`)
    const OUT2 = join(E2E, 'export-c1')
    mkdirSync(OUT2, { recursive: true })
    const out2 = await exportWith('Original', OUT2, 'e2e-f6-14-c1-exportar.png')
    if (out2) {
      // caixa do texto em cada quadro da fonte (absoluta) levada ao quadro exportado pela geometria do clipe com o zoom
      const first = TEXT.appear * FPS
      const boxes = []
      for (let n = first; n < NFRAMES; n++) {
        const b = textBox(src[n], W, ROW.h)
        boxes.push(b ? { n, tUs: Math.round((n * S) / FPS), b: { x0: b.x0, y0: b.y0 + ROW.y, x1: b.x1 + 1, y1: b.y1 + 1 + ROW.y } } : { n, b: null })
      }
      const mapped = await ev(`const q = window.__qaEditor; return ${JSON.stringify(boxes)}.map((r) => { if (!r.b) return null; const a = q.clipPoint('${v}', r.tUs, r.b.x0 / ${W}, r.b.y0 / ${H}); const c = q.clipPoint('${v}', r.tUs, r.b.x1 / ${W}, r.b.y1 / ${H}); return a && c ? { x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) } : null })`)
      const full = frames(out2, `select=gte(n\\,${first})`, W, H)
      const rows2 = []
      let offscreen = 0, occl = 0, zoomed = 0
      for (let i = 0; i < boxes.length; i++) {
        const { n, b } = boxes[i]
        if (occluded(n) !== 'no') { occl++; continue }
        const m = mapped[i]
        if (!b || !m) { rows2.push({ n, error: 'sem texto na fonte ou clipe invisível' }); continue }
        const cb = { x0: Math.max(6, Math.ceil(m.x0)), y0: Math.max(6, Math.ceil(m.y0)), x1: Math.min(W - 7, Math.floor(m.x1) - 1), y1: Math.min(H - 7, Math.floor(m.y1) - 1) }
        if (cb.x1 - cb.x0 < 12 || cb.y1 - cb.y0 < 12) { offscreen++; continue }
        const k = (m.x1 - m.x0) / (b.x1 - b.x0)
        if (k > 1.1) zoomed++
        const sb = { x0: b.x0, y0: b.y0 - ROW.y, x1: b.x1 - 1, y1: b.y1 - 1 - ROW.y }
        const c0 = localContrast(src[n], W, ROW.h, sb), c1 = localContrast(full[n - first], W, H, cb)
        const l0 = lapVar(src[n], W, ROW.h, sb), l1 = lapVar(full[n - first], W, H, cb)
        rows2.push({ n, k: +k.toFixed(3), cSrc: +c0.toFixed(1), c: +(c1 / c0).toFixed(4), lap: +(l1 / l0).toFixed(5) })
      }
      const bad2 = rows2.filter((r) => r.error || !(r.c < 0.15 && r.lap < 0.2 && r.cSrc >= 120))
      const worst2 = rows2.filter((r) => !r.error).reduce((a, r) => (!a || r.c > a.c ? r : a), null)
      console.log(`  C1 CPF: ${rows2.length} quadros medidos (${zoomed} com zoom), ${occl} na oclusão, ${offscreen} fora do quadro; pior ${JSON.stringify(worst2)}`)
      check(`C1: CPF ilegível em TODOS os ${rows2.length} quadros medidos depois de zoom + ancorar pelo toast (${zoomed} com o zoom; caixa do texto levada pela geometria do clipe)`, bad2.length === 0 && rows2.length > 120 && zoomed > 60, bad2.slice(0, 10))
      result.c1 = { sliders: sl, zoomKeys: ap.keys, measured: rows2.length, zoomed, occluded: occl, offscreen, worst: worst2, bad: bad2.length }
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out2, '-vf', 'select=eq(n\\,165),scale=-2:540', '-frames:v', '1', '-update', '1', join(SHOTS, 'e2e-f6-15-quadro-c1-zoom-ancorado.png')])
      console.log('  📷 e2e-f6-15-quadro-c1-zoom-ancorado.png')
    }
    writeFileSync(join(E2E, 'e2e-f6-result.json'), JSON.stringify({ out, po, yellow, arrow, darkest, g60, gSrc, ...result }, null, 2))
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    await shot('e2e-f6-erro.png')
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
