// QA das legendas automáticas (G2 Task 5) via CDP, com eventos sintéticos despachados nos elementos reais da página —
// nunca entrada do sistema operacional. Fala sintética pt-BR (System.Speech via synthSpeech.mjs — nunca o microfone)
// misturada a um vídeo testsrc2 vira a mídia de um projeto novo (pasta de teste test-out/qa-g2-captions); a faixa do
// áudio ganha o papel de voz, um trecho fica 2× mais rápido e um silêncio é removido (ops do editor pelo store), para
// a conta fonte → timeline ser exercitada. Modelos do whisper em test-out/whisper-models (o `base` é baixado uma vez
// pela IPC do app se faltar); o download do `small` é iniciado e cancelado pela UI.
//
// uso (depois de `npm run build`; SEMPRE sob o lock das execuções do Electron):
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "node scripts/qa/editor-g2-captions.mjs"
//
// Confere: (1) botão e textos do diálogo em pt-BR, base "baixado"; (2) small "precisa baixar (488 MB)", clicar inicia o
// download com progresso, Cancelar não deixa arquivo/.part; (3) Gerar (base, pt): limites das cues, ≥ 80 % das palavras
// em ordem e cada palavra dentro (± 0,3 s) da cue que a contém, na posição mapeada pelo 2× e pelo corte; (4) um Ctrl+Z
// tira todas, refazer volta; (5) "Só onde não há legenda" mantém a manual e pula as que encostam; (6) cancelar durante
// a transcrição não aplica nada e avisa; (7) Transcrição: busca sem acento destaca, clique leva o playhead (± 0,5 s),
// copiar; (8) exportar SRT; (9) settings.json intocado. Screenshots em docs/qa/editor-g2/ (só mídia sintética).
import { spawn, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import electronPath from 'electron'
import { guardSettings } from './settingsGuard.mjs'
import { synthSpeech } from './synthSpeech.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PORT = process.env.CDP_PORT ?? '9337'
const SHOTS = join(ROOT, 'docs', 'qa', 'editor-g2')
const SETTINGS = join(process.env.APPDATA ?? '', 'cialight-gravador', 'settings.json')
const QA = join(ROOT, 'test-out', 'qa-g2-captions')
const RAW_REL = 'test-out/qa-g2-captions/raw'
const MODELS_REL = 'test-out/whisper-models'
const MODELS = join(ROOT, MODELS_REL)
const FFMPEG = join(ROOT, 'resources', 'ffmpeg', 'ffmpeg.exe')
const WAV = join(QA, 'media', 'fala.wav')
const MP4 = join(QA, 'media', 'fala.mp4')
const SRT_OUT = join(QA, 'exportado.srt')
const S = 1_000_000

// ~40 s, duas pausas longas (1,5 s e 2 s), sem números (o whisper escreveria por extenso ou em algarismos)
const SSML = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-BR">
Bom dia a todos, e sejam bem-vindos à reunião da equipe de iluminação.
Hoje vamos falar sobre a manutenção preventiva das luminárias da fábrica.
<break time="1500ms"/>
A produção cresceu bastante neste trimestre, e os clientes ficaram satisfeitos com a qualidade das peças.
Precisamos de atenção redobrada com a segurança dos equipamentos elétricos.
<break time="2000ms"/>
O relatório completo será enviado por e-mail na próxima semana.
Agradeço a participação de vocês e desejo um ótimo trabalho.
</speak>`
const SEARCH_WORD = 'manutenção'

mkdirSync(SHOTS, { recursive: true })
// pastas de teste: projeto/brutos recriados; a mídia sintética (fala.wav + verdade) fica em cache
for (const d of ['raw', 'Projetos', 'brand']) rmSync(join(QA, d), { recursive: true, force: true })
rmSync(SRT_OUT, { force: true })
mkdirSync(join(QA, 'media'), { recursive: true })
mkdirSync(MODELS, { recursive: true })
// o small nunca pode estar baixado aqui (o teste do download começa de "precisa baixar"): caminhos explícitos
const SMALL = join(MODELS, 'ggml-small.bin')
for (const f of [SMALL, `${SMALL}.ok`, `${SMALL}.part`]) rmSync(f, { force: true })

let failures = 0
let checks = 0
function check(name, ok, detail) {
  checks++
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 1500)}`}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- mídia sintética
async function makeMedia() {
  if (!existsSync(WAV) || !existsSync(`${WAV}.words.json`)) {
    console.log('sintetizando a fala (System.Speech, pt-BR)…')
    await synthSpeech({ ssmlOrText: SSML, voice: 'pt-BR', outWav: WAV })
  }
  const truth = JSON.parse(readFileSync(`${WAV}.words.json`, 'utf8'))
  if (!existsSync(MP4)) {
    execFileSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-i', WAV, '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', MP4], { stdio: 'ignore' })
  }
  return truth
}

/** Silêncios ≥ minUs do WAV PCM 16-bit mono (janelas de 20 ms, RMS < limiar), em µs. */
function silences(wavFile, minUs = 1_000_000) {
  const b = readFileSync(wavFile)
  let off = 12, rate = 16000, data = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + size); break }
    off += 8 + size + (size & 1)
  }
  const win = Math.round(rate * 0.02)
  const n = Math.floor(data.length / 2)
  const out = []
  let runStart = -1
  for (let i = 0; i + win <= n; i += win) {
    let acc = 0
    for (let k = i; k < i + win; k++) { const v = data.readInt16LE(k * 2) / 32768; acc += v * v }
    const quiet = Math.sqrt(acc / win) < 0.002
    const t = Math.round((i / rate) * S)
    if (quiet && runStart < 0) runStart = t
    if (!quiet && runStart >= 0) { if (t - runStart >= minUs) out.push([runStart, t]); runStart = -1 }
  }
  return out
}

// ---------------------------------------------------------------- texto / alinhamento
const norm = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
/**
 * Alinhamento guloso em ordem: cada palavra da verdade procura a próxima igual nas palavras das legendas (janela de 8);
 * devolve, por palavra da verdade, o índice da palavra de legenda casada (ou -1).
 */
function alignInOrder(truthWords, capWords) {
  const out = []
  let j = 0
  for (const tw of truthWords) {
    let hit = -1
    for (let k = j; k < Math.min(capWords.length, j + 8); k++) if (capWords[k].n === tw.n) { hit = k; break }
    out.push(hit)
    if (hit >= 0) j = hit + 1
  }
  return out
}

/** Fonte → timeline pelos itens do asset na faixa de voz (conta independente do app): null se a fonte foi cortada. */
function mapSrc(items, src) {
  for (const it of items) {
    const lo = it.inUs, hi = it.inUs + it.durationUs * it.speed
    if (src >= lo && src < hi) return it.startUs + Math.round((src - lo) / it.speed)
  }
  return null
}

// ---------------------------------------------------------------- CDP
let app = null
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
          } else if (m.method === 'Runtime.exceptionThrown') console.log(`  [página] exceção: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`)
          else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log(`  [página] erro: ${m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 600)}`)
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
async function ev(body, timeout = 240000) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { const T = window.__gq; ${body} })()`, awaitPromise: true, returnByValue: true, timeout })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`  [captura] ${name}`)
}

const HELPERS = `
window.__gq = (() => {
  const st = () => window.__qaEditor.store.getState()
  const ops = () => window.__qaEditor.ops
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const settle = async () => { await raf(); await raf() }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (sel, root = document) => { const e = root.querySelector(sel); if (!e) throw new Error('não achei ' + sel); return e }
  const all = (sel, root = document) => [...root.querySelectorAll(sel)]
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  const me = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 })
  const click = async (e) => {
    e.scrollIntoView({ block: 'nearest' })
    const { x, y } = center(e)
    e.dispatchEvent(pe('pointerdown', x, y)); e.dispatchEvent(me('mousedown', x, y))
    e.dispatchEvent(pe('pointerup', x, y)); e.dispatchEvent(me('mouseup', x, y)); e.dispatchEvent(me('click', x, y))
    await settle()
  }
  const key = async (k, mods, target) => { (target || window).dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...(mods || {}) })); await settle() }
  const setValue = (input, value) => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })) }
  const past = () => st().history.past.length
  const seek = async (us) => { window.__qaEditor.controller.seek(us); await settle(); await wait(400); await settle() }
  const seen = new WeakSet()
  const toasts = () => all('[data-sonner-toast]').filter((t) => !seen.has(t)).map((t) => t.textContent)
  const clearToasts = async () => { for (const t of all('[data-sonner-toast]')) seen.add(t); await settle() }
  const waitToast = async (pred, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const hit = toasts().find(pred); if (hit) return hit; await wait(200) } return null }
  const capTrack = () => st().project.tracks.find((t) => t.role === 'captions')
  const caps = () => (capTrack()?.items ?? []).map((i) => ({ id: i.id, s: i.startUs, e: i.startUs + i.durationUs, text: i.text, enabled: i.enabled !== false })).sort((a, b) => a.s - b.s)
  const panel = () => el('[data-captions-panel]')
  const button = (text, root = document) => { const b = all('button', root).find((x) => x.textContent.trim() === text); if (!b) throw new Error('não achei o botão ' + text); return b }
  const dialog = () => document.querySelector('[role="dialog"]')
  const gen = () => document.querySelector('[data-generate-dialog]')
  const tab = async (label) => { const t = all('aside[aria-label="Biblioteca de mídia"] [role="tab"]').find((x) => x.textContent.trim() === label); if (!t) throw new Error('aba ' + label); t.dispatchEvent(pe('pointerdown', 0, 0)); t.dispatchEvent(me('mousedown', 0, 0)); t.click(); await settle(); await wait(150) }
  const openGenerate = async () => { await click(el('[data-caption-generate]')); for (let i = 0; i < 50 && !gen()?.querySelector('[data-model-option]'); i++) await wait(100); await settle() }
  const pickModel = async (id) => { el('[data-model-option="' + id + '"] input').click(); await settle() }
  const pickMode = async (m) => { el('[data-generate-mode="' + m + '"] input').click(); await settle() }
  const step = () => gen()?.querySelector('[data-generate-step]')?.textContent ?? null
  const voiceItems = () => { const t = st().project.tracks.find((x) => x.role === 'voice'); return t.items.filter((i) => i.type === 'media').map((i) => ({ startUs: i.startUs, durationUs: i.durationUs, inUs: i.inUs, speed: i.speed })) }
  return { st, ops, settle, wait, el, all, click, key, setValue, past, seek, toasts, clearToasts, waitToast, capTrack, caps, panel, button, dialog, gen, tab, openGenerate, pickModel, pickMode, step, voiceItems }
})()
'ok'`

async function ev0(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(`erro na página: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`)
  return r.result?.result?.value
}

// ---------------------------------------------------------------- main
async function main(truth) {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60 && !(await ev0(`return typeof window.__navigate === 'function'`)); i++) await sleep(500)

  // modelo base: no cache do test:transcribe; se faltar, baixa uma vez pela IPC do app (antes da UI)
  const base = await ev0(`return (await window.api.transcribe.models()).find((m) => m.id === 'base')`)
  if (!base?.present) {
    console.log('modelo base ausente em test-out/whisper-models: baixando pela IPC do app…')
    const r = await ev0(`return await window.api.transcribe.downloadModel('base')`)
    check('download do modelo base pela IPC', r?.ok === true, r)
  }

  console.log('projeto novo + fala sintética na faixa de voz (2× num trecho, um silêncio removido)')
  await ev0(`localStorage.setItem('editor.timelineHeight', '240'); window.__navigate('projects'); return 1`)
  await sleep(800)
  await ev0(HELPERS + '; return 1')
  await ev(`await T.click(T.button('Novo projeto')); await T.wait(300); const d = T.dialog(); T.setValue(d.querySelector('input'), 'Legendas automáticas (QA)'); await T.settle(); await T.click(T.button('Criar e abrir', d)); return 1`)
  for (let i = 0; i < 60 && !(await ev0(`return !!window.__qaEditor?.store.getState().project`)); i++) await sleep(500)
  await ev0(HELPERS + '; return 1')
  const imp = await ev(`const a = await window.__qaEditor.importPaths(${JSON.stringify([MP4])}); return a.map((x) => x.id)`)
  const assetId = imp[0]
  for (let i = 0; i < 120 && !(await ev(`return T.st().project.assets.every((a) => a.status === 'ready')`)); i++) await sleep(1000)

  // as duas pausas do SSML (1,5 s e 2 s de <break> + o fim da frase) passam de 1,8 s; as pausas naturais entre
  // frases ficam perto de 1 s
  const sil = silences(WAV, 1_800_000)
  console.log(`  silêncios ≥ 1,8 s na fala: ${JSON.stringify(sil.map(([a, b]) => [(a / S).toFixed(2), (b / S).toFixed(2)]))}`)
  check('fala sintética com as duas pausas longas', sil.length === 2, sil)
  const [p1, p2] = sil
  const cut = { from: p2[0] + 250_000, to: p2[1] - 250_000 }
  const t1 = Math.round((p1[0] + p1[1]) / 2)
  // fim do trecho 2× num respiro entre palavras (≥ 120 ms) perto de t1 + 8 s: cortar no meio de uma palavra deixaria a
  // palavra metade em cada trecho (o whisper a põe onde soa a maior parte, a verdade-base marca o início)
  const gaps = silences(WAV, 120_000).filter(([a, b]) => a > t1 + 4 * S && b < p2[0] - 500_000)
  gaps.sort((x, y) => Math.abs((x[0] + x[1]) / 2 - (t1 + 8 * S)) - Math.abs((y[0] + y[1]) / 2 - (t1 + 8 * S)))
  const t2 = gaps.length ? Math.round((gaps[0][0] + gaps[0][1]) / 2) : Math.min(t1 + 8 * S, p2[0] - 500_000)
  console.log(`  trecho 2×: fonte [${(t1 / S).toFixed(2)}; ${(t2 / S).toFixed(2)}) s; corte [${(cut.from / S).toFixed(2)}; ${(cut.to / S).toFixed(2)}) s`)
  const setup = await ev(`const O = T.ops()
    let itemIds = []
    T.st().apply((p) => { const r = O.addMediaFromAsset(p, ${JSON.stringify(assetId)}, 0); itemIds = r.itemIds; return r.project })
    const audioTrack = T.st().project.tracks.find((t) => t.items.some((i) => itemIds.includes(i.id) && t.kind === 'audio'))
    T.st().apply((p) => O.updateTrack(p, audioTrack.id, { role: 'voice' }))
    T.st().apply((p) => O.deleteRange(p, ${cut.from}, ${cut.to}))
    T.st().apply((p) => O.splitAt(O.splitAt(p, 'all', ${t1}), 'all', ${t2}))
    const mid = T.st().project.tracks.find((t) => t.kind === 'video' && t.role !== 'captions').items.find((i) => i.startUs === ${t1})
    T.st().apply((p) => O.setSpeed(p, mid.id, 2))
    await T.settle()
    return { voice: T.voiceItems(), tracks: T.st().project.tracks.map((t) => [t.name, t.kind, t.role ?? null, t.items.length]), past: T.past() }`)
  console.log(`  itens de voz: ${JSON.stringify(setup.voice)}`)
  // 4 trechos: [0; t1) 1×, [t1; t2) 2×, [t2; corte) 1×, depois do corte 1× (a fonte pula o silêncio removido)
  const v = setup.voice
  check('faixa de voz com 4 trechos (1×, 2×, 1×, 1×) e o silêncio removido da fonte', v.length === 4 && v.map((x) => x.speed).join() === '1,2,1,1' && v[3].inUs - (v[2].inUs + v[2].durationUs) === cut.to - cut.from && v[3].startUs === v[2].startUs + v[2].durationUs, setup)

  // verdade-base na timeline (conta independente): palavras cujo início foi cortado saem da expectativa
  const truthTl = truth.words.map((w) => ({ text: w.text, n: norm(w.text), src: w.startUs, t: mapSrc(setup.voice, w.startUs) })).filter((w) => w.n && w.t !== null)
  console.log(`  verdade: ${truth.words.length} palavras, ${truthTl.length} na timeline depois dos cortes`)

  // ------------------------------------------------------------------ 1
  console.log('1. botão e diálogo em pt-BR; base "baixado"')
  await ev(`await T.tab('Legendas'); return 1`)
  const d1 = await ev(`const b = T.el('[data-caption-generate]'); const btn = { text: b.textContent.trim(), disabled: b.disabled }
    await T.openGenerate(); await T.pickModel('base'); const g = T.gen()
    return { btn, text: g.textContent, title: T.dialog().querySelector('h2')?.textContent, opts: T.all('[data-model-option]', g).map((o) => ({ id: o.dataset.modelOption, text: o.textContent })), source: g.querySelector('[data-generate-source]').textContent, modeShown: !!g.querySelector('[data-generate-mode]'), start: g.querySelector('[data-generate-start]').textContent, lang: T.dialog().querySelector('[aria-label="Idioma"]')?.textContent }`)
  check('botão "Gerar legendas…" habilitado', d1.btn.text === 'Gerar legendas…' && !d1.btn.disabled, d1.btn)
  check('título "Gerar legendas"; modelos Base (148 MB, mais rápido) / Preciso (488 MB, mais lento)', d1.title === 'Gerar legendas' && d1.opts[0]?.text.includes('Base (148 MB, mais rápido)') && d1.opts[1]?.text.includes('Preciso (488 MB, mais lento)'), d1)
  check('base "baixado"; small "precisa baixar (488 MB)"', d1.opts[0]?.text.includes('baixado') && d1.opts[1]?.text.includes('precisa baixar (488 MB)'), d1.opts)
  check('idioma padrão Português (Brasil); seções Modelo/Idioma/Fonte; privacidade', d1.lang?.includes('Português (Brasil)') && ['Modelo', 'Idioma', 'Fonte', 'A transcrição é feita neste computador; o áudio não sai daqui.'].every((s) => d1.text.includes(s)), d1)
  check('fonte "Faixas de voz · … de áudio"; sem legendas → sem a escolha substituir/preencher; botão "Gerar"', d1.source.startsWith('Faixas de voz · ') && d1.source.endsWith(' de áudio') && !d1.modeShown && d1.start === 'Gerar', d1)
  await shot('g2-captions-01-dialogo.png')

  // ------------------------------------------------------------------ 2
  console.log('2. download do small: progresso e Cancelar sem sobra')
  {
    const r = await ev(`await T.clearToasts(); await T.pickModel('small'); const start = T.gen().querySelector('[data-generate-start]').textContent
      await T.click(T.el('[data-generate-start]'))
      let seenStep = null
      for (let i = 0; i < 300; i++) { const s = T.step(); if (s && /Baixando modelo \\((\\d+) de 488 MB\\)/.test(s) && Number(RegExp.$1) >= 1) { seenStep = s; break } await T.wait(100) }
      return { start, seenStep, bar: !!T.gen().querySelector('[data-generate-progress] [role="progressbar"]'), cancel: !!T.gen().querySelector('[data-generate-cancel]') }`)
    check('small: botão "Baixar modelo e gerar"', r.start === 'Baixar modelo e gerar', r)
    check('progresso "Baixando modelo (x de 488 MB)" com barra e Cancelar', !!r.seenStep && r.bar && r.cancel, r)
    await shot('g2-captions-02-baixando.png')
    const c = await ev(`await T.click(T.el('[data-generate-cancel]')); const toast = await T.waitToast((t) => t.includes('Geração de legendas cancelada'), 15000)
      for (let i = 0; i < 50 && T.gen()?.querySelector('[data-generate-progress]'); i++) await T.wait(100)
      return { toast, progress: !!T.gen()?.querySelector('[data-generate-progress]'), status: T.gen()?.querySelector('[data-model-option="small"]')?.textContent, caps: T.caps().length }`)
    await sleep(800)
    const left = readdirSync(MODELS).filter((f) => f.startsWith('ggml-small'))
    check('Cancelar: toast "Geração de legendas cancelada", progresso some, nada aplicado', !!c.toast && !c.progress && c.caps === 0, c)
    check('nenhum ggml-small.bin/.part deixado em test-out/whisper-models', left.length === 0, left)
    check('small continua "precisa baixar"', c.status?.includes('precisa baixar (488 MB)'), c.status)
  }

  // ------------------------------------------------------------------ 3
  console.log('3. Gerar (base, pt)')
  let generated
  {
    const p0 = await ev(`await T.clearToasts(); await T.pickModel('base'); return T.past()`)
    const t0 = Date.now()
    const r = await ev(`await T.click(T.el('[data-generate-start]'))
      let shotStep = null
      for (let i = 0; i < 1200; i++) { const s = T.step(); if (s && s.startsWith('Transcrevendo')) { shotStep = s; break } if (!T.gen()) break; await T.wait(100) }
      return { shotStep }`)
    if (r.shotStep) await shot('g2-captions-03-transcrevendo.png')
    const done = await ev(`const toast = await T.waitToast((t) => /legendas? geradas?/.test(t) || t.includes('Nenhuma fala') || t.includes('Não foi possível'), 240000); await T.wait(200)
      return { toast, open: !!T.gen(), caps: T.caps(), past: T.past() }`)
    console.log(`  geração: ${((Date.now() - t0) / 1000).toFixed(1)} s; passo visto: ${r.shotStep}; toast: ${done.toast}`)
    generated = done.caps
    check('progresso "Transcrevendo (n%)" apareceu', !!r.shotStep && /^Transcrevendo \(\d+%\)$/.test(r.shotStep), r)
    check(`toast "${done.caps.length} legendas geradas" e diálogo fechado`, !!done.toast && done.toast.includes(`${done.caps.length} legendas geradas`) && !done.open && done.caps.length > 3, done.toast)
    check('aplicado em UM passo de desfazer', done.past === p0 + 1, { p0, past: done.past })
    const bad = []
    for (let k = 0; k < generated.length; k++) {
      const c = generated[k]
      const lines = c.text.split('\n')
      const dur = c.e - c.s
      if (lines.length > 2) bad.push(['linhas', c])
      for (const l of lines) if (l.length > 42 && l.includes(' ')) bad.push(['> 42 caracteres', c])
      if (dur < 700_000 || dur > 6_000_000) bad.push(['duração', dur, c])
      if (k > 0 && c.s < generated[k - 1].e) bad.push(['sobreposição', generated[k - 1], c])
    }
    check('cues: ≤ 2 linhas, ≤ 42 caracteres/linha, 0,7–6 s, em ordem e sem sobreposição', bad.length === 0, bad)
    const endLimit = await ev(`return T.ops().nonCaptionContentEndUs(T.st().project)`)
    check('nenhuma legenda passa do fim do vídeo', generated.every((c) => c.e <= endLimit), { endLimit, last: generated.at(-1) })
    // palavras em ordem e o tempo de cada uma dentro da cue que a contém
    const capWords = []
    generated.forEach((c, ci) => { for (const w of c.text.split(/\s+/)) { const n = norm(w); if (n) capWords.push({ n, ci }) } })
    const al = alignInOrder(truthTl, capWords)
    const matched = al.filter((x) => x >= 0).length
    const ratio = matched / truthTl.length
    console.log(`  palavras da verdade presentes em ordem: ${matched}/${truthTl.length} (${(ratio * 100).toFixed(1)} %)`)
    check('≥ 80 % das palavras da verdade nas legendas, em ordem', ratio >= 0.8, { matched, total: truthTl.length })
    const off = []
    al.forEach((ci, i) => {
      if (ci < 0) return
      const c = generated[capWords[ci].ci]
      const t = truthTl[i].t
      if (t < c.s - 300_000 || t > c.e + 300_000) off.push({ word: truthTl[i].text, t: t / S, cue: [c.s / S, c.e / S, c.text] })
    })
    console.log(`  palavras fora da sua cue (> 0,3 s): ${off.length}`)
    check('cada palavra casada está dentro (± 0,3 s) da cue que a contém (posição mapeada pelo 2× e pelo corte)', off.length === 0, off.slice(0, 6))
    // palavras dentro do trecho 2× aparecem na metade do tempo da fonte
    const fast = truthTl.filter((w, i) => al[i] >= 0 && w.src >= t1 + 500_000 && w.src < t2 - 500_000)
    check('há palavras casadas dentro do trecho 2×', fast.length >= 5, fast.length)
    await ev(`const c = T.caps()[Math.min(3, T.caps().length - 1)]; await T.seek(Math.round((c.s + c.e) / 2)); return 1`)
    await shot('g2-captions-04-geradas.png')
  }

  // ------------------------------------------------------------------ 4
  console.log('4. um Ctrl+Z tira todas; refazer volta')
  {
    const r = await ev(`document.activeElement?.blur?.(); await T.key('z', { ctrlKey: true }); await T.wait(200); const undone = T.caps().length
      await T.key('z', { ctrlKey: true, shiftKey: true }); await T.wait(200); const redone = T.caps()
      return { undone, redone: redone.length, same: JSON.stringify(redone.map((c) => [c.s, c.e, c.text])) }`)
    check('desfazer uma vez: nenhuma legenda', r.undone === 0, r)
    check('refazer: as mesmas legendas de volta', r.redone === generated.length && r.same === JSON.stringify(generated.map((c) => [c.s, c.e, c.text])), r.redone)
  }

  // ------------------------------------------------------------------ 5
  console.log('5. "Só onde não há legenda" com uma legenda manual')
  let manual
  {
    // volta a zero, cria uma manual no meio da fala e gera de novo só nos buracos
    const target = generated[Math.floor(generated.length / 2)]
    const m = await ev(`await T.key('z', { ctrlKey: true }); await T.wait(200); await T.seek(${target.s + 100_000}); await T.click(T.el('[data-caption-add]')); await T.wait(200)
      document.activeElement?.blur?.(); await T.settle(); return T.caps()`)
    manual = m[0]
    check('uma legenda manual criada', m.length === 1, m)
    const r = await ev(`await T.clearToasts(); await T.openGenerate(); const g = T.gen(); const modes = T.all('[data-generate-mode]', g).map((x) => x.textContent.trim())
      await T.pickMode('fill'); const p0 = T.past(); await T.click(T.el('[data-generate-start]'))
      const toast = await T.waitToast((t) => /legendas? geradas?/.test(t) || t.includes('Nenhuma') || t.includes('Não foi possível'), 240000); await T.wait(200)
      return { modes, toast, caps: T.caps(), past: T.past(), p0 }`)
    const kept = r.caps.find((c) => c.id === manual.id)
    const overlapping = r.caps.filter((c) => c.id !== manual.id && c.s < manual.e && c.e > manual.s)
    check('escolha "Substituir as atuais" / "Só onde não há legenda" aparece com legendas', JSON.stringify(r.modes) === JSON.stringify(['Substituir as atuais', 'Só onde não há legenda']), r.modes)
    check('manual mantida intacta; nenhuma gerada sobre ela', !!kept && kept.s === manual.s && kept.e === manual.e && kept.text === manual.text && overlapping.length === 0, { kept, manual, overlapping })
    check('toast com geradas e puladas; um passo', !!r.toast && /\d+ legendas? geradas? · \d+ puladas? \(já havia legenda\)/.test(r.toast) && r.past === r.p0 + 1, r.toast)
  }

  // ------------------------------------------------------------------ 6
  console.log('6. cancelar durante a transcrição')
  {
    const r = await ev(`await T.clearToasts(); const before = JSON.stringify(T.caps()); const p0 = T.past(); await T.openGenerate(); await T.pickMode('replace')
      await T.click(T.el('[data-generate-start]'))
      let s = null
      for (let i = 0; i < 600; i++) { s = T.step(); if (s && s.startsWith('Transcrevendo')) break; await T.wait(50) }
      const focusOnCancel = document.activeElement === T.el('[data-generate-cancel]')
      await T.click(T.el('[data-generate-cancel]'))
      const toast = await T.waitToast((t) => t.includes('Geração de legendas cancelada'), 20000)
      await T.wait(1500)
      return { s, focusOnCancel, toast, same: JSON.stringify(T.caps()) === before, past: T.past(), p0, open: !!T.gen(), running: !!T.gen()?.querySelector('[data-generate-progress]') }`)
    check(`cancelado em "${r.s}" (Transcrevendo): foco no Cancelar, toast, nada aplicado, nenhum passo novo`, /^Transcrevendo/.test(r.s || '') && r.focusOnCancel === true && !!r.toast && r.same && r.past === r.p0 && !r.running, r)
    // Esc com o diálogo aberto (parado) fecha
    const esc = await ev(`T.dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); await T.wait(300); return !!T.gen()`)
    check('Esc fecha o diálogo', esc === false, esc)
  }

  // ------------------------------------------------------------------ 7
  console.log('7. Transcrição: busca, clique leva o playhead, copiar')
  {
    const word = truthTl.find((w) => w.n === norm(SEARCH_WORD))
    const r = await ev(`const seg = T.all('[role="radio"]', T.panel()).find((b) => b.textContent.trim() === 'Transcrição'); await T.click(seg); await T.wait(200)
      const view = T.el('[data-transcript-view]'); const input = T.el('[data-transcript-search]')
      T.setValue(input, 'MANUTENCAO'); await T.wait(300); await T.settle()
      const marks = T.all('mark[data-transcript-match]', view)
      const count = view.querySelector('[data-transcript-count]')?.textContent
      const w = marks[0]?.closest('[data-transcript-word]')
      await T.seek(0)
      if (w) { await T.click(w); await T.wait(500) }
      return { marks: marks.map((m) => m.textContent), count, word: w?.textContent ?? null, ph: T.st().playheadUs, rows: T.all('[data-transcript-row]', view).length }`)
    check('busca "MANUTENCAO" (sem acento) destaca "manutenção"', r.marks.length >= 1 && r.marks.every((m) => norm(m) === 'manutencao') && /ocorrência/.test(r.count ?? ''), r)
    check('uma linha por legenda ativa', r.rows === (await ev(`return T.caps().filter((c) => c.enabled).length`)), r.rows)
    check(`clique na palavra leva o playhead a ± 0,5 s do instante dela (${word ? (word.t / S).toFixed(2) : '?'} s)`, !!word && Math.abs(r.ph - word.t) <= 500_000, { ph: r.ph / S, want: word ? word.t / S : null })
    await shot('g2-captions-05-transcricao-busca.png')
    const c = await ev(`window.focus(); await T.clearToasts(); try { await navigator.clipboard.writeText('x') } catch {}
      await T.click(T.el('[data-transcript-copy]')); const toast = await T.waitToast((t) => t.includes('Transcrição copiada'), 5000)
      let clip; try { clip = (await navigator.clipboard.readText()).replace(/\\r\\n/g, '\\n') } catch (e) { clip = 'ERRO: ' + e.message }
      const p2 = (n) => String(n).padStart(2, '0'); const clock = (us) => { const s = Math.floor(us / 1e6); return p2(Math.floor(s / 60)) + ':' + p2(s % 60) }
      const want = T.caps().filter((x) => x.enabled).map((x) => clock(x.s) + ' ' + x.text.replace(/\\s+/g, ' ').trim()).join('\\n')
      return { toast, ok: clip === want, clip: clip.slice(0, 200), want: want.slice(0, 200) }`)
    check('"Copiar transcrição": toast e área de transferência com "mm:ss texto" por legenda', !!c.toast && c.ok, c)
    await ev(`T.setValue(T.el('[data-transcript-search]'), ''); const seg = T.all('[role="radio"]', T.panel()).find((b) => b.textContent.trim() === 'Lista'); await T.click(seg); return 1`)
  }

  // ------------------------------------------------------------------ 8
  console.log('8. exportar SRT com as legendas geradas')
  {
    const r = await ev(`await T.clearToasts(); await T.click(T.el('[data-caption-export]')); const toast = await T.waitToast((t) => t.includes('exportada'), 8000)
      return { toast, cues: T.caps().filter((c) => c.enabled).map((c) => ({ startUs: c.s, endUs: c.e, text: c.text })) }`)
    const p2 = (n, w = 2) => String(n).padStart(w, '0')
    const srtTime = (us) => { const t = Math.round(us / 1000); return `${p2(Math.floor(t / 3_600_000))}:${p2(Math.floor(t / 60_000) % 60)}:${p2(Math.floor(t / 1000) % 60)},${p2(t % 1000, 3)}` }
    const want = r.cues.map((c, i) => `${i + 1}\r\n${srtTime(c.startUs)} --> ${srtTime(c.endUs)}\r\n${c.text.split('\n').join('\r\n')}\r\n`).join('\r\n')
    const got = existsSync(SRT_OUT) ? readFileSync(SRT_OUT) : null
    const text = got ? got.subarray(got[0] === 0xef ? 3 : 0).toString('utf8') : null
    check(`toast "${r.cues.length} legendas exportadas" e SRT gravado com o conteúdo esperado`, !!r.toast && text === want, { toast: r.toast, got: text?.slice(0, 200), want: want.slice(0, 200) })
  }
}

let truth = null
const settings = guardSettings(SETTINGS)
try {
  truth = await makeMedia()
  console.log(`fala sintética: ${(truth.durationUs / S).toFixed(2)} s, ${truth.words.length} palavras`)
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, CIALIGHT_QA: 'g2-captions', CIALIGHT_RAW_DIR: RAW_REL, CIALIGHT_WHISPER_MODELS_DIR: MODELS_REL, CIALIGHT_QA_SRT_SAVE: SRT_OUT },
    stdio: 'ignore'
  })
  await main(truth)
} catch (e) {
  failures++
  console.error('falhou:', e)
  try {
    await shot('g2-captions-erro.png')
  } catch {
    // sem janela
  }
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
  await sleep(800)
  // o small nunca fica (o teste cancelou; se algo escapou, apaga por caminho explícito)
  for (const f of [SMALL, `${SMALL}.ok`, `${SMALL}.part`]) rmSync(f, { force: true })
  failures += settings.finish()
  console.log(failures ? `\n${failures} falha(s) em ${checks} verificações` : `\ntudo OK (${checks} verificações)`)
  process.exit(failures ? 1 : 0)
}
