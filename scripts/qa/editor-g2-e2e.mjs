// E2E do G2 (legendas automáticas) via CDP, com eventos sintéticos despachados nos elementos reais da página — nunca
// entrada do sistema operacional. Fala sintética pt-BR (System.Speech, voz Maria, ~45 s, 3 pausas ≥ 1,5 s — nunca o
// microfone) vira o microfone de uma SESSÃO DE GRAVAÇÃO sintética (tela de cor lisa + microfone); o projeto é aberto no
// editor e o fluxo completo roda pela interface:
//   "Remover silêncios" (F3) → um trecho a 1,5× → "Gerar legendas" (Base, pt-BR, substituir) → editar o texto de uma
//   legenda à mão → exportar "YouTube 1080p" (o preset de 1080p do app; não existe "Alta 1080p") com "Queimar no vídeo"
//   e "Salvar arquivo .srt ao lado".
//
// uso (depois de `npm run build`; SEMPRE sob o lock das execuções do Electron):
//   node <pasta dos locks>/run-locked.mjs "node scripts/qa/editor-g2-e2e.mjs"
//
// Confere no arquivo exportado: (a) duração = a do plano; (b) o .srt tem o mesmo número de cues da faixa de legendas, com
// os tempos a ≤ 1 quadro dos da faixa; (c) legenda queimada: no meio de 3 cues a região da legenda difere do fundo liso
// conhecido por um limiar claro e numa pausa sem cue não difere; (d) ≥ 80 % das palavras da verdade no SRT em ordem e o
// instante esperado de cada palavra casada (verdade → cortes → clipe 1,5×) dentro da sua cue (± 0,3 s); (e) settings.json
// com o mesmo sha256. Tudo em test-out/qa-g2-e2e (CIALIGHT_RAW_DIR); modelos em test-out/whisper-models; screenshots só
// com mídia sintética em docs/qa/editor-g2/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'
import { guardSettings } from './settingsGuard.mjs'
import { synthSpeech } from './synthSpeech.mjs'
import { guardShot } from './shotGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9339'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-g2')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const QA = join(ROOT, 'test-out', 'qa-g2-e2e')
const RAW_REL = 'test-out/qa-g2-e2e/raw'
const MODELS_REL = 'test-out/whisper-models'
const MODELS = join(ROOT, MODELS_REL)
const OUT = join(QA, 'export')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const WAV = join(QA, 'media', 'fala.wav')
const SID = 'qa-g2-e2e-session'
const S = 1_000_000
const BG = [37, 99, 235] // 0x2563eb: fundo liso da "tela" gravada

// ~45 s, 3 pausas longas (1,5 s, 2 s e 1,7 s) e uma pausa curta no começo; sem números
const SSML = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-BR">
<break time="800ms"/>
Bom dia a todos, e sejam bem-vindos à reunião da equipe de iluminação.
Hoje vamos falar sobre a manutenção preventiva das luminárias da fábrica.
<break time="1500ms"/>
A produção cresceu bastante neste trimestre, e os clientes ficaram satisfeitos com a qualidade das peças.
<break time="2000ms"/>
O relatório completo será enviado por e-mail na próxima semana.
<break time="1700ms"/>
Se alguém tiver dúvidas, procure a coordenação da equipe durante a tarde.
Muito obrigado e até a próxima reunião.
</speak>`

mkdirSync(SHOTS, { recursive: true })
for (const d of ['raw', 'Projetos', 'export']) rmSync(join(QA, d), { recursive: true, force: true })
mkdirSync(join(QA, 'media'), { recursive: true })
mkdirSync(OUT, { recursive: true })
mkdirSync(MODELS, { recursive: true })

let failures = 0
let checks = 0
function check(name, ok, detail) {
  checks++
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 1500)}`}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- mídia sintética
async function makeMedia() {
  if (!existsSync(WAV) || !existsSync(`${WAV}.words.json`)) {
    console.log('sintetizando a fala (System.Speech, pt-BR)…')
    await synthSpeech({ ssmlOrText: SSML, voice: 'pt-BR', outWav: WAV })
  }
  return JSON.parse(readFileSync(`${WAV}.words.json`, 'utf8'))
}

/** Sessão de gravação sintética: tela lisa (v:0) + microfone com a fala (a:0), como o gravador grava. */
function makeSession(durS) {
  const dir = join(ROOT, RAW_REL, SID)
  mkdirSync(dir, { recursive: true })
  execFileSync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x2563eb:s=1280x720:r=30:d=${durS}`,
    '-i', WAV,
    '-map', '0:v', '-map', '1:a', '-t', String(durS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', join(dir, 'rec.mp4')
  ])
  const session = {
    version: 1, id: SID, createdAt: new Date().toISOString(), state: 'stopped',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 },
    video: { width: 1280, height: 720, fps: 30, codec: 'avc1.640028', bitrate: 8e6 },
    mic: { deviceId: 'y', label: 'Mic', echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    systemAudio: false,
    tracks: { screen: 0, mic: 0 },
    durationMs: Math.round(durS * 1000),
    pauses: [], pip: [], strokes: [], clearEvents: [], markers: [], engine: 'webcodecs', files: { rec: 'rec.mp4' }
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2))
}

// ---------------------------------------------------------------- texto / SRT / alinhamento
const norm = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
function alignInOrder(truthWords, capWords) {
  const out = []
  let j = 0
  for (const tw of truthWords) {
    let hit = -1
    for (let k = j; k < Math.min(capWords.length, j + 8); k++) if (capWords[k].n === tw.n) { hit = k; break }
    out.push(hit)
    if (hit >= 0) j = hit + 1
  }
  return out
}
/** Fonte → timeline pelos itens do asset na faixa de voz (conta independente do app): null se a fonte foi cortada. */
function mapSrc(items, src) {
  for (const it of items) {
    const lo = it.inUs, hi = it.inUs + it.durationUs * it.speed
    if (src >= lo && src < hi) return it.startUs + Math.round((src - lo) / it.speed)
  }
  return null
}
function parseSrt(file) {
  const b = readFileSync(file)
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  const text = b.subarray(bom ? 3 : 0).toString('utf8')
  const t = (s) => { const m = s.match(/(\d+):(\d+):(\d+),(\d+)/); return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * S + +m[4] * 1000 }
  const cues = text.split(/\r?\n\r?\n/).map((blk) => blk.trim()).filter(Boolean).map((blk) => {
    const lines = blk.split(/\r?\n/)
    const [a, b2] = lines[1].split(' --> ')
    return { s: t(a), e: t(b2), text: lines.slice(2).join('\n') }
  })
  return { bom, cues }
}

// ---------------------------------------------------------------- ffmpeg
function probe(file) {
  const p = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
  const vs = p.streams.find((s) => s.codec_type === 'video')
  return { codec: vs?.codec_name, width: vs?.width, height: vs?.height, duration: Number(p.format.duration), fps: vs?.avg_frame_rate }
}
function frameRgb(file, n) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 })
}
/** Pixels da região (frações do quadro) que diferem do fundo liso por mais de `tol` (soma dos canais). */
function diffFromBg(buf, w, h, r, tol = 90, bg = BG) {
  let n = 0
  for (let y = Math.floor(r.y0 * h); y < Math.floor(r.y1 * h); y++)
    for (let x = Math.floor(r.x0 * w); x < Math.floor(r.x1 * w); x++) {
      const i = (y * w + x) * 3
      if (Math.abs(buf[i] - bg[0]) + Math.abs(buf[i + 1] - bg[1]) + Math.abs(buf[i + 2] - bg[2]) > tol) n++
    }
  return n
}

// ---------------------------------------------------------------- CDP
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
async function ev(body, timeout = 300000) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__ge; ${body} })()`, awaitPromise: true, returnByValue: true, timeout })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function ev0(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await guardShot(send)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  [captura] ${name}`)
}

const HELPERS = `
window.__ge = (() => {
  const st = () => window.__qaEditor.store.getState()
  const ops = () => window.__qaEditor.ops
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel, root = document) => { const e = root.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel, root = document) => [...root.querySelectorAll(sel)]
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const click = async (e) => {
    e.scrollIntoView({ block: 'nearest' })
    const { x, y } = center(e)
    e.dispatchEvent(pe('pointerdown', x, y)); e.dispatchEvent(me('mousedown', x, y))
    e.dispatchEvent(pe('pointerup', x, y)); e.dispatchEvent(me('mouseup', x, y)); e.dispatchEvent(me('click', x, y))
    await settle()
  }
  const setValue = (input, value) => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })) }
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(400); await settle() }
  const seen = new WeakSet()
  const toasts = () => all('[data-sonner-toast]').filter((t) => !seen.has(t)).map((t) => t.textContent)
  const clearToasts = async () => { for (const t of all('[data-sonner-toast]')) seen.add(t); await settle() }
  const waitToast = async (pred, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const hit = toasts().find(pred); if (hit) return hit; await wait(200) } return null }
  const capTrack = () => st().project.tracks.find((t) => t.role === 'captions')
  const caps = () => (capTrack()?.items ?? []).map((i) => ({ id: i.id, s: i.startUs, e: i.startUs + i.durationUs, text: i.text, enabled: i.enabled !== false })).sort((a, b) => a.s - b.s)
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.getAttribute('aria-label') === text || x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const dialog = () => document.querySelector('[role="dialog"]')
  const gen = () => document.querySelector('[data-generate-dialog]')
  const tab = async (label) => { const t = all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').find((x) => x.textContent.trim() === label); if (!t) throw new Error('aba ' + label); t.dispatchEvent(pe('pointerdown', 0, 0)); t.dispatchEvent(me('mousedown', 0, 0)); t.click(); await settle(); await wait(150) }
  const voiceItems = () => { const t = st().project.tracks.find((x) => x.role === 'voice'); return t.items.filter((i) => i.type === 'media').map((i) => ({ startUs: i.startUs, durationUs: i.durationUs, inUs: i.inUs, speed: i.speed })) }
  return { st, ops, settle, wait, el, all, click, setValue, past, seek, toasts, clearToasts, waitToast, capTrack, caps, button, dialog, gen, tab, voiceItems }
})()
'ok'`

// ---------------------------------------------------------------- main
async function main(truth, durS) {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev0(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)

  const base = await ev0(`return (await window.api.transcribe.models()).find((m) => m.id === 'base')`)
  if (!base?.present) {
    console.log('modelo base ausente em test-out/whisper-models: baixando pela IPC do app…')
    const r = await ev0(`return await window.api.transcribe.downloadModel('base')`)
    check('download do modelo base pela IPC', r?.ok === true, r)
  }

  // ------------------------------------------------------------------ 1
  console.log('1. sessão de gravação sintética → projeto no editor')
  const pid = await ev0(`const p = await window.api.project.fromSession('${SID}'); return p.id`)
  await ev0(`localStorage.setItem('editor.timelineHeight', '240'); window.__navigate('projects'); return 1`)
  await sleep(600)
  await ev0(`window.__navigate('editor:${pid}'); return 1`)
  let ready = false
  for (let i = 0; i < 180 && !ready; i++) {
    ready = await ev0(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!s.project.assets.find((a) => a.id.endsWith('-mic'))?.speech`)
    if (!ready) await sleep(1000)
  }
  check('gravação aberta; ingestão e análise de fala do microfone prontas', ready, null)
  await ev0(HELPERS + '; return 1')
  const shape = await ev(`return T.st().project.tracks.map((t) => t.name + ':' + (t.role ?? '') + ':' + t.items.length)`)
  check('faixas: Tela e Microfone (voz)', shape.join('|') === 'Tela::1|Microfone:voice:1', shape)
  const fps = await ev(`return T.st().project.canvas.fps`)

  // ------------------------------------------------------------------ 2
  console.log('2. Remover silêncios (F3) e um clipe a 1,5×')
  const dur0 = await ev(`return T.ops().nonCaptionContentEndUs(T.st().project)`)
  await ev(`await T.click(T.button('Remover silêncios')); for (let i = 0; i < 80 && !window.__qaEditor.silence.getState().cuts.length; i++) await T.wait(250); return 1`)
  const cuts = await ev(`return window.__qaEditor.silence.getState().cuts.map((c) => [c.fromUs, c.toUs])`)
  console.log(`  cortes: ${JSON.stringify(cuts.map(([a, b]) => [(a / S).toFixed(2), (b / S).toFixed(2)]))}`)
  check('a análise propõe cortes (≥ 3: as pausas longas)', cuts.length >= 3, cuts)
  await shot('g2-e2e-01-silencios.png')
  await ev(`await T.click(T.button('Aplicar')); await T.wait(600); return 1`)
  const dur1 = await ev(`return T.ops().nonCaptionContentEndUs(T.st().project)`)
  const saved = cuts.reduce((a, [f, t]) => a + (t - f), 0)
  check('duração depois dos cortes = antes − soma dos cortes (± 0,1 s)', Math.abs(dur0 - saved - dur1) <= 100_000, { dur0, saved, dur1 })
  const setup = await ev(`const v = T.voiceItems(); if (v.length < 3) return { v }
    // um clipe do meio a 1,5× (o setSpeed muda também os vinculados)
    const screen = T.st().project.tracks.find((t) => t.name === 'Tela').items.find((i) => i.startUs === v[1].startUs)
    T.st().apply((p) => T.ops().setSpeed(p, screen.id, 1.5)); await T.settle()
    return { v: T.voiceItems(), end: T.ops().nonCaptionContentEndUs(T.st().project) }`)
  console.log(`  itens de voz: ${JSON.stringify(setup.v)}`)
  // (mudar a velocidade encurta o clipe e deixa uma lacuna depois dele: o editor não fecha lacunas sozinho)
  check('um clipe a 1,5× e os demais a 1×; clipes em ordem, sem sobreposição', setup.v.length >= 3 && setup.v.filter((x) => x.speed === 1.5).length === 1 && setup.v.every((x, i) => i === 0 || x.startUs >= setup.v[i - 1].startUs + setup.v[i - 1].durationUs), setup)
  const truthTl = truth.words.map((w) => ({ text: w.text, n: norm(w.text), src: w.startUs, t: mapSrc(setup.v, w.startUs) })).filter((w) => w.n && w.t !== null)
  console.log(`  verdade: ${truth.words.length} palavras, ${truthTl.length} na timeline depois dos cortes`)
  const plan = setup.end

  // ------------------------------------------------------------------ 3
  console.log('3. Gerar legendas (Base, pt-BR, substituir)')
  await ev(`await T.tab('Legendas'); await T.clearToasts(); await T.click(T.el('[data-caption-generate]'))
    for (let i = 0; i < 50 && !T.gen()?.querySelector('[data-model-option]'); i++) await T.wait(100)
    T.el('[data-model-option="base"] input').click(); await T.settle()
    const m = T.gen().querySelector('[data-generate-mode="replace"] input'); if (m) { m.click(); await T.settle() }
    await T.click(T.el('[data-generate-start]')); return 1`)
  const t0 = Date.now()
  const done = await ev(`const toast = await T.waitToast((t) => /legendas? geradas?/.test(t) || t.includes('Nenhuma fala') || t.includes('Não foi possível'), 300000); await T.wait(200)
    return { toast, open: !!T.gen(), caps: T.caps() }`)
  console.log(`  geração: ${((Date.now() - t0) / 1000).toFixed(1)} s; toast: ${done.toast}`)
  check(`toast "${done.caps.length} legendas geradas" e diálogo fechado`, !!done.toast && done.toast.includes(`${done.caps.length} legendas geradas`) && !done.open && done.caps.length >= 6, done)
  await ev(`const c = T.caps()[3]; await T.seek(Math.round((c.s + c.e) / 2)); return 1`)
  await shot('g2-e2e-02-geradas.png')

  // ------------------------------------------------------------------ 4
  console.log('4. editar o texto de uma legenda à mão')
  const edit = await ev(`const p0 = T.past(); const idx = 2; const before = T.caps()[idx]
    const ta = T.all('[data-caption-text]')[idx]; ta.focus()
    const want = before.text.toUpperCase()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, want); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.blur(); await T.settle(); await T.wait(300)
    return { p0, past: T.past(), want, got: T.caps()[idx].text, n: T.caps().length }`)
  check('texto editado na lista (MAIÚSCULAS), um passo de desfazer, mesmas cues', edit.got === edit.want && edit.past === edit.p0 + 1 && edit.n === done.caps.length, edit)
  const caps = await ev(`return T.caps().filter((c) => c.enabled)`)

  // ------------------------------------------------------------------ 5
  console.log('5. exportar "YouTube 1080p" com "Queimar no vídeo" + ".srt ao lado"')
  const before5 = await ev(`return T.past()`)
  await ev(`document.activeElement?.blur?.(); T.st().select([]); window.__qaEditor.exportDir = ${JSON.stringify(OUT)}
    await T.click([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(600)
    await T.click([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith('YouTube 1080p'))); return 1`)
  const opt = await ev(`const d = T.dialog(); const srt = d.querySelector('[data-caption-srt]'); if (!srt.checked) await T.click(srt)
    return { burn: d.querySelector('[data-caption-burn]')?.checked, srt: d.querySelector('[data-caption-srt]')?.checked }`)
  check('diálogo: "Queimar no vídeo" e "Salvar arquivo .srt ao lado" marcados', opt.burn === true && opt.srt === true, opt)
  // o caminho da pasta aparece no diálogo: o texto fica invisível só na captura (a imagem não mostra caminhos da máquina)
  await ev(`const hid = []; for (const e of document.querySelectorAll('[role="dialog"] *')) if (e.children.length === 0 && /test-out/.test(e.textContent)) { e.style.visibility = 'hidden'; hid.push(e) } window.__ge.hid = hid; return hid.length`)
  await shot('g2-e2e-03-exportar.png')
  await ev(`for (const e of T.hid ?? []) e.style.visibility = ''; return 1`)
  await ev(`await T.click(T.button('Exportar', T.dialog())); return 1`)
  let text = ''
  const te = Date.now()
  for (let i = 0; i < 2400; i++) {
    text = await ev(`return T.dialog()?.textContent ?? ''`)
    if (text.includes('Vídeo exportado') || text.includes('falhou')) break
    await sleep(250)
  }
  console.log(`  exportação: ${((Date.now() - te) / 1000).toFixed(1)} s`)
  check('exportação concluída', text.includes('Vídeo exportado'), text.slice(0, 300))
  await ev(`if (T.dialog()) { await T.click(T.button('Fechar', T.dialog())); await T.wait(300) } return 1`)
  check('exportar não grava passo de desfazer', (await ev(`return T.past()`)) === before5, null)
  const files = readdirSync(OUT)
  const mp4s = files.filter((f) => f.endsWith('.mp4'))
  check('um .mp4 e o .srt de mesmo nome, sem .part', mp4s.length === 1 && files.length === 2 && files.includes(mp4s[0].replace(/\.mp4$/, '.srt')), files)
  if (mp4s.length !== 1) return
  const outFile = join(OUT, mp4s[0])

  // ------------------------------------------------------------------ 6
  console.log('6. conferência do arquivo exportado')
  const pr = probe(outFile)
  console.log(`  ${JSON.stringify(pr)}; plano ${(plan / S).toFixed(2)} s`)
  check(`(a) H.264 com a duração do plano (${(plan / S).toFixed(2)} s ± 0,12)`, pr.codec === 'h264' && Math.abs(pr.duration - plan / S) <= 0.12, { pr, plan })

  const srt = parseSrt(outFile.replace(/\.mp4$/, '.srt'))
  check('(b) .srt UTF-8 com BOM e o mesmo número de cues da faixa', srt.bom && srt.cues.length === caps.length, { bom: srt.bom, srt: srt.cues.length, track: caps.length })
  const frameUs = Math.round(S / fps)
  const badT = srt.cues.map((c, i) => [i, c, caps[i]]).filter(([, c, k]) => !k || Math.abs(c.s - k.s) > frameUs || Math.abs(c.e - k.e) > frameUs)
  check(`(b) tempos do .srt a ≤ 1 quadro (${(frameUs / 1000).toFixed(1)} ms) dos da faixa`, badT.length === 0, badT.slice(0, 3))
  check('(b) o texto editado à mão está no .srt', srt.cues[2]?.text === edit.want, { got: srt.cues[2]?.text, want: edit.want })

  // (d) palavras da verdade no SRT, em ordem, e cada uma dentro da sua cue (± 0,3 s)
  const capWords = []
  srt.cues.forEach((c, ci) => { for (const w of c.text.split(/\s+/)) { const n = norm(w); if (n) capWords.push({ n, ci }) } })
  const al = alignInOrder(truthTl, capWords)
  const matched = al.filter((x) => x >= 0).length
  const ratio = matched / truthTl.length
  console.log(`  palavras da verdade no SRT, em ordem: ${matched}/${truthTl.length} (${(ratio * 100).toFixed(1)} %)`)
  check('(d) ≥ 80 % das palavras da verdade no .srt, em ordem', ratio >= 0.8, { matched, total: truthTl.length })
  const off = []
  al.forEach((ci, i) => {
    if (ci < 0) return
    const c = srt.cues[capWords[ci].ci]
    const t = truthTl[i].t
    if (t < c.s - 300_000 || t > c.e + 300_000) off.push({ word: truthTl[i].text, t: t / S, cue: [c.s / S, c.e / S, c.text] })
  })
  console.log(`  palavras fora da sua cue (> 0,3 s): ${off.length}`)
  check('(d) o instante esperado de cada palavra casada (cortes + clipe 1,5×) cai na sua cue (± 0,3 s)', off.length === 0, off.slice(0, 6))
  const fast = truthTl.filter((w, i) => al[i] >= 0 && w.t >= setup.v.find((x) => x.speed === 1.5).startUs && w.t < setup.v.find((x) => x.speed === 1.5).startUs + setup.v.find((x) => x.speed === 1.5).durationUs)
  check('há palavras casadas dentro do clipe 1,5×', fast.length >= 5, fast.length)

  // (c) legenda queimada: diferença do fundo liso no meio de 3 cues; numa pausa sem cue, nenhuma
  const REGION = { x0: 0.1, y0: 0.72, x1: 0.9, y1: 0.99 }
  const idxs = [Math.floor(srt.cues.length * 0.25), Math.floor(srt.cues.length * 0.5), Math.floor(srt.cues.length * 0.75)]
  const inCue = []
  for (const k of idxs) {
    const c = srt.cues[k]
    const n = Math.round((((c.s + c.e) / 2) * pr.fps.split('/').reduce((a, b) => a / b)) / S)
    const f = frameRgb(outFile, n)
    inCue.push({ cue: k + 1, frame: n, px: diffFromBg(f, pr.width, pr.height, REGION) })
    if (k === idxs[1]) execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', outFile, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-update', '1', join(SHOTS, 'g2-e2e-04-quadro-com-legenda.png')])
  }
  console.log(`  pixels da legenda (≠ fundo) no meio de 3 cues: ${JSON.stringify(inCue)}`)
  const minPx = Math.floor(pr.width * pr.height * 0.01)
  check(`(c) no meio de 3 cues a região da legenda difere do fundo (> ${minPx} px)`, inCue.every((x) => x.px > minPx), inCue)
  // pausas sem cue (o fundo é o do próprio quadro: azul da tela, ou o preto do projeto onde não há mídia): uma no MEIO da fala (entre duas cues) e, de reforço, a maior do começo/fim
  const rate = pr.fps.split('/').reduce((a, b) => a / b)
  const noCuePx = (g) => { const n = Math.round((((g[0] + g[1]) / 2) * rate) / S); return { n, px: (() => { const f = frameRgb(outFile, n); const k = (Math.floor(pr.height / 2) * pr.width + 8) * 3; return diffFromBg(f, pr.width, pr.height, REGION, 90, [f[k], f[k + 1], f[k + 2]]) })() } }
  const total = pr.duration * S
  const interior = srt.cues.slice(1).map((c, i) => [srt.cues[i].e, c.s]).filter(([a, b]) => b - a >= 3 * frameUs).sort((x, y) => y[1] - y[0] - (x[1] - x[0]))
  check('há uma pausa sem cue de ≥ 3 quadros no meio da fala (entre duas cues)', interior.length >= 1, { cues: srt.cues.map((c) => [c.s / S, c.e / S]) })
  if (interior.length) {
    const r = noCuePx(interior[0])
    console.log(`  pausa no meio da fala [${(interior[0][0] / S).toFixed(2)}; ${(interior[0][1] / S).toFixed(2)}) s, quadro ${r.n}: ${r.px} px ≠ fundo`)
    check('(c) numa pausa sem cue no meio da fala a região da legenda é uniforme como o fundo do quadro (< 20 px)', r.px < 20, { gap: interior[0], ...r })
  }
  const edge = [[0, srt.cues[0].s], [srt.cues.at(-1).e, total - frameUs]].filter(([a, b]) => b - a >= 3 * frameUs)
  for (const g of edge) {
    const r = noCuePx(g)
    check(`(c) sem cue em [${(g[0] / S).toFixed(2)}; ${(g[1] / S).toFixed(2)}) s (começo/fim) também é uniforme como o fundo`, r.px < 20, { gap: g, ...r })
  }
}

let truth = null
const settings = guardSettings(SETTINGS)
try {
  truth = await makeMedia()
  const durS = Math.ceil(truth.durationUs / S) + 1
  console.log(`fala sintética: ${(truth.durationUs / S).toFixed(2)} s, ${truth.words.length} palavras`)
  makeSession(durS)
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, CIALIGHT_QA: 'g2-e2e', CIALIGHT_RAW_DIR: RAW_REL, CIALIGHT_WHISPER_MODELS_DIR: MODELS_REL },
    stdio: 'ignore'
  })
  await main(truth, durS)
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    await shot('g2-e2e-erro.png')
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
  failures += settings.finish()
  console.log(failures ? `\n${failures} falha(s) em ${checks} verificações` : `\ntudo OK (${checks} verificações)`)
  process.exit(failures ? 1 : 0)
}
