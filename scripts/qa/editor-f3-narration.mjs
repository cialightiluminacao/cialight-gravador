// QA + teste real da gravação de narração (F3 Task 7) via CDP. O app sobe em modo de teste (CIALIGHT_TEST=editor-narration:
// microfone falso do Chromium, sem pedir permissão) e o microfone falso toca um WAV com um tom de 440 Hz. Numa gravação
// de tela (testsrc + microfone com tom de 1 kHz): abre "Gravar narração" na barra da linha do tempo, confere a contagem
// 3-2-1, grava ~3 s a partir de 2 s com a timeline tocando, para com Espaço e verifica: microfone sem processamento,
// asset 'generated' em generated/narracao-1.m4a, item na faixa "Narração" (Voz) no lugar certo (±50 ms), um passo de
// desfazer; exporta e confere o tom de 440 Hz só no intervalo do item (±50 ms) e o 1 kHz do vídeo inteiro. Depois:
// microfone "desconectado" no meio (parcial inserido + aviso) e janela que cai no meio da gravação (arquivo parcial
// recuperado ao reabrir o projeto, com aviso). Eventos sintéticos na página — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):  node scripts/qa/editor-f3-narration.mjs
// Tudo em test-out/f3-narration. Screenshots em docs/qa/editor-f3/. settings.json do usuário é restaurado se mudar.
import { spawn, spawnSync, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'
import { guardShot } from './shotGuard.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9338'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f3')
const BASE = join(ROOT, 'test-out', 'f3-narration')
const RAW_REL = 'test-out/f3-narration/raw'
const OUT = join(BASE, 'export')
const TONE = join(BASE, 'tom-440.wav')
const SID = 'qa-narration-session'
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const S = 1_000_000
const DUR_S = 8
const START_S = 2
const TOL_US = 50_000

mkdirSync(SHOTS, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// ---- mídia: tom de 440 Hz do microfone falso + gravação de tela (testsrc + microfone com 1 kHz) ----
function makeFixtures() {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  execFileSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20', '-af', 'volume=0.5', '-ac', '1', '-c:a', 'pcm_s16le', TONE])
  const dir = join(ROOT, RAW_REL, SID)
  mkdirSync(dir, { recursive: true })
  execFileSync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', `aevalsrc='0.15*sin(2*PI*1000*t)':s=48000`,
    '-t', String(DUR_S), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', join(dir, 'rec.mp4')
  ])
  const session = {
    version: 1, id: SID, createdAt: new Date().toISOString(), state: 'stopped',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 },
    video: { width: 1280, height: 720, fps: 30, codec: 'avc1.640028', bitrate: 8e6 },
    mic: { deviceId: 'y', label: 'Mic', echoCancellation: false, noiseSuppression: false, autoGainControl: false },
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
          // erros da página aparecem no log do QA (diagnóstico)
          if (m.method === 'Runtime.exceptionThrown') console.log('    [página] exceção:', m.params.exceptionDetails?.exception?.description?.slice(0, 400) ?? m.params.exceptionDetails?.text)
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('    [página] console.error:', m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__nq; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
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

const HELPERS = `
window.__nq = (() => {
  const st = () => window.__qaEditor.store.getState()
  const nar = () => window.__qaEditor.narration.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const clickEl = async (e) => {
    const c = center(e)
    const t = document.elementFromPoint(c.x, c.y) ?? e
    t.dispatchEvent(pe('pointerdown', c.x, c.y)); t.dispatchEvent(me('mousedown', c.x, c.y))
    t.dispatchEvent(pe('pointerup', c.x, c.y)); t.dispatchEvent(me('mouseup', c.x, c.y)); t.dispatchEvent(me('click', c.x, c.y))
    await settle()
  }
  const button = (label, root = document) => [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label)
  const project = () => st().project
  const key = (k, code) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true }))
  const narrItems = () => project().tracks.filter((t) => t.name.startsWith('Narração')).flatMap((t) => t.items.map((i) => ({ ...i, track: t.name, role: t.role, asset: project().assets.find((a) => a.id === i.assetId) })))
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await new Promise((r) => setTimeout(r, 500)); await settle() }
  // streams do microfone abertos pela página (para conferir o processamento e simular o microfone desconectado)
  if (!window.__qaStreams) {
    window.__qaStreams = []
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await orig(c); window.__qaStreams.push(s); return s }
  }
  const lastTrack = () => window.__qaStreams.at(-1)?.getAudioTracks()[0]
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent)
  return { st, nar, settle, clickEl, button, project, key, narrItems, seek, lastTrack, toasts }
})()
'ok'`

async function openEditor(pid) {
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(600)
  await ev(`window.__navigate('editor:${pid}'); return 1`)
  const ok = await until(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`, 150_000, 500)
  await ev(HELPERS + '; return 1')
  return ok
}

/** Abre o popover, escolhe "ouvir" e grava; devolve quando a fase é 'recording'. */
async function startNarration(monitor, shots) {
  await ev(`await T.clickEl(T.button('Gravar narração')); await new Promise((r) => setTimeout(r, 300)); return 1`)
  const setup = await ev(`const d = document.querySelector('[data-narration-setup]'); return d ? { text: d.textContent, monitor: d.querySelector('[role="switch"]').getAttribute('aria-checked') } : null`)
  if (shots) {
    check('popover "Gravar narração" com o microfone e "ouvir o vídeo"', !!setup && setup.text.includes('Microfone') && setup.text.includes('Ouvir o vídeo enquanto grava') && setup.text.includes('Fake'), setup)
    await shot('f3-narracao-01-popover.png')
  }
  if (setup && (setup.monitor === 'true') !== monitor) await ev(`await T.clickEl(document.querySelector('[data-narration-setup] [role="switch"]')); return 1`)
  await ev(`await T.clickEl(T.button('Gravar', document.querySelector('[data-narration-setup]'))); return 1`)
  const cd = await until(`const c = document.querySelector('[data-narration-count]'); return c ? { count: c.textContent, phase: T.nar().phase, level: T.nar().level } : null`, 3000, 50)
  if (shots) {
    await sleep(400)
    check('contagem 3-2-1 na tela (VU do microfone já ativo)', !!cd && cd.phase === 'countdown' && ['3', '2'].includes(cd.count), cd)
    await shot('f3-narracao-02-contagem.png')
  }
  const t0 = Date.now()
  const rec = await until(`return T.nar().phase === 'recording'`, 6000, 20)
  return { ok: !!rec, countdownMs: Date.now() - t0 }
}

/** mean_volume (dB) do volumedetect do ffmpeg. */
function volDetect(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1])
}

/** Energia (Goertzel) por janela de 20 ms a cada 10 ms, na frequência dada. */
function goertzel(pcm, sr, hz, win = 960, hop = 480) {
  const out = []
  const k = 2 * Math.cos((2 * Math.PI * hz) / sr)
  for (let i = 0; i + win <= pcm.length; i += hop) {
    let s1 = 0, s2 = 0
    for (let j = 0; j < win; j++) {
      const s0 = pcm[i + j] + k * s1 - s2
      s2 = s1
      s1 = s0
    }
    out.push(Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (win / 2))
  }
  return out
}

async function main() {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1000, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)

  console.log('gravação de tela (testsrc + microfone com 1 kHz)')
  const pid = await ev(`const p = await window.api.project.fromSession('${SID}'); return p.id`)
  await ev(`localStorage.setItem('editor.timelineHeight', '330'); localStorage.removeItem('editor.narration.mic'); localStorage.removeItem('editor.narration.monitor'); return 1`)
  check('projeto aberto, ingestão pronta', await openEditor(pid), null)
  const pdir = join(BASE, 'Projetos', pid)

  // ---------- 1) narração de ~3 s a partir de 2 s ----------
  console.log('narração de ~3 s a partir de 2 s (timeline tocando muda)')
  await ev(`await T.seek(${START_S * S}); return 1`)
  const past0 = await ev(`return T.st().history.past.length`)
  const started = await startNarration(false, true)
  check('contagem de ~3 s antes de gravar', started.ok && started.countdownMs > 1500 && started.countdownMs < 4500, started)
  const live = await ev(`await new Promise((r) => setTimeout(r, 700)); const s = T.lastTrack()?.getSettings() ?? {}; return { ec: s.echoCancellation, ns: s.noiseSuppression, agc: s.autoGainControl, label: T.lastTrack()?.label, playing: T.st().playing, playhead: T.st().playheadUs, level: T.nar().level, recordedUs: T.nar().recordedUs, warned: T.toasts().some((t) => t.includes('processamento ligado')) }`)
  check('microfone sem processamento (eco, ruído e ganho automático desligados) e sem o aviso de processamento', live.ec === false && live.ns === false && live.agc === false && !live.warned, live)
  check('timeline tocando a partir do playhead durante a gravação; VU com sinal', live.playing === true && live.playhead > START_S * S && live.level > 0.05, live)
  // nada do editor responde enquanto grava: bloqueio por cima de tudo, atalhos e transporte ignorados
  const blocked = await ev(`
    const tl = document.querySelector('[data-editor-topbar]')
    const pts = [[700, 800], [660, 350], [1200, 300], [60, 690]]
    const hits = pts.map(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-narration-block]') ? 1 : 0)
    const past = T.st().history.past.length
    await T.clickEl(document.querySelector('button[aria-label="Dividir no playhead"]'))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', code: 'Home', bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 200))
    // teclado: nenhum controle do editor com o foco; Enter/Tab num botão focado à força são engolidos
    const focused = document.activeElement
    const focusFree = !focused || focused === document.body || !!focused.closest('[data-narration-bar]')
    const btn = document.querySelector('button[aria-label="Dividir no playhead"]')
    btn.focus()
    const kd = (k) => { const e = new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }); btn.dispatchEvent(e); return e.defaultPrevented }
    const swallowed = [kd('Enter'), kd('Tab')]
    btn.blur()
    return { focusFree, focusedTag: focused?.tagName + ':' + (focused?.getAttribute?.('aria-label') ?? ''), swallowed, hits, hint: document.querySelector('[data-narration-hint]')?.textContent, dp: T.st().history.past.length - past, playing: T.st().playing, phase: T.nar().phase, playhead: T.st().playheadUs }`)
  check('gravando: bloqueio cobre linha do tempo, visualizador, inspetor e barra; "Gravando narração — pare para editar"; clique e atalhos (S, Home) não editam nem pulam; foco fora do editor, Enter/Tab num botão focado engolidos', blocked.hits.every((h) => h === 1) && blocked.focusFree && blocked.swallowed.every(Boolean) && blocked.hint === 'Gravando narração — pare para editar' && blocked.dp === 0 && blocked.playing && blocked.phase === 'recording' && blocked.playhead > START_S * S, blocked)
  await shot('f3-narracao-03-gravando.png')
  await until(`return T.nar().recordedUs >= 3000000`, 8000, 20)
  const stopAt = await ev(`const r = { recordedUs: T.nar().recordedUs, playhead: T.st().playheadUs }; T.key(' ', 'Space'); return r`)
  // o que já estava no worklet/microfone quando a tecla chegou ainda entra (até um bloco de ~85 ms + a latência)
  const done = await until(`return T.nar().phase === 'idle' && T.narrItems().length === 1`, 15000, 100)
  check('Espaço para e insere a narração', !!done, null)
  const r1 = await ev(`const [i] = T.narrItems(); return { item: { startUs: i.startUs, durationUs: i.durationUs, inUs: i.inUs, track: i.track, role: i.role }, asset: { name: i.asset.name, source: i.asset.source, durationUs: i.asset.durationUs, kind: i.asset.kind }, dp: T.st().history.past.length - ${past0}, playing: T.st().playing, sel: T.st().selection, itemId: i.id }`)
  console.log('   ', JSON.stringify(r1))
  check('asset "Narração 1" gerado em generated/narracao-1.m4a', r1.asset.name === 'Narração 1' && r1.asset.kind === 'audio' && r1.asset.source.type === 'generated' && r1.asset.source.file === 'generated/narracao-1.m4a' && existsSync(join(pdir, 'generated', 'narracao-1.m4a')), r1.asset)
  check('item na faixa "Narração" (papel Voz), selecionado, em 1 passo de desfazer; reprodução parada', r1.item.track === 'Narração' && r1.item.role === 'voice' && r1.dp === 1 && r1.sel.includes(r1.itemId) && r1.playing === false, r1)
  check(`item no lugar certo: início ${(r1.item.startUs / S).toFixed(3)} s ≈ ${START_S} s (±50 ms)`, Math.abs(r1.item.startUs - START_S * S) <= TOL_US, r1.item)
  const tail = r1.asset.durationUs - stopAt.recordedUs
  check(`duração: arquivo = gravado até o Espaço (${(stopAt.recordedUs / S).toFixed(2)} s) + o bloco em curso (${(tail / 1000).toFixed(0)} ms ≤ 150 ms); item = arquivo − inUs ≈ 3 s`, Math.abs(r1.item.durationUs + r1.item.inUs - r1.asset.durationUs) <= 1 && tail >= 0 && tail <= 150_000 && Math.abs(r1.item.durationUs - 3 * S) <= 150_000, { r1, stopAt })
  // sem processamento, o arquivo tem o mesmo nível do WAV do microfone falso (AGC/supressão mudariam o nível)
  const levels = { arquivo: volDetect(join(pdir, 'generated', 'narracao-1.m4a')), fonte: volDetect(TONE) }
  check(`nível do arquivo igual ao da fonte (${levels.arquivo} dB × ${levels.fonte} dB, ±1 dB)`, Math.abs(levels.arquivo - levels.fonte) <= 1, levels)
  check('marcador de recuperação limpo depois de salvo', !existsSync(join(pdir, 'generated', 'narracao-1.m4a.pending.json')), readdirSync(join(pdir, 'generated')))
  const ingested = await until(`const a = T.narrItems()[0].asset; return a.status === 'ready' && !!a.peaks && !!a.speech && !!a.loudness ? { peaks: a.peaks, loudness: a.loudness } : null`, 60000, 500)
  check('ingestão da narração: peaks, fala e loudness', !!ingested, ingested)
  await ev(`T.st().select([]); await T.settle(); await new Promise((r) => setTimeout(r, 800)); return 1`)
  await shot('f3-narracao-04-timeline.png')

  // ---------- 2) exportação: o tom de 440 Hz só no intervalo do item ----------
  console.log('exportação: 440 Hz no intervalo da narração')
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; await T.seek(0); return 1`)
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Exportar' && !b.closest('[role="dialog"]')).click(); return 1`)
  await sleep(700)
  await ev(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Exportar').click(); return 1`)
  const exported = await until(`const t = document.querySelector('[role="dialog"]')?.textContent ?? ''; return t.includes('Vídeo exportado') ? 'ok' : t.includes('falhou') ? t : null`, 240_000, 300)
  check('exportação concluída', exported === 'ok', exported)
  await ev(`const c = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Fechar'); c?.click(); return 1`)
  const mp4 = readdirSync(OUT).find((f) => f.endsWith('.mp4'))
  if (mp4) {
    const raw = execFileSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', join(OUT, mp4), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 28 })
    const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
    const e440 = goertzel(pcm, 48000, 440)
    const e1k = goertzel(pcm, 48000, 1000)
    const hopUs = 10_000
    const peak = Math.max(...e440)
    const on = e440.map((v) => v > peak / 2)
    const first = on.indexOf(true), last = on.lastIndexOf(true)
    // centro da janela de 20 ms
    const onsetUs = first * hopUs + 10_000, offsetUs = last * hopUs + 10_000
    const itemEnd = r1.item.startUs + r1.item.durationUs
    console.log(`    440 Hz de ${(onsetUs / S).toFixed(3)} a ${(offsetUs / S).toFixed(3)} s (item ${(r1.item.startUs / S).toFixed(3)}–${(itemEnd / S).toFixed(3)} s)`)
    check('o tom de 440 Hz começa no início do item (±50 ms)', Math.abs(onsetUs - r1.item.startUs) <= TOL_US, { onsetUs, start: r1.item.startUs })
    check('…e termina no fim do item (±50 ms)', Math.abs(offsetUs - itemEnd) <= TOL_US, { offsetUs, itemEnd })
    const inside = e440.slice(first + 5, last - 5)
    const outside = [...e440.slice(0, Math.max(0, first - 5)), ...e440.slice(last + 5)]
    const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
    const ratioDb = 20 * Math.log10(avg(inside) / Math.max(1e-9, avg(outside)))
    check(`440 Hz contínuo dentro e ausente fora (${ratioDb.toFixed(0)} dB de diferença)`, inside.every((v) => v > peak / 4) && ratioDb > 30, { ratioDb })
    const k1 = e1k.slice(5, -5)
    check('o 1 kHz do microfone da gravação segue o vídeo inteiro', k1.every((v) => v > Math.max(...k1) / 4), { min: Math.min(...k1), max: Math.max(...k1) })
  }

  // ---------- 2b) desistir na contagem: microfone solto, nada gravado ----------
  console.log('Esc na contagem regressiva')
  {
    const before = readdirSync(join(pdir, 'generated')).sort()
    await ev(`await T.clickEl(T.button('Gravar narração')); await new Promise((r) => setTimeout(r, 300)); await T.clickEl(T.button('Gravar', document.querySelector('[data-narration-setup]'))); return 1`)
    await until(`return T.nar().phase === 'countdown' && !!T.lastTrack() && T.lastTrack().readyState === 'live'`, 3000, 50)
    await ev(`T.key('Escape', 'Escape'); return 1`)
    const r = await until(`return T.nar().phase === 'idle' ? { phase: T.nar().phase, track: T.lastTrack()?.readyState, block: !!document.querySelector('[data-narration-block]') } : null`, 3000, 50)
    await sleep(4000) // passa do fim da contagem: nada começa depois
    const after = readdirSync(join(pdir, 'generated')).sort()
    const still = await ev(`return { phase: T.nar().phase, playing: T.st().playing }`)
    check('Esc na contagem: fase idle, microfone liberado (track ended), sem bloqueio, nenhum arquivo criado, nada começa depois', !!r && r.track === 'ended' && !r.block && JSON.stringify(after) === JSON.stringify(before) && still.phase === 'idle' && !still.playing, { r, before, after, still })
  }

  // ---------- 3) microfone desconectado no meio ----------
  console.log('microfone desconectado no meio da gravação')
  await ev(`await T.seek(${6 * S}); return 1`)
  const s2 = await startNarration(true, false)
  check('2ª gravação começou (ouvindo o vídeo)', s2.ok, s2)
  await until(`return T.nar().recordedUs >= 1200000`, 6000, 20)
  await ev(`const t = T.lastTrack(); t.stop(); t.dispatchEvent(new Event('ended')); return 1`)
  const unplug = await until(`return T.nar().phase === 'idle' && T.narrItems().length === 2 ? { toasts: T.toasts(), item: T.narrItems().find((i) => i.asset.name === 'Narração 2') } : null`, 15000, 100)
  check('parcial inserido com aviso claro', !!unplug && unplug.toasts.some((t) => t.includes('microfone foi desconectado') && t.includes('inserida')) && unplug.item && Math.abs(unplug.item.startUs - 6 * S) <= TOL_US && unplug.item.durationUs >= 1.1 * S, unplug)
  await sleep(300)
  await shot('f3-narracao-05-microfone-desconectado.png')

  // ---------- 4) janela cai no meio da gravação → recuperada ao reabrir ----------
  console.log('janela cai no meio da gravação')
  await ev(`window.__qaEditor.store.getState().apply((p) => p); await T.seek(${0.3 * S}); return 1`)
  await ev(`return 1`)
  const s3 = await startNarration(false, false)
  check('3ª gravação começou', s3.ok, s3)
  await until(`return T.nar().recordedUs >= 2600000`, 8000, 20)
  const atCrash = await ev(`return T.nar().recordedUs`)
  const pendingBefore = readdirSync(join(pdir, 'generated')).filter((f) => f.endsWith('.pending.json'))
  check('marcador de recuperação gravado durante a gravação', pendingBefore.includes('narracao-3.m4a.pending.json'), pendingBefore)
  const meta = JSON.parse(readFileSync(join(pdir, 'generated', 'narracao-3.m4a.pending.json'), 'utf8'))
  check('marcador já com o início calculado (≈ 0,3 s)', Math.abs(meta.startUs - 0.3 * S) <= TOL_US, meta)
  send('Page.crash').catch(() => {})
  await sleep(1500)
  try { ws.close() } catch { /* */ }
  await connect()
  // página caída não responde a Page.enable: recarrega primeiro
  await send('Page.reload')
  await sleep(1500)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1000, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`).catch(() => false)); i++) await sleep(500)
  check('projeto reaberto depois da queda', await openEditor(pid), null)
  const rec = await until(`const i = T.narrItems().find((x) => x.asset.name === 'Narração 3'); const toasts = T.toasts(); return i && toasts.some((t) => t.includes('recuperada')) ? { startUs: i.startUs, durationUs: i.durationUs, inUs: i.inUs, track: i.track, toasts, items: T.narrItems().length } : null`, 20000, 200)
  console.log('   ', JSON.stringify(rec))
  check('gravação interrompida recuperada no lugar (±50 ms) com aviso; as outras duas narrações continuam', !!rec && Math.abs(rec.startUs - meta.startUs) <= 1 && rec.toasts.some((t) => t.includes('Narração 3 recuperada')) && rec.items === 3, rec)
  check(`trecho recuperado: ${rec ? (rec.durationUs / S).toFixed(2) : '?'} s de ${(atCrash / S).toFixed(2)} s gravados (perde no máximo o fragmento final, 0,25 s, mais o bloco em curso)`, !!rec && rec.durationUs >= atCrash - 0.45 * S && rec.durationUs <= atCrash + TOL_US, { rec, atCrash })
  check('marcador limpo depois da recuperação', !existsSync(join(pdir, 'generated', 'narracao-3.m4a.pending.json')), null)
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', join(pdir, 'generated', 'narracao-3.m4a')]).toString())
  check('arquivo recuperado legível (ffprobe)', Number(probe.format?.duration) > 1, probe)
  await sleep(300)
  await shot('f3-narracao-06-recuperada.png')

  // ---------- 5) rede de segurança: a reprodução parou no meio ----------
  console.log('reprodução pausada por fora no meio da gravação')
  await ev(`await T.seek(${0.4 * S}); return 1`)
  const n0 = await ev(`return T.narrItems().length`)
  check('4ª gravação começou', (await startNarration(false, false)).ok, null)
  await until(`return T.nar().recordedUs >= 900000`, 6000, 20)
  await ev(`window.__qaEditor.controller.pause(); return 1`)
  const net = await until(`return T.nar().phase === 'idle' && T.narrItems().length === ${n0 + 1} ? { toasts: T.toasts(), item: T.narrItems().find((i) => i.asset.name === 'Narração 4') } : null`, 10000, 100)
  check('reprodução parou antes do fim → a gravação termina sozinha, insere no lugar e avisa', !!net && !!net.item && Math.abs(net.item.startUs - 0.4 * S) <= TOL_US && net.toasts.some((t) => t.includes('A reprodução parou no meio da gravação')), net)

  // ---------- 6) falha de escrita no disco (simulada) ----------
  console.log('falha de escrita no meio da gravação (simulada)')
  await ev(`await T.seek(${3 * S}); window.__qaEditor.narrationFailWritesAfter = 8; return 1`)
  check('5ª gravação começou', (await startNarration(false, false)).ok, null)
  const wf = await until(`return T.nar().phase === 'idle' && T.narrItems().some((i) => i.asset.name === 'Narração 5') ? { toasts: T.toasts(), item: T.narrItems().find((i) => i.asset.name === 'Narração 5') } : null`, 20000, 100)
  await ev(`delete window.__qaEditor.narrationFailWritesAfter; return 1`)
  const wfile = join(pdir, 'generated', 'narracao-5.m4a')
  const wprobe = existsSync(wfile) ? JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', wfile]).toString()) : null
  console.log('   ', JSON.stringify({ item: wf?.item && { startUs: wf.item.startUs, durationUs: wf.item.durationUs }, wprobe }))
  check('escrita falhou: a gravação para sozinha com aviso, o parcial fica no disco e entra na timeline no lugar', !!wf && wf.toasts.some((t) => t.includes('Falha ao gravar no disco')) && !!wf.item && Math.abs(wf.item.startUs - 3 * S) <= TOL_US && wf.item.durationUs > 0.1 * S && Number(wprobe?.format?.duration) > 0.1 && !existsSync(`${wfile}.pending.json`), { wf, wprobe })
  await sleep(300)
  await shot('f3-narracao-07-falha-de-escrita.png')

  // ---------- 7) ponto de saída no meio da gravação: a reprodução para nele e a gravação continua ----------
  console.log('gravação atravessando o ponto de saída (I/O marcados)')
  await ev(`T.st().setInOut(${1 * S}, ${6.5 * S}); await T.seek(${5.8 * S}); return 1`)
  check('6ª gravação começou', (await startNarration(false, false)).ok, null)
  // depois do ponto de saída (≈ 0,7 s de gravação): parado em 6,5 s, ainda gravando
  await until(`return T.nar().recordedUs >= 1400000`, 6000, 20)
  const frozen = await ev(`return { phase: T.nar().phase, playing: T.st().playing, playhead: T.st().playheadUs, endedAtLimit: window.__qaEditor.controller.endedAtLimit }`)
  check('a reprodução parou no ponto de saída (6,5 s) e a gravação continua contra o quadro parado', frozen.phase === 'recording' && frozen.playing === false && frozen.playhead === 6.5 * S && frozen.endedAtLimit === true, frozen)
  await until(`return T.nar().recordedUs >= 1800000`, 6000, 20)
  const io = await ev(`const rec = T.nar().recordedUs; T.key(' ', 'Space'); return rec`)
  const ioItem = await until(`const i = T.narrItems().find((x) => x.asset.name === 'Narração 6'); return T.nar().phase === 'idle' && i ? { startUs: i.startUs, durationUs: i.durationUs, toasts: T.toasts() } : null`, 15000, 100)
  check(`gravação inteira inserida (≈ ${(io / S).toFixed(2)} s a partir de 5,8 s), sem aviso de interrupção`, !!ioItem && Math.abs(ioItem.startUs - 5.8 * S) <= TOL_US && ioItem.durationUs >= io - 150_000 && !ioItem.toasts.some((t) => t.includes('A reprodução parou no meio')), { ioItem, io })
  await ev(`T.st().setInOut(null, null); return 1`)
}

try {
  await main()
} catch (e) {
  console.error(e)
  failures++
} finally {
  try { ws?.close() } catch { /* */ }
  app?.kill()
  await sleep(800)
  if (settingsBefore && existsSync(SETTINGS) && !readFileSync(SETTINGS).equals(settingsBefore)) {
    writeFileSync(SETTINGS, settingsBefore)
    console.log('  (settings.json do usuário restaurado)')
  }
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo certo')
  process.exit(failures ? 1 : 0)
}
