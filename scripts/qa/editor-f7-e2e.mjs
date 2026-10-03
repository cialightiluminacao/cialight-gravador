// E2E da F7 (exportação completa) via CDP: uma história contínua com mídia sintética (o projeto de teste do
// CIALIGHT_QA=editor-fixture: testsrc2 1280×720 de 12 s + voz, logo em PiP e trilha).
//  1. Abre o fixture; põe uma tarja #123456 e um blur (faixa de efeitos, pelo store) e 3 marcadores com rótulo.
//  2. I–O de 2 s a 8 s; Ctrl+E → "YouTube 1080p" → "Adicionar à fila"; GIF 480 → fila; "Só áudio" MP3 → fila;
//     painel "Exportações" até os 3 concluírem (na pasta window.__qaEditor.exportDir, dentro de test-out).
//  3. Quadro atual em PNG (Ctrl+Shift+E).
//  4. Copia os capítulos (barra superior; usa o I–O) e confere o texto exato.
//  5. ffprobe de cada saída (codec/dimensões/duração) e privacidade nos pixels do MP4, GIF e PNG: tarja com a cor
//     nas tolerâncias do test:editor-formats (MP4 ±3 em cada macrobloco, GIF ±8 em todo pixel coberto de todo
//     quadro, PNG exata) e o miolo do blur com pouco detalhe (energia < 10 % da mesma região na fonte; no GIF
//     sobre médias de blocos 4×4, por causa do pontilhado da paleta).
//  6. Codificador de reserva (libx264): a flag de teste (simulateSoftwareFailure) não é alcançável por
//     window.__qaEditor — fica registrado e o test:editor-formats cobre o caminho real.
//  7. Relink: move o logo do fixture para uma pasta irmã, reabre o projeto, confirma o diálogo e o asset volta a
//     'ready' no novo local.
//  8. Métricas de memória (window.__qaEditor) dentro dos tetos (texturas 512 MiB, filmstrips 200 MiB) depois de
//     percorrer a linha do tempo.
// Teclas e cliques sintéticos (CDP Input.dispatchKeyEvent / element.click), nunca entrada do SO. Restaura o
// settings.json (hash) e a área de transferência; apaga o que criou em test-out.
//
// uso (depois de `npm run build`, sob o lock):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs node scripts/qa/editor-f7-e2e.mjs
// Screenshots em docs/qa/editor-f7/e2e-NN-*.png.
import { spawn, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9337'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f7')
const BASE = join(ROOT, 'test-out', 'qa-f7-e2e')
const OUT = join(BASE, 'saida')
// pasta irmã da pasta do fixture (test-out/qa-editor): o nível 2 da busca do relink
const MOVED_DIR = join(ROOT, 'test-out', 'qa-f7-e2e-movida')
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'ffmpeg', 'ffprobe.exe')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const PROJECT_ID = 'p-qa-editor-fixture'
const hash = (b) => (b ? createHash('sha256').update(b).digest('hex') : null)

// efeitos (normalizados ao quadro): longe do logo (canto de cima à direita) e um do outro
const TARJA = [0x12, 0x34, 0x56]
const SOLID = { x: 0.3, y: 0.7, w: 0.25, h: 0.25 }
const BLUR = { x: 0.3, y: 0.3, w: 0.25, h: 0.25 }
const IN_US = 2_000_000
const OUT_US = 8_000_000
const RANGE_S = (OUT_US - IN_US) / 1e6
const PNG_US = 5_000_000
const MARKERS = [
  { id: 'qa-e2e-m1', tUs: 2_000_000, label: 'Abertura', color: '#f59e0b' },
  { id: 'qa-e2e-m2', tUs: 4_500_000, label: 'Demonstração', color: '#f59e0b' },
  { id: 'qa-e2e-m3', tUs: 6_000_000, label: 'Conclusão', color: '#f59e0b' }
]
// relativos ao I–O (2 s): 0 s, 2,5 s → 00:02, 4 s
const EXPECTED_CHAPTERS = '00:00 Abertura\n00:02 Demonstração\n00:04 Conclusão'

mkdirSync(SHOTS, { recursive: true })
rmSync(BASE, { recursive: true, force: true })
rmSync(MOVED_DIR, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
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
let shotN = 0
// repo público: nenhuma captura mostra caminho local (com o usuário). Antes de cada uma, o texto visível troca o
// prefixo até "test-out" por "…" (só a exibição; os caminhos de verdade — title, store — ficam) e confere que o
// nome da pasta do usuário não aparece mais em lugar nenhum da tela.
const PATH_PREFIX = String.raw`[^\s"'(]*[\\/]test-out(?=[\\/])`
const USER_DIR = basename(homedir()).toLowerCase()
async function shot(name) {
  const file = `e2e-${String(++shotN).padStart(2, '0')}-${name}.png`
  const leak = await ev(`
    const re = new RegExp(${JSON.stringify(PATH_PREFIX)}, 'g')
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes('test-out')) n.nodeValue = n.nodeValue.replace(re, ${JSON.stringify('…\\test-out')})
    const text = document.body.innerText.toLowerCase()
    return [${JSON.stringify(`\\${USER_DIR}\\`)}, ${JSON.stringify(`/${USER_DIR}/`)}].some((s) => text.includes(s))`)
  check(`captura ${file} sem caminho local do usuário`, leak === false, { leak })
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, file), Buffer.from(r.result.data, 'base64'))
  console.log(`  📷 docs/qa/editor-f7/${file}`)
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
// tecla sintética pelo CDP (modifiers: 2 = Ctrl, 8 = Shift)
async function key(k, code, vk, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

const DLG = `document.querySelector('[role="dialog"]')`
const toasts = `return [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).join(' | ')`
const setInput = (sel, value) => `{
  const el = ${DLG}.querySelector(${JSON.stringify(sel)})
  if (!el) throw new Error('campo não encontrado: ' + ${JSON.stringify(sel)})
  el.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.blur()
}`
const clickText = (text) => `{
  const el = [...${DLG}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
  if (!el) throw new Error('não achei o botão ' + ${JSON.stringify(text)})
  el.click()
}`

// ---- ffmpeg / ffprobe ----
const ffprobe = (file, extra = []) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', ...extra, '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
/** Quadros RGB24 (Buffer contínuo) do arquivo; `ss` em segundos e `vf` opcionais. */
const rgb = (file, { ss, frames = 1, vf } = {}) =>
  execFileSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...(ss != null ? ['-ss', ss.toFixed(3)] : []), '-i', file, ...(frames ? ['-frames:v', String(frames)] : []), ...(vf ? ['-vf', vf] : []), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 })
/** Caixa em pixels inteiros totalmente dentro da região normalizada (com recuo `inset` px). */
const box = (r, W, H, inset = 0) => ({ x0: Math.ceil((r.x - r.w / 2) * W) + inset, y0: Math.ceil((r.y - r.h / 2) * H) + inset, x1: Math.floor((r.x + r.w / 2) * W) - inset, y1: Math.floor((r.y + r.h / 2) * H) - inset })
/** Pior desvio por canal da cor da tarja em todo pixel da caixa (imagem `off` bytes adentro do buffer). */
function tarjaWorstPixels(img, W, b, off = 0) {
  let worst = 0
  let n = 0
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const i = off + (y * W + x) * 3
      worst = Math.max(worst, Math.abs(img[i] - TARJA[0]), Math.abs(img[i + 1] - TARJA[1]), Math.abs(img[i + 2] - TARJA[2]))
      n++
    }
  }
  return { worst, n }
}
/** Como o checkEffects do test:editor-export: centro de cada macrobloco 16×16 inteiro dentro da região. */
function tarjaWorstBlocks(img, W, H) {
  const B = 16
  const bx0 = Math.ceil(((SOLID.x - SOLID.w / 2) * W) / B)
  const by0 = Math.ceil(((SOLID.y - SOLID.h / 2) * H) / B)
  const bx1 = Math.floor(((SOLID.x + SOLID.w / 2) * W) / B) - 1
  const by1 = Math.floor(((SOLID.y + SOLID.h / 2) * H) / B) - 1
  let worst = 0
  let n = 0
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      const i = ((by * B + B / 2) * W + bx * B + B / 2) * 3
      worst = Math.max(worst, Math.abs(img[i] - TARJA[0]), Math.abs(img[i + 1] - TARJA[1]), Math.abs(img[i + 2] - TARJA[2]))
      n++
    }
  }
  return { worst, n }
}
/** Energia de detalhe (gradiente de luma ao quadrado, média) da caixa — a mesma métrica do test:editor-export. */
function detailEnergy(img, W, b, off = 0) {
  const L = (x, y) => {
    const i = off + (y * W + x) * 3
    return 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]
  }
  let s = 0
  let n = 0
  for (let y = b.y0; y < b.y1 - 1; y++) {
    for (let x = b.x0; x < b.x1 - 1; x++) {
      const l = L(x, y)
      s += (L(x + 1, y) - l) ** 2 + (L(x, y + 1) - l) ** 2
      n++
    }
  }
  return n ? s / n : 0
}
/**
 * Energia de detalhe sobre as médias de blocos K×K da caixa. No GIF a paleta pontilha o degradê liso do borrão
 * (ruído de alta frequência que não revela nada); com K = 4 o pontilhado some e as bordas do conteúdo ficam.
 */
function blockEnergy(img, W, b, K, off = 0) {
  const L = (x, y) => {
    const i = off + (y * W + x) * 3
    return 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]
  }
  const bw = Math.floor((b.x1 - b.x0) / K)
  const bh = Math.floor((b.y1 - b.y0) / K)
  const m = new Float64Array(bw * bh)
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      let s = 0
      for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) s += L(b.x0 + i * K + x, b.y0 + j * K + y)
      m[j * bw + i] = s / (K * K)
    }
  }
  let s = 0
  let n = 0
  for (let j = 0; j < bh - 1; j++) {
    for (let i = 0; i < bw - 1; i++) {
      const v = m[j * bw + i]
      s += (m[j * bw + i + 1] - v) ** 2 + (m[(j + 1) * bw + i] - v) ** 2
      n++
    }
  }
  return n ? s / n : 0
}
// miolo do blur: 20 % para dentro de cada lado (longe da borda, onde o borrão mistura o que está fora)
const blurCore = (W, H) => {
  const b = box(BLUR, W, H)
  const dx = Math.round((b.x1 - b.x0) * 0.2)
  const dy = Math.round((b.y1 - b.y0) * 0.2)
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 - dx, y1: b.y1 - dy }
}

async function openEditor() {
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:${PROJECT_ID}'); return 1`)
  return waitFor(`const s = window.__qaEditor?.store.getState(); return s?.project?.id === ${JSON.stringify(PROJECT_ID)}`)
}

let clipboardBefore = null
let logoOriginal = null
let logoMoved = null

async function main() {
  await connect()
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 860, deviceScaleFactor: 1, mobile: false })
  // corrida conhecida na subida: __navigate só existe depois do 1º render
  check('app pronto (__navigate)', !!(await waitFor(`return typeof window.__navigate === 'function'`, 30000)), null)
  clipboardBefore = await ev(`window.focus(); try { return await navigator.clipboard.readText() } catch { return null }`)

  // ---- 1. fixture + tarja + blur + 3 marcadores ----
  check('editor aberto no projeto de teste', !!(await openEditor()), null)
  const ready = await waitFor(`const s = window.__qaEditor.store.getState(); return s.project.assets.every((a) => a.status === 'ready')`, 120000)
  check('mídias do fixture prontas', !!ready, await ev(`return window.__qaEditor.store.getState().project.assets.map((a) => [a.name, a.status])`))
  await ev(`window.__qaEditor.exportDir = ${JSON.stringify(OUT)}; return 1`)
  const canvas = await ev(`return window.__qaEditor.store.getState().project.canvas`)
  const srcVideo = await ev(`return window.__qaEditor.store.getState().project.assets.find((a) => a.id === 'a_qa_video').source.path`)
  console.log(`fixture: ${canvas.width}×${canvas.height} @ ${canvas.fps} fps; vídeo ${srcVideo}`)
  const fx = (id, effect, r, extra) => ({
    id, type: 'effect', effect, startUs: 0, durationUs: 12_000_000,
    region: { shape: 'rect', x: { value: r.x }, y: { value: r.y }, w: { value: r.w }, h: { value: r.h }, rotation: { value: 0 } },
    strength: { value: effect === 'solid' ? 100 : 80 }, feather: 0, color: '#000000', invert: false, scope: 'below', ...extra
  })
  // uma faixa por efeito (itens de uma faixa não se sobrepõem)
  const fxTrack = (id, name, item) => ({ id, kind: 'video', name, muted: false, hidden: false, locked: false, volume: 1, role: 'effects', items: [item] })
  const fxTracks = [fxTrack('t_qa_e2e_blur', 'Efeitos', fx('i_qa_e2e_blur', 'blur', BLUR)), fxTrack('t_qa_e2e_tarja', 'Efeitos 2', fx('i_qa_e2e_tarja', 'solid', SOLID, { color: '#123456' }))]
  const applied = await ev(`const s = window.__qaEditor.store.getState()
    return s.apply((p) => {
      const lastVideo = p.tracks.reduce((m, t, i) => (t.kind === 'video' ? i : m), -1)
      const tracks = [...p.tracks]
      tracks.splice(lastVideo + 1, 0, ...${JSON.stringify(fxTracks)})
      return { ...p, tracks, markers: ${JSON.stringify(MARKERS)} }
    })`)
  const st1 = await ev(`const p = window.__qaEditor.store.getState().project; return { fx: p.tracks.flatMap((t) => t.items).filter((i) => i.type === 'effect').map((i) => i.effect), markers: p.markers.map((m) => m.label) }`)
  check('tarja e blur na faixa de efeitos; 3 marcadores com rótulo', applied === true && JSON.stringify(st1.fx) === '["blur","solid"]' && JSON.stringify(st1.markers) === JSON.stringify(MARKERS.map((m) => m.label)), { applied, st1 })
  await ev(`const s = window.__qaEditor.store.getState(); s.setInOut(${IN_US}, ${OUT_US}); s.setPlayhead(${PNG_US}); return 1`)
  await sleep(1200)
  await shot('editor-efeitos-marcadores')

  // ---- 2. três itens na fila: YouTube 1080p, GIF 480, Só áudio MP3 (todos no I–O) ----
  await ev(`document.activeElement?.blur?.(); return 1`)
  await key('e', 'KeyE', 69, 2)
  await sleep(600)
  check('Ctrl+E abre o diálogo', (await ev(`return ${DLG}?.textContent ?? ''`)).includes('Exportar vídeo'), null)
  const enqueue = async (format, name, setup) => {
    await ev(`${clickText(format)}; return 1`)
    await sleep(250)
    if (setup) await setup()
    await ev(`${clickText('Entrada–Saída (I–O)')}; return 1`)
    await sleep(200)
    await ev(`${setInput('[data-export-name]', name)}; return 1`)
    await sleep(150)
    await ev(`${DLG}.querySelector('[data-export-enqueue]').click(); return 1`)
    await sleep(400)
  }
  await enqueue('Vídeo', 'e2e-video.mp4', async () => {
    await ev(`${DLG}.querySelector('[data-preset="youtube1080"]').click(); return 1`)
    await sleep(250)
  })
  const est = await ev(`return ${DLG}.querySelector('[data-export-estimate]')?.textContent ?? ''`)
  check('YouTube 1080p na fila (posição 1)', (await ev(toasts)).includes('Adicionado à fila (posição 1)'), { est, toasts: await ev(toasts) })
  await enqueue('GIF', 'e2e-anim.gif', async () => {
    const w = await ev(`const g = ${DLG}.querySelector('[aria-label="Largura do GIF"]'); return [...g.querySelectorAll('button')].find((b) => b.getAttribute('aria-checked') === 'true' || b.getAttribute('data-state') === 'on')?.textContent.trim() ?? null`)
    if (w !== '480 px') await ev(`[...${DLG}.querySelector('[aria-label="Largura do GIF"]').querySelectorAll('button')].find((b) => b.textContent.trim() === '480 px').click(); return 1`)
    await sleep(200)
  })
  // a posição conta o que ainda não terminou: o vídeo curto pode acabar antes do próximo clique
  const queued = async (name, n) => {
    const t = await ev(toasts)
    const len = await ev(`return window.__qaEditor.queue.items.length`)
    check(`${name} na fila (toast "Adicionado à fila (posição N)"; ${n} itens)`, Array.from({ length: n }, (_, k) => `Adicionado à fila (posição ${k + 1})${name}`).some((s) => t.includes(s)) && len === n, { t, len })
  }
  await queued('e2e-anim.gif', 2)
  await enqueue('Só áudio', 'e2e-audio.mp3', async () => {
    const est2 = await ev(`return ${DLG}.querySelector('[data-export-estimate]')?.textContent ?? ''`)
    check('Só áudio: MP3 192 kbps (padrão)', /MP3 · 192 kbps/.test(est2), est2)
  })
  await queued('e2e-audio.mp3', 3)
  await shot('dialogo-fila')
  await key('Escape', 'Escape', 27)
  await sleep(400)
  await ev(`if (!document.querySelector('[data-export-queue-panel]')) document.querySelector('[data-export-queue-button]').click(); return 1`)
  await sleep(500)
  const running = await waitFor(`const t = document.querySelector('[data-export-queue-panel]')?.textContent ?? ''; return /Exportando \\d+%/.test(t) ? t : null`, 20000)
  check('painel "Exportações" com a fila rodando', !!running, null)
  await shot('fila-rodando')
  let states = null
  for (let i = 0; i < 3000; i++) {
    states = await ev(`return window.__qaEditor.queue.items.map((i) => i.state)`)
    if (states.every((s) => s !== 'pending' && s !== 'running')) break
    await sleep(100)
  }
  check('fila: os 3 concluídos', JSON.stringify(states) === '["done","done","done"]', { states, items: await ev(`return window.__qaEditor.queue.items.map((i) => ({ s: i.state, e: i.error }))`) })
  await sleep(600)
  check('toast "Fila de exportações: 3 concluídas"', (await ev(toasts)).includes('Fila de exportações: 3 concluídas'), await ev(toasts))
  await shot('fila-concluida')
  await key('Escape', 'Escape', 27)
  await sleep(300)

  // ---- 3. quadro PNG (Ctrl+Shift+E) na posição do cursor (5 s) ----
  const pngBefore = readdirSync(OUT).filter((f) => f.endsWith('.png'))
  await ev(`window.__qaEditor.store.getState().setPlayhead(${PNG_US}); document.activeElement?.blur?.(); return 1`)
  await sleep(300)
  await key('E', 'KeyE', 69, 10)
  let pngFile = null
  for (let i = 0; i < 150 && !pngFile; i++) {
    pngFile = readdirSync(OUT).find((f) => f.endsWith('.png') && !pngBefore.includes(f)) ?? null
    if (!pngFile) await sleep(100)
  }
  check('Ctrl+Shift+E: quadro "<projeto> - 00m05s.png" na pasta', !!pngFile && / - 00m05s\.png$/.test(pngFile), readdirSync(OUT))
  await sleep(700)
  await shot('quadro-png')

  // ---- 4. capítulos (barra superior; I–O) ----
  await ev(`window.focus(); await navigator.clipboard.writeText('x'); document.querySelector('[data-copy-chapters]').click(); return 1`)
  let clip = null
  for (let i = 0; i < 30; i++) {
    clip = await ev(`try { return (await navigator.clipboard.readText()).replace(/\\r\\n/g, '\\n') } catch (e) { return 'ERRO: ' + e.message }`) // o Windows normaliza para CRLF
    if (clip === EXPECTED_CHAPTERS) break
    await sleep(100)
  }
  check('capítulos copiados com o texto exato (relativos ao I–O)', clip === EXPECTED_CHAPTERS, { clip, expected: EXPECTED_CHAPTERS })

  // ---- 5. ffprobe + privacidade nos pixels ----
  const files = readdirSync(OUT)
  check('pasta de saída: MP4, GIF, MP3 e PNG, sem .part', ['e2e-video.mp4', 'e2e-anim.gif', 'e2e-audio.mp3'].every((f) => files.includes(f)) && !!pngFile && files.every((f) => !f.endsWith('.part')), files)
  const sc = Math.min(1, 1920 / canvas.width, 1080 / canvas.height)
  const VW = Math.max(2, Math.round((canvas.width * sc) / 2) * 2)
  const VH = Math.max(2, Math.round((canvas.height * sc) / 2) * 2)
  // MP4
  const mp4 = join(OUT, 'e2e-video.mp4')
  if (existsSync(mp4)) {
    const p = ffprobe(mp4)
    const v = p.streams.find((s) => s.codec_type === 'video')
    const a = p.streams.find((s) => s.codec_type === 'audio')
    const dur = Number(p.format.duration)
    check(`MP4: H.264 ${VW}×${VH}, AAC, ${RANGE_S} s (±0,1) — ffprobe`, v?.codec_name === 'h264' && v.width === VW && v.height === VH && a?.codec_name === 'aac' && Math.abs(dur - RANGE_S) <= 0.1, { v: v && [v.codec_name, v.width, v.height], a: a?.codec_name, dur })
    for (const t of [1, 4]) {
      const img = rgb(mp4, { ss: t })
      const tj = tarjaWorstBlocks(img, VW, VH)
      check(`MP4 em ${t} s: tarja #123456 ±3 no centro de cada macrobloco (${tj.n} blocos; pior ${tj.worst})`, tj.n > 50 && tj.worst <= 3, tj)
      const core = blurCore(VW, VH)
      const src = rgb(srcVideo, { ss: (IN_US / 1e6) + t, vf: `scale=${VW}:${VH}` })
      const eOut = detailEnergy(img, VW, core)
      const eSrc = detailEnergy(src, VW, core)
      check(`MP4 em ${t} s: blur com pouco detalhe (energia ${eOut.toFixed(1)} < 10 % da fonte ${eSrc.toFixed(1)})`, eSrc > 0 && eOut < 0.1 * eSrc, { eOut, eSrc })
    }
  }
  // GIF
  const gif = join(OUT, 'e2e-anim.gif')
  if (existsSync(gif)) {
    const GW = 480
    const GH = Math.max(2, Math.round((480 * canvas.height) / canvas.width / 2) * 2)
    const p = ffprobe(gif, ['-count_frames'])
    const v = p.streams[0]
    const frames = Number(v.nb_read_frames)
    const expectFrames = Math.round(RANGE_S * 12)
    check(`GIF: ${GW}×${GH}, ${expectFrames} quadros (12 fps × ${RANGE_S} s, ±1) — ffprobe`, v.codec_name === 'gif' && v.width === GW && v.height === GH && Math.abs(frames - expectFrames) <= 1, { codec: v.codec_name, w: v.width, h: v.height, frames })
    const all = rgb(gif, { frames: 0 })
    const fsz = GW * GH * 3
    const n = Math.floor(all.length / fsz)
    // recuo de 1 px: o redimensionamento 1920 → 480 (filtro com vários taps) mistura o pixel da borda com o vizinho
    // de fora da região — mistura do que está FORA, não vazamento do conteúdo coberto
    const tb = box(SOLID, GW, GH, 1)
    let tWorst = 0
    let tPixels = 0
    let eMax = 0
    const core = blurCore(GW, GH)
    for (let k = 0; k < n; k++) {
      const tj = tarjaWorstPixels(all, GW, tb, k * fsz)
      tWorst = Math.max(tWorst, tj.worst)
      tPixels += tj.n
      eMax = Math.max(eMax, blockEnergy(all, GW, core, 4, k * fsz))
    }
    check(`GIF: tarja ±8 em todo pixel coberto (recuo de 1 px) de todo quadro (${n} quadros, ${tPixels} px; pior ${tWorst})`, n === frames && tPixels > 0 && tWorst <= 8, { n, tWorst })
    // referência: a mesma região da fonte reduzida a 480 px, no início/meio/fim do intervalo (o menor detalhe)
    const eSrc = Math.min(...[0.5, RANGE_S / 2, RANGE_S - 0.5].map((t) => blockEnergy(rgb(srcVideo, { ss: IN_US / 1e6 + t, vf: `scale=${GW}:${GH}` }), GW, core, 4)))
    check(`GIF: blur com pouco detalhe em todo quadro (energia em blocos 4×4: pior ${eMax.toFixed(1)} < 10 % da fonte ${eSrc.toFixed(1)})`, eSrc > 0 && eMax < 0.1 * eSrc, { eMax, eSrc })
  }
  // MP3
  const mp3 = join(OUT, 'e2e-audio.mp3')
  if (existsSync(mp3)) {
    const p = ffprobe(mp3)
    const a = p.streams.find((s) => s.codec_type === 'audio')
    const dur = Number(p.format.duration)
    check(`MP3: mp3 48 kHz estéreo, ${RANGE_S} s (±0,1), sem vídeo — ffprobe`, a?.codec_name === 'mp3' && Number(a.sample_rate) === 48000 && a.channels === 2 && Math.abs(dur - RANGE_S) <= 0.1 && !p.streams.some((s) => s.codec_type === 'video'), { a: a && [a.codec_name, a.sample_rate, a.channels], dur })
  }
  // PNG
  if (pngFile) {
    const png = join(OUT, pngFile)
    const p = ffprobe(png)
    const v = p.streams[0]
    check(`PNG: ${canvas.width}×${canvas.height} — ffprobe`, v.codec_name === 'png' && v.width === canvas.width && v.height === canvas.height, { codec: v.codec_name, w: v.width, h: v.height })
    const img = rgb(png)
    const tj = tarjaWorstPixels(img, canvas.width, box(SOLID, canvas.width, canvas.height, 2))
    check(`PNG: tarja com a cor EXATA #123456 (${tj.n} px a 2 px da borda; desvio ${tj.worst})`, tj.n > 1000 && tj.worst === 0, tj)
    const core = blurCore(canvas.width, canvas.height)
    const eOut = detailEnergy(img, canvas.width, core)
    const eSrc = detailEnergy(rgb(srcVideo, { ss: PNG_US / 1e6, vf: `scale=${canvas.width}:${canvas.height}` }), canvas.width, core)
    check(`PNG: blur com pouco detalhe (energia ${eOut.toFixed(1)} < 10 % da fonte ${eSrc.toFixed(1)})`, eSrc > 0 && eOut < 0.1 * eSrc, { eOut, eSrc })
  }

  // ---- 6. codificador de reserva (libx264) ----
  const reachable = await ev(`return Object.keys(window.__qaEditor).filter((k) => /simulate|x264|fallback/i.test(k))`)
  if (reachable.length === 0) console.log('  ↷ libx264 de reserva: a flag de teste (simulateSoftwareFailure) não é alcançável por window.__qaEditor — pulado; o test:editor-formats exercita o caminho real (paridade PSNR e tarja).')
  else console.log(`  ↷ libx264 de reserva: chaves ${reachable.join(', ')} existem, mas o E2E não as usa (coberto pelo test:editor-formats).`)

  // ---- 7. relink: o logo vai para uma pasta irmã ----
  logoOriginal = await ev(`return window.__qaEditor.store.getState().project.assets.find((a) => a.id === 'a_qa_logo').source.path`)
  logoMoved = join(MOVED_DIR, 'logo.png')
  check('pasta do logo é irmã da pasta nova (nível 2 da busca)', dirname(dirname(logoOriginal)) === dirname(MOVED_DIR), { logoOriginal, MOVED_DIR })
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(2500)
  mkdirSync(MOVED_DIR, { recursive: true })
  renameSync(logoOriginal, logoMoved)
  check('editor reaberto', !!(await openEditor()), null)
  const missing = await waitFor(`const a = window.__qaEditor.store.getState().project.assets.find((x) => x.id === 'a_qa_logo'); return a?.status === 'missing'`, 20000)
  check('logo ausente ao reabrir', !!missing, await ev(`return window.__qaEditor.store.getState().project.assets.map((a) => [a.name, a.status])`))
  const dlg = await waitFor(`return document.querySelector('[data-relink-dialog]') ? document.querySelector('[role="dialog"]').textContent : null`, 30000)
  const titles = await ev(`return [...document.querySelectorAll('[data-relink-dialog] [title]')].map((e) => e.title)`)
  check('diálogo "Mídia encontrada em outro local" com o caminho antigo → novo', !!dlg && dlg.includes('Mídia encontrada em outro local') && titles.includes(logoOriginal) && titles.includes(logoMoved), { dlg, titles })
  await shot('relink-dialogo')
  await ev(`const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === 'Reapontar selecionadas'); if (!b) throw new Error('sem botão Reapontar'); b.click(); return 1`)
  const relinked = await waitFor(`const a = window.__qaEditor.store.getState().project.assets.find((x) => x.id === 'a_qa_logo'); return a?.status === 'ready' ? a.source.path : null`, 60000)
  check('logo pronto no novo local', relinked === logoMoved, relinked)
  check('todas as mídias prontas', !!(await waitFor(`return window.__qaEditor.store.getState().project.assets.every((a) => a.status === 'ready')`, 60000)), null)

  // ---- 8. memória depois de percorrer a linha do tempo ----
  for (let t = 0; t <= 11_500_000; t += 500_000) {
    await ev(`window.__qaEditor.controller.seek(${t}); await window.__qaEditor.engine.render.requestFrame(${t}, false); return 1`)
  }
  await sleep(800)
  const mem = await ev(`return await window.__qaEditor.memStats()`)
  const fsx = await ev(`return window.__qaEditor.filmstrips()`)
  console.log(`  memória do compositor: ${JSON.stringify(mem)}; filmstrips: ${JSON.stringify(fsx)}`)
  check('compositor: texturas ≤ 512 MiB depois de percorrer', !!mem && mem.textureCount >= 1 && mem.textureBytes <= 512 * 2 ** 20, mem)
  check('filmstrips ≤ 200 MiB', !!fsx && fsx.bytes <= 200 * 2 ** 20, fsx)
  await shot('relink-pronto-memoria')
  await ev(`window.__navigate('projects'); return 1`)
  await sleep(1500)
}

try {
  await main()
} catch (e) {
  failures++
  console.error('falhou:', e)
} finally {
  // área de transferência do usuário de volta
  if (ws && clipboardBefore != null) {
    try {
      await ev(`window.focus(); await navigator.clipboard.writeText(${JSON.stringify(clipboardBefore)}); return 1`)
    } catch {
      // ignorar
    }
  }
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
  await sleep(800)
  // o logo volta para a pasta do fixture (que é recriada a cada QA) e o resto criado aqui some
  try {
    if (logoMoved && logoOriginal && existsSync(logoMoved) && !existsSync(logoOriginal)) renameSync(logoMoved, logoOriginal)
  } catch {
    // ignorar
  }
  rmSync(MOVED_DIR, { recursive: true, force: true })
  // QA_KEEP=1: mantém as saídas para inspeção
  if (!process.env.QA_KEEP) rmSync(BASE, { recursive: true, force: true })
  const now = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null
  if (hash(now) !== hash(settingsBefore)) {
    if (settingsBefore) writeFileSync(SETTINGS, settingsBefore)
    else if (now) rmSync(SETTINGS)
    console.log(`settings.json restaurado (sha256 ${hash(now)} → ${hash(settingsBefore)})`)
  } else console.log(`settings.json intocado (sha256 ${hash(settingsBefore)})`)
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo OK')
  process.exit(failures ? 1 : 0)
}
