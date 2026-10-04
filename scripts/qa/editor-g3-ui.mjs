// QA da INTERFACE do G3 ("Procurar dados sensíveis") via CDP no app real, com mídia SINTÉTICA.
//
// Gravação: sessão no formato do gravador (session.json + rec.mp4 H.264 1920×1080 30 qps, 8 s) desenhada pelo drawtext
// do ffmpeg empacotado: valores falsos válidos parados (CPF, e-mail, telefone — biblioteca de testes do app) e um nome
// fictício ("Fulano Exemplo") que só é achado como palavra personalizada.
// No app (só cliques/teclas pelo DOM e os ganchos de QA de leitura): Histórico → Editar; o clipe vira dois (A e a cópia B,
// um passo). Aba Efeitos → "Procurar dados sensíveis" → palavra personalizada → Procurar → a lista tem cpf/email/phone/
// custom; foco numa linha leva o playhead e desenha o contorno; desmarca uma; "Esconder selecionados" = um passo (efeitos
// novos selecionados); Ctrl+Z (pelo atalho do app) remove todos, Ctrl+Shift+Z refaz. Menu do clipe B → só o B. Cancelar
// no meio da busca → volta às opções com "Busca cancelada". Fechar apaga os termos da memória do diálogo.
// No fim (app fechado): nenhum arquivo em test-out/e2e-g3-ui (inclui a pasta de projetos), em %TEMP% (modificados
// durante o teste) nem o trecho novo do main.log contém a palavra personalizada ou um valor verdadeiro (bytes).
// settings.json do usuário: guardSettings (hash antes/depois, restaurado se mudar).
//
// uso (depois de `npm run build`, sob o lock):  node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "node scripts/qa/editor-g3-ui.mjs"
// Screenshots (sintéticos) em docs/qa/editor-g3/e2e-g3-11-dialogo.png, -12-lista.png, -13-escondido.png.
import { spawn, execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import electronPath from 'electron'
import { guardSettings } from './settingsGuard.mjs'
import { guardShot } from './shotGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9342'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-g3')
const E2E = join(ROOT, 'test-out', 'e2e-g3-ui')
const RAW_REL = 'test-out/e2e-g3-ui/raw'
const RAW = join(ROOT, RAW_REL)
const GEN = join(ROOT, 'test-out', 'e2e-g3-ui-gen')
const SESSION_ID = 'e2e-g3-ui-gravacao'
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const MAIN_LOG = join(process.env.APPDATA ?? '', 'cialight-gravador', 'logs', 'main.log')
const W = 1920, H = 1080, FPS = 30, DUR_S = 8
const CUSTOM = 'Fulano Exemplo'
// webcam (v:1 do rec.mp4, ruling R23): outro tamanho e uma palavra que só existe nela
const CAM = { w: 640, h: 480, word: 'Beltrano Teste', x: 120, y: 200, size: 40 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
const guard = guardSettings(SETTINGS)
const t0 = Date.now()
const logSize0 = existsSync(MAIN_LOG) ? statSync(MAIN_LOG).size : 0

// ---------------------------------------------------------------- valores falsos (biblioteca de testes do app)
async function loadLib() {
  mkdirSync(GEN, { recursive: true })
  const out = join(GEN, 'g3-lib.mjs')
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'), join(ROOT, 'scripts', 'qa', 'editor-g3-lib.ts'), '--bundle', '--platform=node', '--format=esm', `--alias:@shared=${join(ROOT, 'src', 'shared')}`, `--outfile=${out}`, '--log-level=warning'], { cwd: ROOT, stdio: 'inherit' })
  return import(pathToFileURL(out).href)
}

/** Gravação sintética; devolve os valores verdadeiros. Os arquivos de texto do drawtext ficam em GEN (apagada antes do app). */
function makeSession(L) {
  const items = [
    { kind: 'cpf', value: L.formatCpf(L.fakeCpf(31)), x: 320, y: 200 },
    { kind: 'email', value: L.fakeEmail(32), x: 900, y: 200 },
    { kind: 'phone', value: L.fakePhone(33, 'paren'), x: 320, y: 360 },
    { kind: 'custom', value: CUSTOM, x: 900, y: 360 }
  ]
  const dir = join(RAW, SESSION_ID)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(GEN, 'txt'), { recursive: true })
  let n = 0
  const tf = (text) => { writeFileSync(join(GEN, 'txt', `${n}.txt`), text, 'utf8'); return `txt/${n++}.txt` }
  const dt = (text, x, y, size = 26, color = '0x1F1F1F') => `drawtext=fontfile=/Windows/Fonts/segoeui.ttf:textfile=${tf(text)}:expansion=none:y_align=font:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`
  const parts = ['drawbox=x=0:y=0:w=1920:h=40:color=0xE1E1E1:t=fill', 'drawbox=x=250:y=60:w=1650:h=1020:color=0xFFFFFF:t=fill', dt('Cadastro de clientes', 320, 110, 22, '0x3A3A3A'), dt('Clique em Salvar para concluir o cadastro', 320, 520, 20, '0x3A3A3A')]
  for (const it of items) parts.push(dt(it.value, it.x, it.y))
  // duas faixas de vídeo: tela (v:0) e "webcam" (v:1, 640×480, com a palavra só dela)
  const cam = ['drawbox=x=40:y=60:w=560:h=360:color=0xFFFFFF:t=fill', dt(CAM.word, CAM.x, CAM.y, CAM.size)]
  writeFileSync(join(GEN, 'f.txt'), `[0:v]format=rgb24,\n${parts.join(',\n')},format=yuv420p[s];\n[1:v]format=rgb24,\n${cam.join(',\n')},format=yuv420p[w]`)
  const rec = join(dir, 'rec.mp4')
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xF3F3F3:s=${W}x${H}:r=${FPS}:d=${DUR_S}`, '-f', 'lavfi', '-i', `color=c=0x9AA4B0:s=${CAM.w}x${CAM.h}:r=${FPS}:d=${DUR_S}`, '-/filter_complex', 'f.txt', '-map', '[s]', '-map', '[w]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '60', '-movflags', '+faststart', rec], { cwd: GEN })
  items.push({ kind: 'custom', value: CAM.word, cam: true })
  const session = {
    version: 1, id: SESSION_ID, createdAt: new Date().toISOString(), state: 'finalized',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor sintético', bounds: { x: 0, y: 0, width: W, height: H }, scaleFactor: 1 },
    video: { width: W, height: H, fps: FPS, codec: 'avc1.640028', bitrate: 8e6 },
    webcam: { deviceId: 'sintetica', label: 'Webcam sintética', width: CAM.w, height: CAM.h, mirrored: false },
    // PiP no canto inferior direito (vazio na tela sintética)
    systemAudio: false, tracks: { screen: 0, webcam: 1 }, durationMs: DUR_S * 1000, pauses: [], pip: [{ tMs: 0, x: 0.76, y: 0.7, w: 0.2, h: 0.2667, shape: 'rounded', visible: true }], strokes: [], clearEvents: [], markers: [],
    engine: 'webcodecs', files: { rec: 'rec.mp4' }, bytes: statSync(rec).size
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2))
  return items
}

// ---------------------------------------------------------------- CDP
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__g3; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 600000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await guardShot(send)
  await sleep(400)
  const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(20000).then(() => null)])
  if (!r?.result?.data) return console.log(`  (sem captura: ${name})`)
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}
const HELPERS = `
window.__g3 = (() => {
  const st = () => window.__qaEditor.store.getState()
  const ss = () => window.__qaEditor.sensitive.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const all = (sel, root = document) => [...root.querySelectorAll(sel)]
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const click = async (e) => { e.scrollIntoView({ block: 'center' }); await settle(); const c = center(e); const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y)); t.dispatchEvent(me('mousedown', c.x, c.y)); window.dispatchEvent(pe('pointerup', c.x, c.y)); t.dispatchEvent(me('mouseup', c.x, c.y)); t.dispatchEvent(me('click', c.x, c.y)); await settle(); return t }
  const key = async (k, mods, target = window) => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const past = () => st().history.past.length
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.textContent.trim().startsWith(text)); if (!b) throw new Error('não achei o botão ' + text); return b }
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  const dialog = () => document.querySelector('[data-sensitive-dialog]')
  const effects = () => st().project.tracks.flatMap((t) => t.items).filter((i) => i.type === 'effect')
  const setText = async (e, v) => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); await settle() }
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await wait(200) } return null }
  const contextMenu = async (id) => {
    const r = el('[data-item-id="' + id + '"]').getBoundingClientRect()
    const x = r.left + Math.min(40, r.width / 2), y = r.top + 8
    topAt(x, y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
    await settle(); await wait(250)
  }
  const menuItem = (text) => all('[data-timeline-menu] [role="menuitem"]').find((x) => x.textContent.includes(text))
  const openEffectsTab = async () => { const t = all('[role="tab"]').find((x) => x.textContent.trim() === 'Efeitos'); if (!t) throw new Error('sem aba Efeitos')
    t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })); t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); t.focus(); await settle(); await wait(200) }
  return { st, ss, settle, wait, all, el, click, key, past, button, toasts, dialog, effects, setText, waitFor, contextMenu, menuItem, openEffectsTab }
})()
'ok'`

const truths = []

/** Abre o diálogo pela aba Efeitos, escreve a palavra e procura; devolve o resumo da revisão. */
async function scanFromEffects(words) {
  await ev(`await T.openEffectsTab(); await T.click(T.el('[data-sensitive-open]')); await T.waitFor(() => T.dialog(), 5000); return 1`)
  await ev(`await T.setText(T.el('[data-sensitive-words]'), ${JSON.stringify(words)}); return 1`)
}

async function main() {
  rmSync(E2E, { recursive: true, force: true })
  rmSync(GEN, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  const L = await loadLib()
  const items = makeSession(L)
  for (const it of items) truths.push(it.value)
  console.log(`gravação sintética: ${items.map((i) => (i.cam ? 'webcam:' : '') + i.kind).join(', ')}`)
  // as entradas do drawtext (com os valores) saem antes do app: a varredura de bytes do fim vale para tudo o que sobra
  rmSync(GEN, { recursive: true, force: true })

  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, CIALIGHT_QA: 'e2e-g3-ui', CIALIGHT_RAW_DIR: RAW_REL }, stdio: 'ignore' })
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await ev(HELPERS + '; return 1')
  console.log('Histórico → Editar')
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`localStorage.setItem('editor.timelineHeight', '240'); window.__navigate('history'); return 1`)
  for (let i = 0; i < 40; i++) {
    if (await ev(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Editar')`)) break
    await sleep(500)
  }
  await ev(`await T.click(T.button('Editar')); return 1`)
  let ready = null
  for (let i = 0; i < 180; i++) {
    ready = await ev(`const s = window.__qaEditor?.store.getState(); if (!s?.project) return null; return { ok: s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]') && !!window.__qaEditor.sensitive }`)
    if (ready?.ok) break
    await sleep(1000)
  }
  check('editor abriu a gravação e a ingestão terminou', !!ready?.ok, ready)
  await ev(HELPERS + '; return 1')

  const clips = await ev(`const O = window.__qaEditor.ops; const v = T.st().project.tracks[0].items[0]; let B
    T.st().apply((p) => { const r = O.duplicateItems(p, [v.id], v.durationUs); B = r.itemIds[0]; return r.project })
    T.st().select([]); const cam = T.st().project.tracks.find((t) => t.items.some((i) => i.type === 'media' && T.st().project.assets.find((a) => a.id === i.assetId)?.videoTrackIndex === 1))
    return { A: v.id, B, assetId: v.assetId, camTrack: cam?.id, cam: cam?.items[0]?.id }`)
  check('a gravação tem a faixa da webcam (asset v:1)', !!clips.cam, clips)

  // ---------------- 1) aba Efeitos → diálogo → palavra personalizada → Procurar
  console.log('aba Efeitos → Procurar dados sensíveis')
  await scanFromEffects(`${CUSTOM}\nOutro Nome Inexistente`)
  const setup = await ev(`const d = T.dialog(); return { modal: d.getAttribute('role') === 'dialog', text: d.textContent, kinds: T.all('[data-sensitive-kind] input', d).filter((x) => x.checked).length, words: T.ss().wordsText, focusInside: d.contains(document.activeElement) }`)
  check('diálogo modal com tipos marcados, aviso obrigatório e a palavra digitada', setup.modal && setup.kinds === 12 && setup.text.includes('A busca é uma ajuda: confira o vídeo') && setup.text.includes('Não ficam salvos') && setup.words.includes(CUSTOM), setup)
  await shot('e2e-g3-11-dialogo.png')
  const p0 = await ev(`return { past: T.past(), fx: T.effects().length }`)
  const tScan = Date.now()
  await ev(`await T.click(T.el('[data-sensitive-start]')); return 1`)
  const prog = await ev(`return !!(await T.waitFor(() => document.querySelector('[data-sensitive-progress]') && T.ss().step === 'scanning', 10000))`)
  check('busca mostra o progresso', prog, null)
  const rev = await ev(`await T.waitFor(() => T.ss().step !== 'scanning', 240000); const s = T.ss(); return { step: s.step, rows: s.rows.map((r) => ({ id: r.id, kind: r.kind, masked: r.occ.masked, clipId: r.clipId, atUs: r.atUs, confidence: r.occ.confidence })), toasts: T.toasts() }`)
  console.log(`  busca: ${((Date.now() - tScan) / 1000).toFixed(1)} s; ${rev.rows.length} linhas: ${rev.rows.map((r) => `${r.kind} ${r.masked}`).join(' | ')}`)
  const kinds = new Set(rev.rows.map((r) => r.kind))
  check('a lista tem cpf, email, phone e custom (palavra personalizada)', rev.step === 'review' && ['cpf', 'email', 'phone', 'custom'].every((k) => kinds.has(k)), rev)
  check('nenhum efeito criado sem clicar em "Esconder…"', (await ev(`return T.effects().length`)) === p0.fx, null)
  check('linhas só com texto mascarado (nenhum valor verdadeiro no estado do diálogo)', !truths.some((v) => JSON.stringify(rev).includes(v)), null)
  await ev(`await T.waitFor(() => Object.keys(T.ss().thumbs).length >= T.ss().rows.length, 20000); return 1`)
  const thumbs = await ev(`return { n: Object.keys(T.ss().thumbs).length, imgs: T.all('[data-sensitive-row] img').length, size: (() => { const i = document.querySelector('[data-sensitive-row] img'); return i ? [i.naturalWidth, i.naturalHeight] : null })() }`)
  check('miniaturas 160×60 geradas no renderer para as linhas', thumbs.n >= rev.rows.length && thumbs.imgs >= rev.rows.length && thumbs.size?.[0] === 160 && thumbs.size?.[1] === 60, thumbs)

  // ---------------- 2) foco numa linha: playhead + contorno
  const target = rev.rows.find((r) => r.kind === 'custom') ?? rev.rows[0]
  const hov = await ev(`const row = T.el('[data-sensitive-row="${target.id}"]'); row.querySelector('input').focus(); await T.settle(); await T.wait(500); await T.settle()
    return { playhead: T.st().playheadUs, hover: T.ss().hover, outline: !!document.querySelector('[data-sensitive-outline]') }`)
  check('foco numa linha leva o playhead ao 1º instante dela e desenha o contorno no visualizador', hov.playhead === target.atUs && hov.hover?.itemId === target.clipId && hov.outline, { hov, target })
  // ponteiro numa outra linha também
  const other = rev.rows.find((r) => r.id !== target.id)
  const hov2 = await ev(`const row = T.el('[data-sensitive-row="${other.id}"]'); const r = row.getBoundingClientRect(); row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5, pointerType: 'mouse' })); await T.settle(); await T.wait(400); return { playhead: T.st().playheadUs, id: T.ss().hover?.itemId }`)
  check('passar o ponteiro numa linha também move o playhead', hov2.playhead === other.atUs, { hov2, other })
  await shot('e2e-g3-12-lista.png')

  // ---------------- 3) desmarca uma, esconde as selecionadas (um passo), desfaz/refaz
  const skip = rev.rows.find((r) => r.kind === 'phone')
  await ev(`await T.click(T.el('[data-sensitive-row="${skip.id}"] input[type=checkbox]')); return 1`)
  const btn = await ev(`return T.el('[data-sensitive-hide-selected]').textContent`)
  check(`"Esconder selecionados (${rev.rows.length - 1})"`, btn.includes(`(${rev.rows.length - 1})`), btn)
  const before = await ev(`return { json: JSON.stringify(T.st().project), past: T.past() }`)
  await ev(`await T.click(T.el('[data-sensitive-hide-selected]')); await T.wait(300); return 1`)
  const hid = await ev(`const fx = T.effects(); const sel = T.st().selection; return { past: T.past(), fx: fx.length, sel: sel.length, selAreFx: sel.every((id) => fx.some((f) => f.id === id)), names: fx.map((f) => f.name), attach: fx.map((f) => f.attach?.mediaItemId), rowsLeft: T.ss().rows.map((r) => r.id), open: T.ss().open, toasts: T.toasts(), json: JSON.stringify(T.st().project) }`)
  console.log(`  ${hid.fx} efeitos: ${JSON.stringify(hid.names)}; aviso: ${JSON.stringify(hid.toasts.filter((t) => t.includes('escondido')))}`)
  // cada valor aparece nos dois clipes (A e a cópia B): 2 efeitos por linha marcada
  check('um passo de desfazer; efeitos = linhas marcadas × 2 clipes, selecionados; a desmarcada continua na lista', hid.past === before.past + 1 && hid.fx === (rev.rows.length - 1) * 2 && hid.sel === hid.fx && hid.selAreFx && hid.rowsLeft.length === 1 && hid.rowsLeft[0] === skip.id && hid.open, { ...hid, json: undefined })
  check('aviso "N dados escondidos (M efeitos criados)"', hid.toasts.some((t) => t.includes(`${rev.rows.length - 1} dados escondidos (${hid.fx} efeitos criados)`)), hid.toasts)
  check('nomes dos efeitos só com máscara', !truths.some((v) => hid.names.join(' ').includes(v)), hid.names)
  // fecha com Esc (sem busca em andamento) e mostra o quadro escondido
  await ev(`await T.key('Escape', {}, T.dialog()); await T.wait(300); return 1`)
  const closed = await ev(`const s = T.ss(); return { open: s.open, words: s.wordsText, rows: s.rows.length, thumbs: Object.keys(s.thumbs).length }`)
  check('Esc fecha o diálogo e apaga termos, resultados e miniaturas da memória', !closed.open && closed.words === '' && closed.rows === 0 && closed.thumbs === 0, closed)
  await ev(`T.st().select([]); window.__qaEditor.controller.seek(${target.atUs + 200000}); await T.wait(800); for (let i = 0; i < 40 && T.toasts().length; i++) await T.wait(250); return 1`)
  await shot('e2e-g3-13-escondido.png')
  const u = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), past: T.past(), fx: T.effects().length }`)
  check('Ctrl+Z (atalho do app) remove todos os efeitos de uma vez', u.json === before.json && u.past === before.past && u.fx === 0, { same: u.json === before.json, fx: u.fx })
  const rd = await ev(`await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(300); return { json: JSON.stringify(T.st().project), fx: T.effects().length }`)
  check('Ctrl+Shift+Z refaz (o mesmo projeto)', rd.json === hid.json, { fx: rd.fx })
  await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return 1`)

  // ---------------- 4) menu do clipe B: só o B
  console.log('menu do clipe → Procurar dados sensíveis neste clipe')
  await ev(`await T.contextMenu(${JSON.stringify(clips.B)}); const it = T.menuItem('Procurar dados sensíveis neste clipe'); if (!it) throw new Error('sem a entrada no menu'); await T.click(it); await T.waitFor(() => T.dialog(), 5000); return 1`)
  const scope = await ev(`return { clipId: T.ss().clipId, text: T.dialog().textContent }`)
  check('menu do clipe abre o diálogo só para o clipe', scope.clipId === clips.B && scope.text.includes('Só no clipe'), scope)
  await ev(`await T.setText(T.el('[data-sensitive-words]'), ${JSON.stringify(CUSTOM)}); await T.click(T.el('[data-sensitive-start]')); await T.waitFor(() => T.ss().step === 'scanning', 5000); await T.waitFor(() => T.ss().step !== 'scanning', 240000); return 1`)
  const cm = await ev(`const s = T.ss(); return { step: s.step, rows: s.rows.map((r) => ({ clipId: r.clipId, clipIds: r.clipIds, kind: r.kind })) }`)
  check('busca do clipe: linhas só do clipe B (com os 4 tipos)', cm.step === 'review' && cm.rows.length >= 4 && cm.rows.every((r) => r.clipId === clips.B && r.clipIds?.length === 1 && r.clipIds[0] === clips.B), cm)
  const pb = await ev(`return T.past()`)
  await ev(`await T.click(T.el('[data-sensitive-hide-all]')); await T.wait(300); return 1`)
  const cmFx = await ev(`const fx = T.effects(); return { past: T.past(), n: fx.length, attach: [...new Set(fx.map((f) => f.attach?.mediaItemId))], open: T.ss().open }`)
  check('"Esconder todos" do clipe: um passo, efeitos só no clipe B, diálogo fecha (lista vazia)', cmFx.past === pb + 1 && cmFx.n === cm.rows.length && cmFx.attach.length === 1 && cmFx.attach[0] === clips.B && !cmFx.open, cmFx)
  await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return 1`)

  // ---------------- 4b) R23: busca no clipe da webcam (asset v:1) acha a palavra só dela, na geometria da v:1;
  // faixa bloqueada → a linha fica marcada "não escondido"; desbloqueada → Esconder de novo funciona
  console.log('webcam (v:1): busca no clipe, faixa bloqueada e de novo')
  await ev(`await T.contextMenu(${JSON.stringify(clips.cam)}); const it = T.menuItem('Procurar dados sensíveis neste clipe'); if (!it) throw new Error('sem a entrada no menu da webcam'); await T.click(it); await T.waitFor(() => T.dialog(), 5000); return 1`)
  await ev(`await T.setText(T.el('[data-sensitive-words]'), ${JSON.stringify(CAM.word)}); await T.click(T.el('[data-sensitive-start]')); await T.waitFor(() => T.ss().step === 'scanning', 5000); await T.waitFor(() => T.ss().step !== 'scanning', 240000); return 1`)
  const camRows = await ev(`const s = T.ss(); return { step: s.step, toasts: T.toasts(), rows: s.rows.map((r) => ({ id: r.id, kind: r.kind, clipId: r.clipId, w: r.occ.sourceW, h: r.occ.sourceH, box: r.occ.samples[0].box })) }`)
  const cw = camRows.rows.find((r) => r.kind === 'custom')
  const inBox = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
  check(`R23: a palavra da webcam é achada na faixa v:1 (${CAM.w}×${CAM.h}), com a caixa onde ela foi desenhada`,
    camRows.step === 'review' && !!cw && cw.clipId === clips.cam && cw.w === CAM.w && cw.h === CAM.h && inBox(cw.box, (CAM.x + 40) / CAM.w, (CAM.y + CAM.size * 0.6) / CAM.h), camRows)
  if (cw) {
    const pastCam = await ev(`return T.past()`)
    const pl = await ev(`T.st().apply((p) => window.__qaEditor.ops.updateTrack(p, ${JSON.stringify(clips.camTrack)}, { locked: true })); const p0 = T.past(); const fx0 = T.effects().length
      await T.click(T.el('[data-sensitive-row="${cw.id}"] button[aria-label^="Esconder"]')); await T.wait(300)
      return { added: T.effects().length - fx0, steps: T.past() - p0, still: T.ss().rows.some((r) => r.id === ${JSON.stringify(cw.id)}), marked: !!document.querySelector('[data-sensitive-row="${cw.id}"] [data-sensitive-not-hidden]'), toasts: T.toasts() }`)
    check('faixa bloqueada: nada criado, a linha fica com "não escondido" e o aviso pede para desbloquear', pl.added === 0 && pl.still && pl.marked && pl.toasts.some((t) => t.includes('Desbloqueie')), pl)
    const ul = await ev(`T.st().apply((p) => window.__qaEditor.ops.updateTrack(p, ${JSON.stringify(clips.camTrack)}, { locked: false })); const p0 = T.past(); const fx0 = T.effects().length
      await T.click(T.el('[data-sensitive-row="${cw.id}"] button[aria-label^="Esconder"]')); await T.wait(300)
      const fx = T.effects(); return { added: fx.length - fx0, steps: T.past() - p0, attach: fx.map((f) => f.attach?.mediaItemId), open: T.ss().open, still: T.ss().rows.some((r) => r.id === ${JSON.stringify(cw.id)}) }`)
    check('desbloqueada: Esconder de novo cria o efeito no clipe da webcam (um passo) e a linha sai', ul.added === 1 && ul.steps === 1 && ul.attach.includes(clips.cam) && !ul.still, ul)
    await ev(`if (T.ss().open) { await T.click(T.dialog().querySelector('[aria-label="Fechar"]')); await T.wait(300) } for (let i = 0; i < 6 && T.past() > ${pastCam}; i++) await T.key('z', { ctrlKey: true }); await T.wait(300); return T.effects().length`)
  }

  // ---------------- 5) cancelar no meio da busca
  console.log('cancelar no meio da busca')
  await scanFromEffects(CUSTOM)
  await ev(`await T.click(T.el('[data-sensitive-start]')); await T.waitFor(() => T.ss().scanId, 20000); return 1`)
  const mid = await ev(`const s = T.ss(); return { step: s.step, scanId: !!s.scanId }`)
  await ev(`await T.click(T.button('Cancelar', T.dialog())); await T.wait(500); return 1`)
  const cancelled = await ev(`const s = T.ss(); return { step: s.step, open: s.open, rows: s.rows.length, words: s.wordsText, toasts: T.toasts(), fx: T.effects().length }`)
  check('Cancelar no meio: volta às opções (palavras mantidas), aviso "Busca cancelada", nada criado', mid.step === 'scanning' && mid.scanId && cancelled.step === 'setup' && cancelled.open && cancelled.rows === 0 && cancelled.words === CUSTOM && cancelled.toasts.some((t) => t.includes('Busca cancelada')) && cancelled.fx === 0, { mid, cancelled })
  // uma nova busca logo depois funciona (o main libera a anterior)
  await ev(`await T.click(T.el('[data-sensitive-start]')); await T.waitFor(() => T.ss().step === 'scanning', 5000); await T.waitFor(() => T.ss().step !== 'scanning', 240000); return 1`)
  const again = await ev(`return { step: T.ss().step, rows: T.ss().rows.length }`)
  check('nova busca depois de cancelar conclui', again.step === 'review' && again.rows >= 4, again)
  await ev(`await T.click(T.dialog().querySelector('[aria-label="Fechar"]')); await T.wait(300); return 1`)
  check('fechar apaga os termos da memória', (await ev(`return T.ss().wordsText === '' && !T.ss().open && T.ss().rows.length === 0`)), null)
}

/** Arquivos (recursivo) que contêm algum dos termos (bytes UTF-8, UTF-16LE e só dígitos). */
function leaks(dir, needles, sinceMs = 0, maxBytes = 64 * 1024 * 1024) {
  const out = []
  const walk = (d, depth) => {
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); continue }
      let s
      try { s = statSync(p) } catch { continue }
      if (s.mtimeMs < sinceMs || s.size > maxBytes || s.size === 0) continue
      let b
      try { b = readFileSync(p) } catch { continue }
      for (const n of needles) if (b.includes(n)) { out.push({ file: p, needle: n.toString('utf8').slice(0, 3) + '…' }); break }
    }
  }
  walk(dir, 0)
  return out
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    if (ws) await shot('e2e-g3-ui-erro.png')
  } catch {
    // sem janela
  }
} finally {
  try { ws?.close() } catch { /* ignorar */ }
  if (app) {
    try {
      // só o PID iniciado aqui (nunca por nome de imagem: o app instalado tem o mesmo executável)
      execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // já saiu
    }
  }
  await sleep(1500)
  if (truths.length) {
    console.log('privacidade: nenhum arquivo com a palavra personalizada ou um valor verdadeiro')
    const needles = []
    for (const v of truths) {
      needles.push(Buffer.from(v, 'utf8'), Buffer.from(v, 'utf16le'))
      const d = v.replace(/\D/g, '')
      if (d.length >= 8) needles.push(Buffer.from(d, 'utf8'))
    }
    const inTest = leaks(E2E, needles)
    check('test-out/e2e-g3-ui (gravação, pasta de projetos, project.json, cache) sem os valores', inTest.length === 0, inTest.slice(0, 10))
    const inTemp = leaks(tmpdir(), needles, t0 - 1000)
    check('%TEMP% (arquivos tocados durante o teste) sem os valores', inTemp.length === 0, inTemp.slice(0, 10))
    let logLeak = false
    if (existsSync(MAIN_LOG)) {
      const size = statSync(MAIN_LOG).size
      const from = size >= logSize0 ? logSize0 : 0
      const fd = openSync(MAIN_LOG, 'r')
      const buf = Buffer.alloc(size - from)
      readSync(fd, buf, 0, buf.length, from)
      closeSync(fd)
      logLeak = needles.some((n) => buf.includes(n))
      console.log(`  main.log: ${buf.length} bytes novos lidos`)
    }
    check('o trecho novo do main.log não tem os valores', !logLeak, null)
  }
  failures += guard.finish()
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
