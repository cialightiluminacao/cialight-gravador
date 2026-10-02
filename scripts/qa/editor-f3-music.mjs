// QA da música com ducking (F3 Task 5) via CDP: música importada na faixa "Música" (papel música), prévia no cartão
// da aba Áudio, seletor de papel da faixa (Voz), painel do projeto (ducking), medidores de nível (master e por faixa)
// tocando, a música abaixando sob a voz no audio worker do editor e a forma de onda seguindo o volume (keyframes e
// volume da faixa). Eventos sintéticos despachados no elemento real sob o ponto — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f3-music.mjs            → abre o app (CIALIGHT_QA=editor-fixture,
//                                                    CIALIGHT_RAW_DIR=test-out/raw), testa e fecha
//   node scripts/qa/editor-f3-music.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// A fixture é mídia sintética (testsrc2 + voz sintética + trilha de ruído). Screenshots em docs/qa/editor-f3/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f3')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')

mkdirSync(SHOTS, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

let app = null
if (!ATTACH) {
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw' },
    stdio: 'ignore'
  })
}

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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__mq; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

const HELPERS = `
window.__mq = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  const clickEl = async (e, at) => {
    e.scrollIntoView({ block: 'nearest' })
    const c = at ?? center(e)
    const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y))
    t.dispatchEvent(me('mousedown', c.x, c.y))
    t.dispatchEvent(pe('pointerup', c.x, c.y))
    t.dispatchEvent(me('mouseup', c.x, c.y))
    t.dispatchEvent(me('click', c.x, c.y))
    await settle()
    return t
  }
  const project = () => st().project
  const trackOfAsset = (assetId) => project().tracks.find((t) => t.kind === 'audio' && t.items.some((i) => i.assetId === assetId))
  const itemOfAsset = (assetId) => trackOfAsset(assetId).items.find((i) => i.assetId === assetId)
  const panel = () => el('[aria-label="Inspetor"]')
  const binTab = (text) => { const b = [...el('[aria-label="Biblioteca de mídia"]').querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === text); if (!b) throw new Error('sem aba ' + text); return b }
  const setItem = (id, fn) => st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === id ? fn(i) : i)) })) }))
  const setTrack = (id, patch) => st().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  /** Pixels pintados por coluna na forma de onda do item (canvas da linha do tempo). */
  const waveCols = (itemId) => {
    const c = el('[data-item-id="' + itemId + '"] canvas')
    const g = c.getContext('2d')
    const d = g.getImageData(0, 0, c.width, c.height).data
    const cols = new Array(c.width).fill(0)
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) cols[x]++
    return cols
  }
  const meanOf = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
  return { st, settle, el, clickEl, project, trackOfAsset, itemOfAsset, panel, binTab, setItem, setTrack, waveCols, meanOf }
})()
'ok'`

async function openEditor() {
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(800)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!s.project.assets.find((a) => a.id === 'a_qa_video')?.speech`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
}

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1000, deviceScaleFactor: 1, mobile: false })
  await ev(`localStorage.setItem('editor.timelineHeight', '380'); return 1`)
  await openEditor()

  console.log('música importada → faixa "Música" com papel música')
  const music = await ev(`const t = T.trackOfAsset('a_qa_music'); return { id: t.id, name: t.name, role: t.role, item: T.itemOfAsset('a_qa_music').id }`)
  const voice = await ev(`const t = T.trackOfAsset('a_qa_video'); return { id: t.id, name: t.name, role: t.role ?? null, item: T.itemOfAsset('a_qa_video').id }`)
  check('a música entrou numa faixa "Música" (role music); o som do vídeo em outra faixa', music.name === 'Música' && music.role === 'music' && voice.id !== music.id, { music, voice })

  console.log('aba Áudio: prévia no cartão')
  {
    await ev(`await T.clickEl(T.binTab('Áudio')); return 1`)
    const r = await ev(`const b = T.el('[data-audio-preview="a_qa_music"]'); await T.clickEl(b); await new Promise((r) => setTimeout(r, 700)); return { pressed: T.el('[data-audio-preview="a_qa_music"]').getAttribute('aria-pressed'), hint: T.el('[aria-label="Biblioteca de mídia"]').textContent.includes('faixa Música') }`)
    check('tocar a prévia: botão vira "parar" (aria-pressed) e a dica da faixa Música aparece', r.pressed === 'true' && r.hint, r)
    await shot('f3-musica-01-biblioteca-previa.png')
    const off = await ev(`await T.clickEl(T.el('[data-audio-preview="a_qa_music"]')); return T.el('[data-audio-preview="a_qa_music"]').getAttribute('aria-pressed')`)
    check('clicar de novo para a prévia', off === 'false', off)
  }

  console.log('seletor de papel da faixa: Voz')
  {
    await ev(`await T.clickEl(T.el('[data-track-header="${voice.id}"] [aria-label="Papel da faixa"]')); await new Promise((r) => setTimeout(r, 250)); return 1`)
    const items = await ev(`return [...document.querySelectorAll('[role="menuitemradio"]')].map((e) => e.textContent)`)
    check('menu com Voz / Música / Efeitos sonoros', items.length === 3 && items[0].startsWith('Voz') && items[1].startsWith('Música') && items[2].startsWith('Efeitos sonoros'), items)
    await shot('f3-musica-02-papel-da-faixa.png')
    const r = await ev(`const it = [...document.querySelectorAll('[role="menuitemradio"]')].find((e) => e.textContent.startsWith('Voz')); await T.clickEl(it); await new Promise((r) => setTimeout(r, 250)); return { role: T.trackOfAsset('a_qa_video').role, icon: T.el('[data-track-header="${voice.id}"] [aria-label="Papel da faixa"]').getAttribute('data-track-role') }`)
    check('a faixa do som do vídeo vira Voz (modelo e ícone)', r.role === 'voice' && r.icon === 'voice', r)
    // o foco volta ao gatilho e abriria a dica dele nas próximas capturas
    await ev(`document.activeElement?.blur(); await T.settle(); return 1`)
  }

  console.log('painel do projeto: música sob a voz')
  {
    const r = await ev(`T.st().select([]); await T.settle(); const t = T.panel().textContent; return { has: t.includes('Música sob a voz'), hint: !!T.panel().querySelector('[data-ducking-hint]'), toggle: T.panel().querySelector('[role="switch"][aria-label^="Abaixar a música"]')?.getAttribute('aria-checked') }`)
    check('seção "Música sob a voz" ligada, sem aviso (voz analisada, música na timeline)', r.has && !r.hint && r.toggle === 'true', r)
    await shot('f3-musica-03-inspetor-ducking.png')
  }

  console.log('a música abaixa sob a voz no audio worker do editor (−12 dB)')
  {
    // mesmo bloco (3,0 s: a voz fala) com o ducking ligado e desligado: só o ganho da faixa Música muda
    const r = await ev(`
      const audio = window.__qaEditor.engine.audio
      const peakAt = async () => { await new Promise((r) => setTimeout(r, 300)); const b = await audio.render(3_000_000, 4800); return b?.tracks ?? null }
      const on = await peakAt()
      T.st().apply((p) => ({ ...p, audioMix: { enabled: false, duckingDb: -12, attackMs: 250, releaseMs: 400, holdMs: 300 } })); await T.settle()
      const off = await peakAt()
      T.st().undo(); await T.settle()
      return { on, off, mix: T.project().audioMix ?? null }`)
    const db = r.on && r.off ? 20 * Math.log10(r.on[music.id] / r.off[music.id]) : NaN
    check(`pico da faixa Música no mesmo bloco: ligado ÷ desligado = ${db.toFixed(2)} dB (−12 ±1); voz igual`, Math.abs(db + 12) <= 1 && Math.abs(r.on[voice.id] - r.off[voice.id]) < 1e-6, r)
  }

  console.log('medidores de nível tocando')
  {
    const r = await ev(`
      const c = window.__qaEditor.controller
      c.seek(2_400_000); await T.settle()
      await c.play()
      await new Promise((r) => setTimeout(r, 300))
      // o pico é do bloco de 100 ms que está soando e a trilha da fixture é em rajadas ((0,5+0,5·sen)^4, quase muda em
      // ~1/3 de cada ciclo de 0,83 s, e abaixada −12 dB sob a voz): um instante só pode cair no vale. Máximo em 1 s.
      const tracks = {}
      const master = { l: 0, r: 0 }
      for (let i = 0; i < 20; i++) {
        for (const [id, v] of Object.entries(c.trackLevels)) tracks[id] = Math.max(tracks[id] ?? 0, v)
        master.l = Math.max(master.l, c.levels.l); master.r = Math.max(master.r, c.levels.r)
        await new Promise((r) => setTimeout(r, 50))
      }
      const covers = [...document.querySelectorAll('[data-level-meter] > span > span:first-child')].map((e) => e.style.height || e.style.width)
      return { tracks, master, covers }`)
    await shot('f3-musica-04-medidores.png')
    await ev(`window.__qaEditor.controller.pause(); return 1`)
    const lit = r.covers.filter((v) => parseFloat(v) < 99).length
    check('níveis por faixa (voz e música) e master > 0 tocando; barras acesas', (r.tracks[voice.id] ?? 0) > 0.01 && (r.tracks[music.id] ?? 0) > 0.01 && r.master.l > 0.01 && lit >= 3, { ...r, lit })
    const z = await ev(`await new Promise((r) => setTimeout(r, 200)); return [...document.querySelectorAll('[data-level-meter] > span > span:first-child')].map((e) => e.style.height || e.style.width)`)
    check('parado: medidores zerados', z.every((v) => v === '100%'), z)
  }

  console.log('forma de onda reflete o volume (keyframes e faixa)')
  {
    const r = await ev(`
      const id = '${music.item}'
      const before = T.meanOf(T.waveCols(id))
      T.setItem(id, (i) => ({ ...i, audio: { ...i.audio, volume: { value: 1, keys: [{ tUs: 0, value: 0.1, ease: 'linear' }, { tUs: i.durationUs, value: 1, ease: 'linear' }] } } }))
      await T.settle(); await T.settle()
      const cols = T.waveCols(id)
      const n = Math.floor(cols.length / 6)
      const left = T.meanOf(cols.slice(0, n)), right = T.meanOf(cols.slice(-n))
      T.setTrack('${music.id}', { volume: 0.5 })
      await T.settle(); await T.settle()
      const half = T.meanOf(T.waveCols(id).slice(-n))
      return { before, left, right, half }`)
    check(`keyframes 10 %→100 %: início da onda menor que o fim (${r.left.toFixed(1)} × ${r.right.toFixed(1)} px por coluna); faixa a 50 % encolhe (${r.half.toFixed(1)})`, r.left < r.right * 0.5 && r.half < r.right * 0.8, r)
    await ev(`T.st().select(['${music.item}']); await T.settle(); return 1`)
    await shot('f3-musica-05-onda-volume.png')
    await ev(`T.st().undo(); await T.settle(); T.st().undo(); await T.settle(); return 1`)
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
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
