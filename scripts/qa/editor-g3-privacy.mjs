// QA real de privacidade do G3 ("Procurar dados sensíveis" → efeitos) via CDP no app real, com mídia SINTÉTICA.
//
// Gravação: uma sessão no formato do gravador em <brutos>/<id> (session.json + rec.mp4 H.264 1920×1080 30 qps, 10 s),
// desenhada pelo drawtext do ffmpeg empacotado com a receita de src/main/sensitive/__fixtures__/scanVideos.ts (tela clara
// de app, textfile + y_align=font): 5 valores falsos válidos PARADOS (CPF, CNPJ, e-mail, telefone, cartão) e 4 que ROLAM
// para cima 2 px/quadro de 4 s a 8 s (CPF, e-mail, CNPJ, CEP), entre linhas de texto comum. Verdade: o retângulo de
// TINTA de cada valor (quadro com tudo − quadro sem os valores, n = 0), deslocado pela rolagem em cada quadro da fonte.
//
// No app (só o caminho padrão + ganchos de QA): Histórico → Editar → o clipe da tela vira três: A simples [0, 10 s),
// B = cópia a 1,5× com zoom 1→1,4 e pan em keyframes, C = cópia em reverso a 2× (ops puras pelo window.__qaEditor.ops,
// um passo). Varredura REAL pelo IPC (editor.sensitive.start no rec.mp4, Windows.Media.Ocr) → hideOccurrences pelo store
// (um passo de desfazer; Ctrl+Z / Ctrl+Shift+Z conferidos) → exporta "Original" (1080p) pelo diálogo real.
// Conferência com o ffmpeg em TODO quadro exportado: para cada valor visível (tinta levada ao quadro pela conta do
// renderer: sourceTimeUs → quadro da fonte → window.__qaEditor.clipPoint), a estrutura de caractere some (variância do
// laplaciano < 0,2 × a da fonte nítida ≥ 120 — limite do F2/F6; ruling R22: o contraste local p99−p1 é só medido e
// relatado, com e sem a folga de 4 px, porque o blur de texto escuro sobre claro deixa uma mancha que revela o comprimento,
// não o conteúdo). E o OCR do Windows (helper e detector do app, empacotados por esbuild de editor-g3-lib.ts) em TODO
// quadro exportado (ampliado 2× como a varredura) não acha NENHUM valor verdadeiro nem detecção dentro da tinta deles —
// controle positivo: ele os acha na fonte.
//
// uso (depois de `npm run build`, sob o lock):  node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "node scripts/qa/editor-g3-privacy.mjs"
// Tudo em test-out/e2e-g3 (CIALIGHT_RAW_DIR=test-out/e2e-g3/raw). Screenshots (sintéticos) em docs/qa/editor-g3/e2e-g3-*.png.
// settings.json do usuário: guardSettings (hash antes/depois, restaurado se mudar).
import { spawn, execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import electronPath from 'electron'
import { guardSettings } from './settingsGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9341'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-g3')
const E2E = join(ROOT, 'test-out', 'e2e-g3')
const RAW_REL = 'test-out/e2e-g3/raw'
const RAW = join(ROOT, RAW_REL)
const GEN = join(E2E, 'gen')
const SESSION_ID = 'e2e-g3-gravacao'
const OUT = join(E2E, 'export')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const OCR_SCRIPT = join(ROOT, 'resources', 'ocr', 'ocr-winrt.ps1')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const W = 1920, H = 1080, FPS = 30, DUR_S = 10, NFRAMES = DUR_S * FPS
const S = 1_000_000
const SCROLL = { n0: 120, n1: 240, px: 2 } // rolagem: 2 px/quadro para cima nos quadros (n0, n1]
// métrica do F2/F6 (mesmos limites)
const LEG = { contrast: 0.15, lap: 0.2, minSrcContrast: 120 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
const guard = guardSettings(SETTINGS)

// ---------------------------------------------------------------- biblioteca TS do app (esbuild)
async function loadLib() {
  mkdirSync(E2E, { recursive: true })
  const out = join(E2E, 'g3-lib.mjs')
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'), join(ROOT, 'scripts', 'qa', 'editor-g3-lib.ts'), '--bundle', '--platform=node', '--format=esm', `--alias:@shared=${join(ROOT, 'src', 'shared')}`, `--outfile=${out}`, '--log-level=warning'], { cwd: ROOT, stdio: 'inherit' })
  return import(pathToFileURL(out).href)
}

// ---------------------------------------------------------------- gravação sintética
const FONT = { segoe: '/Windows/Fonts/segoeui.ttf', arial: '/Windows/Fonts/arial.ttf' }
const NORMALS = ['Relatório mensal de vendas por região', 'Clique em Salvar para concluir o cadastro', 'Pedido aguardando aprovação do gerente', 'Última atualização há 5 minutos']

/** Itens: valores falsos válidos (biblioteca de testes do app), sem rótulo colado (a medida da tinta fica só no valor). */
function makeItems(L) {
  const st = { size: 24, font: 'segoe', color: '0x1F1F1F', scroll: false }
  const sc = { size: 24, font: 'arial', color: '0x203060', scroll: true }
  return [
    { kind: 'cpf', value: L.formatCpf(L.fakeCpf(11)), x: 300, y: 180, ...st },
    { kind: 'cnpj', value: L.formatCnpj(L.fakeCnpj(12)), x: 760, y: 180, ...st },
    { kind: 'email', value: L.fakeEmail(13), x: 1260, y: 180, ...st },
    { kind: 'phone', value: L.fakePhone(14, 'paren'), x: 300, y: 300, ...st },
    { kind: 'card', value: L.formatCard(L.fakeCard(15, 'visa'), ' '), x: 760, y: 300, ...st },
    { kind: 'cpf', value: L.formatCpf(L.fakeCpf(21)), x: 300, y: 760, ...sc },
    { kind: 'email', value: L.fakeEmail(22), x: 800, y: 760, ...sc },
    { kind: 'cnpj', value: L.formatCnpj(L.fakeCnpj(23)), x: 300, y: 880, ...sc },
    { kind: 'cep', value: L.fakeCep(24), x: 1300, y: 760, ...sc }
  ].map((it, i) => ({ id: i, ...it }))
}
let tf = 0
function textFile(text) {
  const p = join(GEN, 'txt', `${tf++}.txt`)
  writeFileSync(p, text, 'utf8')
  return `txt/${tf - 1}.txt`
}
const yExpr = (y, scroll) => (scroll ? `${y}-${SCROLL.px}*clip(n-${SCROLL.n0}\\,0\\,${SCROLL.n1 - SCROLL.n0})` : String(y))
/** Filtro (receita do scanVideos.ts): fundo de app, linhas comuns e os valores (`withItems`). */
function filter(items, withItems) {
  const parts = ['drawbox=x=0:y=0:w=1920:h=40:color=0xE1E1E1:t=fill', 'drawbox=x=0:y=40:w=230:h=1040:color=0xEBEBEB:t=fill', 'drawbox=x=250:y=60:w=1650:h=1020:color=0xFFFFFF:t=fill']
  const dt = (text, font, size, x, y, color) => `drawtext=fontfile=${FONT[font]}:textfile=${textFile(text)}:expansion=none:y_align=font:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`
  // linhas comuns a ≥ 30 px dos valores (a janela medida, tinta + 4 px, nunca pega outra linha)
  ;[120, 240, 360, 420].forEach((y, i) => parts.push(dt(NORMALS[i], 'segoe', 20, 300, y, '0x3A3A3A')))
  ;[820, 940, 1000, 1040].forEach((y, i) => parts.push(dt(NORMALS[i], 'arial', 20, 300, yExpr(y, true), '0x3A3A3A')))
  if (withItems) for (const it of items) parts.push(dt(it.value, it.font, it.size, it.x, yExpr(it.y, it.scroll), it.color))
  return `format=rgb24,\n${parts.join(',\n')}`
}
function ffmpegIn(args) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { cwd: GEN, maxBuffer: 1 << 30 })
}
function makeSession(items) {
  const dir = join(RAW, SESSION_ID)
  for (const d of [dir, OUT, join(GEN, 'txt')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(GEN, 'full.filter.txt'), filter(items, true))
  writeFileSync(join(GEN, 'none.filter.txt'), `${filter(items, false)},\nformat=gray`)
  writeFileSync(join(GEN, 'still.filter.txt'), `${filter(items, true)},\nformat=gray`)
  const rec = join(dir, 'rec.mp4')
  ffmpegIn(['-y', '-f', 'lavfi', '-i', `color=c=0xF3F3F3:s=${W}x${H}:r=${FPS}:d=${DUR_S}`, '-/vf', 'full.filter.txt', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '60', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', rec])
  // tinta de cada valor no quadro 0: pixels que diferem (> 24) entre "com valores" e "sem valores", na célula do item
  const still = (f) => ffmpegIn(['-f', 'lavfi', '-i', `color=c=0xF3F3F3:s=${W}x${H}:r=${FPS}:d=1`, '-/vf', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  const full = still('still.filter.txt'), none = still('none.filter.txt')
  for (const it of items) {
    const x1c = Math.min(W, it.x + Math.round(it.value.length * it.size * 0.75) + 20)
    const y0c = it.y - Math.round(it.size * 0.5), y1c = it.y + Math.round(it.size * 1.6)
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1
    for (let y = y0c; y < y1c; y++) for (let x = it.x - 4; x < x1c; x++) {
      const i = y * W + x
      if (Math.abs(full[i] - none[i]) > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    }
    it.ink = x1 >= 0 ? { x0, y0, x1, y1 } : null
  }
  const session = {
    version: 1, id: SESSION_ID, createdAt: new Date().toISOString(), state: 'finalized',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor sintético', bounds: { x: 0, y: 0, width: W, height: H }, scaleFactor: 1 },
    video: { width: W, height: H, fps: FPS, codec: 'avc1.640028', bitrate: 8e6 },
    systemAudio: false, tracks: { screen: 0 }, durationMs: DUR_S * 1000, pauses: [], pip: [], strokes: [], clearEvents: [], markers: [],
    engine: 'webcodecs', files: { rec: 'rec.mp4' }, bytes: statSync(rec).size
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2))
  return rec
}
/** Tinta (px do quadro da fonte, inclusiva) do item no quadro k da fonte. */
function inkAt(it, k) {
  const dy = it.scroll ? -SCROLL.px * Math.min(SCROLL.n1 - SCROLL.n0, Math.max(0, k - SCROLL.n0)) : 0
  return { x0: it.ink.x0, y0: it.ink.y0 + dy, x1: it.ink.x1, y1: it.ink.y1 + dy }
}

// ---------------------------------------------------------------- quadros e métricas (as funções do F6)
/** Lê todos os quadros (rawvideo) de `file` com `vf`, chamando onFrame(n, buf) em fluxo (sem guardar o vídeo inteiro). */
function eachFrame(file, vf, w, h, onFrame) {
  return new Promise((res, rej) => {
    const size = w * h
    const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-vsync', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let buf = Buffer.alloc(size), fill = 0, n = 0
    let chain = Promise.resolve()
    ff.stdout.on('data', (chunk) => {
      let off = 0
      while (off < chunk.length) {
        const k = Math.min(size - fill, chunk.length - off)
        chunk.copy(buf, fill, off, off + k)
        fill += k
        off += k
        if (fill === size) {
          const frame = buf, idx = n++
          chain = chain.then(() => onFrame(idx, frame))
          buf = Buffer.alloc(size)
          fill = 0
        }
      }
    })
    ff.on('error', rej)
    ff.on('close', (code) => (code === 0 ? chain.then(() => res(n), rej) : rej(new Error(`ffmpeg saiu com ${code}`))))
  })
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
function probe(file) {
  const p = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
  const vs = p.streams.find((s) => s.codec_type === 'video')
  return { codec: vs?.codec_name, width: vs?.width, height: vs?.height, duration: Number(p.format.duration), frames: Number(vs?.nb_frames) }
}
/** sourceTimeUs (src/shared/editor/sourceTime.ts), a mesma conta do renderer: corte, velocidade, reverso, travas. */
function sourceTimeUs(m, asset, tUs) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const local = tUs - m.startUs
  let src
  if (m.freeze) src = m.freeze.atUs
  else {
    src = m.reverse ? m.inUs + (m.durationUs - local) * m.speed - Math.round(1e6 / (asset.fps || 30)) : m.inUs + local * m.speed
    src = clamp(Math.round(src), m.inUs, m.inUs + Math.max(0, Math.ceil(m.durationUs * m.speed) - 1))
  }
  const max = asset.durationUs != null ? Math.max(0, asset.durationUs - 1) : Infinity
  return Math.round(clamp(src, 0, max))
}
const norm = (v) => v.toLowerCase().replace(/[^a-z0-9@.]/g, '')
const digits = (v) => v.replace(/\D/g, '')
/** O valor detectado é (ou contém) o verdadeiro? */
const sameValue = (det, truth) => {
  const a = norm(det), b = norm(truth)
  return a === b || a.includes(b) || (digits(b).length >= 8 && digits(a).includes(digits(b)))
}

// ---------------------------------------------------------------- CDP (como o F6)
let app = null, ws = null, seq = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
async function connect() {
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r) => (ws.onopen = r))
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__g3; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 900000 })
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
const HELPERS = `
window.__g3 = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const all = (sel, root = document) => [...root.querySelectorAll(sel)]
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const click = async (e) => { e.scrollIntoView({ block: 'center' }); await settle(); const c = center(e); const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y)); t.dispatchEvent(me('mousedown', c.x, c.y)); window.dispatchEvent(pe('pointerup', c.x, c.y)); t.dispatchEvent(me('mouseup', c.x, c.y)); t.dispatchEvent(me('click', c.x, c.y)); await settle(); return t }
  const key = async (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(400); await settle() }
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  const dialog = () => document.querySelector('[role="dialog"]')
  return { st, settle, wait, all, click, key, past, seek, button, toasts, dialog }
})()
'ok'`

/** Exporta pelo diálogo com o preset `label` para `dir` (vazia); devolve o .mp4 ou null. */
async function exportWith(label, dir) {
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(dir)}; await T.click([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(500)
    await T.click([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))); return 1`)
  const dlg = await ev(`const d = T.dialog(); return { text: d?.textContent ?? '', privacy: d?.querySelector('[data-privacy-warnings]')?.textContent ?? null }`)
  console.log(`  diálogo: ${dlg.text.slice(0, 140)}… avisos de privacidade: ${dlg.privacy}`)
  check('diálogo de exportação sem avisos de privacidade', !dlg.privacy, dlg.privacy)
  await ev(`await T.click(T.button('Exportar', T.dialog())); return 1`)
  let text = ''
  const t0 = Date.now()
  for (let i = 0; i < 3000; i++) {
    text = await ev(`return T.dialog()?.textContent ?? ''`)
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(200)
  }
  console.log(`  exportação "${label}": ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  check(`exportação "${label}" concluída`, text.includes('Vídeo exportado'), text.slice(0, 300))
  await ev(`if (T.dialog()) { await T.click(T.button('Fechar', T.dialog())); await T.wait(300) } return 1`)
  const files = readdirSync(dir).filter((x) => x.endsWith('.mp4'))
  return files.length === 1 ? join(dir, files[0]) : null
}

const result = {}

async function main() {
  rmSync(E2E, { recursive: true, force: true })
  const L = await loadLib()
  mkdirSync(SHOTS, { recursive: true })
  const items = makeItems(L)
  console.log('gravação sintética (formato do gravador) com 5 valores parados e 4 que rolam')
  const rec = makeSession(items)
  const pr = probe(rec)
  check(`fonte: H.264 ${W}×${H}, ${DUR_S} s, ${NFRAMES} quadros; tinta medida dos ${items.length} valores`, pr.codec === 'h264' && pr.width === W && pr.frames === NFRAMES && items.every((i) => i.ink && i.ink.x1 - i.ink.x0 > 40), { pr, ink: items.map((i) => i.ink) })

  // referência nítida (fonte): contraste e laplaciano de cada valor em cada quadro da fonte
  const srcRef = []
  await eachFrame(rec, 'null', W, H, (k, g) => {
    srcRef[k] = items.map((it) => { const b = inkAt(it, k); return { c: localContrast(g, W, H, b), c0: localContrast(g, W, H, b, 0), l: lapVar(g, W, H, b) } })
  })
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', rec, '-vf', 'select=eq(n\\,180),scale=-2:540', '-frames:v', '1', '-update', '1', join(SHOTS, 'e2e-g3-01-fonte.png')])
  console.log('  📷 e2e-g3-01-fonte.png')

  // controle positivo do OCR: na fonte (ampliada 2× como a varredura) ele acha os valores
  const ocr = await L.startOcr(OCR_SCRIPT)
  try {
    const found = []
    await eachFrame(rec, `select='eq(n\\,0)+eq(n\\,180)+eq(n\\,299)',scale=${W * 2}:${H * 2}:flags=lanczos`, W * 2, H * 2, async (i, g) => {
      const det = await ocr.detect(g, W * 2, H * 2)
      found.push(items.filter((it) => det.some((d) => sameValue(d.value, it.value))).length)
    })
    console.log(`  OCR (${ocr.lang}) na fonte: valores achados por quadro ${JSON.stringify(found)} de ${items.length}`)
    check('controle positivo: o OCR do Windows acha os valores na fonte (≥ 7 de 9 em cada quadro)', found.length === 3 && found.every((n) => n >= 7), found)
    result.ocrSource = found
    // --gen-only: só a gravação sintética, a tinta e o controle positivo do OCR (sem abrir o app)
    if (process.argv.includes('--gen-only')) return

    app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
      cwd: ROOT,
      env: { ...process.env, CIALIGHT_QA: 'e2e-g3', CIALIGHT_RAW_DIR: RAW_REL },
      stdio: 'ignore'
    })
    await connect()
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(1500)
    await ev(HELPERS + '; return 1')
    console.log('Histórico → Editar')
    for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
    await ev(`localStorage.setItem('editor.timelineHeight', '260'); window.__navigate('history'); return 1`)
    for (let i = 0; i < 40; i++) {
      if (await ev(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Editar')`)) break
      await sleep(500)
    }
    await ev(`await T.click(T.button('Editar')); return 1`)
    let ready = null
    for (let i = 0; i < 180; i++) {
      ready = await ev(`const s = window.__qaEditor?.store.getState(); if (!s?.project) return null; return { ok: s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]') }`)
      if (ready?.ok) break
      await sleep(1000)
    }
    check('editor abriu a gravação e a ingestão terminou', !!ready?.ok, ready)
    await ev(HELPERS + '; return 1')

    console.log('três clipes da tela: A simples, B 1,5× com zoom + pan em keyframes, C reverso 2×')
    const clips = await ev(`const O = window.__qaEditor.ops; const v = T.st().project.tracks[0].items[0]; const p0 = T.past()
      let B, C
      const ok = T.st().apply((p) => {
        let r = O.duplicateItems(p, [v.id], v.durationUs); let q = r.project; B = r.itemIds[0]
        q = O.setSpeed(q, B, 1.5)
        q = O.updateItem(q, B, (d) => { const t = d.visual.transform
          t.scale = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'inOut' }, { tUs: 3000000, value: 1.4, ease: 'linear' }] }
          t.x = { value: 0.5, keys: [{ tUs: 500000, value: 0.5, ease: 'inOut' }, { tUs: 4000000, value: 0.56, ease: 'linear' }] }
          t.y = { value: 0.5, keys: [{ tUs: 0, value: 0.5, ease: 'linear' }, { tUs: 3000000, value: 0.53, ease: 'linear' }] } })
        const b = O.findItem(q, B).item
        r = O.duplicateItems(q, [v.id], b.startUs + b.durationUs); q = r.project; C = r.itemIds[0]
        q = O.setReverse(q, [C], true)
        return O.setSpeed(q, C, 2)
      })
      const p = T.st().project; const a = p.assets.find((x) => x.id === v.assetId)
      const pick = (id) => { const m = O.findItem(p, id); return { id, track: m.track.name, startUs: m.item.startUs, durationUs: m.item.durationUs, inUs: m.item.inUs, speed: m.item.speed, reverse: m.item.reverse } }
      return { ok, steps: T.past() - p0, assetId: v.assetId, asset: { durationUs: a.durationUs, fps: a.video.fps }, A: pick(v.id), B: pick(B), C: pick(C) }`)
    check('clipes montados num passo (A, B 1,5×, C reverso 2×, na mesma faixa)', clips.ok && clips.steps === 1 && clips.B.speed === 1.5 && clips.C.reverse && clips.C.speed === 2 && clips.A.track === clips.B.track && clips.B.track === clips.C.track, clips)
    result.clips = clips

    console.log('varredura REAL pelo IPC (editor.sensitive.start no rec.mp4)')
    const t0 = Date.now()
    const scan = await ev(`return await new Promise((resolve) => {
        let id = null; const early = []
        const off = window.api.editor.sensitive.onDone((d) => { if (id === null) early.push(d); else if (d.scanId === id) { off(); resolve(d.result) } })
        window.api.editor.sensitive.start({ filePath: ${JSON.stringify(rec)}, fromUs: 0, toUs: ${DUR_S * S} }).then((r) => {
          if (r.error) { off(); resolve({ error: r.error, occurrences: [] }); return }
          id = r.scanId; const d = early.find((x) => x.scanId === id); if (d) { off(); resolve(d.result) }
        })
      })`)
    const scanS = (Date.now() - t0) / 1000
    console.log(`  varredura: ${scanS.toFixed(1)} s, ${scan.occurrences.length} ocorrências, ${scan.framesSampled} amostras (${scan.framesOcr} no OCR), idioma ${scan.lang}, tempos ${JSON.stringify(scan.timings)}`)
    check('varredura sem erro', !scan.error && !scan.cancelled, scan.error)
    // recall: o valor i foi achado se alguma amostra de alguma ocorrência contém o centro da tinta dele naquele quadro
    const recall = items.map((it) => scan.occurrences.some((o) => o.samples.some((s) => {
      const b = inkAt(it, Math.min(NFRAMES - 1, Math.floor((s.tUs * FPS) / S + 1e-6)))
      const cx = (b.x0 + b.x1 + 1) / 2 / W, cy = (b.y0 + b.y1 + 1) / 2 / H
      return cx >= s.box.x && cx <= s.box.x + s.box.w && cy >= s.box.y && cy <= s.box.y + s.box.h
    })))
    const nFound = recall.filter(Boolean).length
    console.log(`  recall da varredura neste vídeo: ${nFound}/${items.length} (${items.map((it, i) => `${it.kind}${it.scroll ? '↑' : ''}:${recall[i] ? 'ok' : 'NÃO'}`).join(', ')})`)
    result.scan = { seconds: scanS, occurrences: scan.occurrences.length, kinds: scan.occurrences.map((o) => `${o.kind} ${o.masked}`), recall: `${nFound}/${items.length}`, timings: scan.timings, framesSampled: scan.framesSampled, framesOcr: scan.framesOcr }
    check(`a varredura achou todos os valores (${nFound}/${items.length})`, nFound === items.length, recall)
    // nada do valor cruza o IPC
    check('ocorrências só com máscara (nenhum valor verdadeiro no resultado do IPC)', !items.some((it) => JSON.stringify(scan).includes(it.value)), null)

    console.log('esconder tudo (hideOccurrences pelo store: um passo)')
    const before = await ev(`return { json: JSON.stringify(T.st().project), past: T.past() }`)
    const hid = await ev(`const O = window.__qaEditor.ops; let r
      const ok = T.st().apply((p) => { r = O.hideOccurrences(p, ${JSON.stringify(clips.assetId)}, ${JSON.stringify(scan.occurrences)}, { style: 'blur' }); return r.project })
      const p = T.st().project; const fx = p.tracks.flatMap((t) => t.items).filter((i) => i.type === 'effect')
      return { ok, past: T.past(), ids: r.itemIds.length, skipped: r.skipped, fx: fx.length, tracks: p.tracks.filter((t) => t.role === 'effects').map((t) => t.name), names: [...new Set(fx.map((f) => f.name))], attached: fx.every((f) => f.attach && f.linkId), json: JSON.stringify(p) }`)
    console.log(`  ${hid.ids} efeitos em ${JSON.stringify(hid.tracks)}; nomes ${JSON.stringify(hid.names)}`)
    check(`um passo de desfazer, ${scan.occurrences.length} ocorrências × 3 clipes = ${hid.ids} efeitos ancorados e vinculados, nada pulado`, hid.ok && hid.past === before.past + 1 && hid.ids === scan.occurrences.length * 3 && hid.fx === hid.ids && hid.attached && hid.skipped.length === 0, { ...hid, json: undefined })
    check('nomes dos efeitos só com máscara', !items.some((it) => hid.names.join(' ').includes(it.value)), hid.names)
    const u = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past() }`)
    check('Ctrl+Z volta ao projeto de antes', u.json === before.json && u.past === before.past, { same: u.json === before.json, past: u.past })
    const rd = await ev(`await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past() }`)
    check('Ctrl+Shift+Z refaz (o mesmo projeto)', rd.json === hid.json && rd.past === hid.past, { same: rd.json === hid.json })

    console.log('exportar "Original" (1080p) pelo diálogo real')
    await ev(`T.st().select([]); for (let i = 0; i < 80 && T.toasts().length; i++) await T.wait(250); return 1`)
    const out = await exportWith('Original', OUT)
    if (!out) return
    const po = probe(out)
    const totalUs = clips.C.startUs + clips.C.durationUs
    check(`exportação H.264 ${W}×${H}, ≈ ${(totalUs / S).toFixed(2)} s`, po.codec === 'h264' && po.width === W && po.height === H && Math.abs(po.duration - totalUs / S) < 0.15, po)

    console.log('verdade de cada quadro exportado: tinta da fonte levada ao quadro (sourceTimeUs → clipPoint)')
    const nOut = Math.round((totalUs * FPS) / S)
    const plan = []
    for (let n = 0; n < nOut; n++) {
      const t = Math.round((n * S) / FPS)
      const c = [clips.A, clips.B, clips.C].find((m) => t >= m.startUs && t < m.startUs + m.durationUs)
      if (!c) { plan.push(null); continue }
      const src = sourceTimeUs(c, clips.asset, t)
      // quadro exibido em src (e os vizinhos: a caixa medida é a união — mais exigente, nunca menos)
      const k = Math.min(NFRAMES - 1, Math.floor((src * FPS) / S + 1e-6))
      const ks = [k - 1, k, k + 1].filter((x) => x >= 0 && x < NFRAMES)
      const boxes = items.map((it) => {
        const bs = ks.map((x) => inkAt(it, x))
        return { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)) + 1, y1: Math.max(...bs.map((b) => b.y1)) + 1 }
      })
      plan.push({ n, t, clip: c.id, k, boxes })
    }
    const mapped = await ev(`const q = window.__qaEditor; return ${JSON.stringify(plan)}.map((r) => r && r.boxes.map((b) => { const a = q.clipPoint(r.clip, r.t, b.x0 / ${W}, b.y0 / ${H}); const c = q.clipPoint(r.clip, r.t, b.x1 / ${W}, b.y1 / ${H}); return a && c ? { x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) } : null }))`)

    console.log('legibilidade em TODO quadro exportado')
    const rows = []
    let offscreen = 0
    const ocrFrames = []
    const decoded = await eachFrame(out, 'null', W, H, (n, g) => {
      const r = plan[n]
      if (!r) return
      r.boxes.forEach((b, i) => {
        const m = mapped[n]?.[i]
        if (!m) { rows.push({ n, i, error: 'clipe invisível' }); return }
        const cb = { x0: Math.max(6, Math.ceil(m.x0)), y0: Math.max(6, Math.ceil(m.y0)), x1: Math.min(W - 7, Math.floor(m.x1) - 1), y1: Math.min(H - 7, Math.floor(m.y1) - 1) }
        if (cb.x1 - cb.x0 < 12 || cb.y1 - cb.y0 < 8) { offscreen++; return }
        const ref = srcRef[r.k][i]
        const c1 = localContrast(g, W, H, cb), l1 = lapVar(g, W, H, cb)
        rows.push({ n, i, clip: r.clip === clips.A.id ? 'A' : r.clip === clips.B.id ? 'B' : 'C', cSrc: +ref.c.toFixed(1), c: +(c1 / ref.c).toFixed(4), lap: +(l1 / ref.l).toFixed(5), cIn: +(localContrast(g, W, H, cb, 0) / ref.c0).toFixed(4) })
      })
    })
    check(`quadros decodificados = ${nOut}`, decoded === nOut, { decoded, nOut })
    // Ruling R22: o oráculo de ilegibilidade por valor × quadro é a ESTRUTURA DE CARACTERE (variância do laplaciano < 0,2
    // × a da fonte nítida, limite do F2/F6) + o OCR do Windows em TODO quadro exportado (abaixo). O contraste local
    // continua medido e relatado, mas não é afirmado para texto escuro sobre claro: o blur de texto escuro sobre branco
    // deixa uma mancha cinza lisa que revela o COMPRIMENTO do texto, não o conteúdo (a borda dura do retângulo
    // desfocado ainda cai na folga de 4 px). Medido com e sem a folga.
    const bad = rows.filter((r) => r.error || !(r.lap < LEG.lap && r.cSrc >= LEG.minSrcContrast))
    const ok = rows.filter((r) => !r.error)
    const worst = ok.reduce((a, r) => (!a || r.c > a.c ? r : a), null)
    const worstIn = ok.reduce((a, r) => (!a || r.cIn > a.cIn ? r : a), null)
    const worstLap = ok.reduce((a, r) => (!a || r.lap > a.lap ? r : a), null)
    const frames = new Set(ok.map((r) => r.n)).size
    const perClip = Object.fromEntries(['A', 'B', 'C'].map((c) => [c, ok.filter((r) => r.clip === c).length]))
    const overPad = ok.filter((r) => r.c >= LEG.contrast), overIn = ok.filter((r) => r.cIn >= LEG.contrast)
    const byItem = {}
    for (const r of overPad) { const k = `${r.i}:${items[r.i]?.kind}${items[r.i]?.scroll ? '↑' : ''}/${r.clip}`; byItem[k] = (byItem[k] ?? 0) + 1 }
    console.log(`  ${ok.length} medidas (valor × quadro) em ${frames} quadros (${JSON.stringify(perClip)}); ${offscreen} fora do quadro (zoom); pior laplaciano ${JSON.stringify(worstLap)}`)
    console.log(`  contraste (só relatado): pior com folga 4 px ${JSON.stringify(worst)}, ${overPad.length} ≥ ${LEG.contrast} ${JSON.stringify(byItem)}; pior só dentro da tinta ${JSON.stringify(worstIn)}, ${overIn.length} ≥ ${LEG.contrast}`)
    check(`estrutura de caractere apagada em TODOS os valores × quadros exportados (laplaciano < ${LEG.lap}, fonte nítida ≥ ${LEG.minSrcContrast})`, bad.length === 0 && frames === nOut && ok.length > nOut * 7, bad.slice(0, 12).map((r) => ({ ...r, item: items[r.i]?.kind })))
    result.legibility = { frames, measured: ok.length, perClip, offscreen, worstLap: worstLap && { ...worstLap, item: items[worstLap.i].kind }, bad: bad.length,
      contrastReported: { worstPad4: worst && { ...worst, item: items[worst.i].kind }, overPad4: overPad.length, overPad4ByItem: byItem, worstInside: worstIn && { ...worstIn, item: items[worstIn.i].kind }, overInside: overIn.length } }

    console.log('OCR do Windows em TODO quadro exportado (ampliado 2× como a varredura)')
    let ocrN = 0
    await eachFrame(out, `scale=${W * 2}:${H * 2}:flags=lanczos`, W * 2, H * 2, async (n, g) => {
      const det = await ocr.detect(g, W * 2, H * 2)
      ocrN++
      if (ocrN % 100 === 0) console.log(`  … ${ocrN} quadros no OCR`)
      const leaks = items.filter((it) => det.some((d) => sameValue(d.value, it.value))).map((it) => it.kind)
      // qualquer detecção cuja caixa cruza a tinta de um valor verdadeiro neste quadro
      const rects = (mapped[n] ?? []).filter(Boolean).map((m) => ({ x0: m.x0 / W, y0: m.y0 / H, x1: m.x1 / W, y1: m.y1 / H }))
      const inside = det.filter((d) => rects.some((r) => d.box.x < r.x1 && d.box.x + d.box.w > r.x0 && d.box.y < r.y1 && d.box.y + d.box.h > r.y0)).map((d) => d.kind)
      ocrFrames.push({ n, detections: det.length, kinds: det.map((d) => d.kind), leaks, inside })
    })
    const leaky = ocrFrames.filter((f) => f.leaks.length || f.inside.length)
    const nDet = ocrFrames.reduce((a, f) => a + f.detections, 0)
    console.log(`  ${ocrN} quadros no OCR; detecções (qualquer coisa) ${nDet}; quadros com valor verdadeiro ou detecção na tinta: ${leaky.length}`)
    check(`o OCR não acha NENHUM valor verdadeiro nem detecção dentro da tinta em TODOS os ${ocrN} quadros exportados`, leaky.length === 0 && ocrN === nOut, leaky.slice(0, 10))
    // R22: zero detecções de QUALQUER tipo (uma leitura parcial fora da tinta estimada também não pode passar)
    check(`o OCR não acha nenhuma detecção de qualquer tipo em todos os ${ocrN} quadros (${nDet})`, nDet === 0 && ocrN === nOut, ocrFrames.filter((x) => x.detections > 0).slice(0, 10).map((x) => ({ n: x.n, kinds: x.kinds })))
    result.ocrExport = { frames: ocrN, detections: nDet, leakyFrames: leaky.length, insideTruth: ocrFrames.reduce((a, f) => a + f.inside.length, 0), detectedKinds: [...new Set(ocrFrames.flatMap((f) => f.kinds))] }

    for (const [name, t] of [['e2e-g3-02-exportado-plano.png', 6 * S], ['e2e-g3-03-exportado-zoom.png', clips.B.startUs + 3.5 * S]]) {
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-vf', `select=eq(n\\,${Math.round((t * FPS) / S)}),scale=-2:540`, '-frames:v', '1', '-update', '1', join(SHOTS, name)])
      console.log(`  📷 ${name}`)
    }
    writeFileSync(join(E2E, 'e2e-g3-result.json'), JSON.stringify({ out, po, ...result }, null, 2))
  } finally {
    await ocr.close().catch(() => {})
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    if (ws) await shot('e2e-g3-erro.png')
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
      // só o PID iniciado aqui (nunca por nome de imagem: o app instalado tem o mesmo executável)
      execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // já saiu
    }
  }
  await sleep(500)
  failures += guard.finish()
  console.log(JSON.stringify(result, null, 2))
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
