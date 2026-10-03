// QA dos Modelos de marca (F5 Task 7) via CDP, com eventos sintéticos despachados nos elementos reais (cliques em
// botões/diálogos da aba Modelos) — nunca entrada do sistema operacional. Os pixels do quadro vêm do render worker
// (readPixels), a mesma imagem do preview.
//
// uso (depois de `npm run build`; SEMPRE sob o lock das execuções do Electron):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs node scripts/qa/editor-f5-brand.mjs
//
// Confere: (1) aba Modelos em pt-BR, vazia, "Salvar seleção como modelo…" desligado sem seleção; (2) título (atalho T)
// + logo (imagem sintética do projeto de teste) salvos como modelo "Abertura" pelo diálogo (nome + tipo): toast, lista,
// arquivo copiado para a pasta de TESTE dos modelos; (3) só o logo salvo como "Marca d'água"; (4) noutro projeto (cópia
// do de teste, sem o título): "Usar como abertura" desloca tudo (itens, marcadores) pela duração do modelo em UM passo,
// o logo foi copiado para generated/ do projeto, o título e o logo aparecem no quadro em 2 s e o conteúdo original
// aparece igual (pixels) deslocado; (5) excluir o modelo (confirmação) não quebra o projeto (o logo continua no quadro);
// (6) faixa bloqueada → "Usar como abertura" recusa com toast e não muda nada; (7) "Aplicar como marca d'água": faixa
// "Marca d'água" no topo de 0 ao fim do conteúdo, logo no quadro no início e no fim; (8) renomear; (9) arquivo de
// modelos corrompido → renomeado e aviso. Compara o sha256 do settings.json antes/depois e confere que
// %APPDATA%\cialight-gravador\brand-templates.json (e brand-assets) do usuário NÃO foram criados nem alterados.
// Screenshots em docs/qa/editor-f5/ (só mídia sintética).
import { spawn, execFileSync } from 'child_process'
import { guardSettings, sha } from './settingsGuard.mjs'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9333'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-f5')
const APPDATA_DIR = join(process.env.APPDATA ?? '', 'cialight-gravador')
const SETTINGS = join(APPDATA_DIR, 'settings.json')
const REAL_BRAND = join(APPDATA_DIR, 'brand-templates.json')
const REAL_BRAND_ASSETS = join(APPDATA_DIR, 'brand-assets')
const BRAND_DIR = join(ROOT, 'test-out', 'brand-qa')
const PROJECTS = join(ROOT, 'test-out', 'Projetos')
const PROJECT_B = 'p-qa-brand-b'

mkdirSync(SHOTS, { recursive: true })
const settings = guardSettings(SETTINGS)
/** Estado dos modelos reais do usuário (não podem ser criados nem alterados pelo teste). */
const realBrandState = () => ({
  file: existsSync(REAL_BRAND) ? sha(readFileSync(REAL_BRAND)) : 'ausente',
  assets: existsSync(REAL_BRAND_ASSETS) ? readdirSync(REAL_BRAND_ASSETS).sort().join(',') + `@${statSync(REAL_BRAND_ASSETS).mtimeMs}` : 'ausente'
})
const realBefore = realBrandState()
console.log(`modelos reais do usuário antes: ${JSON.stringify(realBefore)}`)

// pasta de modelos de TESTE limpa; projeto B de uma rodada anterior sai
rmSync(BRAND_DIR, { recursive: true, force: true })
rmSync(join(PROJECTS, PROJECT_B), { recursive: true, force: true })

const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CIALIGHT_QA: 'editor-fixture', CIALIGHT_RAW_DIR: 'test-out/raw', CIALIGHT_BRAND_DIR: 'test-out/brand-qa' },
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

/** Avalia `body` (corpo de função async, com os helpers em `T`) na página e devolve o valor. */
async function ev(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__fb; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function ev0(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  [captura] ${name}`)
}
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}

let failures = 0
let checks = 0
function check(name, ok, detail) {
  checks++
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

const HELPERS = `
window.__fb = (() => {
  const st = () => window.__qaEditor.store.getState()
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel) => [...document.querySelectorAll(sel)]
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  /** Clique completo (pointer + mouse + click) no centro do elemento. */
  const click = async (e) => {
    const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    e.dispatchEvent(pe('pointerdown', x, y)); e.dispatchEvent(me('mousedown', x, y))
    e.dispatchEvent(pe('pointerup', x, y)); e.dispatchEvent(me('mouseup', x, y)); e.click()
    await settle()
  }
  const key = async (k, mods, target) => { (target || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const items = () => st().project.tracks.flatMap((t) => t.items)
  const item = (id) => items().find((i) => i.id === id)
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(700); await settle() }
  const toasts = () => all('[data-sonner-toast]').map((t) => t.textContent)
  const dismissToasts = async () => { for (const b of all('[data-sonner-toast] [data-close-button]')) b.click(); await wait(300) }
  const setInput = async (input, text) => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const region = async (x, y, w, h) => {
    const r = window.__qaEditor.engine.render
    const k = (r.size.width * r.size.dpr) / st().project.canvas.width
    return r.readPixels(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
  }
  const patch = async (x, y, n = 9) => {
    const px = await region(x - (n >> 1), y - (n >> 1), n, n)
    const c = px.length / 4, m = [0, 0, 0]
    for (let i = 0; i < c; i++) for (let j = 0; j < 3; j++) m[j] += px[i * 4 + j] / c
    return m.map(Math.round)
  }
  const tab = async (label) => { const t = all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').find((x) => x.textContent.trim() === label); if (!t) throw new Error('aba ' + label); t.dispatchEvent(pe('pointerdown', 0, 0)); t.dispatchEvent(me('mousedown', 0, 0)); t.click(); await settle(); await wait(250) }
  const row = (name) => all('[data-brand-template]').find((r) => r.querySelector('[data-brand-name]').textContent.trim() === name)
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150) } return null }
  const open = async (id) => {
    window.__navigate('projects'); await wait(600)
    window.__navigate('editor:' + id)
    return waitFor(() => { const s = window.__qaEditor?.store.getState(); return !!s?.project && s.project.id === id && s.project.assets.every((a) => a.status === 'ready') && !!document.querySelector('[data-viewer-overlay]') }, 120000)
  }
  return { st, settle, wait, el, all, click, key, items, item, past, seek, toasts, dismissToasts, setInput, region, patch, tab, row, waitFor, open }
})()
'ok'`

const red = (c) => c[0] > 170 && c[1] < 110 && c[2] < 110
const near = (a, b, tol = 14) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
// logo do projeto de teste: 480×480 em PiP (x 0,84, y 0,22, escala 0,28 → ~302 px de lado no quadro 1920×1080); a
// borda vermelha tem ~38 px: amostra na borda esquerda, meio da altura
const LOGO_RED = { x: 1613 - 151 + 16, y: 238 }

async function main() {
  await connect()
  await send('Page.enable')
  await viewport(1366, 900)
  await ev0(`localStorage.setItem('editor.timelineHeight', '260'); return 1`)
  await ev0(HELPERS + '; return 1')
  const opened = await ev(`return await T.open('p-qa-editor-fixture')`)
  check('projeto de teste aberto', !!opened, opened)
  const base = await ev(`return JSON.parse(JSON.stringify(T.st().project))`)

  // ------------------------------------------------------------------ 1
  console.log('1. aba Modelos (pt-BR, vazia, botão de salvar sem seleção)')
  {
    const r = await ev(`const tabs = T.all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').map((x) => x.textContent.trim())
      T.st().select([]); await T.tab('Modelos'); await T.wait(400)
      const btn = T.el('[data-brand-save]')
      return { tabs, btn: btn.textContent.trim(), disabled: btn.disabled, empty: T.el('[data-brand-panel]').textContent, rows: T.all('[data-brand-template]').length }`)
    check('abas terminam em Legendas, Modelos', JSON.stringify(r.tabs.slice(-2)) === JSON.stringify(['Legendas', 'Modelos']), r.tabs)
    check('"Salvar seleção como modelo…" desligado sem seleção', r.btn === 'Salvar seleção como modelo…' && r.disabled, r)
    check('lista vazia com explicação em pt-BR (pasta de teste nova)', r.rows === 0 && /Nenhum modelo ainda/.test(r.empty), r)
    await shot('f5-20-modelos-vazio.png')
  }

  // ------------------------------------------------------------------ 2
  console.log('2. título + logo → modelo "Abertura" pelo diálogo')
  let titleId, logoId
  {
    const r = await ev(`await T.seek(0); T.st().select([])
      await T.key('t'); await T.wait(300)
      const title = T.items().find((i) => i.type === 'text')
      const logo = T.items().find((i) => i.type === 'media' && i.assetId === 'a_qa_logo')
      T.st().select([title.id, logo.id]); await T.settle(); await T.wait(200)
      const btn = T.el('[data-brand-save]')
      const enabled = !btn.disabled
      await T.click(btn); await T.wait(300)
      const dlg = T.el('[data-brand-save-dialog]')
      await T.setInput(T.el('[data-brand-name-input]'), 'Vinheta QA')
      const kinds = [...dlg.querySelectorAll('button')].map((b) => b.textContent.trim())
      const abertura = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Abertura')
      await T.click(abertura)
      return { title: title && { id: title.id, startUs: title.startUs, durationUs: title.durationUs }, logo: logo && { id: logo.id, startUs: logo.startUs, durationUs: logo.durationUs }, enabled, kinds }`)
    titleId = r.title?.id
    logoId = r.logo?.id
    check('atalho T criou o título em 0 s; logo do projeto de teste em 1 s', r.title?.startUs === 0 && r.logo?.startUs === 1000000, r)
    check('com seleção o botão liga; diálogo com os 4 tipos em pt-BR', r.enabled && ['Sobreposição', 'Abertura', 'Encerramento', "Marca d'água"].every((k) => r.kinds.includes(k)), r)
    await shot('f5-21-salvar-modelo.png')
    const s = await ev(`await T.click(T.el('[data-brand-save-confirm]'))
      const ok = await T.waitFor(() => T.row('Vinheta QA'))
      await T.wait(300)
      const rowText = ok ? ok.textContent : null
      return { ok: !!ok, rowText, toasts: T.toasts(), dialog: !!document.querySelector('[data-brand-save-dialog]') }`)
    check('toast "Modelo “Vinheta QA” salvo" e o diálogo fecha', s.toasts.some((t) => /Modelo “Vinheta QA” salvo/.test(t)) && !s.dialog, s)
    check('lista: Vinheta QA · Abertura · 7 s', s.ok && /Abertura · 7 s/.test(s.rowText), s)
    const disk = existsSync(join(BRAND_DIR, 'brand-templates.json')) ? JSON.parse(readFileSync(join(BRAND_DIR, 'brand-templates.json'), 'utf8')) : null
    const t0 = disk?.templates?.[0]
    const files = t0 ? (existsSync(join(BRAND_DIR, 'brand-assets', t0.id)) ? readdirSync(join(BRAND_DIR, 'brand-assets', t0.id)) : []) : []
    check('pasta de TESTE: brand-templates.json versão 1 com o modelo (texto + logo) e o logo copiado em brand-assets/<id>/', disk?.version === 1 && t0?.name === 'Vinheta QA' && t0.kind === 'intro' && t0.durationUs === 7000000 && t0.tracks.flatMap((x) => x.items).map((i) => i.type).sort().join() === 'media,text' && files.length === 1 && /logo\.png$/.test(files[0]), { t0: t0 && { ...t0, tracks: undefined }, files })
    await ev(`await T.dismissToasts(); return 1`)
    await shot('f5-22-modelo-salvo.png')
  }

  // ------------------------------------------------------------------ 3
  console.log('3. só o logo → modelo "Marca d\'água"')
  {
    const s = await ev(`T.st().select(['${logoId}']); await T.settle()
      await T.click(T.el('[data-brand-save]')); await T.wait(300)
      await T.setInput(T.el('[data-brand-name-input]'), 'Logo QA')
      await T.click([...T.el('[data-brand-save-dialog]').querySelectorAll('button')].find((b) => b.textContent.trim() === "Marca d'água"))
      await T.click(T.el('[data-brand-save-confirm]'))
      const row = await T.waitFor(() => T.row('Logo QA'))
      return { row: row ? row.textContent : null, actions: row ? [...row.querySelectorAll('[data-brand-action]')].map((b) => b.getAttribute('aria-label')) : [], vin: [...T.row('Vinheta QA').querySelectorAll('[data-brand-action]')].map((b) => b.getAttribute('data-brand-action')) }`)
    check("Logo QA · Marca d'água · 6 s", /Marca d'água · 6 s/.test(s.row ?? ''), s)
    check("ações do modelo marca d'água: playhead, abertura, encerramento, marca d'água, renomear, excluir (pt-BR)", JSON.stringify(s.actions.map((a) => a.split(':')[0])) === JSON.stringify(['Aplicar no playhead', 'Usar como abertura', 'Usar como encerramento', "Aplicar como marca d'água", 'Renomear o modelo Logo QA', 'Excluir o modelo Logo QA']), s.actions)
    check("modelo de abertura não oferece marca d'água", !s.vin.includes('watermark') && s.vin.includes('intro'), s.vin)
  }

  // ------------------------------------------------------------------ 4
  console.log('4. outro projeto: "Usar como abertura"')
  let D = 7000000
  let introIds = []
  let pastB0 = 0
  let origPatches = null
  {
    // cópia do projeto de teste como estava ao abrir (sem o título), em test-out/Projetos
    const dup = await ev(`const base = ${JSON.stringify(base)}
      await window.__qaEditor.store.getState()
      await window.api.project.duplicate('p-qa-editor-fixture', { ...base, id: '${PROJECT_B}', name: 'Projeto B (QA modelos)' })
      return await T.open('${PROJECT_B}')`)
    check('projeto B aberto (cópia do de teste, sem título)', !!dup, dup)
    origPatches = await ev(`const out = {}
      for (const t of [500000, 3000000]) { await T.seek(t); await T.wait(500); out[t] = { center: await T.patch(960, 540), left: await T.patch(300, 800), logo: await T.patch(${LOGO_RED.x}, ${LOGO_RED.y}) } }
      return out`)
    check('antes: logo do projeto (PiP) visível em 3 s e ausente em 0,5 s', red(origPatches[3000000].logo) && !red(origPatches[500000].logo), origPatches)
    const r = await ev(`await T.tab('Modelos'); await T.wait(300)
      const before = T.items().map((i) => ({ id: i.id, startUs: i.startUs })); const markers = T.st().project.markers.map((m) => m.tUs)
      const p0 = T.past()
      await T.click(T.row('Vinheta QA').querySelector('[data-brand-action="intro"]'))
      await T.waitFor(() => T.past() > p0)
      await T.wait(400)
      const p = T.st().project
      const shifted = before.every((b) => T.item(b.id).startUs === b.startUs + 7000000)
      const added = T.items().filter((i) => !before.some((b) => b.id === i.id))
      const gen = p.assets.filter((a) => a.source.type === 'generated')
      return { p0, past: T.past(), shifted, markers, markersNow: p.markers.map((m) => m.tUs), added: added.map((i) => ({ id: i.id, type: i.type, startUs: i.startUs, durationUs: i.durationUs, assetId: i.assetId })), gen: gen.map((a) => ({ id: a.id, file: a.source.file, status: a.status })), sel: T.st().selection, toasts: T.toasts() }`)
    pastB0 = r.p0
    introIds = r.added.map((i) => i.id)
    check('um passo de desfazer', r.past === r.p0 + 1, r)
    check('tudo o que existia andou 7 s (itens e marcadores)', r.shifted && JSON.stringify(r.markersNow) === JSON.stringify(r.markers.map((m) => m + 7000000)), r)
    check('modelo em 0: título (0–3 s) e logo (1–7 s), selecionados', r.added.length === 2 && r.added.some((i) => i.type === 'text' && i.startUs === 0 && i.durationUs === 3000000) && r.added.some((i) => i.type === 'media' && i.startUs === 1000000 && i.durationUs === 6000000) && r.sel.length === 2, r)
    const genFile = r.gen[0] && join(PROJECTS, PROJECT_B, ...r.gen[0].file.split('/'))
    check('logo copiado para generated/ do projeto (asset generated, pronto) — o projeto não depende do modelo', r.gen.length === 1 && r.added.find((i) => i.type === 'media')?.assetId === r.gen[0].id && r.gen[0].status === 'ready' && existsSync(genFile), { gen: r.gen, genFile })
    check('toast "“Vinheta QA” virou a abertura"', r.toasts.some((t) => /“Vinheta QA” virou a abertura/.test(t) && /7 s/.test(t)), r.toasts)
    const px = await ev(`T.st().select([]); await T.seek(2000000); await T.wait(600)
      const title = await T.region(760, 470, 400, 140); let white = 0; for (let i = 0; i < title.length; i += 4) if (title[i] > 235 && title[i + 1] > 235 && title[i + 2] > 235) white++
      const logo = await T.patch(${LOGO_RED.x}, ${LOGO_RED.y})
      const out = {}
      for (const t of [500000, 3000000]) { await T.seek(t + 7000000); await T.wait(500); out[t] = { center: await T.patch(960, 540), left: await T.patch(300, 800), logo: await T.patch(${LOGO_RED.x}, ${LOGO_RED.y}) } }
      return { white, logo, out }`)
    check('em 2 s: o título (pixels brancos no centro) e o logo do modelo (borda vermelha) no quadro', px.white > 300 && red(px.logo), { white: px.white, logo: px.logo })
    const same = [500000, 3000000].every((t) => ['center', 'left', 'logo'].every((k) => near(px.out[t][k], origPatches[t][k])))
    check('conteúdo original deslocado: quadro em t + 7 s = quadro original em t (0,5 s e 3 s; centro, canto e PiP)', same, { orig: origPatches, now: px.out })
    await shot('f5-23-abertura-aplicada.png')
  }

  // ------------------------------------------------------------------ 5
  console.log('5. excluir o modelo (confirmação) não quebra o projeto')
  {
    const tplId = JSON.parse(readFileSync(join(BRAND_DIR, 'brand-templates.json'), 'utf8')).templates.find((t) => t.name === 'Vinheta QA').id
    const r = await ev(`await T.dismissToasts()
      await T.click(T.row('Vinheta QA').querySelector('[data-brand-action="delete"]')); await T.wait(300)
      const desc = document.querySelector('[role="dialog"]')?.textContent ?? ''
      await T.click(T.el('[data-brand-delete-confirm]'))
      const gone = await T.waitFor(() => !T.row('Vinheta QA'))
      await T.seek(2000000); await T.wait(600)
      return { desc, gone: !!gone, toasts: T.toasts(), logo: await T.patch(${LOGO_RED.x}, ${LOGO_RED.y}), missing: T.st().project.assets.filter((a) => a.status !== 'ready').map((a) => a.id) }`)
    check('confirmação em pt-BR antes de excluir', /Excluir o modelo “Vinheta QA”\? Os projetos que já o usaram não mudam\./.test(r.desc), r.desc)
    check('excluído: some da lista, toast, pasta brand-assets/<id> apagada', r.gone && r.toasts.some((t) => /Modelo “Vinheta QA” excluído/.test(t)) && !existsSync(join(BRAND_DIR, 'brand-assets', tplId)), r)
    check('o projeto continua com o logo no quadro (cópia própria) e sem mídia ausente', red(r.logo) && r.missing.length === 0, r)
    await shot('f5-24-modelo-excluido.png')
    const u = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(300); return { past: T.past(), n: T.items().filter((i) => ${JSON.stringify(introIds)}.includes(i.id)).length }`)
    check('Ctrl+Z desfaz a abertura inteira', u.past === pastB0 && u.n === 0, u)
  }

  // ------------------------------------------------------------------ 6
  console.log('6. faixa bloqueada → abertura recusada com toast')
  {
    const r = await ev(`await T.dismissToasts()
      T.st().apply((p) => ({ ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)) }))
      const p0 = T.past(); const n0 = T.items().length
      await T.click(T.row('Logo QA').querySelector('[data-brand-action="intro"]')); await T.wait(800)
      const out = { p0, past: T.past(), n0, n: T.items().length, toasts: T.toasts() }
      await T.key('z', { ctrlKey: true }); await T.wait(200)
      return { ...out, unlocked: !T.st().project.tracks[0].locked }`)
    check('toast "Faixa bloqueada: …" e nada muda', r.past === r.p0 && r.n === r.n0 && r.toasts.some((t) => /Faixa bloqueada/.test(t)) && r.unlocked, r)
  }

  // ------------------------------------------------------------------ 7
  console.log("7. Aplicar como marca d'água")
  {
    const r = await ev(`await T.dismissToasts()
      const p0 = T.past(); const n0 = T.items().length
      await T.click(T.row('Logo QA').querySelector('[data-brand-action="watermark"]'))
      await T.waitFor(() => T.past() > p0); await T.wait(400)
      const p = T.st().project
      const ti = p.tracks.findIndex((t) => t.name === "Marca d'água")
      const wm = ti >= 0 ? p.tracks[ti].items : []
      const end = Math.max(...p.tracks.filter((t) => !t.hidden).flatMap((t) => t.items).filter((i) => i.type !== 'effect' && !wm.includes(i)).map((i) => i.startUs + i.durationUs))
      return { past: T.past(), p0, ti, top: p.tracks.filter((t) => t.kind === 'video').pop()?.name, wm: wm.map((i) => [i.type, i.startUs, i.durationUs]), end, toasts: T.toasts() }`)
    check("uma faixa \"Marca d'água\" no topo das de vídeo com o logo de 0 ao fim do conteúdo, um passo", r.past === r.p0 + 1 && r.top === "Marca d'água" && r.wm.length === 1 && r.wm[0][1] === 0 && r.wm[0][2] === r.end, r)
    check("toast \"“Logo QA” aplicado como marca d'água\"", r.toasts.some((t) => /“Logo QA” aplicado como marca d'água/.test(t)), r.toasts)
    const px = await ev(`T.st().select([])
      const out = {}
      for (const t of [300000, 10500000]) { await T.seek(t); await T.wait(600); out[t] = await T.patch(${LOGO_RED.x}, ${LOGO_RED.y}) }
      return out`)
    check("logo da marca d'água no quadro no início (0,3 s, antes do PiP) e no fim (10,5 s, depois do PiP)", red(px[300000]) && red(px[10500000]) && !red(origPatches[500000].logo), { px, sem: origPatches[500000].logo })
    await shot('f5-25-marca-dagua.png')
    await ev(`await T.key('z', { ctrlKey: true }); await T.wait(200); return 1`)
  }

  // ------------------------------------------------------------------ 8
  console.log('8. renomear')
  {
    const r = await ev(`await T.dismissToasts()
      await T.click(T.row('Logo QA').querySelector('[data-brand-action="rename"]')); await T.wait(300)
      await T.setInput(T.el('[data-brand-rename-input]'), 'Logo da marca')
      await T.click(T.el('[data-brand-rename-confirm]'))
      const row = await T.waitFor(() => T.row('Logo da marca'))
      return { ok: !!row, toasts: T.toasts() }`)
    const disk = JSON.parse(readFileSync(join(BRAND_DIR, 'brand-templates.json'), 'utf8'))
    check('renomeado na lista e no arquivo, com toast', r.ok && r.toasts.some((t) => /Modelo renomeado para “Logo da marca”/.test(t)) && disk.templates.map((t) => t.name).join() === 'Logo da marca', { r, names: disk.templates.map((t) => t.name) })
  }

  // ------------------------------------------------------------------ 9
  console.log('9. arquivo de modelos corrompido')
  {
    writeFileSync(join(BRAND_DIR, 'brand-templates.json'), '{ "version": 1, "templates": [ quebrado')
    const r = await ev(`await T.dismissToasts(); await T.tab('Mídia'); await T.tab('Modelos'); await T.wait(800)
      return { rows: T.all('[data-brand-template]').length, toasts: T.toasts() }`)
    const corrupt = readdirSync(BRAND_DIR).filter((f) => f.startsWith('brand-templates.corrupt-'))
    check('aviso "corrompido", lista vazia, arquivo renomeado (não apagado)', r.rows === 0 && r.toasts.some((t) => /corrompido/.test(t)) && corrupt.length === 1 && readFileSync(join(BRAND_DIR, corrupt[0]), 'utf8').includes('quebrado') && !existsSync(join(BRAND_DIR, 'brand-templates.json')), { r, corrupt })
    await shot('f5-26-modelos-corrompido.png')
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
  try {
    execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // já saiu
  }
  await sleep(800)
  rmSync(join(PROJECTS, PROJECT_B), { recursive: true, force: true })
  // modelos reais do usuário: nem criados nem alterados
  const realAfter = realBrandState()
  const realOk = JSON.stringify(realAfter) === JSON.stringify(realBefore)
  checks++
  if (!realOk) failures++
  console.log(`${realOk ? '  ✔' : '  ✘'} %APPDATA%\\cialight-gravador\\brand-templates.json e brand-assets do usuário intocados (${JSON.stringify(realAfter)})`)
  // settings.json do usuário: compara o hash antes/depois. Diferente = restaura o backup e confere o hash de novo.
  // Só `pip` regravado pelo app (tela Preparar ao redimensionar pela emulação do CDP) é aceito, restaurado.
  failures += settings.finish() // settingsGuard.mjs: restaura e confere o hash; só `pip` (regravado pelo app) é tolerado
  console.log(failures ? `\n${failures} falha(s) em ${checks} verificações` : `\ntudo OK (${checks} verificações)`)
  process.exit(failures ? 1 : 0)
}
