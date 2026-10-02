// E2E do editor F1 via CDP (eventos sintéticos despachados nos elementos; nunca entrada do sistema
// operacional): grava pelo caminho do `test:capture`, abre a gravação no editor pelo Histórico, divide no meio,
// apaga 2 s (I/O + Ctrl+Shift+X), move a webcam no visualizador, importa mp3 e png gerados, ajusta o volume,
// exporta "Alta 1080p" e confere o arquivo com ffprobe (faixas, duração, faststart).
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-e2e.mjs                 → grava (CIALIGHT_TEST=capture) e roda o fluxo
//   node scripts/qa/editor-e2e.mjs --reuse         → reaproveita a gravação de uma rodada anterior
//   node scripts/qa/editor-e2e.mjs --no-blur       → screenshots sem borrar a mídia (a gravação é a tela real)
//
// Tudo fica em test-out/e2e (CIALIGHT_RAW_DIR=test-out/e2e/raw → projetos em test-out/e2e/Projetos,
// exportação em test-out/e2e/export). Screenshots em docs/qa/editor-f1/e2e-*.png. settings.json do usuário
// é restaurado se mudar.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9335'
const REUSE = process.argv.includes('--reuse')
// a gravação é a tela real do usuário e o repositório é público: screenshots com a mídia borrada (--no-blur desliga)
const BLUR = !process.argv.includes('--no-blur')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f1')
const E2E = join(ROOT, 'test-out', 'e2e')
const RAW_REL = 'test-out/e2e/raw'
const RAW = join(ROOT, RAW_REL)
const MEDIA = join(E2E, 'media')
const OUT = join(E2E, 'export')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const S = 1_000_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
mkdirSync(SHOTS, { recursive: true })

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// ---- 1. gravação: o mesmo caminho do `npm run test:capture`, mantendo a sessão ----
function runCapture() {
  rmSync(E2E, { recursive: true, force: true })
  mkdirSync(E2E, { recursive: true })
  console.log('gravando pelo caminho do test:capture (9 s com 2 s de pausa → ≈ 7 s de mídia)…')
  const r = spawn(electronPath, ['.'], {
    cwd: ROOT,
    env: { ...process.env, CIALIGHT_TEST: 'capture', CIALIGHT_CAPTURE_KEEP: '1', CIALIGHT_RAW_DIR: RAW_REL },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  r.stdout.on('data', (d) => (out += d))
  r.stderr.on('data', (d) => (out += d))
  return new Promise((res) => r.on('exit', (code) => res({ code, out })))
}

function findSession() {
  const ids = existsSync(RAW) ? readdirSync(RAW).filter((d) => existsSync(join(RAW, d, 'session.json'))) : []
  if (ids.length !== 1) throw new Error(`esperava 1 gravação em ${RAW}, achei ${ids.length}`)
  return JSON.parse(readFileSync(join(RAW, ids[0], 'session.json'), 'utf8'))
}

// ---- mídia gerada para importar ----
function makeMedia() {
  rmSync(MEDIA, { recursive: true, force: true })
  mkdirSync(MEDIA, { recursive: true })
  const mp3 = join(MEDIA, 'trilha-e2e.mp3')
  const png = join(MEDIA, 'selo-e2e.png')
  const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:a', 'libmp3lame', '-b:a', '128k', mp3])
  ff(['-f', 'lavfi', '-i', 'color=c=0x2563eb:s=400x400,drawbox=x=50:y=50:w=300:h=300:color=white@0.9:t=20', '-frames:v', '1', '-update', '1', png])
  return { mp3, png }
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__e2e; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 300000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await sleep(400)
  if (BLUR) {
    // só para o screenshot: visualizador, miniaturas e filmstrips (a gravação mostra a área de trabalho real)
    await ev(`if (!document.getElementById('e2e-blur')) { const st = document.createElement('style'); st.id = 'e2e-blur'; st.textContent = 'section[aria-label="Visualizador"] canvas, [data-timeline-lanes] canvas, img, video, [style*="background-image"] { filter: blur(7px) !important; }'; document.head.appendChild(st) } return 1`)
    await sleep(100)
  }
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  if (BLUR) await ev(`document.getElementById('e2e-blur')?.remove(); return 1`)
  console.log(`  📷 ${name}`)
}

// helpers da página (eventos de ponteiro/teclado despachados nos elementos e leitura do store)
const HELPERS = `
window.__e2e = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const el = (sel, root = document) => { const e = root.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const pt = (e, fx = 0.5, fy = 0.5) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  async function drag(target, from, to, steps = 10) {
    target.dispatchEvent(pe('pointerdown', from.x, from.y))
    for (let i = 1; i <= steps; i++) window.dispatchEvent(pe('pointermove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps))
    await settle()
    window.dispatchEvent(pe('pointerup', to.x, to.y)); await settle()
  }
  const key = async (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items.map((i) => ({ ...i, trackName: t.name, kind: t.kind })))
  const byAsset = (assetId) => items().filter((i) => i.assetId === assetId)
  const duration = () => Math.max(0, ...items().map((i) => i.startUs + i.durationUs))
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle() }
  const xOf = (us) => { const r = el('[data-timeline-ruler]').getBoundingClientRect(); const s = st(); return r.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6 }
  const button = (text, root = document) => { const b = [...root.querySelectorAll('button')].find((x) => x.textContent.includes(text)); if (!b) throw new Error('não achei o botão ' + text); return b }
  const setInput = (input, value) => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur() }
  return { st, settle, el, pt, drag, key, items, byAsset, duration, seek, xOf, button, setInput }
})()
'ok'`

// ---- ffprobe / faststart ----
function ffprobe(file) {
  return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
}
/** Ordem das caixas de topo do MP4 (faststart = moov antes de mdat). */
function topLevelBoxes(file) {
  const fd = openSync(file, 'r')
  const size = statSync(file).size
  const out = []
  let pos = 0
  const head = Buffer.alloc(16)
  while (pos + 8 <= size && out.length < 20) {
    readSync(fd, head, 0, 16, pos)
    let len = head.readUInt32BE(0)
    const type = head.toString('latin1', 4, 8)
    if (len === 1) len = Number(head.readBigUInt64BE(8))
    else if (len === 0) len = size - pos
    out.push(type)
    if (len < 8) break
    pos += len
  }
  closeSync(fd)
  return out
}

async function main() {
  if (!REUSE) {
    const r = await runCapture()
    const tail = r.out.split(/\r?\n/).filter((l) => /✔|✘|FALHAS|PASSOU|ok|falh/i.test(l)).slice(-25).join('\n')
    console.log(tail)
    check('gravação pelo caminho do test:capture terminou (exit 0)', r.code === 0, r.code)
  }
  const session = findSession()
  console.log(`gravação ${session.id}: ${session.durationMs} ms, webcam: ${session.tracks.webcam !== undefined}, PiP: ${session.pip.length} keyframes`)
  const media = makeMedia()

  rmSync(join(E2E, 'Projetos'), { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    // CIALIGHT_QA (qualquer valor) libera o lock de instância única (o app instalado pode estar aberto) e pula o probe adiado
    env: { ...process.env, CIALIGHT_QA: 'e2e', CIALIGHT_RAW_DIR: RAW_REL },
    stdio: 'ignore'
  })
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)

  console.log('Histórico → Editar')
  await ev(`window.__navigate('history'); return 1`)
  for (let i = 0; i < 30; i++) {
    if (await ev(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Editar')`)) break
    await sleep(500)
  }
  await shot('e2e-01-historico.png')
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Editar').click(); return 1`)
  let ready = null
  for (let i = 0; i < 180; i++) {
    ready = await ev(`const s = window.__qaEditor?.store.getState(); if (!s?.project) return null; return { assets: s.project.assets.map((a) => [a.id, a.status]), ok: s.project.assets.every((a) => a.status === 'ready') }`)
    if (ready?.ok) break
    await sleep(1000)
  }
  check('editor abriu a gravação e a ingestão terminou', !!ready?.ok, ready)
  await ev(HELPERS + '; return 1')
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; const s = T.st(); s.select([]); await T.seek(0); return 1`)
  await ev(`await T.key('Z', { shiftKey: true }); return 1`) // ajustar o zoom à janela
  const start = await ev(`return { dur: T.duration(), tracks: T.st().project.tracks.map((t) => [t.name, t.kind, t.items.length]) }`)
  console.log(`  projeto: ${(start.dur / S).toFixed(2)} s; faixas ${JSON.stringify(start.tracks)}`)
  check('projeto da gravação com tela e áudio', start.tracks.some((t) => t[0] === 'Tela') && start.tracks.some((t) => t[1] === 'audio'), start.tracks)
  await shot('e2e-02-editor.png')

  console.log('dividir no meio')
  const mid = Math.round(start.dur / 2)
  const split = await ev(`await T.seek(${mid}); const n0 = T.items().length; T.el('[aria-label="Dividir no playhead"]').click(); await T.settle()
    return { n0, n1: T.items().length, cuts: T.items().filter((i) => i.startUs === ${mid}).length }`)
  check('tudo dividido no playhead (cada item em 2)', split.n1 === split.n0 * 2 && split.cuts === split.n0, split)
  await shot('e2e-03-dividir.png')

  console.log('apagar 2 s (I/O + Ctrl+Shift+X)')
  const delFrom = Math.round(mid - 1 * S)
  const del = await ev(`await T.seek(${delFrom}); await T.key('i'); await T.seek(${delFrom + 2 * S}); await T.key('o')
    const marks = { in: T.st().inUs, out: T.st().outUs }; const d0 = T.duration()
    await T.key('X', { ctrlKey: true, shiftKey: true }); return { marks, d0, d1: T.duration(), ph: T.st().playheadUs, inOut: [T.st().inUs, T.st().outUs] }`)
  check('in/out marcados', del.marks.in === delFrom && del.marks.out === delFrom + 2 * S, del.marks)
  check('trecho de 2 s apagado (duração −2 s) e marcas limpas', del.d0 - del.d1 === 2 * S && del.inOut[0] === null && del.inOut[1] === null, del)
  await shot('e2e-04-apagar-trecho.png')

  console.log('mover a webcam')
  const hasCam = await ev(`return T.items().some((i) => i.trackName === 'Webcam')`)
  let movedId = null
  if (hasCam) {
    const mv = await ev(`const cam = T.items().find((i) => i.trackName === 'Webcam' && i.startUs === 0); await T.seek(Math.round(cam.durationUs / 2)); T.st().select([cam.id]); await T.settle(); await new Promise((r) => setTimeout(r, 300))
      const h = document.querySelector('section[aria-label="Visualizador"] .cursor-move'); if (!h) throw new Error('alça de mover não apareceu')
      const before = { x: cam.visual.transform.x, y: cam.visual.transform.y }; const a = T.pt(h); const stage = T.el('[aria-label="Visualização do projeto"]').getBoundingClientRect()
      const p0 = T.st().history.past.length
      await T.drag(h, a, { x: a.x - stage.width * 0.3, y: a.y - stage.height * 0.25 })
      const it = T.items().find((i) => i.id === cam.id); return { id: cam.id, before, after: { x: it.visual.transform.x, y: it.visual.transform.y }, dp: T.st().history.past.length - p0 }`)
    movedId = mv.id
    const val = (v) => (typeof v === 'object' && v !== null && 'value' in v ? v.value : v)
    const kf = (v) => (typeof v === 'object' && v !== null && Array.isArray(v.keyframes) ? v.keyframes.length : 0)
    console.log(`  transform antes ${JSON.stringify(mv.before).slice(0, 160)} depois ${JSON.stringify(mv.after).slice(0, 160)}`)
    check('webcam movida (transform x/y mudou) em 1 passo de desfazer', JSON.stringify(mv.before) !== JSON.stringify(mv.after) && mv.dp === 1, { dp: mv.dp, kf: [kf(mv.after.x), kf(mv.after.y)], x: val(mv.after.x) })
  } else console.log('  (gravação sem webcam nesta máquina — passo de mover feito no png, abaixo)')
  await shot('e2e-05-mover-webcam.png')

  console.log('importar mp3 e png')
  const imp = await ev(`const assets = await window.__qaEditor.importPaths(${JSON.stringify([media.mp3, media.png])}); return assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name }))`)
  check('importou 2 assets (áudio + imagem)', imp.length === 2 && imp.some((a) => a.kind === 'audio') && imp.some((a) => a.kind === 'image'), imp)
  const mp3Id = imp.find((a) => a.kind === 'audio')?.id
  const pngId = imp.find((a) => a.kind === 'image')?.id
  for (let i = 0; i < 60; i++) {
    if (await ev(`return T.st().project.assets.every((a) => a.status === 'ready')`)) break
    await sleep(1000)
  }
  const drop = await ev(`const lanes = T.el('[data-timeline-lanes]'); const top = lanes.getBoundingClientRect().top
    const drop = (assetId, us) => { const dt = new DataTransfer(); dt.setData('application/x-cialight-asset', assetId); lanes.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: T.xOf(us), clientY: top + 6, dataTransfer: dt })) }
    drop('${pngId}', 500000); await T.settle(); drop('${mp3Id}', 0); await T.settle()
    return { png: T.byAsset('${pngId}').map((i) => [i.trackName, i.startUs, i.durationUs]), mp3: T.byAsset('${mp3Id}').map((i) => [i.trackName, i.kind, i.startUs, i.durationUs]) }`)
  // o instante vem do pixel sob o ponteiro: ±1 quadro
  check('png na linha do tempo (faixa de vídeo nova) em ≈ 0,5 s', drop.png.length === 1 && Math.abs(drop.png[0][1] - 500_000) <= 34_000, drop)
  check('mp3 numa faixa de áudio em 0 s', drop.mp3.length === 1 && drop.mp3[0][1] === 'audio' && drop.mp3[0][2] === 0, drop)
  if (!hasCam) {
    const mv = await ev(`const it0 = T.byAsset('${pngId}')[0]; await T.seek(1500000); T.st().select([it0.id]); await T.settle(); await new Promise((r) => setTimeout(r, 300))
      const h = document.querySelector('section[aria-label="Visualizador"] .cursor-move'); const a = T.pt(h)
      await T.drag(h, a, { x: a.x + 120, y: a.y + 60 }); const it = T.byAsset('${pngId}')[0]; return { before: it0.visual.transform, after: it.visual.transform }`)
    check('imagem movida no visualizador', JSON.stringify(mv.before) !== JSON.stringify(mv.after), mv)
  }
  await ev(`T.st().select([]); await T.seek(1500000); return 1`)
  await shot('e2e-06-importar.png')

  console.log('volume do mp3')
  const vol = await ev(`const it = T.byAsset('${mp3Id}')[0]; T.st().select([it.id]); await T.settle(); await new Promise((r) => setTimeout(r, 300))
    const insp = T.el('aside[aria-label="Inspetor"]'); const input = T.el('input[aria-label="Volume"]', insp)
    const p0 = T.st().history.past.length; T.setInput(input, '-6'); await T.settle()
    const after = T.byAsset('${mp3Id}')[0].audio.volume; return { after, dp: T.st().history.past.length - p0, shown: input.value }`)
  const gain = typeof vol.after === 'object' ? vol.after.value : vol.after
  check('volume −6 dB (ganho ≈ 0,501) em 1 passo', Math.abs(gain - 10 ** (-6 / 20)) < 0.002 && vol.dp === 1, vol)
  await shot('e2e-07-volume.png')

  console.log('exportar Alta 1080p')
  const expected = await ev(`T.st().select([]); return T.duration()`)
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Exportar' && !b.closest('[role="dialog"]')).click(); return 1`)
  await sleep(600)
  await ev(`T.button('Alta 1080p', document.querySelector('[role="dialog"]')).click(); await T.settle(); return 1`)
  const dlg = await ev(`return document.querySelector('[role="dialog"]')?.textContent ?? ''`)
  check('diálogo com Alta 1080p (1920×1080)', dlg.includes('1920×1080'), dlg.slice(0, 300))
  await shot('e2e-08-exportar.png')
  await ev(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Exportar').click(); return 1`)
  let text = ''
  let sawProgress = false
  const t0 = Date.now()
  for (let i = 0; i < 3000; i++) {
    text = await ev(`return document.querySelector('[role="dialog"]')?.textContent ?? ''`)
    if (!sawProgress && /\d+%/.test(text)) {
      sawProgress = true
      await shot('e2e-09-exportando.png')
    }
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(200)
  }
  console.log(`  exportação: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  check('exportação concluída', text.includes('Vídeo exportado'), text.slice(0, 300))
  await shot('e2e-10-exportado.png')

  console.log('ffprobe do resultado')
  const files = readdirSync(OUT)
  check('um .mp4 na pasta, sem .part', files.length === 1 && files[0].endsWith('.mp4'), files)
  if (files.length === 1) {
    const file = join(OUT, files[0])
    const p = ffprobe(file)
    const v = p.streams.filter((s) => s.codec_type === 'video')
    const a = p.streams.filter((s) => s.codec_type === 'audio')
    const dur = Number(p.format.duration)
    console.log(`  ${files[0]}: ${(statSync(file).size / 1e6).toFixed(2)} MB, ${dur.toFixed(3)} s, vídeo ${v.map((s) => `${s.codec_name} ${s.width}×${s.height} ${s.r_frame_rate} ${s.pix_fmt}`).join(', ')}, áudio ${a.map((s) => `${s.codec_name} ${s.sample_rate} Hz ${s.channels} ch`).join(', ')}`)
    check('1 vídeo H.264 1920×1080', v.length === 1 && v[0].codec_name === 'h264' && v[0].width === 1920 && v[0].height === 1080, v)
    check('1 áudio AAC', a.length === 1 && a[0].codec_name === 'aac', a)
    check(`duração ≈ ${(expected / S).toFixed(2)} s (±0,15 s)`, Math.abs(dur - expected / S) <= 0.15, { dur, expected: expected / S })
    const boxes = topLevelBoxes(file)
    check('faststart (moov antes de mdat)', boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'), boxes)
    writeFileSync(join(E2E, 'e2e-result.json'), JSON.stringify({ file: files[0], expectedUs: expected, ffprobe: p, boxes, movedId }, null, 2))
  }
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
  }
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
