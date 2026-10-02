// QA do tratamento de voz (F3 Task 4) via CDP: switches "Reduzir ruído (voz)" e "Normalizar volume (−16 LUFS)" no
// inspetor de áudio, estado do processamento, comparação A/B segurando o botão, desligar/religar sem reprocessar e
// o projeto aberto "em outro PC" (generated/ apagado) reprocessando sozinho. Eventos sintéticos despachados no
// elemento real sob o ponto — nunca entrada do sistema operacional.
//
// uso (depois de `npm run build` e `npm run fetch:models`):
//   node scripts/qa/editor-f3-voice.mjs            → abre o app (CIALIGHT_QA=editor-fixture,
//                                                    CIALIGHT_RAW_DIR=test-out/raw), testa e fecha
//   node scripts/qa/editor-f3-voice.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//
// A fixture é mídia sintética (testsrc2 + voz sintética + PNG). Screenshots em docs/qa/editor-f3/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f3')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const GENERATED = join(ROOT, 'test-out', 'Projetos', 'p-qa-editor-fixture', 'generated')

mkdirSync(SHOTS, { recursive: true })
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
// começa sem cache de áudio processado
if (existsSync(GENERATED)) for (const f of readdirSync(GENERATED)) if (f.includes('.audio-')) rmSync(join(GENERATED, f), { force: true })

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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__vq; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
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
window.__vq = (() => {
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
    window.dispatchEvent(pe('pointerup', c.x, c.y))
    t.dispatchEvent(me('mouseup', c.x, c.y))
    t.dispatchEvent(me('click', c.x, c.y))
    await settle()
    return t
  }
  /** Segura (pointerdown) o elemento sob o centro; devolve a função que solta. */
  const press = (e) => {
    e.scrollIntoView({ block: 'nearest' })
    const c = center(e)
    const t = topAt(c.x, c.y)
    t.dispatchEvent(pe('pointerdown', c.x, c.y))
    return async () => { t.dispatchEvent(pe('pointerup', c.x, c.y)); await settle() }
  }
  const items = () => st().project.tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t.name, kind: t.kind })))
  const media = (id) => items().find((i) => i.id === id)
  const panel = () => el('[aria-label="Inspetor"]')
  const toggle = (label) => el('[aria-label="Inspetor"] [role="switch"][aria-label="' + label + '"]')
  const tab = (text) => { const b = [...panel().querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === text); if (!b) throw new Error('sem aba ' + text); return b }
  const status = () => panel().querySelector('[data-audio-process-status]')?.getAttribute('data-audio-process-status') ?? null
  const ab = () => [...panel().querySelectorAll('button')].find((b) => b.textContent.includes('comparar') || b.textContent.includes('Ouvindo'))
  const timelineItem = (id) => el('[data-item-id="' + id + '"]')
  const selectItem = async (id) => { const r = timelineItem(id).getBoundingClientRect(); await clickEl(timelineItem(id), { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 }); await new Promise((res) => setTimeout(res, 150)) }
  const waitReady = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (status() === 'ready') return performance.now() - t0; await new Promise((r) => setTimeout(r, 200)) } return -1 }
  const past = () => st().history.past.length
  return { st, settle, el, clickEl, press, items, media, panel, toggle, tab, status, ab, selectItem, waitReady, past }
})()
'ok'`

async function openEditor() {
  for (let i = 0; i < 60 && !(await ev(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(800)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready')`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
}

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(`localStorage.setItem('editor.timelineHeight', '240'); return 1`)
  await openEditor()
  const a = await ev(`return T.items().find((i) => i.assetId === 'a_qa_video' && !i.visual).id`)
  await ev(`T.st().select(['${a}']); await T.settle(); await T.clickEl(T.tab('Áudio')); return 1`)

  console.log('switches no inspetor de áudio')
  {
    const r = await ev(`return { dn: !!T.toggle('Reduzir ruído (voz)'), ln: !!T.toggle('Normalizar volume (−16 LUFS)'), status: T.status() }`)
    check('"Reduzir ruído (voz)" e "Normalizar volume (−16 LUFS)" presentes, sem status com tudo desligado', r.dn && r.ln && r.status === null, r)
  }

  console.log('ligar a redução de ruído: processa e passa a usar o tratado')
  {
    const r = await ev(`const p0 = T.past(); await T.clickEl(T.toggle('Reduzir ruído (voz)')); await T.settle(); return { p0, past: T.past(), denoise: T.media('${a}').audio.denoise, status: T.status(), text: T.panel().textContent }`)
    check('um passo de histórico; status "processando" (tocando o original)', r.denoise === true && r.past === r.p0 + 1 && r.status === 'processing' && r.text.includes('tocando o original'), { ...r, text: undefined })
    await shot('f3-voz-01-processando.png')
    const ms = await ev(`return await T.waitReady(60000)`)
    const keys = await ev(`return T.st().project.assets.find((x) => x.id === 'a_qa_video').processedAudio`)
    check('fica pronto e a chave entra em processedAudio', ms >= 0 && JSON.stringify(keys) === '["dn-sh"]', { ms, keys })
    check('arquivo em generated/', existsSync(join(GENERATED, 'a_qa_video.audio-dn-sh.m4a')), readdirSync(GENERATED))
    await shot('f3-voz-02-pronto.png')
  }

  console.log('comparar A/B segurando o botão')
  {
    const r = await ev(`const release = T.press(T.ab()); await T.settle(); const held = { bypass: T.st().audioBypass, text: T.ab().textContent }; window.__vqRelease = release; return held`)
    check('segurando: o preview toca o original (audioBypass) e o botão avisa', r.bypass === true && r.text.includes('Ouvindo o original'), r)
    await shot('f3-voz-03-ab-segurando.png')
    const after = await ev(`await window.__vqRelease(); return { bypass: T.st().audioBypass, text: T.ab().textContent }`)
    check('soltou: volta ao tratado', after.bypass === false && after.text.includes('comparar'), after)
  }

  console.log('desligar e religar: sem reprocessar')
  {
    const r = await ev(`await T.clickEl(T.toggle('Reduzir ruído (voz)')); const off = { status: T.status(), jobs: Object.keys(T.st().audioJobs).length }; await T.clickEl(T.toggle('Reduzir ruído (voz)')); await T.settle(); return { off, on: { status: T.status(), jobs: Object.keys(T.st().audioJobs).length } }`)
    check('desligado: sem status; religado: pronto na hora (cache), nenhum job', r.off.status === null && r.on.status === 'ready' && r.on.jobs === 0, r)
  }

  console.log('normalizar também: nova chave (ruído antes da normalização)')
  {
    await ev(`await T.clickEl(T.toggle('Normalizar volume (−16 LUFS)')); return 1`)
    const ms = await ev(`return await T.waitReady(60000)`)
    const keys = await ev(`return T.st().project.assets.find((x) => x.id === 'a_qa_video').processedAudio`)
    check('dn-sh_ln-i16-tp1.5 pronto, dn-sh mantido no cache', ms >= 0 && JSON.stringify(keys) === '["dn-sh","dn-sh_ln-i16-tp1.5"]', { ms, keys })
    await shot('f3-voz-04-ruido-e-normalizar.png')
  }

  console.log('projeto aberto "em outro PC" (sem generated/): reprocessa sozinho')
  {
    await ev(`window.__navigate('projects'); return 1`)
    await sleep(1500)
    for (const f of readdirSync(GENERATED)) if (f.includes('.audio-')) rmSync(join(GENERATED, f), { force: true })
    await openEditor()
    const r0 = await ev(`return { keys: T.st().project.assets.find((x) => x.id === 'a_qa_video').processedAudio ?? null, jobs: Object.keys(T.st().audioJobs) }`)
    check('ao abrir, as chaves sem arquivo saem e o pedido sai sozinho', r0.keys === null && r0.jobs.includes('a_qa_video~dn-sh_ln-i16-tp1.5'), r0)
    let keys = null
    for (let i = 0; i < 60; i++) {
      keys = await ev(`return T.st().project.assets.find((x) => x.id === 'a_qa_video').processedAudio ?? null`)
      if (keys) break
      await sleep(1000)
    }
    check('reprocessado (só a chave pedida pelo item)', JSON.stringify(keys) === '["dn-sh_ln-i16-tp1.5"]' && existsSync(join(GENERATED, 'a_qa_video.audio-dn-sh_ln-i16-tp1.5.m4a')), keys)
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
