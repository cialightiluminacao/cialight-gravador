// QA do relink automático (F7, Task 6) via CDP: um projeto com um vídeo e uma imagem (mídia sintética gerada aqui em
// test-out/qa-f7-relink/aulas/originais), fechado; a pasta dos arquivos é "movida" (os arquivos vão para a pasta irmã
// aulas/movidas); ao reabrir, o editor procura em segundo plano e mostra "Mídia encontrada em outro local" com o
// caminho antigo → novo. Confirma: os assets voltam a 'ready' e o preview desenha os dois sem placeholder. Também lê
// as métricas de memória (compositor e filmstrips) expostas em window.__qaEditor.
// Cliques sintéticos (element.click), nunca entrada do SO. Restaura o settings.json (hash).
//
// uso (depois de `npm run build`, sob o lock):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs node scripts/qa/editor-f7-relink.mjs
// Screenshots em docs/qa/editor-f7/.
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9336'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f7')
const BASE = join(ROOT, 'test-out', 'qa-f7-relink')
const ORIG = join(BASE, 'aulas', 'originais')
const MOVED = join(BASE, 'aulas', 'movidas')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const PROJECT_ID = 'p-qa-f7-relink'
const VIDEO = 'aula-relink.mp4'
const IMAGE = 'foto-relink.png'
const hash = (b) => (b ? createHash('sha1').update(b).digest('hex') : null)

mkdirSync(SHOTS, { recursive: true })
rmSync(BASE, { recursive: true, force: true })
mkdirSync(ORIG, { recursive: true })
mkdirSync(MOVED, { recursive: true })
const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(ORIG, VIDEO)])
ff(['-f', 'lavfi', '-i', 'color=c=0x2266cc:s=320x180,drawbox=x=100:y=50:w=120:h=80:color=0xffcc00:t=fill', '-frames:v', '1', '-update', '1', join(ORIG, IMAGE)])
const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null

const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw' },
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
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 docs/qa/editor-f7/${name}`)
}
async function waitFor(body, ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await ev(body)
    if (v) return v
    await sleep(300)
  }
  return null
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

const assetsState = `const s = window.__qaEditor?.store.getState(); return s?.project?.id === ${JSON.stringify(PROJECT_ID)} ? s.project.assets.map((a) => ({ name: a.name, status: a.status, path: a.source.path })) : null`
const allReady = `const s = window.__qaEditor?.store.getState(); return s?.project?.id === ${JSON.stringify(PROJECT_ID)} && s.project.assets.length === 2 && s.project.assets.every((a) => a.status === 'ready')`

async function openEditor() {
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:${PROJECT_ID}'); return 1`)
  return waitFor(`return window.__qaEditor?.store.getState().project?.id === ${JSON.stringify(PROJECT_ID)}`)
}

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false })
  await waitFor(`return typeof window.__navigate === 'function'`, 30000)

  // ---- projeto com as duas mídias em aulas/originais ----
  await ev(`const base = await window.api.project.load('p-qa-editor-fixture')
    await window.api.project.remove(${JSON.stringify(PROJECT_ID)}).catch(() => {})
    await window.api.project.create({ ...base, id: ${JSON.stringify(PROJECT_ID)}, name: 'Aula (relink)', assets: [], markers: [], tracks: base.tracks.filter((t) => t.kind === 'video').slice(0, 1).map((t) => ({ ...t, items: [] })) })
    return 1`)
  check('editor aberto no projeto novo', !!(await openEditor()), null)
  await ev(`await window.__qaEditor.importPaths(${JSON.stringify([join(ORIG, VIDEO), join(ORIG, IMAGE)])}); return 1`)
  const ready0 = await waitFor(allReady, 90000)
  check('mídias importadas e prontas', !!ready0, await ev(assetsState))
  for (const name of [VIDEO, IMAGE]) {
    await ev(`const b = document.querySelector('[aria-label="Adicionar ${name} no playhead"]'); if (!b) throw new Error('sem botão de adicionar ${name}'); b.click(); return 1`)
    await sleep(300)
  }
  const items = await ev(`return window.__qaEditor.store.getState().project.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.items).length`)
  check('vídeo e imagem na linha do tempo', items === 2, items)
  // sai do editor (grava) e "move" a pasta: os arquivos vão para a pasta irmã
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(2500)
  renameSync(join(ORIG, VIDEO), join(MOVED, VIDEO))
  renameSync(join(ORIG, IMAGE), join(MOVED, IMAGE))

  // ---- reabrir: busca em segundo plano → diálogo ----
  check('editor reaberto', !!(await openEditor()), null)
  const missing = await waitFor(`const a = ${'(() => { ' + assetsState + ' })()'}; return a && a.length === 2 && a.every((x) => x.status === 'missing') ? a : null`, 20000)
  check('ao reabrir as duas mídias estão ausentes', !!missing, await ev(assetsState))
  const dlg = await waitFor(`return document.querySelector('[data-relink-dialog]') ? document.querySelector('[role="dialog"]').textContent : null`, 20000)
  check('diálogo "Mídia encontrada em outro local" aparece sozinho', !!dlg && dlg.includes('Mídia encontrada em outro local') && dlg.includes('2 mídias ausentes'), dlg)
  // caminhos inteiros no title (o texto mostra o fim do caminho: as pastas que mudaram e o nome)
  const titles = await ev(`return [...document.querySelectorAll('[data-relink-dialog] [title]')].map((e) => e.title)`)
  check('lista nome e caminho antigo → novo das duas', !!dlg && [VIDEO, IMAGE].every((n) => dlg.includes(n) && titles.includes(join(ORIG, n)) && titles.includes(join(MOVED, n))) && dlg.includes('originais') && dlg.includes('movidas'), { dlg, titles })
  const boxes = await ev(`return [...document.querySelectorAll('[data-relink-dialog] input[type="checkbox"]')].map((c) => c.checked)`)
  check('todas marcadas', JSON.stringify(boxes) === '[true,true]', boxes)
  const stillMissing = await ev(`const s = window.__qaEditor.store.getState(); return s.project.assets.every((a) => a.status === 'missing')`)
  check('nada reapontado antes de confirmar', stillMissing === true, stillMissing)
  await shot('f7-20-relink-dialogo.png')

  // ---- confirmar ----
  await ev(`const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === 'Reapontar selecionadas'); if (!b) throw new Error('sem botão Reapontar'); b.click(); return 1`)
  const toast = await waitFor(`const t = [...document.querySelectorAll('[data-sonner-toast]')].map((x) => x.textContent).join(' | '); return t.includes('2 mídias reapontadas') ? t : null`, 20000)
  check('toast "2 mídias reapontadas"', !!toast, await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((x) => x.textContent)`))
  const ready = await waitFor(allReady, 90000)
  const after = await ev(assetsState)
  check('assets prontos no novo local', !!ready && after.every((a) => a.path.startsWith(MOVED)), after)
  check('diálogo fechado', !(await ev(`return !!document.querySelector('[data-relink-dialog]')`)), null)

  // preview: o quadro em 0,5 s desenha as duas mídias, sem placeholder
  // a imagem cobre o quadro: o vídeo (por baixo) é conferido pelo `missing` do quadro renderizado
  const frameAt = `const r = await window.__qaEditor.engine.render.requestFrame(500000, false); return r.t === 'rendered' ? { missing: r.missing } : { error: r.message }`
  await ev(`window.__qaEditor.controller.seek(500000); return 1`)
  const frame = await waitFor(`const f = await (async () => { ${frameAt} })(); return f.missing && f.missing.length === 0 ? f : null`, 3000)
  check('preview renderiza sem mídia indisponível', !!frame, await ev(frameAt))
  const audioErr = await ev(`return [...document.querySelectorAll('[data-sonner-toast]')].map((x) => x.textContent).filter((t) => t.includes('Não foi possível'))`)
  check('nenhum erro de áudio/vídeo depois de reapontar', audioErr.length === 0, audioErr)
  await sleep(800)
  await shot('f7-21-relink-reapontado.png')

  // métricas de memória (QA): compositor e filmstrips
  const mem = await ev(`return await window.__qaEditor.memStats()`)
  const fs = await ev(`return window.__qaEditor.filmstrips()`)
  console.log(`  memória do compositor: ${JSON.stringify(mem)}; filmstrips: ${JSON.stringify(fs)}`)
  check('memStats do compositor (texturas ≤ 512 MiB, contadores presentes)', !!mem && mem.textureCount >= 1 && mem.textureBytes <= 512 * 2 ** 20 && typeof mem.effectBytes === 'number' && typeof mem.evictions === 'number', mem)
  check('métricas dos filmstrips (sprite do vídeo admitida, ≤ 200 MiB)', !!fs && fs.count >= 1 && fs.bytes > 0 && fs.bytes <= 200 * 2 ** 20 && fs.denied === 0, fs)

  await ev(`window.__navigate('projects'); return 1`)
  await sleep(1500)
  await ev(`await window.api.project.remove(${JSON.stringify(PROJECT_ID)}).catch(() => {}); return 1`)
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
  try {
    execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // já saiu
  }
  await sleep(500)
  const now = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
  if (hash(now) !== hash(settingsBefore)) {
    if (settingsBefore) writeFileSync(SETTINGS, settingsBefore)
    else if (now) rmSync(SETTINGS)
    console.log(`settings.json restaurado (hash ${hash(now)} → ${hash(settingsBefore)})`)
  } else console.log(`settings.json intocado (hash ${hash(settingsBefore)})`)
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
