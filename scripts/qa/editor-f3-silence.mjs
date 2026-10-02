// QA do "Remover silêncios" (F3 Task 6) via CDP, num projeto de gravação: tela + webcam (testsrc: número do quadro
// desenhado) + microfone com fala sintética e pausas conhecidas + anotações + um blur vinculado à tela. Abre o painel
// pela barra da linha do tempo, confere a pré-visualização (faixas vermelhas na régua, total economizado), aplica e
// verifica: duração reduzida como esperado (±0,2 s), todas as faixas cortadas em sincronia (mesmo instante da fonte em
// tela, webcam, microfone e anotações; o blur continua sobre o mesmo conteúdo), o quadro mostrado no visualizador antes
// e depois do corte é o mesmo (marcadores de quadro) e desfazer volta tudo em um passo. Eventos sintéticos despachados
// no elemento real sob o ponto — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):  node scripts/qa/editor-f3-silence.mjs
// Tudo em test-out/f3-silence (CIALIGHT_RAW_DIR=test-out/f3-silence/raw → projeto em test-out/f3-silence/Projetos).
// Screenshots em docs/qa/editor-f3/. settings.json do usuário é restaurado se mudar.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9337'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f3')
const BASE = join(ROOT, 'test-out', 'f3-silence')
const RAW_REL = 'test-out/f3-silence/raw'
const SID = 'qa-silence-session'
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const S = 1_000_000
const DUR_S = 16
// fala (s) — pausa curta de 0,25 s em 8–8,25 (abaixo do mínimo da detecção, não é silêncio)
const SPEECH = [[0.5, 3], [5, 8], [8.25, 10], [13, 16]]
// padrões do painel: silêncio ≥ 0,7 s, margem 0,15 s → cortes 3,15–4,85 e 10,15–12,85 (0–0,5 s é curto demais)
const EXPECTED_SAVED_S = 1.7 + 2.7
const SYSTEM = [11, 11.5]

mkdirSync(SHOTS, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// ---- gravação sintética (rec.mp4 com v:0 tela, v:1 webcam, a:0 microfone + session.json) ----
function makeSession() {
  rmSync(BASE, { recursive: true, force: true })
  const dir = join(ROOT, RAW_REL, SID)
  mkdirSync(dir, { recursive: true })
  const voice = `0.3*(0.6+0.4*sin(2*PI*4*t))*(sin(2*PI*220*t)+0.5*sin(4*PI*220*t)+0.25*sin(6*PI*220*t))*(${SPEECH.map(([a, b]) => `between(t,${a},${b})`).join('+')})`
  execFileSync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
    '-f', 'lavfi', '-i', `aevalsrc='${voice}':s=48000`,
    // áudio do sistema: um som em 11–11,5 s, dentro da pausa de 3 s da voz
    '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*660*t)*between(t,${SYSTEM[0]},${SYSTEM[1]})':s=48000`,
    '-t', String(DUR_S), '-map', '0:v', '-map', '1:v', '-map', '2:a', '-map', '3:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', join(dir, 'rec.mp4')
  ])
  const pip = { tMs: 0, x: 0.62, y: 0.56, w: 0.34, h: 0.34, shape: 'rounded', visible: true }
  const session = {
    version: 1, id: SID, createdAt: new Date().toISOString(), state: 'stopped',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 },
    video: { width: 1280, height: 720, fps: 30, codec: 'avc1.640028', bitrate: 8e6 },
    webcam: { deviceId: 'x', label: 'Cam', width: 640, height: 360, mirrored: false },
    mic: { deviceId: 'y', label: 'Mic', echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    systemAudio: true,
    tracks: { screen: 0, webcam: 1, mic: 0, system: 1 },
    durationMs: DUR_S * 1000,
    pauses: [], pip: [pip],
    strokes: [
      { id: 's1', tMs: 5500, tool: 'arrow', points: [{ x: 0.15, y: 0.75, tMs: 5500 }, { x: 0.4, y: 0.6, tMs: 5900 }], color: '#ff3b30', width: 6 },
      { id: 's2', tMs: 13500, tool: 'pen', points: [{ x: 0.1, y: 0.1, tMs: 13500 }, { x: 0.2, y: 0.15, tMs: 13700 }, { x: 0.3, y: 0.1, tMs: 13900 }], color: '#22c55e', width: 6 }
    ],
    clearEvents: [], markers: [{ tMs: 11000, label: 'Na pausa' }, { tMs: 14000, label: 'Depois' }], engine: 'webcodecs', files: { rec: 'rec.mp4' }
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2))
}

makeSession()
const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CIALIGHT_QA: 'editor-silence', CIALIGHT_RAW_DIR: RAW_REL },
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__sq; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}
/** PNG (base64) da área do visualizador. */
async function viewerPng() {
  const rect = await ev(`const r = window.__qaEditor.engine.canvas.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }`)
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } })
  return r.result.data
}

const HELPERS = `
window.__sq = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
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
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label)
  const project = () => st().project
  const end = (i) => i.startUs + i.durationUs
  const duration = (p = project()) => Math.max(0, ...p.tracks.filter((t) => !t.hidden).flatMap((t) => t.items.map(end)))
  const itemAt = (t, us) => t.items.find((i) => us >= i.startUs && us < end(i))
  // mesma conta de resolve.sourceTimeUs (sem reverso/congelado neste projeto)
  const srcAt = (i, us) => i.type === 'media' ? i.inUs + Math.round((us - i.startUs) * i.speed) : i.type === 'annotations' ? i.inUs + (us - i.startUs) : null
  const mapTime = (cuts, t) => { let s = 0; for (const c of cuts) { if (t >= c.fromUs && t < c.toUs) return null; if (t >= c.toUs) s += c.toUs - c.fromUs } return t - s }
  /** Sincronia a cada 10 ms do que sobrou: por faixa, o mesmo tipo de item e o mesmo instante da fonte. */
  const syncErrors = (before, after, cuts) => {
    const bad = []
    for (let t = 0; t < duration(before); t += 10000) {
      const t2 = mapTime(cuts, t)
      if (t2 === null) continue
      for (const tb of before.tracks) {
        const ta = after.tracks.find((x) => x.id === tb.id)
        const a = itemAt(tb, t), b = ta && itemAt(ta, t2)
        if (!a && !b) continue
        if (!a || !b || a.type !== b.type) bad.push(tb.name + ' @' + t + ': ' + a?.type + ' → ' + b?.type)
        else if (srcAt(a, t) !== srcAt(b, t2)) bad.push(tb.name + ' @' + t + ': fonte ' + srcAt(a, t) + ' → ' + srcAt(b, t2))
      }
      if (bad.length > 8) break
    }
    return bad
  }
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await new Promise((r) => setTimeout(r, 900)); await settle() }
  /** Diferença média (0–255) entre dois PNG (base64) do mesmo tamanho. */
  const pngDiff = async (a, b) => {
    const load = (b64) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'data:image/png;base64,' + b64 })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height)
    const px = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, h).data }
    const da = px(ia), db = px(ib)
    let s = 0
    for (let i = 0; i < da.length; i += 4) s += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
    return s / (w * h * 3)
  }
  return { st, settle, el, clickEl, button, project, duration, syncErrors, seek, pngDiff }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1000, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)

  console.log('projeto de gravação (tela + webcam + microfone + anotações)')
  const pid = await ev(`const p = await window.api.project.fromSession('${SID}'); return p.id`)
  await ev(`localStorage.setItem('editor.timelineHeight', '330'); window.__navigate('projects'); return 1`)
  await sleep(600)
  await ev(`window.__navigate('editor:${pid}'); return 1`)
  let ready = false
  for (let i = 0; i < 150 && !ready; i++) {
    ready = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && ['-mic', '-system'].every((k) => !!s.project.assets.find((a) => a.id.endsWith(k))?.speech)`)
    if (!ready) await sleep(1000)
  }
  check('gravação aberta, ingestão e análise de fala do microfone e do áudio do sistema prontas', ready, null)
  await ev(HELPERS + '; return 1')
  const shape = await ev(`return T.project().tracks.map((t) => t.name + ':' + (t.role ?? '') + ':' + t.items.map((i) => i.type).join(','))`)
  check('faixas: Tela, Webcam, Anotações, Microfone (Voz), Áudio do sistema', shape.join('|') === 'Tela::media|Webcam::media|Anotações::annotations|Microfone:voice:media|Áudio do sistema:sfx:media', shape)
  const ids = await ev(`const t = (n) => T.project().tracks.find((x) => x.name === n).id; return { mic: t('Microfone'), sys: t('Áudio do sistema') }`)

  // blur vinculado à tela (como o addEffect sobre o clipe faz): 1–15 s, canto superior esquerdo, numa faixa Efeitos
  await ev(`
    const p = T.project()
    const scr = p.tracks.find((t) => t.name === 'Tela').items[0]
    const fx = { id: 'i_qa_blur', type: 'effect', effect: 'blur', startUs: ${1 * S}, durationUs: ${14 * S}, linkId: scr.linkId,
      region: { shape: 'rect', x: { value: 0.22 }, y: { value: 0.2 }, w: { value: 0.3 }, h: { value: 0.25 }, rotation: { value: 0 } },
      strength: { value: 60 }, feather: 0.15, color: '#000000', invert: false, scope: 'below' }
    const track = { id: 't_qa_fx', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
    const lastVideo = p.tracks.reduce((m, t, i) => (t.kind === 'video' ? i : m), -1)
    T.st().apply((q) => ({ ...q, tracks: [...q.tracks.slice(0, lastVideo + 1), track, ...q.tracks.slice(lastVideo + 1)] }))
    await T.settle()
    return 1`)

  // quadros de referência antes do corte (número do quadro do testsrc na tela e na webcam), sem o painel por cima
  const refs = [6.0, 14.2]
  const pngBefore = []
  for (const t of refs) {
    await ev(`await T.seek(${Math.round(t * S)}); return 1`)
    pngBefore.push(await viewerPng())
  }

  console.log('painel "Remover silêncios" pela barra da linha do tempo')
  const before = await ev(`return { p: T.project(), past: T.st().history.past.length }`)
  {
    await ev(`await T.clickEl(T.button('Remover silêncios')); return 1`)
    let r = null
    for (let i = 0; i < 40; i++) {
      r = await ev(`const d = document.querySelector('[data-silence-dialog]'); const on = (id) => d.querySelector('[data-silence-source="' + id + '"] [role="switch"]')?.getAttribute('aria-checked'); return d ? { summary: d.querySelector('[data-silence-summary]').textContent, bands: document.querySelectorAll('[data-silence-cut]').length, cuts: window.__qaEditor.silence.getState().cuts, mic: on('${ids.mic}'), sys: on('${ids.sys}'), threshold: d.querySelector('[data-silence-threshold]')?.textContent ?? '', other: d.querySelector('[data-silence-other="${ids.sys}"]')?.textContent ?? '', top: d.getBoundingClientRect().top, bar: document.querySelector('[data-editor-topbar]').getBoundingClientRect().bottom } : null`)
      if (r?.cuts.length) break
      await sleep(250)
    }
    const saved = r ? r.cuts.reduce((n, c) => n + c.toUs - c.fromUs, 0) / S : NaN
    check('painel aberto abaixo da barra superior; referência = a faixa de Voz (Microfone), o áudio do sistema desligado', !!r && r.top >= r.bar && r.mic === 'true' && r.sys === 'false', r)
    check('limiar lido da análise, com o menos tipográfico (−35 dB)', !!r && r.threshold.includes('−35 dB por 0,35 s'), r?.threshold)
    check('aviso: há fala em "Áudio do sistema" dentro de 1 corte', !!r && r.other.includes('Áudio do sistema') && r.other.includes('1 corte'), r?.other)
    check(`2 cortes (pausas de 2 s e 3 s; a de 0,5 s no início e a de 0,25 s ficam): ${r?.cuts.map((c) => `${(c.fromUs / S).toFixed(2)}–${(c.toUs / S).toFixed(2)}`).join(', ')}`, r?.cuts.length === 2, r?.cuts)
    check(`economia ${saved.toFixed(2)} s ≈ ${EXPECTED_SAVED_S} s (±0,2) e mostrada no resumo`, Math.abs(saved - EXPECTED_SAVED_S) <= 0.2 && /−4,[2-6] s/.test(r?.summary ?? ''), r?.summary)
    check('pré-visualização: 2 faixas vermelhas na régua', r?.bands === 2, r?.bands)
    check('ainda nada mudou no projeto (só pré-visualização)', await ev(`return T.st().history.past.length === ${before.past}`), null)
    await sleep(500)
    await shot('f3-silencio-01-painel-previa.png')

    // duração mínima maior: só a pausa de 3 s fica
    const r2 = await ev(`
      const s = document.querySelectorAll('[data-silence-dialog] [role="slider"]')[0]
      s.focus()
      // PageUp/PageDown = 10 passos de 0,05 s (um por renderização: o handler lê o valor atual)
      const press = async (key, n) => { for (let i = 0; i < n; i++) { s.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); await T.settle() } await new Promise((r) => setTimeout(r, 200)) }
      const shown = () => document.querySelector('[data-silence-dialog]').textContent.match(/Duração mínima do silêncio([\\d,]+ s)/)?.[1]
      await press('PageUp', 4)
      const n = window.__qaEditor.silence.getState().cuts.length, at = shown()
      await press('PageDown', 4)
      return { n, at, back: window.__qaEditor.silence.getState().cuts.length, atBack: shown() }`)
    check('duração mínima 2,70 s: só a pausa de 3 s; de volta a 0,70 s: as duas', r2.n === 1 && r2.at === '2,70 s' && r2.back === 2 && r2.atBack === '0,70 s', r2)

    // incluir o áudio do sistema como referência: o som em 11–11,5 s divide a pausa de 3 s (sem aviso); desligar volta
    const inc = await ev(`
      const d = document.querySelector('[data-silence-dialog]')
      await T.clickEl([...d.querySelectorAll('button')].find((b) => b.textContent.includes('Incluir como referência')))
      await new Promise((r) => setTimeout(r, 300))
      const cuts = window.__qaEditor.silence.getState().cuts.map((c) => [c.fromUs, c.toUs])
      const warn = !!d.querySelector('[data-silence-other]')
      const sys = d.querySelector('[data-silence-source="${ids.sys}"] [role="switch"]')
      return { cuts, warn, on: sys.getAttribute('aria-checked') }`)
    await sleep(300)
    await shot('f3-silencio-06-incluir-sistema.png')
    const split = inc.cuts.filter(([a, b]) => a >= 10 * S && b <= 13 * S)
    check('"Incluir como referência": sistema ligado, pausa de 3 s dividida em volta do som (sem cortar 11–11,5 s), aviso some', inc.on === 'true' && !inc.warn && split.length === 2 && split[0][1] <= SYSTEM[0] * S && split[1][0] >= SYSTEM[1] * S, inc)
    const off = await ev(`await T.clickEl(document.querySelector('[data-silence-dialog] [data-silence-source="${ids.sys}"] [role="switch"]')); await new Promise((r) => setTimeout(r, 300)); return window.__qaEditor.silence.getState().cuts.length`)
    check('desligar o sistema: de volta aos 2 cortes', off === 2, off)

    // atalhos de transporte com o painel aberto (foco fora dele): Espaço toca, K pausa; S (dividir) não passa
    const keys = await ev(`
      document.activeElement?.blur()
      const k = (key, code) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }))
      const past = T.st().history.past.length
      k(' ', 'Space'); await new Promise((r) => setTimeout(r, 400)); const playing = T.st().playing
      k('k', 'KeyK'); document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'k', code: 'KeyK', bubbles: true })); await new Promise((r) => setTimeout(r, 200)); const paused = !T.st().playing
      k('s', 'KeyS'); await T.settle()
      return { playing, paused, split: T.st().history.past.length !== past, open: !!document.querySelector('[data-silence-dialog]') }`)
    check('painel aberto: Espaço toca e K pausa; S (dividir) é ignorado; o painel continua aberto', keys.playing && keys.paused && !keys.split && keys.open, keys)
  }

  const cuts = await ev(`return window.__qaEditor.silence.getState().cuts`)
  await ev(`await T.seek(${Math.round(6.0 * S)}); return 1`)
  await shot('f3-silencio-02-antes-6s.png')

  console.log('Aplicar')
  {
    await ev(`await T.clickEl(T.button('Aplicar')); await new Promise((r) => setTimeout(r, 400)); return 1`)
    const r = await ev(`return { p: T.project(), past: T.st().history.past.length, open: !!document.querySelector('[data-silence-dialog]'), bands: document.querySelectorAll('[data-silence-cut]').length }`)
    const dur = (p) => Math.max(...p.tracks.filter((t) => !t.hidden).flatMap((t) => t.items.map((i) => i.startUs + i.durationUs))) / S
    const d0 = dur(before.p), d1 = dur(r.p)
    check(`duração ${d0.toFixed(2)} s → ${d1.toFixed(2)} s (esperado ${(DUR_S - EXPECTED_SAVED_S).toFixed(2)} ±0,2)`, Math.abs(d1 - (DUR_S - EXPECTED_SAVED_S)) <= 0.2, { d0, d1 })
    check('um passo no histórico; painel fechado e sem faixas vermelhas', r.past === before.past + 1 && !r.open && r.bands === 0, r)
    const errs = await ev(`return T.syncErrors(${JSON.stringify(before.p)}, T.project(), ${JSON.stringify(cuts)})`)
    check('tela, webcam, anotações, microfone e blur em sincronia (mesmo instante da fonte; blur sobre o mesmo conteúdo)', errs.length === 0, errs)
    const fx = await ev(`return T.project().tracks.find((t) => t.id === 't_qa_fx').items.map((i) => ({ s: i.startUs, e: i.startUs + i.durationUs, link: !!i.linkId }))`)
    check('o blur virou pedaços, todos ainda vinculados ao clipe', fx.length === 3 && fx.every((x) => x.link), fx)
    const marks = await ev(`return T.project().markers.map((m) => m.tUs)`)
    check('marcadores: o da pausa sai, o de depois anda junto', marks.length === 1 && Math.abs(marks[0] - (14 * S - EXPECTED_SAVED_S * S)) <= 0.2 * S, marks)
  }

  console.log('marcadores de quadro: o mesmo quadro no visualizador depois do corte')
  for (let k = 0; k < refs.length; k++) {
    const t2 = await ev(`const cuts = ${JSON.stringify(cuts)}; let s = 0; for (const c of cuts) if (${Math.round(refs[k] * S)} >= c.toUs) s += c.toUs - c.fromUs; return ${Math.round(refs[k] * S)} - s`)
    await ev(`await T.seek(${t2}); return 1`)
    const png = await viewerPng()
    const diff = await ev(`return T.pngDiff(${JSON.stringify(pngBefore[k])}, ${JSON.stringify(png)})`)
    check(`${refs[k]} s antes = ${(t2 / S).toFixed(3)} s depois: mesmo quadro (diferença média ${diff.toFixed(2)} ≤ 1)`, diff <= 1, diff)
    if (k === 0) await shot('f3-silencio-03-depois-mesmo-quadro.png')
  }
  await ev(`window.__qaEditor.store.getState().setZoom(60); window.__qaEditor.store.getState().setScroll(0); await T.settle(); return 1`)
  await shot('f3-silencio-04-timeline-cortada.png')

  console.log('desfazer em 1 passo (pelo "Desfazer" do aviso)')
  const toastUndo = `[...document.querySelectorAll('[data-sonner-toast] button')].filter((b) => b.textContent.trim() === 'Desfazer').at(-1)`
  {
    const r = await ev(`await T.clickEl(${toastUndo}); await T.settle(); return { same: JSON.stringify(T.project().tracks) === JSON.stringify(${JSON.stringify(before.p.tracks)}), markers: JSON.stringify(T.project().markers) === JSON.stringify(${JSON.stringify(before.p.markers)}), past: T.st().history.past.length }`)
    check('um "Desfazer" devolve todas as faixas e marcadores como antes', r.same && r.markers && r.past === before.past, r)
  }

  console.log('"Desfazer" do aviso depois de outra edição: não desfaz a outra')
  {
    await ev(`await T.clickEl(T.button('Remover silêncios')); for (let i = 0; i < 40 && !window.__qaEditor.silence.getState().cuts.length; i++) await new Promise((r) => setTimeout(r, 250)); await T.clickEl(T.button('Aplicar')); await new Promise((r) => setTimeout(r, 400)); return 1`)
    const r = await ev(`
      const cut = T.st().history.past.length
      T.st().apply((p) => ({ ...p, markers: [...p.markers, { id: 'm_qa_extra', tUs: 1000000, label: 'Outra edição', color: '#22c55e' }] }))
      await T.settle()
      await T.clickEl(${toastUndo}); await new Promise((r) => setTimeout(r, 300))
      const out = { cut, past: T.st().history.past.length, extra: T.project().markers.some((m) => m.id === 'm_qa_extra') }
      T.st().undo(); T.st().undo(); await T.settle()
      return { ...out, restored: JSON.stringify(T.project().tracks) === JSON.stringify(${JSON.stringify(before.p.tracks)}) }`)
    check('o "Desfazer" antigo não desfaz a edição feita depois (histórico intacto)', r.extra && r.past === r.cut + 1 && r.restored, r)
  }

  console.log('faixa bloqueada')
  {
    const r = await ev(`
      const id = T.project().tracks.find((t) => t.name === 'Webcam').id
      T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, locked: true } : t)) }))
      await T.settle()
      await T.clickEl(T.button('Remover silêncios'))
      await new Promise((r) => setTimeout(r, 600))
      const d = document.querySelector('[data-silence-dialog]')
      return { text: d?.textContent ?? '', disabled: T.button('Aplicar')?.disabled }`)
    check('webcam bloqueada com blur no projeto: o painel explica e não deixa aplicar', r.text.includes('faixas de vídeo bloqueadas') && r.disabled === true, r)
    await shot('f3-silencio-05-faixa-bloqueada.png')
    await ev(`await T.clickEl(T.button('Cancelar')); return 1`)
  }
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
