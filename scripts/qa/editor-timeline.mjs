// QA da linha do tempo do editor (Task 11) via CDP, com eventos de ponteiro/teclado sintéticos
// despachados nos elementos (nunca entrada do sistema operacional).
//
// uso (depois de `npm run build`):
//   node scripts/qa/editor-timeline.mjs            → abre o app (CIALIGHT_QA=editor-fixture,
//                                                    CIALIGHT_RAW_DIR=test-out/raw), testa e fecha
//   node scripts/qa/editor-timeline.mjs --attach   → usa um app já aberto com --remote-debugging-port=9333
//   node scripts/qa/editor-timeline.mjs --expanded → no teste de desempenho, 10 itens vizinhos expandidos (2 linhas de keyframes cada)
//
// Confere o estado do store após dividir, mover (com vinculados / Alt / outra faixa / faixa nova),
// ímã com linha guia, trim (normal e ripple com Ctrl), excluir com ripple (menu de contexto),
// Esc cancelando o gesto, faixa bloqueada, seleção por caixa, régua, zoom na roda e desfazer;
// mede o custo por evento de arraste com 200 itens; salva screenshots em docs/qa/editor-f1/.
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const ATTACH = process.argv.includes('--attach')
const EXPANDED = process.argv.includes('--expanded')
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f1')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const S = 1_000_000

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
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__tl; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
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

// helpers da página: eventos de ponteiro/teclado despachados nos elementos e leitura do store
const HELPERS = `
window.__tl = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const item = (id) => el('[data-item-id="' + id + '"]')
  const edge = (id, side) => el('[data-item-id="' + id + '"] [data-edge="' + side + '"]')
  const pt = (e, fx = 0.5, fy = 0.5) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy } }
  const pe = (type, x, y, mods) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...(mods || {}) })
  const down = (target, x, y, mods) => target.dispatchEvent(pe('pointerdown', x, y, mods))
  const move = (x, y, mods) => window.dispatchEvent(pe('pointermove', x, y, mods))
  const up = (x, y, mods) => window.dispatchEvent(pe('pointerup', x, y, mods))
  async function drag(target, from, to, opts = {}) {
    const steps = opts.steps ?? 8
    down(target, from.x, from.y, opts.mods)
    for (let i = 1; i <= steps; i++) move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, opts.mods)
    await settle()
    if (opts.release !== false) { up(to.x, to.y, opts.mods); await settle() }
  }
  const key = async (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const tracks = () => st().project.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind, locked: t.locked, items: t.items.map((i) => ({ id: i.id, s: i.startUs, d: i.durationUs, link: i.linkId ?? null, asset: i.assetId ?? null })) }))
  const find = (id) => { for (const t of tracks()) { const i = t.items.find((x) => x.id === id); if (i) return { ...i, track: t.name, trackId: t.id } } return null }
  const byAsset = (assetId) => tracks().flatMap((t) => t.items.filter((i) => i.asset === assetId).map((i) => ({ ...i, track: t.name, kind: t.kind })))
  const past = () => st().history.past.length
  const xOf = (us) => { const r = el('[data-timeline-ruler]').getBoundingClientRect(); const s = st(); return r.left + ((us - s.scrollUs) * s.zoomPxPerSec) / 1e6 }
  const rowOf = (trackId) => el('[data-track-id="' + trackId + '"]')
  return { st, settle, el, item, edge, pt, down, move, up, drag, key, tracks, find, byAsset, past, xOf, rowOf }
})()
'ok'`

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 768)
  // linha do tempo mais alta (preferência local da página, não toca settings.json)
  await ev(`localStorage.setItem('editor.timelineHeight', '330'); window.__navigate('projects'); return 1`)
  await sleep(500)
  await ev(`window.__navigate('editor:p-qa-editor-fixture'); return 1`)
  // espera o projeto e a ingestão (filmstrip/peaks) da fixture
  for (let i = 0; i < 120; i++) {
    const ok = await ev(`const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.assets.every((a) => a.status === 'ready') && !!s.project.assets.find((a) => a.id === 'a_qa_video')?.filmstrip`)
    if (ok) break
    await sleep(1000)
  }
  await ev(HELPERS + '; return 1')
  await ev(`const s = T.st(); s.setZoom(100); s.setScroll(0); s.select([]); window.__qaEditor.controller.seek(0); await T.settle(); return 1`)
  await sleep(800)
  await shot('timeline-1366x768.png')
  const initial = await ev(`return T.tracks()`)
  const ids = await ev(`const v = T.byAsset('a_qa_video'); return { v: v.find((i) => i.kind === 'video').id, a: v.find((i) => i.kind === 'audio').id, logo: T.byAsset('a_qa_logo')[0].id, music: T.byAsset('a_qa_music')[0].id }`)

  console.log('régua')
  {
    const r = await ev(`const ruler = T.el('[data-timeline-ruler]'); const y = T.pt(ruler).y
      T.down(ruler, T.xOf(2.5e6), y); T.up(T.xOf(2.5e6), y); await T.settle(); const a = T.st().playheadUs
      T.down(ruler, T.xOf(3.95e6), y); T.up(T.xOf(3.95e6), y); await T.settle(); return { a, b: T.st().playheadUs }`)
    check('clique na régua move o playhead (2,5 s)', Math.abs(r.a - 2.5 * S) <= 10_000, r)
    check('ímã da régua encaixa no marcador (3,95 s → 4 s)', r.b === 4 * S, r)
  }

  console.log('dividir')
  {
    const r = await ev(`window.__qaEditor.controller.seek(3e6); T.st().select(['${ids.v}']); await T.settle(); const p0 = T.past()
      T.el('[aria-label="Dividir no playhead"]').click(); await T.settle()
      return { dp: T.past() - p0, v: T.byAsset('a_qa_video') }`)
    const vv = r.v.filter((i) => i.kind === 'video').sort((a, b) => a.s - b.s)
    const aa = r.v.filter((i) => i.kind === 'audio').sort((a, b) => a.s - b.s)
    check('vídeo dividido em 0–3 s e 3–12 s', vv.length === 2 && vv[0].d === 3 * S && vv[1].s === 3 * S && vv[1].d === 9 * S, vv)
    check('áudio vinculado dividido junto', aa.length === 2 && aa[1].s === 3 * S, aa)
    check('pedaços da direita vinculados entre si (vínculo novo)', vv[1].link && vv[1].link === aa[1].link && vv[1].link !== vv[0].link, { vv, aa })
    check('um passo de desfazer', r.dp === 1, r.dp)
    ids.v2 = vv[1].id
    ids.a2 = aa[1].id
  }

  console.log('mover (com vinculado)')
  {
    const r = await ev(`const p0 = T.past(); const e = T.item('${ids.v2}'); const a = T.pt(e, 0.3)
      await T.drag(e, a, { x: a.x + 150, y: a.y }); return { dp: T.past() - p0, v: T.find('${ids.v2}'), a: T.find('${ids.a2}'), tx: !!T.st().txBase }`)
    check('vídeo movido +1,5 s', r.v.s === 4.5 * S, r.v)
    check('áudio vinculado acompanhou', r.a.s === 4.5 * S, r.a)
    check('um passo de desfazer, transação fechada', r.dp === 1 && !r.tx, r)
  }

  console.log('ímã com linha guia')
  {
    const mid = await ev(`const e = T.item('${ids.v2}'); const a = T.pt(e, 0.3)
      await T.drag(e, a, { x: a.x - 53, y: a.y }, { release: false })
      const g = document.querySelector('[data-snap-guide]'); window.__tlLast = { x: a.x - 53, y: a.y }
      return { guide: g ? g.getBoundingClientRect().left : null, want: T.xOf(4e6), s: T.find('${ids.v2}').s }`)
    await shot('timeline-snap.png')
    const r = await ev(`const p0 = T.past(); T.up(window.__tlLast.x, window.__tlLast.y); await T.settle(); return { s: T.find('${ids.v2}').s, a: T.find('${ids.a2}').s, guide: !!document.querySelector('[data-snap-guide]'), dp: T.past() - p0 }`)
    check('linha guia no ponto de encaixe (marcador 4 s)', mid.guide !== null && Math.abs(mid.guide - mid.want) <= 1.5, mid)
    check('soltou encaixado em 4 s (vídeo e vinculado)', r.s === 4 * S && r.a === 4 * S, r)
    check('guia some ao soltar', !r.guide, r)
  }

  console.log('Alt ignora o vínculo + desfazer')
  {
    const r = await ev(`const p0 = T.past(); const e = T.item('${ids.v2}'); const a = T.pt(e, 0.3)
      await T.drag(e, a, { x: a.x + 100, y: a.y }, { mods: { altKey: true } })
      const after = { v: T.find('${ids.v2}').s, a: T.find('${ids.a2}').s, dp: T.past() - p0 }
      await T.key('z', { ctrlKey: true })
      return { after, undone: { v: T.find('${ids.v2}').s, a: T.find('${ids.a2}').s, dp: T.past() - p0 } }`)
    check('Alt: só o vídeo moveu', r.after.v === 5 * S && r.after.a === 4 * S && r.after.dp === 1, r.after)
    check('Ctrl+Z desfaz o arraste inteiro', r.undone.v === 4 * S && r.undone.a === 4 * S && r.undone.dp === 0, r.undone)
  }

  console.log('patch de ingestão no meio do arraste')
  {
    const r = await ev(`const p0 = T.past(); const e = T.item('${ids.v2}'); const a = T.pt(e, 0.3)
      await T.drag(e, a, { x: a.x + 100, y: a.y }, { release: false })
      T.st().applyAssetPatch('a_qa_music', { name: 'Trilha (patch no meio do arraste)' })
      T.move(a.x + 150, a.y); await T.settle(); T.up(a.x + 150, a.y); await T.settle()
      const out = { v: T.find('${ids.v2}').s, name: T.st().project.assets.find((x) => x.id === 'a_qa_music').name, dp: T.past() - p0, tx: !!T.st().txBase }
      await T.key('z', { ctrlKey: true })
      out.afterUndo = { v: T.find('${ids.v2}').s, name: T.st().project.assets.find((x) => x.id === 'a_qa_music').name }
      return out`)
    check('arraste concluído (+1,5 s) com 1 passo', r.v === 5.5 * S && r.dp === 1 && !r.tx, r)
    check('patch do asset sobreviveu ao commit e ao desfazer', r.name === 'Trilha (patch no meio do arraste)' && r.afterUndo.name === r.name && r.afterUndo.v === 4 * S, r)
  }

  console.log('teclado no meio do arraste')
  {
    const r = await ev(`const p0 = T.past(); const e = T.item('${ids.v2}'); const a = T.pt(e, 0.3)
      await T.drag(e, a, { x: a.x + 100, y: a.y }, { release: false })
      await T.key('z', { ctrlKey: true }); await T.key('Delete'); await T.key('s')
      const mid = { tx: !!T.st().txBase, v: T.find('${ids.v2}')?.s ?? null, dp: T.past() - p0 }
      T.up(a.x + 100, a.y); await T.settle()
      const out = { mid, v: T.find('${ids.v2}').s, a: T.find('${ids.a2}').s, dp: T.past() - p0, pieces: T.byAsset('a_qa_video').length }
      await T.key('z', { ctrlKey: true }); return out`)
    check('Ctrl+Z/Delete/S engolidos no meio do arraste (transação intacta, sem histórico)', r.mid.tx && r.mid.v === 5 * S && r.mid.dp === 0, r.mid)
    check('ao soltar: um único estado coerente (1 passo, vinculado junto, nada apagado/dividido)', r.dp === 1 && r.v === 5 * S && r.a === 5 * S && r.pieces === 4, r)
  }

  console.log('perder o foco cancela o gesto')
  {
    const r = await ev(`const before = JSON.stringify(T.tracks()); const p0 = T.past(); const e = T.item('${ids.v2}'); const a = T.pt(e, 0.3)
      await T.drag(e, a, { x: a.x + 120, y: a.y }, { release: false }); window.dispatchEvent(new Event('blur')); await T.settle()
      T.move(a.x + 300, a.y); T.up(a.x + 300, a.y); await T.settle()
      return { same: JSON.stringify(T.tracks()) === before, dp: T.past() - p0, tx: !!T.st().txBase }`)
    check('blur: estado igual, sem histórico, sem transação', r.same && r.dp === 0 && !r.tx, r)
  }

  console.log('rolagem automática na borda')
  {
    const r = await ev(`const p0 = T.past(); const e = T.item('${ids.v2}'); const a = T.pt(e, 0.05); const lanes = T.el('[data-timeline-lanes]').getBoundingClientRect()
      const tx = lanes.right - 6; const dx = tx - a.x
      await T.drag(e, a, { x: tx, y: a.y }, { release: false }); const s0 = T.st().scrollUs
      await new Promise((r) => setTimeout(r, 500)); const s1 = T.st().scrollUs; const v = T.find('${ids.v2}').s
      T.up(tx, a.y); await T.settle(); const out = { s0, s1, v, noScroll: 4e6 + Math.round(dx * 1e4), dp: T.past() - p0, committed: T.find('${ids.v2}').s }
      await T.key('z', { ctrlKey: true }); T.st().setScroll(0); await T.settle(); return out`)
    check('perto da borda direita a vista rola sozinha', r.s1 > r.s0 + 500_000, r)
    check('o item acompanha a rolagem (delta recalculado pelo scroll) e solta em 1 passo', r.v > r.noScroll + 400_000 && r.committed === r.v && r.dp === 1, r)
  }

  console.log('fades nos cantos')
  {
    const mid = await ev(`const e = T.el('[data-item-id="${ids.v}"] [data-fade="in"]'); const a = T.pt(e)
      await T.drag(e, a, { x: a.x + 50, y: a.y }, { release: false }); window.__tlLast = { x: a.x + 50, y: a.y }
      return { label: document.querySelector('[data-drag-label]')?.textContent ?? null }`)
    await shot('timeline-fade.png')
    const r = await ev(`const p0 = T.past(); T.up(window.__tlLast.x, window.__tlLast.y); await T.settle()
      const it = () => T.st().project.tracks.flatMap((t) => t.items)
      const v = it().find((i) => i.id === '${ids.v}'); const out = { fin: v.visual.fadeInUs, dp: T.past() - p0 }
      const e = T.el('[data-item-id="${ids.music}"] [data-fade="out"]'); const a = T.pt(e)
      await T.drag(e, a, { x: a.x - 3000, y: a.y }); const m = it().find((i) => i.id === '${ids.music}')
      out.mout = m.audio.fadeOutUs; out.min = m.audio.fadeInUs; out.mdur = m.durationUs; out.dp2 = T.past() - p0; return out`)
    check('dica com a duração durante o arraste', mid.label === 'Fade de entrada: 0,50 s', mid)
    check('fade de entrada do vídeo (visual) = 0,5 s em 1 passo', r.fin === 500_000 && r.dp === 1, r)
    check('fade de saída do áudio limitado à duração do item', r.mout === r.mdur - r.min && r.dp2 === 2, r)
    await ev(`await T.key('z', { ctrlKey: true }); await T.key('z', { ctrlKey: true }); return 1`)
  }

  console.log('trim')
  {
    const r = await ev(`const p0 = T.past(); const e = T.edge('${ids.music}', 'end'); const a = T.pt(e)
      await T.drag(e, a, { x: a.x - 100, y: a.y }); return { m: T.find('${ids.music}'), dp: T.past() - p0 }`)
    check('trim do fim da trilha: 2–11 s → 2–10 s', r.m.s === 2 * S && r.m.d === 8 * S, r.m)
    check('um passo de desfazer', r.dp === 1, r.dp)
  }

  console.log('trim ripple (Ctrl)')
  {
    const r = await ev(`const p0 = T.past(); const e = T.edge('${ids.v}', 'end'); const a = T.pt(e)
      await T.drag(e, a, { x: a.x - 50, y: a.y }, { mods: { ctrlKey: true } })
      return { v: T.find('${ids.v}'), a: T.find('${ids.a}'), v2: T.find('${ids.v2}'), a2: T.find('${ids.a2}'), logo: T.find('${ids.logo}'), music: T.find('${ids.music}'), dp: T.past() - p0 }`)
    check('item encurtado para 2,5 s (e o vinculado)', r.v.d === 2.5 * S && r.a.d === 2.5 * S, r)
    check('posteriores da mesma faixa puxados −0,5 s', r.v2.s === 3.5 * S && r.a2.s === 3.5 * S, r)
    check('faixas com conteúdo no trecho ficam paradas (sem dessincronia)', r.logo.s === 1 * S && r.music.s === 2 * S, r)
    check('um passo de desfazer', r.dp === 1, r.dp)
  }

  console.log('mover para faixa nova / outra faixa')
  {
    const mid = await ev(`const e = T.item('${ids.logo}'); const a = T.pt(e); const top = T.el('[data-timeline-lanes]').getBoundingClientRect().top
      await T.drag(e, a, { x: a.x, y: top + 6 }, { release: false }); window.__tlLast = { x: a.x, y: top + 6 }
      return { ghost: !!document.querySelector('[data-timeline-lanes] .border-dashed'), videos: T.tracks().filter((t) => t.kind === 'video').length }`)
    await shot('timeline-new-track.png')
    const r = await ev(`const p0 = T.past(); T.up(window.__tlLast.x, window.__tlLast.y); await T.settle()
      const t = T.tracks(); const videos = t.filter((x) => x.kind === 'video'); return { videos: videos.map((x) => x.name), top: videos[videos.length - 1].id, logo: T.find('${ids.logo}'), dp: T.past() - p0 }`)
    check('sombra "Nova faixa" durante o arraste, sem criar faixa ainda', mid.ghost && mid.videos === 2, mid)
    check('ao soltar: faixa de vídeo nova no topo com o item', r.videos.length === 3 && r.logo.trackId === r.top && r.logo.s === 1 * S, r)
    check('um passo de desfazer', r.dp === 1, r.dp)
    const r2 = await ev(`const p0 = T.past(); const v2 = T.tracks().find((t) => t.name === 'Vídeo 2'); const e = T.item('${ids.logo}'); const a = T.pt(e); const b = T.pt(T.rowOf(v2.id))
      await T.drag(e, a, { x: a.x, y: b.y }); return { logo: T.find('${ids.logo}'), dp: T.past() - p0 }`)
    check('arrastar para outra faixa de vídeo muda a faixa', r2.logo.track === 'Vídeo 2' && r2.logo.s === 1 * S && r2.dp === 1, r2)
  }

  console.log('Esc cancela o gesto')
  {
    const r = await ev(`const before = JSON.stringify(T.tracks()); const p0 = T.past(); const e = T.item('${ids.logo}'); const a = T.pt(e)
      await T.drag(e, a, { x: a.x + 200, y: a.y }, { release: false }); const moved = T.find('${ids.logo}').s
      await T.key('Escape'); T.move(a.x + 260, a.y); T.up(a.x + 260, a.y); await T.settle()
      return { moved, same: JSON.stringify(T.tracks()) === before, dp: T.past() - p0, tx: !!T.st().txBase, sel: T.st().selection }`)
    check('durante o arraste o item se moveu', r.moved === 3 * S, r)
    check('Esc: estado igual ao de antes, sem histórico, sem transação', r.same && r.dp === 0 && !r.tx, r)
    check('Esc do gesto não limpou a seleção', r.sel.includes(ids.logo), r.sel)
  }

  console.log('faixa bloqueada')
  {
    const r = await ev(`const v2 = T.tracks().find((t) => t.name === 'Vídeo 2'); T.el('[data-track-header="' + v2.id + '"] [aria-label="Bloquear faixa"]').click(); await T.settle()
      const p0 = T.past(); const e = T.item('${ids.logo}'); const a = T.pt(e)
      await T.drag(e, a, { x: a.x + 100, y: a.y }, { release: false }); window.__tlLast = { x: a.x + 100, y: a.y }
      return { ghost: !!document.querySelector('[data-timeline-lanes] .border-danger'), s: T.find('${ids.logo}').s, locked: T.tracks().find((t) => t.id === v2.id).locked, p0, handles: e.querySelectorAll('[data-edge],[data-fade]').length }`)
    await shot('timeline-locked.png')
    const r2 = await ev(`T.up(window.__tlLast.x, window.__tlLast.y); await T.settle(); const out = { s: T.find('${ids.logo}').s, dp: T.past() - ${r.p0} }
      const v2 = T.tracks().find((t) => t.name === 'Vídeo 2'); T.el('[data-track-header="' + v2.id + '"] [aria-label="Desbloquear faixa"]').click(); await T.settle(); return out`)
    check('sombra vermelha na faixa bloqueada, item parado', r.locked && r.ghost && r.s === 1 * S, r)
    check('item de faixa bloqueada sem alças de trim/fade', r.handles === 0, r.handles)
    check('soltar não muda nada (sem passo de desfazer)', r2.s === 1 * S && r2.dp === 0, r2)
  }

  console.log('seleção por caixa')
  {
    const r = await ev(`T.st().select([]); const v3 = T.tracks().filter((t) => t.kind === 'video').at(-1); const a1 = T.tracks().find((t) => t.name === 'Áudio 1')
      const top = T.rowOf(v3.id).getBoundingClientRect(); const bottom = T.rowOf(a1.id).getBoundingClientRect()
      const from = { x: T.xOf(0.5e6), y: top.top + 10 }; const to = { x: T.xOf(6.5e6), y: bottom.top + 20 }
      await T.drag(T.rowOf(v3.id), from, to); return T.st().selection`)
    const want = [ids.logo, ids.v, ids.v2, ids.a, ids.a2].sort()
    check('caixa seleciona os itens cruzados', JSON.stringify([...r].sort()) === JSON.stringify(want), { got: r, want })
  }

  console.log('zoom com Ctrl+roda ancorado no mouse')
  {
    const r = await ev(`const lanes = T.el('[data-timeline-lanes]'); const x = T.xOf(4e6); const y = lanes.getBoundingClientRect().top + 30; const z0 = T.st().zoomPxPerSec
      lanes.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: -200, ctrlKey: true })); await T.settle()
      return { z0, z1: T.st().zoomPxPerSec, x, x1: T.xOf(4e6) }`)
    check('Ctrl+roda aumenta o zoom', r.z1 > r.z0 * 1.2, r)
    check('o instante sob o mouse fica parado (±1 px)', Math.abs(r.x1 - r.x) <= 1, r)
    await ev(`T.st().setZoom(100); T.st().setScroll(0); await T.settle(); return 1`)
  }

  console.log('roda, cabeçalhos, soltar mídia, J/K/L')
  {
    const w = await ev(`const lanes = T.el('[data-timeline-lanes]'); const r = lanes.getBoundingClientRect(); const s0 = T.st().scrollUs
      lanes.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + 400, clientY: r.top + 40, deltaY: 120 })); await T.settle()
      const s1 = T.st().scrollUs; T.st().setScroll(0); await T.settle(); return { s0, s1, z: T.st().zoomPxPerSec }`)
    check('roda rola na horizontal (120 px)', Math.abs(w.s1 - w.s0 - (120 * 1e6) / w.z) <= 1, w)
    const rn = await ev(`const v1 = T.tracks().find((t) => t.name === 'Vídeo 1'); const h = T.el('[data-track-header="' + v1.id + '"]')
      const name = [...h.querySelectorAll('span')].find((x) => x.textContent === 'Vídeo 1'); name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await T.settle()
      const input = h.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Tela principal'); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); await T.settle()
      return T.tracks().find((t) => t.id === v1.id).name`)
    check('duplo clique renomeia a faixa', rn === 'Tela principal', rn)
    // F3: a trilha importada fica na faixa "Música" (papel música), abaixo do som do vídeo ("Áudio 1")
    const mv = await ev(`const a2 = T.tracks().find((t) => t.name === 'Música'); const trig = T.el('[data-track-header="' + a2.id + '"] [aria-label="Opções da faixa"]')
      trig.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })); await T.settle(); await new Promise((r) => setTimeout(r, 200))
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes('Mover para cima')); item.click(); await T.settle(); await new Promise((r) => setTimeout(r, 200))
      return T.tracks().filter((t) => t.kind === 'audio').map((t) => t.name)`)
    check('menu da faixa: mover para cima', JSON.stringify(mv) === JSON.stringify(['Música', 'Áudio 1']), mv)
    const dr = await ev(`const v2 = T.tracks().find((t) => t.name === 'Vídeo 2'); const row = T.rowOf(v2.id).getBoundingClientRect(); const dt = new DataTransfer(); dt.setData('application/x-cialight-asset', 'a_qa_logo')
      const n0 = T.byAsset('a_qa_logo').length; const lanes = T.el('[data-timeline-lanes]')
      lanes.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: T.xOf(8e6), clientY: row.top + 20, dataTransfer: dt })); await T.settle()
      const added = T.byAsset('a_qa_logo').filter((i) => i.s === 8e6); return { n0, n1: T.byAsset('a_qa_logo').length, added, v2: v2.id }`)
    check('soltar mídia da biblioteca: no instante e na faixa sob o ponteiro', dr.n1 === dr.n0 + 1 && dr.added.length === 1 && dr.added[0].track === 'Vídeo 2', dr)
    const wk = await ev(`const v2 = T.tracks().find((t) => t.name === 'Vídeo 2'); const row = T.rowOf(v2.id).getBoundingClientRect(); const lanes = T.el('[data-timeline-lanes]'); const top = lanes.getBoundingClientRect().top
      const drop = (y) => { const dt = new DataTransfer(); dt.setData('application/x-cialight-asset', 'a_qa_music'); lanes.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: T.xOf(9e6), clientY: y, dataTransfer: dt })) }
      const nv = () => T.tracks().filter((t) => t.kind === 'video').length; const v0 = nv()
      drop(row.top + 20); await T.settle(); drop(top + 6); await T.settle()
      return { v0, v1: nv(), music: T.byAsset('a_qa_music').filter((i) => i.s === 9e6).map((i) => i.kind) }`)
    check('áudio solto em faixa/área de vídeo vai para o áudio, sem criar faixa de vídeo vazia', wk.v1 === wk.v0 && wk.music.length === 2 && wk.music.every((k) => k === 'audio'), wk)
    // J/K/L clássico da F3 (o shuttle detalhado está em editor-f3-speed.mjs): L toca e acelera, J toca para trás, K pausa
    const jkl = await ev(`const c = window.__qaEditor.controller; c.seek(8e6); await T.settle()
      const tap = async (k) => { for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true })); await T.settle() }
      await tap('l'); await new Promise((r) => setTimeout(r, 500)); const l1 = { playing: T.st().playing, rate: T.st().playRate }; const t0 = T.st().playheadUs
      await tap('l'); await new Promise((r) => setTimeout(r, 300)); const l2 = { playing: T.st().playing, rate: T.st().playRate, moved: T.st().playheadUs > t0 }
      await tap('k'); await new Promise((r) => setTimeout(r, 200)); const k1 = { playing: T.st().playing, rate: T.st().playRate }
      await tap('j'); await new Promise((r) => setTimeout(r, 300)); const t1 = T.st().playheadUs; await new Promise((r) => setTimeout(r, 300)); const j1 = { playing: T.st().playing, rate: T.st().playRate, back: T.st().playheadUs < t1 }
      await tap('k'); await new Promise((r) => setTimeout(r, 200))
      return { l1, l2, k1, j1, paused: !T.st().playing }`)
    check('L toca a 1×; L de novo acelera a 2× sem parar; K pausa e volta a 1×', jkl.l1.playing && jkl.l1.rate === 1 && jkl.l2.playing && jkl.l2.rate === 2 && jkl.l2.moved && !jkl.k1.playing && jkl.k1.rate === 1, jkl)
    check('J toca para trás (−1×); K pausa', jkl.j1.playing && jkl.j1.rate === -1 && jkl.j1.back && jkl.paused, jkl)
  }

  console.log('desfazer tudo')
  {
    const r = await ev(`let n = 0; while (T.st().canUndo && n < 50) { await T.key('z', { ctrlKey: true }); n++ } return { n, tracks: T.tracks() }`)
    check('Ctrl+Z até o início volta ao projeto original', JSON.stringify(r.tracks) === JSON.stringify(initial), { n: r.n })
  }

  console.log('excluir com ripple (menu de contexto)')
  {
    await ev(`T.st().select(['${ids.logo}']); await T.key('Delete'); T.st().select(['${ids.music}']); await T.key('Delete')
      T.st().select([]); window.__qaEditor.controller.seek(3e6); await T.settle(); await T.key('s'); window.__qaEditor.controller.seek(6e6); await T.settle(); await T.key('s'); return 1`)
    const mid = await ev(`const v = T.byAsset('a_qa_video').filter((i) => i.kind === 'video').sort((a, b) => a.s - b.s); return v.map((i) => [i.id, i.s, i.d])`)
    check('preparo: vídeo em 3 pedaços (0–3, 3–6, 6–12)', mid.length === 3 && mid[1][1] === 3 * S && mid[2][1] === 6 * S, mid)
    const midId = mid[1][0]
    const r0 = await ev(`const e = T.item('${midId}'); const a = T.pt(e); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: a.x, clientY: a.y, button: 2 })); await T.settle(); await new Promise((r) => setTimeout(r, 300))
      return { menu: !!document.querySelector('[data-timeline-menu]'), items: [...document.querySelectorAll('[data-timeline-menu] [role="menuitem"]')].map((x) => x.textContent) }`)
    await shot('timeline-context-menu.png')
    check('menu de contexto com as ações', r0.menu && ['Dividir', 'Duplicar', 'Velocidade', 'Excluir com ripple'].every((w) => r0.items.some((t) => t.includes(w))), r0)
    const r = await ev(`const p0 = T.past(); const it = [...document.querySelectorAll('[data-timeline-menu] [role="menuitem"]')].find((x) => x.textContent.includes('Excluir com ripple')); it.click(); await T.settle(); await new Promise((r) => setTimeout(r, 200))
      const all = T.byAsset('a_qa_video'); return { dp: T.past() - p0, v: all.filter((i) => i.kind === 'video').sort((a, b) => a.s - b.s).map((i) => [i.s, i.d]), a: all.filter((i) => i.kind === 'audio').sort((a, b) => a.s - b.s).map((i) => [i.s, i.d]) }`)
    check('ripple: trecho do meio sumiu e o resto encostou (vídeo e áudio)', JSON.stringify(r.v) === JSON.stringify([[0, 3 * S], [3 * S, 6 * S]]) && JSON.stringify(r.a) === JSON.stringify(r.v), r)
    check('um passo de desfazer', r.dp === 1, r.dp)
    const u = await ev(`await T.key('z', { ctrlKey: true }); return T.byAsset('a_qa_video').filter((i) => i.kind === 'video').length`)
    check('Ctrl+Z traz o pedaço de volta', u === 3, u)
  }

  console.log('desempenho com 200 itens')
  {
    const r = await ev(`const s = T.st(); const src = s.project.tracks.flatMap((t) => t.items).find((i) => i.assetId === 'a_qa_video' && i.visual)
      s.apply((p) => {
        const anim = (a, b) => ({ value: a, keys: [{ tUs: 50000, value: a, ease: 'inOut' }, { tUs: 350000, value: b, ease: 'linear' }] })
        const kf = (v) => (${EXPANDED} ? { ...v, transform: { ...v.transform, x: anim(0.3, 0.7), opacity: anim(1, 0.2) } } : v)
        const mk = (ti, k) => ({ ...src, id: 'i_perf_' + ti + '_' + k, linkId: undefined, startUs: k * 400000, durationUs: 400000, inUs: (k % 25) * 400000, visual: kf(src.visual) })
        const tracks = [0, 1, 2, 3].map((ti) => ({ id: 't_perf_' + ti, kind: 'video', name: 'Carga ' + (ti + 1), muted: false, hidden: false, locked: false, volume: 1, items: Array.from({ length: 50 }, (_, k) => mk(ti, k)) }))
        return { ...p, tracks: [...tracks, ...p.tracks.filter((t) => t.kind === 'audio')] }
      })
      await T.key('Z', { shiftKey: true }); await T.settle()
      if (${EXPANDED}) for (const ti of [0, 2]) for (let k = 21; k <= 25; k++) window.__qaEditor.expanded.getState().toggle('i_perf_' + ti + '_' + k)
      await T.settle()
      const nLanes = document.querySelectorAll('[data-lanes-item]').length
      const n = document.querySelectorAll('[data-item-id]').length
      const e = T.item('i_perf_1_25'); const a = T.pt(e); const lanes = T.el('[data-timeline-lanes]')
      T.down(e, a.x, a.y); T.move(a.x + 4, a.y); await T.settle()
      const times = []
      for (let i = 1; i <= 60; i++) {
        const t0 = performance.now()
        T.move(a.x + 4 + i * 3, a.y)
        await Promise.resolve()
        lanes.getBoundingClientRect(); document.body.offsetHeight
        times.push(performance.now() - t0)
      }
      await T.settle()
      return { n, lanes: nLanes, times }`)
    await shot('timeline-200-items.png')
    await ev(`await T.key('Escape'); T.up(0, 0); await T.settle(); await T.key('z', { ctrlKey: true }); window.__qaEditor.expanded.getState().clear(); return 1`)
    const t = [...r.times].sort((a, b) => a - b)
    const avg = t.reduce((a, b) => a + b, 0) / t.length
    const p95 = t[Math.floor(t.length * 0.95)]
    if (EXPANDED) console.log(`  itens expandidos com linhas visíveis: ${r.lanes}`)
    console.log(`  itens renderizados: ${r.n}; por evento de arraste: média ${avg.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, máx ${t[t.length - 1].toFixed(2)} ms`)
    check('200 itens renderizados', r.n >= 200, r.n)
    check('média < 8 ms por evento de arraste', avg < 8, { avg, p95 })
  }

  console.log('forma de onda e marcador sobre o playhead')
  await ev(`const s = T.st(); s.select([]); s.setZoom(160); s.setScroll(0); window.__qaEditor.controller.seek(4e6); await T.settle(); return 1`)
  await sleep(1200)
  await shot('timeline-waveform.png')
  {
    const r = await ev(`const m = T.el('[data-marker-id]'); const ph = T.el('[data-playhead]'); return { m: getComputedStyle(m).zIndex, p: getComputedStyle(ph).zIndex }`)
    check('marcador desenhado acima do playhead', Number(r.m) > Number(r.p), r)
  }

  console.log('screenshots finais')
  await ev(`const s = T.st(); s.select(['${ids.v}']); window.__qaEditor.controller.seek(4.2e6); await T.key('Z', { shiftKey: true }); return 1`)
  await sleep(600)
  await shot('timeline-1366x768-final.png')
  await viewport(1920, 1080)
  await sleep(600)
  await ev(`await T.key('Z', { shiftKey: true }); return 1`)
  await sleep(600)
  await shot('timeline-1920x1080.png')
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
