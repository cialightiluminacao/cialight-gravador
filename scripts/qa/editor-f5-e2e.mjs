// E2E do editor F5 (textos, formas, transições, legendas e modelos de marca) via CDP, com eventos sintéticos despachados
// no elemento real sob o ponto (document.elementFromPoint) e DragEvents com DataTransfer — nunca entrada do sistema
// operacional. Os diálogos de salvar SRT são trocados por um caminho de teste (CIALIGHT_QA_SRT_SAVE) e os modelos de
// marca vão para uma pasta de teste (CIALIGHT_BRAND_DIR).
//
// Gera dois vídeos sintéticos 1920×1080 de 4 s: A azul liso com um quadrado branco (o "dado sensível") em
// (1500, 180) 160×160; B laranja liso. No app: Projetos → Novo projeto, importa e solta A em 0 e B encostado (dois
// clipes); (1) arrasta o cartão "Dissolver" até o corte e alarga a transição pela borda direita do ícone; (2) Título
// pelo atalho T em 1 s, edição direta por duplo clique no visualizador, cor amarela e fundo no inspetor; Holofote
// (cartão) mais adiante em B; Tarja desenhada (B + "Tarja" no inspetor) sobre o quadrado de A; (3) 3 legendas pela aba
// Legendas (botão + Enter) e "Exportar SRT…"; (4) salva o Título como modelo de marca "Abertura" e "Usar como
// abertura": tudo anda a duração do modelo, a tarja continua sobre o quadrado (pixels do preview); (5) exporta "Alta
// 1080p" com "Queimar no vídeo" + "Salvar arquivo .srt ao lado"; com o ffmpeg: duração, mistura no meio da transição,
// título amarelo com fundo, caixa escura da legenda com letras brancas, título da abertura, o quadrado branco NUNCA
// visível em nenhum quadro do arquivo, e o .srt ao lado com os tempos deslocados; (6) desfaz tudo passo a passo até
// o estado inicial (contagem esperada) e refaz até o fim.
//
// uso (depois de `npm run build`; SEMPRE sob o lock das execuções do Electron):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs node scripts/qa/editor-f5-e2e.mjs
// Tudo em test-out/e2e-f5 (CIALIGHT_RAW_DIR=test-out/e2e-f5/raw → projetos em test-out/e2e-f5/Projetos). Screenshots em
// docs/qa/editor-f5/e2e-f5-*.png (só mídia sintética). settings.json: hash antes/depois (só `pip` regravado pelo app é
// aceito, restaurado); brand-templates.json/brand-assets reais do usuário: nem criados nem alterados.
import { spawn, execFileSync } from 'child_process'
import { guardSettings, sha } from './settingsGuard.mjs'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9338'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f5')
const E2E = join(ROOT, 'test-out', 'e2e-f5')
const RAW_REL = 'test-out/e2e-f5/raw'
const MEDIA = join(E2E, 'media')
const OUT = join(E2E, 'export')
const SRT_SAVE = join(E2E, 'legendas.srt')
const BRAND_REL = 'test-out/e2e-f5/brand'
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const APPDATA_DIR = join(process.env.APPDATA ?? '', 'cialight-gravador')
const SETTINGS = join(APPDATA_DIR, 'settings.json')
const REAL_BRAND = join(APPDATA_DIR, 'brand-templates.json')
const REAL_BRAND_ASSETS = join(APPDATA_DIR, 'brand-assets')
const W = 1920
const H = 1080
const FPS = 30
const S = 1_000_000
const CLIP_S = 4
const BLUE = '0x2563eb'
const ORANGE = '0xf59e0b'
// o "dado sensível" de A e a tarja desenhada por cima (com folga)
const SQ = { x: 1500, y: 180, w: 160, h: 160 }
const TARJA = { x0: SQ.x - 30, y0: SQ.y - 30, x1: SQ.x + SQ.w + 30, y1: SQ.y + SQ.h + 30 }
const BG_PT = { x: 300, y: 700 } // fundo liso: longe do título (centro), da legenda (embaixo) e do quadrado
const TITLE_TEXT = 'Olá F5'
const CAPTIONS = ['Primeira legenda', 'Segunda — ação', 'Terceira legenda']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol) => Math.abs(a - b) <= tol
mkdirSync(SHOTS, { recursive: true })
const settings = guardSettings(SETTINGS)
const realBrandState = () => ({
  file: existsSync(REAL_BRAND) ? sha(readFileSync(REAL_BRAND)) : 'ausente',
  assets: existsSync(REAL_BRAND_ASSETS) ? readdirSync(REAL_BRAND_ASSETS).sort().join(',') + `@${statSync(REAL_BRAND_ASSETS).mtimeMs}` : 'ausente'
})
const realBefore = realBrandState()

let failures = 0
let checks = 0
function check(name, ok, detail) {
  checks++
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// ---- SRT canônico (o mesmo formato de src/shared/editor/srt.ts serializeSrt) ----
const p2 = (n, w = 2) => String(n).padStart(w, '0')
const srtTime = (us) => {
  const t = Math.round(us / 1000)
  return `${p2(Math.floor(t / 3_600_000))}:${p2(Math.floor(t / 60_000) % 60)}:${p2(Math.floor(t / 1000) % 60)},${p2(t % 1000, 3)}`
}
const serialize = (cues) => cues.map((c, i) => `${i + 1}\r\n${srtTime(c.startUs)} --> ${srtTime(c.endUs)}\r\n${c.text.split('\n').join('\r\n')}\r\n`).join('\r\n')
const readSrt = (f) => {
  const b = readFileSync(f)
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  return { bom, text: b.subarray(bom ? 3 : 0).toString('utf8') }
}

// ---- mídia sintética e leitura do arquivo exportado ----
function makeMedia() {
  rmSync(E2E, { recursive: true, force: true })
  for (const d of [MEDIA, OUT]) mkdirSync(d, { recursive: true })
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '30', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart']
  const a = join(MEDIA, 'a-azul-quadrado.mp4')
  const b = join(MEDIA, 'b-laranja.mp4')
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${BLUE}:s=${W}x${H}:r=${FPS}:d=${CLIP_S}`, '-vf', `drawbox=x=${SQ.x}:y=${SQ.y}:w=${SQ.w}:h=${SQ.h}:color=white:t=fill`, ...enc, a])
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${ORANGE}:s=${W}x${H}:r=${FPS}:d=${CLIP_S}`, ...enc, b])
  return { a, b }
}
function frame(file, n) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 })
}
/** Recorte (x, y, w, h) de TODOS os quadros do arquivo, rgb24 em sequência. */
function cropAll(file, r) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 512 << 20 })
}
function probe(file) {
  const p = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
  const vs = p.streams.find((s) => s.codec_type === 'video')
  return { codec: vs?.codec_name, width: vs?.width, height: vs?.height, duration: Number(p.format.duration), frames: Number(vs?.nb_frames) }
}
const px = (buf, w, x, y) => { const i = (y * w + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]] }
/** Média de um quadrado n×n centrado em (x, y) num quadro w×h rgb24. */
function patchAt(buf, x, y, n = 9, w = W) {
  const m = [0, 0, 0]
  for (let j = -(n >> 1); j <= n >> 1; j++) for (let i = -(n >> 1); i <= n >> 1; i++) { const c = px(buf, w, x + i, y + j); for (let k = 0; k < 3; k++) m[k] += c[k] / (n * n) }
  return m.map(Math.round)
}
/** Conta pixels por predicado num retângulo do quadro. */
function countIn(buf, r, pred, w = W) {
  let n = 0
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (pred(px(buf, w, x, y))) n++
  return n
}
const isWhite = (c) => c[0] > 200 && c[1] > 200 && c[2] > 200
const isYellow = (c) => c[0] > 190 && c[1] > 190 && c[2] < 90

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
          } else if (m.method === 'Runtime.exceptionThrown') console.log(`  [página] exceção: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`)
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__f5; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 300000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await sleep(300)
  // a captura pode não voltar com a janela sem pintar: não trava o E2E
  const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(20000).then(() => null)])
  if (!r?.result?.data) return console.log(`  (sem captura: ${name})`)
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  [captura] ${name}`)
}

const HELPERS = `
window.__f5 = (() => {
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
  const click = async (e, mods) => { e.scrollIntoView({ block: 'nearest' }); const c = center(e); return clickAt(c.x, c.y, mods) }
  /** Clique direto no elemento (botões de diálogo/listas que podem estar sob outra camada). */
  const press = async (e) => {
    const { x, y } = center(e)
    e.dispatchEvent(pe('pointerdown', x, y)); e.dispatchEvent(me('mousedown', x, y))
    e.dispatchEvent(pe('pointerup', x, y)); e.dispatchEvent(me('mouseup', x, y)); e.dispatchEvent(me('click', x, y))
    await settle()
  }
  const dblclickAt = async (x, y) => {
    const t = topAt(x, y)
    for (const n of [1, 2]) {
      t.dispatchEvent(pe('pointerdown', x, y)); t.dispatchEvent(me('mousedown', x, y))
      window.dispatchEvent(pe('pointerup', x, y)); t.dispatchEvent(me('mouseup', x, y)); t.dispatchEvent(me('click', x, y))
    }
    t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 2 }))
    await settle()
    return t
  }
  async function drag(from, to, opts = {}) {
    const steps = opts.steps ?? 10
    const t = topAt(from.x, from.y)
    t.dispatchEvent(pe('pointerdown', from.x, from.y))
    for (let i = 1; i <= steps; i++) window.dispatchEvent(pe('pointermove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps))
    await settle()
    window.dispatchEvent(pe('pointerup', to.x, to.y)); await settle()
    return t
  }
  const key = async (k, mods, target) => { (target || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items)
  const item = (id) => items().find((i) => i.id === id)
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(600); await settle() }
  const toScreen = (x, y) => { const r = el('[data-viewer-overlay]').getBoundingClientRect(); const k = r.width / st().project.canvas.width; return { x: r.left + x * k, y: r.top + y * k } }
  const xOf = (us) => { const r = el('[data-timeline-ruler]').getBoundingClientRect(); const s = st(); return r.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6 }
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const setNative = (e, v) => {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v)
    e.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  const dialog = () => document.querySelector('[role="dialog"]')
  const region = async (x, y, w, h) => {
    const r = window.__qaEditor.engine.render
    const k = (r.size.width * r.size.dpr) / st().project.canvas.width
    return r.readPixels(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
  }
  const patch = async (x, y, n = 9) => {
    const p = await region(x - (n >> 1), y - (n >> 1), n, n)
    const c = p.length / 4, m = [0, 0, 0]
    for (let i = 0; i < c; i++) for (let j = 0; j < 3; j++) m[j] += p[i * 4 + j] / c
    return m.map(Math.round)
  }
  const whiteIn = async (x, y, w, h) => { const p = await region(x, y, w, h); let n = 0; for (let i = 0; i < p.length; i += 4) if (p[i] > 200 && p[i + 1] > 200 && p[i + 2] > 200) n++; return n }
  const handleBox = (id) => {
    const h = el('[data-media-handles="' + id + '"]'); const o = el('[data-viewer-overlay]').getBoundingClientRect(); const k = o.width / st().project.canvas.width
    const r = h.getBoundingClientRect()
    return { x: (r.left - o.left) / k, y: (r.top - o.top) / k, w: r.width / k, h: r.height / k }
  }
  const outline = (id) => {
    const e = document.querySelector('[data-region-outline="' + id + '"], [data-region-handles="' + id + '"]')
    if (!e) return null
    const r = e.getBoundingClientRect(); const o = el('[data-viewer-overlay]').getBoundingClientRect(); const k = o.width / st().project.canvas.width
    return { x0: (r.left - o.left) / k, y0: (r.top - o.top) / k, x1: (r.right - o.left) / k, y1: (r.bottom - o.top) / k }
  }
  const tab = async (label) => { const t = all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').find((x) => x.textContent.trim() === label); if (!t) throw new Error('aba ' + label); t.dispatchEvent(pe('pointerdown', 0, 0)); t.dispatchEvent(me('mousedown', 0, 0)); t.click(); await settle(); await wait(250) }
  const lanePoint = (us, trackId) => {
    const s = st(); const lr = el('[data-track-id="' + trackId + '"]').getBoundingClientRect()
    return { x: lr.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6, y: lr.top + lr.height / 2 }
  }
  const dragCard = async (card, pt) => {
    const dt = new DataTransfer()
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const target = topAt(pt.x, pt.y)
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, dataTransfer: dt })
    target.dispatchEvent(over)
    await settle()
    const highlight = document.querySelector('[data-cut-highlight]')?.getAttribute('data-cut-highlight') ?? null
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, dataTransfer: dt }))
    await settle()
    return { types: [...dt.types], highlight, accepted: over.defaultPrevented }
  }
  const videoTrack = () => st().project.tracks.find((t) => t.kind === 'video')
  const inspector = () => el('aside[aria-label="Inspetor"]')
  const capTrack = () => st().project.tracks.find((t) => t.role === 'captions')
  const caps = () => (capTrack()?.items ?? []).map((i) => ({ id: i.id, startUs: i.startUs, endUs: i.startUs + i.durationUs, text: i.text }))
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150) } return null }
  const brandRow = (name) => all('[data-brand-template]').find((r) => r.querySelector('[data-brand-name]').textContent.trim() === name)
  /** Estado comparável do projeto (o que o desfazer/refazer tem de devolver). */
  const snap = () => { const p = st().project; return JSON.stringify({ tracks: p.tracks, markers: p.markers }) }
  return { st, settle, wait, el, all, center, topAt, clickAt, click, press, dblclickAt, drag, key, items, item, past, seek, toScreen, xOf, button, setNative, toasts, dialog, region, patch, whiteIn, handleBox, outline, tab, lanePoint, dragCard, videoTrack, inspector, capTrack, caps, waitFor, brandRow, snap }
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

async function main() {
  console.log('gerando os vídeos de teste (A azul com quadrado branco, B laranja)…')
  const media = makeMedia()

  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    // CIALIGHT_QA (qualquer valor) libera o lock de instância única e habilita os caminhos de teste (SRT, modelos)
    env: { ...process.env, CIALIGHT_QA: 'e2e-f5', CIALIGHT_RAW_DIR: RAW_REL, CIALIGHT_BRAND_DIR: BRAND_REL, CIALIGHT_QA_SRT_SAVE: SRT_SAVE },
    stdio: 'ignore'
  })
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await ev(HELPERS + '; return 1')

  // ------------------------------------------------------------------ 0
  console.log('0. Projetos → Novo projeto; importar A e B e soltar encostados (dois clipes)')
  await ev(`localStorage.setItem('editor.timelineHeight', '300'); window.__navigate('projects'); return 1`)
  await sleep(800)
  await ev(`await T.click(T.button('Novo projeto')); await T.wait(300); const d = T.dialog(); T.setNative(d.querySelector('input'), 'E2E textos e transições'); await T.settle(); await T.click(T.button('Criar e abrir', d)); return 1`)
  for (let i = 0; i < 60; i++) {
    if (await ev(`return !!window.__qaEditor?.store.getState().project`)) break
    await sleep(500)
  }
  await ev(HELPERS + '; return 1')
  const proj = await ev(`const p = T.st().project; return { id: p.id, name: p.name, w: p.canvas.width, h: p.canvas.height }`)
  check('projeto novo "E2E textos e transições" aberto em 1920×1080', proj.name === 'E2E textos e transições' && proj.w === W && proj.h === H, proj)
  const imp = await ev(`const a = await window.__qaEditor.importPaths(${JSON.stringify([media.a, media.b])}); return a.map((x) => x.id)`)
  for (let i = 0; i < 90; i++) {
    if (await ev(`return T.st().project.assets.length === 2 && T.st().project.assets.every((a) => a.status === 'ready')`)) break
    await sleep(1000)
  }
  await waitEditor()
  const placed = await ev(`const drop = async (assetId, us, trackId) => { const pt = T.lanePoint(us, trackId); const dt = new DataTransfer(); dt.setData('application/x-cialight-asset', assetId)
      T.topAt(pt.x + 2, pt.y).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: pt.x + 2, clientY: pt.y, dataTransfer: dt })); await T.settle(); await T.wait(200) }
    await drop('${imp[0]}', 0, T.videoTrack().id)
    await T.key('Z', { shiftKey: true }); await T.wait(200)
    const a = T.items().find((i) => i.assetId === '${imp[0]}' && i.visual)
    await drop('${imp[1]}', a.startUs + a.durationUs, T.st().project.tracks.find((t) => t.items.some((i) => i.id === a.id)).id)
    await T.key('Z', { shiftKey: true }); T.st().select([]); await T.wait(200)
    const b = T.items().find((i) => i.assetId === '${imp[1]}' && i.visual)
    const tr = (id) => T.st().project.tracks.find((t) => t.items.some((i) => i.id === id))?.id
    return { a: a && { id: a.id, start: a.startUs, dur: a.durationUs, track: tr(a.id) }, b: b && { id: b.id, start: b.startUs, dur: b.durationUs, track: tr(b.id) } }`)
  check('A em 0 e B encostado no fim de A, na mesma faixa (4 s cada)', placed.a?.start === 0 && placed.b?.start === placed.a.start + placed.a.dur && placed.a.track === placed.b.track && near(placed.a.dur, CLIP_S * S, 40_000) && near(placed.b.dur, CLIP_S * S, 40_000), placed)
  const A = placed.a.id
  const B = placed.b.id
  const track = placed.a.track
  const past0 = await ev(`return T.past()`)
  const snap0 = await ev(`return T.snap()`)
  let steps = 0 // passos de desfazer esperados a partir daqui
  /** Confere que o gesto gravou exatamente um passo. */
  const oneStep = (label, before, after) => {
    check(`${label}: um passo de desfazer`, after === before + 1, { before, after })
    steps++
  }

  // ------------------------------------------------------------------ 1
  console.log('1. Dissolver arrastado até o corte; borda do ícone muda a duração')
  let cut = placed.b.start
  let trDur = 0
  {
    const r = await ev(`await T.tab('Transições'); const p0 = T.past()
      const d = await T.dragCard(T.el('[data-transition-kind="crossfade"]'), T.lanePoint(${cut} + 40000, '${track}'))
      await T.wait(400)
      const icon = document.querySelector('[data-transition-id="${B}"] [data-transition-icon]')
      return { d, p0, past: T.past(), tr: T.item('${B}').transitionIn ?? null, label: icon?.getAttribute('aria-label') }`)
    check('arrastando o cartão sobre o corte ele é realçado (ok) e soltar grava Dissolver 0,5 s em B', r.d.highlight === 'ok' && r.d.accepted && r.tr?.kind === 'crossfade' && r.tr?.durationUs === 500000 && r.label === 'Transição: Dissolver, 0,5 s', r)
    oneStep('soltar a transição', r.p0, r.past)
    const e = await ev(`const p0 = T.past(); const d0 = T.item('${B}').transitionIn.durationUs
      const edge = document.querySelector('[data-transition-id="${B}"] [data-tedge="end"]'); const c = T.center(edge)
      await T.drag(c, { x: c.x + 20, y: c.y }, { steps: 10 }); await T.wait(300)
      return { p0, past: T.past(), d0, d1: T.item('${B}').transitionIn.durationUs, pps: T.st().zoomPxPerSec }`)
    check('arrastar a borda direita do ícone 20 px alarga a transição (≈ +2×20 px de tempo)', e.d1 > e.d0 && near(e.d1 - e.d0, (2 * 20 * S) / e.pps, 80_000), e)
    oneStep('alargar pela borda', e.p0, e.past)
    trDur = e.d1
    await shot('e2e-f5-01-transicao.png')
  }

  // ------------------------------------------------------------------ 2
  console.log('2. Título (T) com edição direta, cor e fundo; Holofote; Tarja sobre o quadrado de A')
  let titleId
  let fxId
  {
    const r = await ev(`document.activeElement?.blur?.(); T.st().select([]); await T.seek(${1 * S}); const p0 = T.past()
      await T.key('t'); await T.wait(300)
      const id = T.st().selection[0]; const it = T.item(id)
      return { p0, past: T.past(), id, type: it?.type, text: it?.text, start: it?.startUs, dur: it?.durationUs }`)
    titleId = r.id
    check('T cria o Título no playhead (1 s, 3 s), selecionado', r.type === 'text' && r.text === 'Título' && r.start === 1 * S && r.dur === 3 * S, r)
    oneStep('atalho T', r.p0, r.past)
    const ed = await ev(`await T.seek(${2.5 * S}); await T.wait(600)
      const box = T.handleBox('${titleId}'); const c = T.toScreen(box.x + box.w / 2, box.y + box.h / 2); await T.dblclickAt(c.x, c.y); await T.wait(200)
      const ta = document.querySelector('[data-text-editor]'); const p0 = T.past()
      if (!ta) return { open: false }
      T.setNative(ta, ${JSON.stringify(TITLE_TEXT)}); await T.key('Enter', { ctrlKey: true }, ta); await T.wait(300)
      return { open: true, p0, past: T.past(), text: T.item('${titleId}').text, closed: !document.querySelector('[data-text-editor]') }`)
    check(`duplo clique no visualizador abre a edição direta; Ctrl+Enter grava "${TITLE_TEXT}"`, ed.open && ed.closed && ed.text === TITLE_TEXT, ed)
    oneStep('edição direta', ed.p0, ed.past)
    const col = await ev(`T.st().select(['${titleId}']); await T.settle(); await T.wait(300); const p0 = T.past()
      const inp = T.inspector().querySelector('input[type="color"][aria-label="Cor do texto"]')
      inp.focus(); T.setNative(inp, '#ffff00'); inp.dispatchEvent(new Event('change', { bubbles: true })); await T.settle(); inp.blur(); await T.settle(); await T.wait(300)
      return { p0, past: T.past(), color: T.item('${titleId}').style.color }`)
    check('cor do texto amarela (#ffff00) pelo inspetor', col.color === '#ffff00', col)
    oneStep('cor do texto', col.p0, col.past)
    const bg = await ev(`const p0 = T.past(); const sw = T.inspector().querySelector('button[role="switch"][aria-label="Fundo"]'); await T.click(sw); await T.wait(700)
      const box = T.handleBox('${titleId}')
      const p = await T.region(box.x, box.y, box.w, box.h); let yellow = 0, dark = 0
      for (let i = 0; i < p.length; i += 4) { if (p[i] > 190 && p[i + 1] > 190 && p[i + 2] < 90) yellow++; if (p[i] < 40 && p[i + 1] < 50 && p[i + 2] < 90) dark++ }
      return { p0, past: T.past(), bgv: T.item('${titleId}').style.background, yellow, dark, box }`)
    check('fundo ligado (#000000b3): no preview, letras amarelas sobre a caixa escura', bg.bgv === '#000000b3' && bg.yellow > 300 && bg.dark > 2000, bg)
    oneStep('fundo do texto', bg.p0, bg.past)
    await shot('e2e-f5-02-titulo.png')

    const sp = await ev(`await T.tab('Texto'); const p0 = T.past()
      const d = await T.dragCard(T.el('[data-shape-preset="spotlight"]'), T.lanePoint(${cut + 1.5 * S}, '${track}')); await T.wait(500)
      const sh = T.items().find((i) => i.type === 'shape')
      return { d, p0, past: T.past(), sh: sh && { id: sh.id, start: sh.startUs, dur: sh.durationUs, spot: sh.spotlight } }`)
    check('Holofote solto em B (cerca de corte + 1,5 s) com escurecimento 0,6', !!sp.sh && sp.sh.spot?.dim === 0.6 && sp.sh.start >= cut + 1 * S, sp)
    oneStep('Holofote', sp.p0, sp.past)
    const spx = await ev(`T.st().select([]); await T.seek(${sp.sh ? sp.sh.start + 0.5 * S : cut + 2 * S}); await T.wait(600)
      return { corner: await T.patch(120, 120), center: await T.patch(960, 540) }`)
    const lum = (c) => (c[0] + c[1] + c[2]) / 3
    check('Holofote: o canto escurece e o centro fica com a cor de B', lum(spx.corner) < lum(spx.center) * 0.6, spx)
    await shot('e2e-f5-03-holofote.png')

    const fx = await ev(`await T.seek(0); T.st().select([]); await T.settle(); const p0 = T.past()
      await T.key('b'); await T.drag(T.toScreen(${TARJA.x0}, ${TARJA.y0}), T.toScreen(${TARJA.x1}, ${TARJA.y1})); await T.wait(200)
      const id = T.st().selection[0]; await T.key('b'); const p1 = T.past()
      await T.click(T.all('[role="radio"]', T.inspector()).find((b) => b.textContent.trim() === 'Tarja')); await T.wait(300)
      const f = T.item(id)
      return { p0, p1, past: T.past(), id, effect: f?.effect, start: f?.startUs, dur: f?.durationUs, linked: !!f?.linkId && f.linkId === T.item('${A}').linkId }`)
    check('Tarja (desenhada com B no início, tipo trocado no inspetor) vinculada a A, de 0 ao fim de A', fx.effect === 'solid' && fx.start === 0 && fx.dur === placed.a.dur && fx.linked, fx)
    oneStep('desenhar o efeito', fx.p0, fx.p1)
    oneStep('trocar para Tarja', fx.p1, fx.past)
    fxId = fx.id
    const cov = await ev(`T.st().select([]); await T.settle(); const out = []
      for (const t of [${0.2 * S}, ${1 * S}, ${cut - 0.1 * S}, ${cut}]) { await T.seek(t); await T.wait(300); out.push([t, await T.whiteIn(${SQ.x}, ${SQ.y}, ${SQ.w}, ${SQ.h})]) }
      return out`)
    check('preview: o quadrado branco coberto pela tarja em 0,2 s, 1 s, antes do corte e no corte (0 px brancos)', cov.every(([, n]) => n === 0), cov)
    await shot('e2e-f5-04-tarja.png')
  }

  // ------------------------------------------------------------------ 3
  console.log('3. três legendas (botão + Enter) e Exportar SRT')
  {
    const r = await ev(`document.activeElement?.blur?.(); T.st().select([]); await T.tab('Legendas'); await T.seek(${1 * S}); const p0 = T.past()
      await T.click(T.el('[data-caption-add]')); await T.wait(200); await T.settle()
      const p1 = T.past()
      const typeEnter = async (text) => { const a = document.activeElement; T.setNative(a, text); await T.settle(); await T.key('Enter', {}, a); await T.wait(150); await T.settle() }
      await typeEnter(${JSON.stringify(CAPTIONS[0])}); const p2 = T.past()
      await typeEnter(${JSON.stringify(CAPTIONS[1])}); const p3 = T.past()
      const a = document.activeElement; const inLast = a?.matches('[data-caption-text]')
      T.setNative(a, ${JSON.stringify(CAPTIONS[2])}); a.blur(); await T.settle(); await T.wait(200)
      return { p0, p1, p2, p3, inLast, past: T.past(), caps: T.caps() }`)
    check('3 legendas: 1–3 s, 3–5 s, 5–7 s com os textos digitados', r.inLast && JSON.stringify(r.caps.map((c) => [c.startUs / S, c.endUs / S, c.text])) === JSON.stringify([[1, 3, CAPTIONS[0]], [3, 5, CAPTIONS[1]], [5, 7, CAPTIONS[2]]]), r.caps)
    oneStep('Nova legenda no playhead', r.p0, r.p1)
    oneStep('Enter (texto + próxima)', r.p1, r.p2)
    oneStep('Enter (texto + próxima)', r.p2, r.p3)
    oneStep('texto da última (perder o foco)', r.p3, r.past)
    await shot('e2e-f5-05-legendas.png')
    const e = await ev(`const p0 = T.past(); await T.click(T.el('[data-caption-export]')); await T.waitFor(() => T.toasts().some((t) => t.includes('exportadas')), 8000)
      return { p0, past: T.past(), toasts: T.toasts() }`)
    const got = existsSync(SRT_SAVE) ? readSrt(SRT_SAVE) : null
    check('Exportar SRT: toast "3 legendas exportadas", nenhum passo de desfazer', e.toasts.some((t) => t.includes('3 legendas exportadas')) && e.past === e.p0, e)
    check('SRT no caminho de teste: UTF-8 com BOM e conteúdo canônico', !!got?.bom && got.text === serialize(r.caps), { got: got?.text, want: serialize(r.caps) })
  }

  // ------------------------------------------------------------------ 4
  console.log('4. Título → modelo de marca "Abertura"; "Usar como abertura"')
  let D = 0
  {
    const s = await ev(`document.activeElement?.blur?.(); await T.tab('Modelos'); T.st().select(['${titleId}']); await T.settle(); await T.wait(200); const p0 = T.past()
      await T.click(T.el('[data-brand-save]')); await T.wait(300)
      const dlg = T.el('[data-brand-save-dialog]')
      const inp = T.el('[data-brand-name-input]'); inp.focus(); T.setNative(inp, 'Abertura E2E'); await T.settle()
      await T.press([...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Abertura'))
      await T.press(T.el('[data-brand-save-confirm]'))
      const row = await T.waitFor(() => T.brandRow('Abertura E2E'))
      return { p0, past: T.past(), row: row ? row.textContent : null }`)
    check('modelo "Abertura E2E" salvo (Abertura · 3 s), sem passo de desfazer no projeto', /Abertura · 3 s/.test(s.row ?? '') && s.past === s.p0, s)
    const disk = existsSync(join(ROOT, BRAND_REL, 'brand-templates.json')) ? JSON.parse(readFileSync(join(ROOT, BRAND_REL, 'brand-templates.json'), 'utf8')) : null
    check('arquivo de modelos na pasta de TESTE com o título (texto, cor e fundo)', disk?.templates?.[0]?.kind === 'intro' && disk.templates[0].tracks.flatMap((t) => t.items).some((i) => i.type === 'text' && i.text === TITLE_TEXT && i.style.color === '#ffff00'), disk?.templates?.[0]?.name)
    const r = await ev(`const before = T.items().map((i) => ({ id: i.id, startUs: i.startUs })); const p0 = T.past()
      await T.click(T.brandRow('Abertura E2E').querySelector('[data-brand-action="intro"]'))
      await T.waitFor(() => T.past() > p0); await T.wait(400)
      const added = T.items().filter((i) => !before.some((b) => b.id === i.id))
      const deltas = before.map((b) => T.item(b.id).startUs - b.startUs)
      return { p0, past: T.past(), deltas, added: added.map((i) => ({ id: i.id, type: i.type, text: i.text, start: i.startUs, dur: i.durationUs })), tr: T.item('${B}').transitionIn, fx: T.item('${fxId}'), a: T.item('${A}').startUs, aLink: T.item('${A}').linkId, toasts: T.toasts() }`)
    D = r.added[0]?.dur ?? 0
    check('abertura: o título do modelo entra em 0 (3 s)', r.added.length === 1 && r.added[0].type === 'text' && r.added[0].text === TITLE_TEXT && r.added[0].start === 0 && r.added[0].dur === 3 * S, r.added)
    check('tudo o que existia andou a duração do modelo (3 s): clipes, título, Holofote, tarja, legendas', D === 3 * S && r.deltas.every((d) => d === D), r.deltas)
    check('a transição continua em B (mesmo tipo e duração) e a tarja continua vinculada a A, desde o início de A', r.tr?.kind === 'crossfade' && r.tr?.durationUs === trDur && r.fx?.startUs === r.a && !!r.fx?.linkId && r.fx.linkId === r.aLink, { tr: r.tr, fx: r.fx && { start: r.fx.startUs, link: r.fx.linkId }, a: r.a })
    oneStep('Usar como abertura', r.p0, r.past)
    cut += D
    const cov = await ev(`T.st().select([]); await T.settle(); const out = []
      for (const t of [${0.2 * S + D}, ${1 * S + D}, ${cut - 0.1 * S}, ${cut}]) { await T.seek(t); await T.wait(300); out.push([t, await T.whiteIn(${SQ.x}, ${SQ.y}, ${SQ.w}, ${SQ.h})]) }
      await T.seek(${1.5 * S}); await T.wait(500)
      const box = await T.region(660, 440, 600, 200); let yellow = 0; for (let i = 0; i < box.length; i += 4) if (box[i] > 190 && box[i + 1] > 190 && box[i + 2] < 90) yellow++
      return { out, yellow }`)
    check('preview depois da abertura: a região coberta continua coberta (0 px brancos no quadrado em A + 3 s, inclusive no corte)', cov.out.every(([, n]) => n === 0), cov.out)
    check('preview: o título da abertura (amarelo) aparece em 1,5 s', cov.yellow > 300, cov.yellow)
    await shot('e2e-f5-06-abertura.png')
  }

  // ------------------------------------------------------------------ 5
  console.log('5. exportar (Alta 1080p) com "Queimar no vídeo" + ".srt ao lado"')
  const layout = await ev(`const p = T.st().project; const it = (id) => T.item(id)
    const end = Math.max(...p.tracks.filter((t) => !t.hidden).flatMap((t) => t.items).filter((i) => i.type !== 'effect').map((i) => i.startUs + i.durationUs))
    const shape = T.items().find((i) => i.type === 'shape')
    const titles = T.items().filter((i) => i.type === 'text' && T.capTrack()?.items.every((c) => c.id !== i.id)).map((i) => ({ start: i.startUs, dur: i.durationUs }))
    return { a: { start: it('${A}').startUs, dur: it('${A}').durationUs }, b: { start: it('${B}').startUs, dur: it('${B}').durationUs }, tr: it('${B}').transitionIn, end, shape: shape && { start: shape.startUs, dur: shape.durationUs }, titles, caps: T.caps() }`)
  const before5 = await ev(`return T.past()`)
  const outFile = await (async () => {
    await ev(`document.activeElement?.blur?.(); T.st().select([]); window.__qaEditor.exportDir = ${JSON.stringify(OUT)}
      await T.click([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(600)
      await T.press([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith('Alta 1080p'))); return 1`)
    const opt = await ev(`const d = T.dialog(); const srt = d.querySelector('[data-caption-srt]'); if (!srt.checked) await T.press(srt)
      return { burn: d.querySelector('[data-caption-burn]')?.checked, srt: d.querySelector('[data-caption-srt]')?.checked }`)
    check('diálogo: "Queimar no vídeo" e "Salvar arquivo .srt ao lado" marcados', opt.burn === true && opt.srt === true, opt)
    await shot('e2e-f5-07-exportar.png')
    await ev(`await T.press(T.button('Exportar', T.dialog())); return 1`)
    let text = ''
    const t0 = Date.now()
    for (let i = 0; i < 1500; i++) {
      text = await ev(`return T.dialog()?.textContent ?? ''`)
      if (text.includes('Vídeo exportado') || text.includes('falhou')) break
      await sleep(200)
    }
    console.log(`  exportação: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    check('exportação concluída', text.includes('Vídeo exportado'), text.slice(0, 300))
    await shot('e2e-f5-08-exportado.png')
    await ev(`if (T.dialog()) { await T.press(T.button('Fechar', T.dialog())); await T.wait(300) } return 1`)
    const files = readdirSync(OUT)
    const mp4 = files.filter((f) => f.endsWith('.mp4'))
    check('um .mp4 e o .srt de mesmo nome na pasta de exportação, sem .part', mp4.length === 1 && files.length === 2 && files.includes(mp4[0].replace(/\.mp4$/, '.srt')), files)
    return mp4.length === 1 ? join(OUT, mp4[0]) : null
  })()
  check('exportar não grava passo de desfazer', (await ev(`return T.past()`)) === before5, null)

  if (outFile) {
    console.log('  conferência com o ffmpeg')
    const pr = probe(outFile)
    console.log(`  ${JSON.stringify(pr)}; layout ${JSON.stringify(layout)}`)
    check(`H.264 1920×1080 com a duração do conteúdo (${(layout.end / S).toFixed(2)} s)`, pr.codec === 'h264' && pr.width === W && pr.height === H && near(pr.duration, layout.end / S, 0.12), pr)
    const fr = (us) => Math.round((us * FPS) / S)
    const cutF = fr(cut)
    const aPure = frame(outFile, fr(layout.a.start + 0.5 * S)) // A sem título/legenda no ponto de fundo
    const bPure = frame(outFile, fr(cut + layout.tr.durationUs / 2 + 0.3 * S))
    const mid = frame(outFile, cutF)
    const ca = patchAt(aPure, BG_PT.x, BG_PT.y), cb = patchAt(bPure, BG_PT.x, BG_PT.y), cm = patchAt(mid, BG_PT.x, BG_PT.y)
    const between = [0, 1, 2].every((k) => { const lo = Math.min(ca[k], cb[k]), hi = Math.max(ca[k], cb[k]); const span = hi - lo; return span < 30 ? near(cm[k], (lo + hi) / 2, 25) : cm[k] > lo + 0.2 * span && cm[k] < hi - 0.2 * span })
    check(`meio da transição (quadro ${cutF}): o fundo é a mistura de A e B (cada canal entre os dois)`, between, { a: ca, b: cb, mid: cm })
    // título original (A + 1,5 s após a abertura): letras amarelas e caixa escura
    const tOrig = layout.titles.find((t) => t.start > 0)
    const tf = frame(outFile, fr(tOrig.start + 1.5 * S))
    const TB = { x0: 560, y0: 420, x1: 1360, y1: 660 }
    const ty = countIn(tf, TB, isYellow), td = countIn(tf, TB, (c) => c[0] < 40 && c[1] < 50 && c[2] < 100)
    check('título no arquivo: letras amarelas (> 1500 px) sobre a caixa escura (> 8000 px) no centro', ty > 1500 && td > 8000, { yellow: ty, dark: td })
    const intro = frame(outFile, fr(1.5 * S))
    const iy = countIn(intro, TB, isYellow)
    check('título da abertura no arquivo em 1,5 s (letras amarelas)', iy > 1500, iy)
    // legenda queimada: caixa escura com letras brancas embaixo, no quadro em A com a 1ª legenda
    const c1 = layout.caps[0]
    const cf = frame(outFile, fr(c1.startUs + 0.6 * S))
    const CB = { x0: 576, y0: 900, x1: 1344, y1: 1000 }
    const bgc = patchAt(cf, BG_PT.x, BG_PT.y)
    const cw = countIn(cf, CB, isWhite), cd = countIn(cf, CB, (c) => c[0] + c[1] + c[2] < (bgc[0] + bgc[1] + bgc[2]) * 0.45)
    check('legenda queimada: caixa escura (> 6000 px) com letras brancas (> 600 px) embaixo', cw > 600 && cd > 6000, { white: cw, dark: cd, bg: bgc })
    // privacidade: o quadrado branco NUNCA aparece em nenhum quadro do arquivo
    const crop = cropAll(outFile, SQ)
    const fsz = SQ.w * SQ.h * 3
    const nF = Math.floor(crop.length / fsz)
    const leaks = []
    for (let f = 0; f < nF; f++) {
      let n = 0
      for (let i = f * fsz; i < (f + 1) * fsz; i += 3) if (crop[i] > 200 && crop[i + 1] > 200 && crop[i + 2] > 200) n++
      if (n > 0) leaks.push([f, n])
    }
    check(`privacidade: o quadrado branco coberto em TODOS os ${nF} quadros do arquivo (abertura, A, transição, B)`, nF >= fr(layout.end) - 2 && leaks.length === 0, { nF, leaks: leaks.slice(0, 10) })
    // .srt ao lado: as legendas com os tempos deslocados pela abertura
    const srtFile = outFile.replace(/\.mp4$/, '.srt')
    const got = existsSync(srtFile) ? readSrt(srtFile) : null
    const want = serialize(layout.caps)
    check('.srt ao lado: UTF-8 com BOM, as 3 legendas com os tempos + 3 s', !!got?.bom && got.text === want && layout.caps[0].startUs === 1 * S + D, { got: got?.text, want })
    for (const [name, n] of [['e2e-f5-09-quadro-transicao.png', cutF], ['e2e-f5-10-quadro-titulo-legenda.png', fr(c1.startUs + 0.6 * S)], ['e2e-f5-11-quadro-abertura.png', fr(1.5 * S)]]) {
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', outFile, '-vf', `select=eq(n\\,${n}),scale=-2:540`, '-frames:v', '1', '-update', '1', join(SHOTS, name)])
      console.log(`  [captura] ${name}`)
    }
  }

  // ------------------------------------------------------------------ 6
  console.log('6. desfazer tudo passo a passo e refazer')
  {
    const total = await ev(`return T.past()`)
    check(`passos gravados desde o início = os ${steps} gestos conferidos`, total - past0 === steps, { total, past0, steps })
    const snapEnd = await ev(`return T.snap()`)
    const u = await ev(`document.activeElement?.blur?.(); T.st().select([]); const seq = []
      for (let i = 0; i < ${steps}; i++) { const b = T.past(); await T.key('z', { ctrlKey: true }); await T.wait(60); seq.push(b - T.past()) }
      return { seq, past: T.past(), same: T.snap() === ${JSON.stringify(snap0)}, canUndo: T.st().canUndo, caps: T.caps().length, texts: T.items().filter((i) => i.type === 'text' || i.type === 'shape' || i.type === 'effect').length, tr: T.item('${B}')?.transitionIn ?? null }`)
    check(`${steps} × Ctrl+Z: cada um desfaz um passo e o projeto volta ao estado inicial (dois clipes, sem transição, texto, forma, tarja nem legenda)`, u.seq.every((x) => x === 1) && u.past === past0 && u.same && u.caps === 0 && u.texts === 0 && u.tr === null, u)
    await ev(`await T.seek(${0.5 * S}); return 1`)
    await shot('e2e-f5-12-desfeito.png')
    const r = await ev(`const seq = []
      for (let i = 0; i < ${steps}; i++) { const b = T.past(); await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(60); seq.push(T.past() - b) }
      return { seq, past: T.past(), same: T.snap() === ${JSON.stringify(snapEnd)} }`)
    check(`${steps} × Ctrl+Shift+Z: refaz até o fim (projeto igual ao do fim)`, r.seq.every((x) => x === 1) && r.same, r)
    const cov = await ev(`T.st().select([]); await T.seek(${cut}); await T.wait(500); return await T.whiteIn(${SQ.x}, ${SQ.y}, ${SQ.w}, ${SQ.h})`)
    check('depois de refazer, a tarja cobre o quadrado no corte (preview)', cov === 0, cov)
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    await shot('e2e-f5-erro.png')
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
  await sleep(800)
  const realAfter = realBrandState()
  const realOk = JSON.stringify(realAfter) === JSON.stringify(realBefore)
  checks++
  if (!realOk) failures++
  console.log(`${realOk ? '  ✔' : '  ✘'} %APPDATA%\\cialight-gravador\\brand-templates.json e brand-assets do usuário intocados (${JSON.stringify(realAfter)})`)
  // settings.json: hash antes/depois; diferente = restaura o backup e confere de novo. Só `pip` regravado pelo app
  // (tela Preparar ao redimensionar pela emulação do CDP) é aceito, restaurado.
  failures += settings.finish() // settingsGuard.mjs: restaura e confere o hash; só `pip` (regravado pelo app) é tolerado
  console.log(failures ? `\n${failures} falha(s) em ${checks} verificações` : `\ntudo OK (${checks} verificações)`)
  process.exit(failures ? 1 : 0)
}
