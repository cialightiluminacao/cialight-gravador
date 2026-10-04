// E2E do editor F3 via CDP, ponta a ponta num projeto de gravação (tela testsrc + microfone com fala sintética e pausas
// conhecidas): remove os silêncios pelo painel → importa uma música e põe no playhead (faixa Música, ducking ligado) →
// grava uma narração com o microfone falso do Chromium (CIALIGHT_TEST=editor-narration) → põe o último clipe a 2× com
// "Manter tom" → exporta "YouTube 1080p". No arquivo, com o ffmpeg: duração total e fim da voz como o plano calcula,
// a música abaixa −12 dB (±1,5) sob a fala, o tom da voz no clipe a 2× é o mesmo (Goertzel 220/440 Hz) e a narração
// está no lugar do item (±50 ms). Eventos sintéticos despachados no elemento real sob o ponto — nunca entrada do sistema
// operacional. Só mídia sintética (o repositório é público).
//
// uso (depois de `npm run build`):  node scripts/qa/editor-f3-e2e.mjs
// Tudo em test-out/f3-e2e (CIALIGHT_RAW_DIR=test-out/f3-e2e/raw → projeto em test-out/f3-e2e/Projetos).
// Screenshots em docs/qa/editor-f3/. settings.json do usuário é restaurado se mudar (e o hash conferido).
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'
import { guardShot } from './shotGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9339'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f3')
const BASE = join(ROOT, 'test-out', 'f3-e2e')
const RAW_REL = 'test-out/f3-e2e/raw'
const OUT = join(BASE, 'export')
const SID = 'qa-f3-e2e-session'
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : null)
const S = 1_000_000
const SR = 48000

// ---- o plano ----
// gravação de 14 s; fala (s) com pausas de 2 s em 4–6 e 9–11 (0–0,5 s é curto demais para virar corte)
const DUR_S = 14
const SPEECH = [[0.5, 4], [6, 9], [11, 14]]
// painel com os padrões (silêncio ≥ 0,7 s, margem 0,15 s) → cortes 4,15–5,85 e 9,15–10,85
const CUTS = [[4.15, 5.85], [9.15, 10.85]]
const AFTER_CUT_S = DUR_S - CUTS.reduce((n, [a, b]) => n + b - a, 0) // 10,6 s
// pedaços da tela depois do corte: A 0–4,15 | B 4,15–7,45 | C 7,45–10,6 (fonte 10,85–14) → C a 2× dura 1,575 s
const C_START_S = 7.45
const VIDEO_END_S = C_START_S + (DUR_S - CUTS[1][1]) / 2 // 9,025 s
// fala na timeline final: A 0,5–4 | B 4,3–7,3 | C 7,525–9,025
const MUSIC_S = 16
const MUSIC_HZ = 1500
const NARR_HZ = 2500
const NARR_AT_S = 10
const NARR_MIN_US = 2 * S
const TOL_US = 50_000

mkdirSync(SHOTS, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// ---- mídia sintética: gravação (tela + microfone com fala), música e o tom do microfone falso ----
const MUSIC = join(BASE, 'trilha-qa.m4a')
const TONE = join(BASE, 'narracao-tom.wav')
function makeFixtures() {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args])
  ff(['-f', 'lavfi', '-i', `sine=frequency=${NARR_HZ}:sample_rate=${SR}:duration=20`, '-af', 'volume=0.5', '-ac', '1', '-c:a', 'pcm_s16le', TONE])
  ff(['-f', 'lavfi', '-i', `sine=frequency=${MUSIC_HZ}:sample_rate=${SR}:duration=${MUSIC_S}`, '-af', 'volume=2', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', MUSIC])
  const dir = join(ROOT, RAW_REL, SID)
  mkdirSync(dir, { recursive: true })
  // mesma "voz" do QA dos silêncios: 220 Hz + harmônicos, modulada a 4 Hz, só nos intervalos de fala
  const voice = `0.3*(0.6+0.4*sin(2*PI*4*t))*(sin(2*PI*220*t)+0.5*sin(4*PI*220*t)+0.25*sin(6*PI*220*t))*(${SPEECH.map(([a, b]) => `between(t,${a},${b})`).join('+')})`
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', `aevalsrc='${voice}':s=${SR}`,
    '-t', String(DUR_S), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', join(dir, 'rec.mp4')
  ])
  const session = {
    version: 1, id: SID, createdAt: new Date().toISOString(), state: 'stopped',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 },
    video: { width: 1280, height: 720, fps: 30, codec: 'avc1.640028', bitrate: 8e6 },
    mic: { deviceId: 'y', label: 'Mic', echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    systemAudio: false,
    tracks: { screen: 0, mic: 0 },
    durationMs: DUR_S * 1000,
    pauses: [], pip: [], strokes: [], clearEvents: [], markers: [], engine: 'webcodecs', files: { rec: 'rec.mp4' }
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2))
}

makeFixtures()
const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CIALIGHT_TEST: 'editor-narration', CIALIGHT_FAKE_AUDIO: TONE, CIALIGHT_RAW_DIR: RAW_REL },
  stdio: 'ignore'
})

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
          if (m.method === 'Runtime.exceptionThrown') console.log('    [página] exceção:', m.params.exceptionDetails?.exception?.description?.slice(0, 400) ?? m.params.exceptionDetails?.text)
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__eq; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  await guardShot(send)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}
async function until(body, ms, step = 100) {
  const t0 = Date.now()
  let v
  while (Date.now() - t0 < ms) {
    v = await ev(body)
    if (v) return v
    await sleep(step)
  }
  return v
}

// helpers da página (os mesmos dos QA de silêncio, velocidade e narração)
const HELPERS = `
window.__eq = (() => {
  const st = () => window.__qaEditor.store.getState()
  const nar = () => window.__qaEditor.narration.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  /** Clique completo (pointer + mouse + click) no elemento real sob o ponto. */
  const clickEl = async (e, at) => {
    e.scrollIntoView({ block: 'nearest' })
    const c = at ?? center(e)
    const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y)); t.dispatchEvent(me('mousedown', c.x, c.y))
    window.dispatchEvent(pe('pointerup', c.x, c.y)); t.dispatchEvent(me('mouseup', c.x, c.y)); t.dispatchEvent(me('click', c.x, c.y))
    await settle()
    return t
  }
  const button = (label, root = document) => [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label)
  const dialog = () => document.querySelector('[role="dialog"]')
  const project = () => st().project
  const key = (k, code) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true }))
  const items = () => project().tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.name, role: t.role ?? null, kind: t.kind })))
  const trackEnd = (name) => Math.max(0, ...project().tracks.filter((t) => t.name === name).flatMap((t) => t.items.map((i) => i.startUs + i.durationUs)))
  const narrItems = () => items().filter((i) => i.track.startsWith('Narração')).map((i) => ({ ...i, asset: project().assets.find((a) => a.id === i.assetId) }))
  const panel = () => el('[aria-label="Inspetor"]')
  const tab = (text) => { const b = [...panel().querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === text); if (!b) throw new Error('sem aba ' + text); return b }
  const binTab = (text) => { const b = [...el('[aria-label="Biblioteca de mídia"]').querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === text); if (!b) throw new Error('sem aba ' + text); return b }
  /** Clique no início do item na timeline (longe das alças de aparar). */
  const selectItem = async (id) => { const e = el('[data-item-id="' + id + '"]'); const r = e.getBoundingClientRect(); await clickEl(e, { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }); await wait(150) }
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await wait(500); await settle() }
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent)
  return { st, nar, settle, wait, el, clickEl, button, dialog, project, key, items, trackEnd, narrItems, panel, tab, binTab, selectItem, seek, toasts }
})()
'ok'`

async function openEditor(pid) {
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(600)
  await ev(`window.__navigate('editor:${pid}'); return 1`)
  const ok = await until(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!s.project.assets.find((a) => a.id.endsWith('-mic'))?.speech`, 150_000, 500)
  await ev(HELPERS + '; return 1')
  return ok
}

// ---- análise do arquivo exportado ----
/** PCM mono f32 da faixa de áudio do arquivo. */
function pcmOf(file) {
  const raw = execFileSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 28 })
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
}
/** Amplitude (Goertzel) na frequência dada, por janela de `win` amostras a cada `hop`; `hann` reduz o vazamento. */
function goertzel(pcm, hz, { win = 960, hop = 480, hann = false } = {}) {
  const out = []
  const k = 2 * Math.cos((2 * Math.PI * hz) / SR)
  const w = Array.from({ length: win }, (_, j) => (hann ? 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (win - 1)) : 1))
  const norm = w.reduce((s, v) => s + v, 0) / 2
  for (let i = 0; i + win <= pcm.length; i += hop) {
    let s1 = 0, s2 = 0
    for (let j = 0; j < win; j++) {
      const s0 = pcm[i + j] * w[j] + k * s1 - s2
      s2 = s1
      s1 = s0
    }
    out.push(Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / norm)
  }
  return out
}
/** Amplitude média (Hann, 100 ms) em hz no intervalo [a, b) s. */
function bandLevel(pcm, hz, a, b) {
  const seg = pcm.subarray(Math.round(a * SR), Math.round(b * SR))
  const v = goertzel(seg, hz, { win: 4800, hop: 2400, hann: true })
  return v.reduce((s, x) => s + x, 0) / Math.max(1, v.length)
}
const dB = (x) => 20 * Math.log10(Math.max(1e-12, x))

async function main() {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1000, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)

  console.log('projeto de gravação (tela + microfone com fala e pausas)')
  const pid = await ev(`const p = await window.api.project.fromSession('${SID}'); return p.id`)
  await ev(`localStorage.setItem('editor.timelineHeight', '330'); localStorage.removeItem('editor.narration.mic'); localStorage.removeItem('editor.narration.monitor'); return 1`)
  check('gravação aberta no editor, ingestão e análise de fala do microfone prontas', await openEditor(pid), null)
  const shape = await ev(`return T.project().tracks.map((t) => t.name + ':' + (t.role ?? ''))`)
  check('faixas: Tela e Microfone (Voz)', shape.join('|') === 'Tela:|Microfone:voice', shape)

  // ---------- 1) remover silêncios ----------
  console.log('1) Remover silêncios (padrões do painel)')
  {
    await ev(`await T.clickEl(T.button('Remover silêncios')); return 1`)
    const cuts = await until(`const c = window.__qaEditor.silence.getState().cuts; return c.length ? c.map((x) => [x.fromUs, x.toUs]) : null`, 10000, 250)
    const near = (a, b) => Math.abs(a - b * S) <= 0.1 * S
    check(`cortes ${cuts?.map(([a, b]) => `${(a / S).toFixed(2)}–${(b / S).toFixed(2)}`).join(', ')} ≈ ${CUTS.map(([a, b]) => `${a}–${b}`).join(', ')} (±0,1 s)`, cuts?.length === 2 && cuts.every(([a, b], k) => near(a, CUTS[k][0]) && near(b, CUTS[k][1])), cuts)
    await ev(`await T.clickEl(T.button('Aplicar')); await T.wait(400); return 1`)
    const r = await ev(`return { tela: T.trackEnd('Tela'), mic: T.trackEnd('Microfone'), n: T.project().tracks.find((t) => t.name === 'Tela').items.length, open: !!document.querySelector('[data-silence-dialog]') }`)
    check(`aplicado: tela e microfone terminam em ${(r.tela / S).toFixed(2)} s ≈ ${AFTER_CUT_S.toFixed(2)} s (±0,2), em 3 pedaços`, Math.abs(r.tela - AFTER_CUT_S * S) <= 0.2 * S && r.mic === r.tela && r.n === 3 && !r.open, r)
  }

  // ---------- 2) música com ducking ----------
  console.log('2) música importada no playhead (faixa Música, ducking ligado)')
  let music
  {
    await ev(`await T.seek(0); await window.__qaEditor.importPaths([${JSON.stringify(MUSIC)}]); return 1`)
    const ready = await until(`const a = T.project().assets.find((x) => x.name.startsWith('trilha-qa')); return a?.status === 'ready' ? a.id : null`, 60000, 300)
    check('música importada e pronta', !!ready, ready)
    await ev(`await T.clickEl(T.binTab('Áudio')); await T.wait(200); await T.clickEl(document.querySelector('[aria-label^="Adicionar trilha-qa"]')); await T.wait(300); return 1`)
    music = await ev(`const i = T.items().find((x) => x.assetId === '${ready}'); return i ? { id: i.id, track: i.track, role: i.role, startUs: i.startUs, durationUs: i.durationUs, fadeInUs: i.audio.fadeInUs, fadeOutUs: i.audio.fadeOutUs } : null`)
    check(`música na faixa "Música" (papel música) de 0 a ${MUSIC_S} s, sem fades`, !!music && music.track === 'Música' && music.role === 'music' && music.startUs === 0 && Math.abs(music.durationUs - MUSIC_S * S) <= 0.05 * S && !music.fadeInUs && !music.fadeOutUs, music)
    const duck = await ev(`T.st().select([]); await T.settle(); await T.wait(200); return { has: T.panel().textContent.includes('Música sob a voz'), on: T.panel().querySelector('[role="switch"][aria-label^="Abaixar a música"]')?.getAttribute('aria-checked'), hint: T.panel().querySelector('[data-ducking-hint]')?.textContent ?? null, mix: T.project().audioMix ?? null }`)
    check('inspetor do projeto: "Música sob a voz" ligado, sem aviso', duck.has && duck.on === 'true' && !duck.hint, duck)
    await shot('f3-e2e-01-silencios-e-musica.png')
  }

  // ---------- 3) narração com o microfone falso ----------
  console.log(`3) narração de ~2 s a partir de ${NARR_AT_S} s (microfone falso: tom de ${NARR_HZ} Hz)`)
  let narr
  {
    await ev(`await T.seek(${NARR_AT_S * S}); return 1`)
    await ev(`await T.clickEl(T.button('Gravar narração')); await T.wait(300); return 1`)
    const setup = await ev(`const d = document.querySelector('[data-narration-setup]'); return d ? { monitor: d.querySelector('[role="switch"]').getAttribute('aria-checked') } : null`)
    if (setup?.monitor === 'true') await ev(`await T.clickEl(document.querySelector('[data-narration-setup] [role="switch"]')); return 1`)
    await ev(`await T.clickEl(T.button('Gravar', document.querySelector('[data-narration-setup]'))); return 1`)
    const rec = await until(`return T.nar().phase === 'recording'`, 8000, 20)
    check('contagem e gravação começaram', !!rec, null)
    await until(`return T.nar().recordedUs >= ${NARR_MIN_US}`, 8000, 20)
    await ev(`T.key(' ', 'Space'); return 1`)
    narr = await until(`const [i] = T.narrItems(); return T.nar().phase === 'idle' && i ? { id: i.id, startUs: i.startUs, durationUs: i.durationUs, track: i.track, role: i.role, assetId: i.assetId } : null`, 15000, 100)
    check(`narração na faixa "Narração" (Voz) em ${narr ? (narr.startUs / S).toFixed(3) : '?'} s ≈ ${NARR_AT_S} s (±50 ms), ~2 s`, !!narr && narr.track === 'Narração' && narr.role === 'voice' && Math.abs(narr.startUs - NARR_AT_S * S) <= TOL_US && narr.durationUs >= NARR_MIN_US - 0.1 * S && narr.durationUs <= NARR_MIN_US + 0.4 * S, narr)
    const ing = await until(`const a = T.project().assets.find((x) => x.id === '${narr?.assetId}'); return a?.status === 'ready' && !!a.speech ? 1 : null`, 60000, 500)
    check('narração analisada (fala pronta para o ducking)', !!ing, null)
  }

  // ---------- 4) último clipe a 2× com o tom preservado ----------
  console.log('4) clipe C (fonte 10,85–14 s) a 2× com "Manter tom"')
  {
    const c = await ev(`return T.items().find((i) => i.track === 'Tela' && Math.abs(i.startUs - ${Math.round(C_START_S * S)}) <= 200000)?.id ?? null`)
    check('pedaço C da tela encontrado', !!c, null)
    await ev(`T.st().select([]); await T.selectItem('${c}'); await T.clickEl(T.tab('Velocidade')); await T.wait(200); await T.clickEl(T.button('2×', T.panel())); await T.wait(300); return 1`)
    const r = await ev(`const it = T.items().find((i) => i.id === '${c}'); const linked = T.items().filter((i) => i.linkId && i.linkId === it.linkId && i.type === 'media'); return { sel: T.st().selection, linked: linked.map((i) => ({ track: i.track, speed: i.speed, pitch: i.audio.preservePitch, start: i.startUs, dur: i.durationUs })), tom: T.panel().querySelector('[role="switch"][aria-label="Manter tom"]')?.getAttribute('aria-checked'), tela: T.trackEnd('Tela') }`)
    check('tela e microfone do pedaço C a 2× com "Manter tom" ligado', r.sel[0] === c && r.linked.length === 2 && r.linked.every((x) => x.speed === 2 && x.pitch === true) && r.tom === 'true', r)
    check(`tela termina em ${(r.tela / S).toFixed(3)} s ≈ ${VIDEO_END_S.toFixed(3)} s do plano (±0,2)`, Math.abs(r.tela - VIDEO_END_S * S) <= 0.2 * S, r.tela)
    // playhead no clipe a 2× e sem avisos por cima da faixa Narração
    await ev(`T.st().select([]); await T.seek(${8 * S}); return 1`)
    await until(`return T.toasts().length === 0`, 10000, 250)
    await shot('f3-e2e-02-timeline-final.png')
  }

  // ---------- 5) exportar YouTube 1080p ----------
  console.log('5) exportar "YouTube 1080p"')
  const plan = await ev(`return { videoEnd: T.trackEnd('Tela'), voiceEnd: T.trackEnd('Microfone'), end: Math.max(...T.project().tracks.filter((t) => !t.hidden).flatMap((t) => t.items.map((i) => i.startUs + i.durationUs))), narr: T.narrItems().map((i) => ({ startUs: i.startUs, durationUs: i.durationUs })) }`)
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; await T.seek(0); await T.clickEl([...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Exportar'))); await T.wait(500)
    await T.clickEl([...T.dialog().querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith('YouTube 1080p'))); return 1`)
  const dlg = await ev(`return T.dialog()?.textContent ?? ''`)
  check('diálogo com "YouTube 1080p"', dlg.includes('YouTube 1080p'), dlg.slice(0, 200))
  await shot('f3-e2e-03-exportar.png')
  await ev(`await T.clickEl(T.button('Exportar', T.dialog())); return 1`)
  const t0 = Date.now()
  const done = await until(`const t = T.dialog()?.textContent ?? ''; return t.includes('Vídeo exportado') ? 'ok' : t.includes('falhou') ? t : null`, 300_000, 300)
  console.log(`  exportação: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  check('exportação concluída', done === 'ok', done)
  await ev(`if (T.dialog()) { const b = T.button('Fechar', T.dialog()); if (b) await T.clickEl(b) } return 1`)
  const files = readdirSync(OUT).filter((f) => f.endsWith('.mp4'))
  check('um .mp4 na pasta', files.length === 1, readdirSync(OUT))
  if (files.length !== 1) return
  const file = join(OUT, files[0])

  console.log('6) conferência com o ffmpeg')
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
  const vs = probe.streams.find((s) => s.codec_type === 'video')
  const narrEnd = (plan.narr[0].startUs + plan.narr[0].durationUs) / S
  const expected = Math.max(VIDEO_END_S, MUSIC_S, narrEnd)
  const got = Number(probe.format.duration)
  check(`duração total ${got.toFixed(3)} s = plano max(vídeo ${VIDEO_END_S}, música ${MUSIC_S}, narração ${narrEnd.toFixed(2)}) = ${expected.toFixed(3)} s (±0,1)`, Math.abs(got - expected) <= 0.1 && Math.abs(plan.end / S - expected) <= 0.1, { got, expected, plan })
  console.log(`    vídeo ${vs?.width}×${vs?.height} ${vs?.codec_name}; áudio ${probe.streams.filter((s) => s.codec_type === 'audio').length} faixa(s)`)

  const pcm = pcmOf(file)
  // fim da voz no arquivo = fim da tela do plano (corte de silêncios + 2×): 220 Hz até ~9,0 s e nada depois
  {
    const before = bandLevel(pcm, 220, VIDEO_END_S - 0.6, VIDEO_END_S - 0.15)
    const after = bandLevel(pcm, 220, VIDEO_END_S + 0.15, NARR_AT_S - 0.1)
    check(`a voz termina em ${VIDEO_END_S} s como o plano (220 Hz antes ${dB(before).toFixed(1)} dB, depois ${dB(after).toFixed(1)} dB; ≥ 30 dB de diferença)`, dB(before) - dB(after) >= 30, { before: dB(before), after: dB(after) })
  }
  // ducking: a música (1,5 kHz) sob a fala dos pedaços A e B × a música sozinha depois da narração
  {
    const free = bandLevel(pcm, MUSIC_HZ, narrEnd + 1.2, MUSIC_S - 0.3)
    const underA = bandLevel(pcm, MUSIC_HZ, 1.0, 3.6)
    const underB = bandLevel(pcm, MUSIC_HZ, 4.6, 7.0)
    const underN = bandLevel(pcm, MUSIC_HZ, NARR_AT_S + 0.3, narrEnd - 0.2)
    const d = [underA, underB, underN].map((x) => dB(x) - dB(free))
    console.log(`    música: livre ${dB(free).toFixed(1)} dBFS; sob a fala A ${d[0].toFixed(2)} dB, B ${d[1].toFixed(2)} dB, sob a narração ${d[2].toFixed(2)} dB`)
    check(`música abaixa sob a fala da gravação: A ${d[0].toFixed(2)} dB, B ${d[1].toFixed(2)} dB (−12 ±1,5)`, Math.abs(d[0] + 12) <= 1.5 && Math.abs(d[1] + 12) <= 1.5, d)
    check(`…e sob a narração: ${d[2].toFixed(2)} dB (−12 ±1,5)`, Math.abs(d[2] + 12) <= 1.5, d)
  }
  // tom preservado: no pedaço C a 2×, 220 Hz e 440 Hz com a mesma relação do pedaço A a 1× (sem preservar, 220 → 440)
  {
    const a220 = bandLevel(pcm, 220, 1.0, 3.6), a440 = bandLevel(pcm, 440, 1.0, 3.6)
    const c220 = bandLevel(pcm, 220, 7.65, VIDEO_END_S - 0.1), c440 = bandLevel(pcm, 440, 7.65, VIDEO_END_S - 0.1)
    const lvl = dB(c220) - dB(a220)
    const ratioA = dB(a440) - dB(a220), ratioC = dB(c440) - dB(c220)
    console.log(`    voz: 220 Hz C−A ${lvl.toFixed(2)} dB; 440/220 A ${ratioA.toFixed(2)} dB, C ${ratioC.toFixed(2)} dB`)
    check(`tom preservado a 2×: 220 Hz no clipe C igual ao de 1× (${lvl.toFixed(2)} dB, ±3) e 440/220 igual (${ratioC.toFixed(2)} × ${ratioA.toFixed(2)} dB, ±3)`, Math.abs(lvl) <= 3 && Math.abs(ratioC - ratioA) <= 3, { lvl, ratioA, ratioC })
  }
  // narração: o tom de 2,5 kHz começa e termina com o item (±50 ms) e não aparece fora dele
  {
    const e = goertzel(pcm, NARR_HZ)
    const peak = Math.max(...e)
    const on = e.map((v) => v > peak / 2)
    const first = on.indexOf(true), last = on.lastIndexOf(true)
    const onsetUs = first * 10_000 + 10_000, offsetUs = last * 10_000 + 10_000
    const n = plan.narr[0]
    const nEnd = n.startUs + n.durationUs
    console.log(`    ${NARR_HZ} Hz de ${(onsetUs / S).toFixed(3)} a ${(offsetUs / S).toFixed(3)} s (item ${(n.startUs / S).toFixed(3)}–${(nEnd / S).toFixed(3)} s)`)
    check(`narração presente na posição do item: início ±50 ms (${((onsetUs - n.startUs) / 1000).toFixed(0)} ms), fim ±50 ms (${((offsetUs - nEnd) / 1000).toFixed(0)} ms)`, Math.abs(onsetUs - n.startUs) <= TOL_US && Math.abs(offsetUs - nEnd) <= TOL_US, { onsetUs, offsetUs, n })
    const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
    const ratio = dB(avg(e.slice(first + 5, last - 5))) - dB(avg([...e.slice(0, Math.max(0, first - 5)), ...e.slice(last + 5)]))
    check(`narração ausente fora do item (${ratio.toFixed(0)} dB de diferença, > 30)`, ratio > 30, ratio)
  }
  writeFileSync(join(BASE, 'e2e-f3-result.json'), JSON.stringify({ file: files[0], plan, expected, got, video: vs && { w: vs.width, h: vs.height } }, null, 2))
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
} finally {
  try { ws?.close() } catch { /* */ }
  try {
    execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // já saiu
  }
  if (settingsBefore) {
    await sleep(800)
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
