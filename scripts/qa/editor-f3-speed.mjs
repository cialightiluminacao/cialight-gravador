// QA da velocidade (F3 Task 2) via CDP: painel Velocidade (presets, Manter tom, Manter áudio acima de 4×),
// Congelar quadro, Reverter e o shuttle J/K/L, com eventos de ponteiro/teclado sintéticos despachados no elemento
// real sob o ponto (document.elementFromPoint) — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-f3-speed.mjs            → abre o app (CIALIGHT_QA=editor-fixture,
//                                                    CIALIGHT_RAW_DIR=test-out/raw), testa e fecha
//   node scripts/qa/editor-f3-speed.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// A fixture é mídia sintética (testsrc2 + voz sintética + PNG), sem gravação da área de trabalho. Confere no store
// e na tela; screenshots em docs/qa/editor-f3/.
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

/** Avalia `body` (corpo de função async, com os helpers em `T`) na página e devolve o valor. */
async function ev(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__sp; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 ${name}`)
}
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
const S = 1_000_000

// helpers da página: cliques e teclas sintéticos no elemento real sob o ponto, leitura do store
const HELPERS = `
window.__sp = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  /** Elemento real mais ao topo no ponto (como o navegador escolheria o alvo de um clique de verdade). */
  const topAt = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) throw new Error('nada em ' + x + ',' + y); return e }
  /** Clique completo (pointer + mouse + click) no elemento sob o centro de e. */
  const clickEl = async (e, at) => {
    e.scrollIntoView({ block: 'nearest' })
    const c = at ?? center(e)
    const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y))
    t.dispatchEvent(me('mousedown', c.x, c.y))
    window.dispatchEvent(pe('pointerup', c.x, c.y))
    t.dispatchEvent(me('mouseup', c.x, c.y))
    t.dispatchEvent(me('click', c.x, c.y))
    await settle()
    return t
  }
  const keyEv = (type, k) => window.dispatchEvent(new KeyboardEvent(type, { key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true }))
  const key = async (k) => { keyEv('keydown', k); keyEv('keyup', k); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.name, kind: t.kind })))
  const media = (id) => items().find((i) => i.id === id)
  const panel = () => el('[aria-label="Inspetor"]')
  const button = (text) => { const b = [...panel().querySelectorAll('button')].find((x) => x.textContent.trim() === text); if (!b) throw new Error('sem botão ' + text); return b }
  const toggle = (label) => el('[aria-label="Inspetor"] [role="switch"][aria-label="' + label + '"]')
  const tab = (text) => { const b = [...panel().querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === text); if (!b) throw new Error('sem aba ' + text); return b }
  const timelineItem = (id) => el('[data-item-id="' + id + '"]')
  /** Clique no início do item na timeline (longe das alças de aparar). */
  const selectItem = async (id) => { const r = timelineItem(id).getBoundingClientRect(); await clickEl(timelineItem(id), { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 }); await new Promise((res) => setTimeout(res, 150)) }
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await new Promise((r) => setTimeout(r, 300)); await settle() }
  const past = () => st().history.past.length
  return { st, settle, el, clickEl, key, keyEv, items, media, panel, button, toggle, tab, timelineItem, selectItem, seek, past }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 768)
  await ev(`localStorage.setItem('editor.timelineHeight', '240'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
  const ids = await ev(`const v = T.items().find((i) => i.assetId === 'a_qa_video' && i.visual); const a = T.items().find((i) => i.assetId === 'a_qa_video' && !i.visual); return { v: v.id, a: a.id }`)
  await ev(`T.st().select([]); await T.seek(3 * ${S}); return 1`)
  await sleep(500)

  console.log('painel Velocidade')
  {
    await ev(`await T.selectItem('${ids.v}'); await T.clickEl(T.tab('Velocidade')); return 1`)
    const r = await ev(`const p = T.panel(); return { sel: T.st().selection, presets: [...p.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent.trim()), tom: !!p.querySelector('[role="switch"][aria-label="Manter tom"]'), fast: !!p.querySelector('[role="switch"][aria-label="Manter áudio acima de 4×"]'), freeze: !!T.button('Congelar quadro'), reverse: !!T.button('Reverter') }`)
    check('clique no clipe da timeline seleciona o vídeo', r.sel.length === 1 && r.sel[0] === ids.v, r.sel)
    check('presets 0,1 a 16× (11), "Manter tom", "Manter áudio acima de 4×", Congelar e Reverter', r.presets.join(' ') === '0,1× 0,25× 0,5× 0,75× 1× 1,25× 1,5× 2× 4× 8× 16× Reverter' && r.tom && r.fast && r.freeze && r.reverse, r)
    await shot('f3-speed-01-painel.png')
  }

  console.log('preset 2× (vídeo e áudio vinculado)')
  {
    const r = await ev(`const p0 = T.past(); await T.clickEl(T.button('2×')); return { p0, past: T.past(), v: T.media('${ids.v}'), a: T.media('${ids.a}') }`)
    check('2×: vídeo e áudio a 2×, duração 12 s → 6 s, um passo', r.v.speed === 2 && r.a.speed === 2 && r.v.durationUs === 6 * S && r.a.durationUs === 6 * S && r.past === r.p0 + 1, { v: [r.v.speed, r.v.durationUs], a: [r.a.speed, r.a.durationUs], past: r.past, p0: r.p0 })
    await shot('f3-speed-02-2x.png')
  }

  console.log('Manter tom / Manter áudio acima de 4×')
  {
    const r = await ev(`await T.clickEl(T.toggle('Manter tom')); const off = [T.media('${ids.v}').audio.preservePitch, T.media('${ids.a}').audio.preservePitch]; const note = T.panel().textContent.includes('mais aguda'); await T.clickEl(T.toggle('Manter tom')); return { off, note, on: [T.media('${ids.v}').audio.preservePitch, T.media('${ids.a}').audio.preservePitch] }`)
    check('"Manter tom" desliga e religa no grupo (vídeo + áudio); aviso do tom', r.off.join() === 'false,false' && r.on.join() === 'true,true' && r.note, r)
    const f = await ev(`await T.clickEl(T.button('8×')); const muted = T.panel().textContent.includes('Acima de 4× o áudio fica mudo'); await T.clickEl(T.toggle('Manter áudio acima de 4×')); const keep = T.media('${ids.a}').audio.keepFastAudio; const gone = !T.panel().textContent.includes('Acima de 4× o áudio fica mudo'); return { speed: T.media('${ids.v}').speed, muted, keep, gone }`)
    check('8×: aviso de áudio mudo; "Manter áudio acima de 4×" liga keepFastAudio e tira o aviso', f.speed === 8 && f.muted && f.keep === true && f.gone, f)
    await shot('f3-speed-03-8x-manter-audio.png')
    await ev(`await T.clickEl(T.toggle('Manter áudio acima de 4×')); await T.clickEl(T.button('1×')); return 1`)
  }

  console.log('Congelar quadro no playhead')
  {
    await ev(`await T.seek(3 * ${S}); await T.selectItem('${ids.v}'); return 1`)
    const r = await ev(`const p0 = T.past(); await T.clickEl(T.button('Congelar quadro')); const vids = T.st().project.tracks[0].items.map((i) => ({ id: i.id, s: i.startUs, d: i.durationUs, f: i.freeze?.atUs ?? null })); const aud = T.items().filter((i) => i.assetId === 'a_qa_video' && !i.visual).map((i) => [i.startUs, i.durationUs]); return { p0, past: T.past(), vids, aud }`)
    const fz = r.vids.find((x) => x.f !== null)
    check('pedaço congelado de 2 s em 3 s com o quadro de 3 s; resto empurrado; um passo', !!fz && fz.s === 3 * S && fz.d === 2 * S && fz.f === 3 * S && r.vids.some((x) => x.s === 5 * S && x.f === null) && r.past === r.p0 + 1, r)
    check('áudio vinculado dividido e empurrado (mudo no congelado)', JSON.stringify(r.aud) === JSON.stringify([[0, 3 * S], [5 * S, 9 * S]]), r.aud)
    const badge = await ev(`return !!document.querySelector('[data-item-id="${fz?.id}"] [aria-label="Quadro congelado"]')`)
    check('timeline: selo de quadro congelado', badge, null)
    await ev(`await T.seek(4 * ${S}); return 1`)
    await sleep(500)
    await ev(`await T.selectItem('${fz?.id}'); await T.clickEl(T.tab('Velocidade')); return 1`)
    await sleep(300)
    await shot('f3-speed-04-congelado.png')
  }

  console.log('Reverter')
  {
    const right = await ev(`return T.st().project.tracks[0].items.find((i) => i.startUs === 5 * ${S}).id`)
    await ev(`await T.selectItem('${right}'); await T.clickEl(T.tab('Velocidade')); return 1`)
    const r = await ev(`const p0 = T.past(); const d0 = T.media('${right}').durationUs; await T.clickEl(T.button('Reverter')); const it = T.media('${right}'); const linked = T.items().filter((i) => i.linkId === it.linkId && i.type === 'media').map((i) => i.reverse); return { p0, past: T.past(), reverse: it.reverse, d0, d: it.durationUs, linked, pressed: T.button('Reverter').getAttribute('aria-pressed'), badge: !!document.querySelector('[data-item-id="${right}"] [aria-label="Reverso"]') }`)
    check('Reverter: clipe e áudio vinculado em reverso, mesma duração, um passo, botão pressionado, selo na timeline', r.reverse && r.linked.every(Boolean) && r.linked.length === 2 && r.d === r.d0 && r.past === r.p0 + 1 && r.pressed === 'true' && r.badge, r)
    await ev(`await T.seek(6 * ${S}); return 1`)
    await sleep(500)
    await shot('f3-speed-05-reverso.png')
    const u = await ev(`T.st().undo(); T.st().undo(); await T.settle(); return { n: T.st().project.tracks[0].items.length, rev: T.st().project.tracks[0].items.some((i) => i.reverse) }`)
    check('desfazer (2×) volta ao clipe inteiro sem reverso', u.n === 1 && !u.rev, u)
  }

  console.log('shuttle J/K/L')
  {
    await ev(`T.st().select([]); await T.seek(2 * ${S}); return 1`)
    const l1 = await ev(`T.key('l'); await new Promise((r) => setTimeout(r, 400)); return { playing: T.st().playing, rate: T.st().playRate }`)
    check('L parado toca a 1×', l1.playing && l1.rate === 1, l1)
    const l2 = await ev(`T.key('l'); await new Promise((r) => setTimeout(r, 300)); const r2 = T.st().playRate; T.key('l'); await new Promise((r) => setTimeout(r, 300)); const t0 = T.st().playheadUs, w0 = performance.now(); await new Promise((r) => setTimeout(r, 600)); const adv = (T.st().playheadUs - t0) / ((performance.now() - w0) * 1000); return { r2, r4: T.st().playRate, adv }`)
    check('L L: 2×; L L L: 4× (playhead anda ~4 s por segundo)', l2.r2 === 2 && l2.r4 === 4 && Math.abs(l2.adv - 4) < 0.6, l2)
    await shot('f3-speed-06-shuttle-4x.png')
    const k = await ev(`T.key('k'); await new Promise((r) => setTimeout(r, 300)); return { playing: T.st().playing, rate: T.st().playRate, at: T.st().playheadUs }`)
    check('K pausa e volta a 1×', !k.playing && k.rate === 1, k)
    const j = await ev(`T.key('j'); await new Promise((r) => setTimeout(r, 300)); const r1 = T.st().playRate; T.key('j'); await new Promise((r) => setTimeout(r, 200)); const t0 = T.st().playheadUs; await new Promise((r) => setTimeout(r, 500)); return { r1, r2: T.st().playRate, back: T.st().playheadUs < t0 }`)
    check('J: para trás a −1×, de novo −2×, playhead voltando', j.r1 === -1 && j.r2 === -2 && j.back, j)
    await shot('f3-speed-07-shuttle-tras.png')
    await ev(`T.key('k'); await new Promise((r) => setTimeout(r, 300)); await T.seek(4 * ${S}); return 1`)
    // K segurado + L / J: quadro a quadro
    const step = await ev(`const t0 = T.st().playheadUs; T.keyEv('keydown', 'k'); await T.settle(); T.keyEv('keydown', 'l'); T.keyEv('keyup', 'l'); await T.settle(); const t1 = T.st().playheadUs; T.keyEv('keydown', 'j'); T.keyEv('keyup', 'j'); T.keyEv('keydown', 'j'); T.keyEv('keyup', 'j'); await T.settle(); const t2 = T.st().playheadUs; T.keyEv('keyup', 'k'); await T.settle(); return { t0, t1, t2, playing: T.st().playing }`)
    check('K+L avança 1 quadro; K+J volta 1 quadro (2×); sem tocar', step.t0 === 4_000_000 && step.t1 === 4_033_333 && step.t2 === 3_966_667 && !step.playing, step)
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
  // settings.json do usuário: restaura se o teste mexeu
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
