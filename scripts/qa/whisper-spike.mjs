// Spike G2: mede o whisper.cpp (CLI) neste PC com fala sintética pt-BR (System.Speech — nunca o microfone).
// Não abre Electron. Tudo em test-out/whisper-spike/. Resultado: test-out/whisper-spike/results.json.
// Uso: node scripts/qa/whisper-spike.mjs [--bin <pasta com whisper-cli.exe>] [--models <pasta>] [--only perf|ts|silence|gap|paths]
//                                       [--threads 8] [--ts-bin cpu|blas|custom]
//   padrão: binário em node_modules/.cache/whisper-spike/{cpu,blas}/Release (zips oficiais extraídos à mão);
//   com --bin resources/whisper usa o binário empacotado (só CPU). Modelos: ggml-base.bin e ggml-small.bin na pasta de --models
//   (baixar do espelho: gh release download deps-whisper-v1.9.4 -R cialightiluminacao/cialight-gravador -p 'ggml-*.bin' -D <pasta>).
// Resultados em docs/research/2026-10-03-whisper-spike.md.
import { execFile, spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { synthSpeech } from './synthSpeech.mjs'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const cache = join(root, 'node_modules', '.cache', 'whisper-spike')
const modelsDir = resolve(arg('--models', cache))
const only = arg('--only', '')
const out = join(root, 'test-out', 'whisper-spike')
mkdirSync(out, { recursive: true })
const ffmpeg = join(root, 'resources', 'ffmpeg', 'ffmpeg.exe')
const bins = arg('--bin') ? { custom: resolve(arg('--bin')) } : { cpu: join(cache, 'cpu', 'Release'), blas: join(cache, 'blas', 'Release') }
const cli = (b) => join(bins[b], 'whisper-cli.exe')
const model = (m) => join(modelsDir, `ggml-${m}.bin`)

// ~60 s: 10 frases, 3 pausas ≥ 1,5 s, números e acentos
export const SSML_PTBR = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-BR">
Bom dia a todos, e sejam bem-vindos à apresentação dos resultados do terceiro trimestre.
Neste período, a equipe atendeu 120 clientes novos em São Paulo e no Paraná.
<break time="1500ms"/>
A produção de luminárias cresceu bastante, e a fábrica operou em dois turnos durante seis semanas.
Na próxima segunda-feira, às 14 horas, vamos revisar o orçamento de iluminação pública.
Também precisamos de atenção com a manutenção preventiva dos equipamentos elétricos.
<break time="2000ms"/>
O relatório completo será enviado por e-mail até o dia 15 de outubro.
Quem tiver dúvidas sobre a importação de peças pode falar comigo depois da reunião.
Lembrem-se de que a segurança vem sempre em primeiro lugar.
<break time="1500ms"/>
Agradeço a participação de vocês e desejo uma ótima semana de trabalho.
Até a próxima, e obrigado pela atenção.
</speak>`

// ---------- utilidades ----------
const cpuSnapshot = () => cpus().map((c) => c.times)
function cpuBusyPct(a, b) {
  let busy = 0, total = 0
  for (let i = 0; i < a.length; i++) {
    const d = (k) => b[i][k] - a[i][k]
    const t = d('user') + d('nice') + d('sys') + d('idle') + d('irq')
    busy += t - d('idle'); total += t
  }
  return total ? (100 * busy) / total : 0
}
async function loadPct(ms = 1000) { const a = cpuSnapshot(); await new Promise((r) => setTimeout(r, ms)); return +cpuBusyPct(a, cpuSnapshot()).toFixed(1) }

function whisper(bin, args, opts = {}) {
  return new Promise((res, rej) => {
    const t0 = process.hrtime.bigint()
    const p = spawn(cli(bin), args, { windowsHide: true, ...opts })
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', rej)
    p.on('close', (code) => res({ code, stdout, stderr, wallMs: Number(process.hrtime.bigint() - t0) / 1e6 }))
  })
}

export function normalize(s) {
  return s.toLowerCase().replace(/[-–—]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

// alinhamento por distância de edição (palavras); devolve pares casados e contagens S/D/I
export function align(ref, hyp) {
  const n = ref.length, m = hyp.length
  const D = Array.from({ length: n + 1 }, (_, i) => Int32Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
  }
  const pairs = []
  let i = n, j = m, S = 0, Del = 0, I = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] === hyp[j - 1]) pairs.push([i - 1, j - 1]); else { S++; pairs.push([i - 1, j - 1, 'sub']) }
      i--; j--
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) { Del++; i-- } else { I++; j-- }
  }
  pairs.reverse()
  return { pairs, S, D: Del, I, N: n, correct: pairs.filter((p) => !p[2]).length }
}

// palavras de verdade-base (texto normalizado pode quebrar 1 palavra em várias: todas herdam o início)
function truthTokens(words) {
  const t = []
  for (const w of words) for (const p of normalize(w.text)) t.push({ text: p, startUs: w.startUs })
  return t
}

// (a) -ojf: tokens BPE → palavras (token que começa com espaço abre palavra; especiais "[_...]" ignorados)
// mode: 'offsets' = offsets.from do token; 'dtw' = t_dtw do próprio token (centésimos de s);
//       'dtwPrev' = t_dtw do token ANTERIOR no mesmo segmento (t_dtw marca o fim do token ≈ início do próximo);
//       o 1º token do segmento usa offsets.from.
export function wordsFromTokens(json, mode = 'offsets') {
  const words = []
  for (const seg of json.transcription) {
    let prevDtw = -1
    for (const tk of seg.tokens ?? []) {
      if (/^\[_.*\]$/.test(tk.text) || /^<\|.*\|>$/.test(tk.text)) continue
      const startMs = mode === 'dtw' ? tk.t_dtw * 10 : mode === 'dtwPrev' && prevDtw >= 0 ? prevDtw * 10 : tk.offsets.from
      prevDtw = tk.t_dtw
      if (tk.text.startsWith(' ') || words.length === 0) words.push({ text: tk.text.trim(), startUs: Math.round(startMs * 1000), p: [tk.p] })
      else { const w = words[words.length - 1]; w.text += tk.text; w.p.push(tk.p) }
    }
  }
  return words
}
// (b) -ml 1 -sow: cada segmento é uma palavra
export function wordsFromSegments(json) {
  return json.transcription.filter((s) => s.text.trim()).map((s) => ({ text: s.text.trim(), startUs: s.offsets.from * 1000 }))
}

function score(truthWords, hypWords) {
  const ref = truthTokens(truthWords)
  const hyp = []
  for (const w of hypWords) for (const p of normalize(w.text)) hyp.push({ text: p, startUs: w.startUs })
  const a = align(ref.map((w) => w.text), hyp.map((w) => w.text))
  const errs = a.pairs.filter((p) => !p[2]).map(([i, j]) => Math.abs(hyp[j].startUs - ref[i].startUs) / 1000).sort((x, y) => x - y)
  const q = (f) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(f * errs.length))] : NaN)
  const subs = a.pairs.filter((p) => p[2]).map(([i, j]) => `${ref[i].text}→${hyp[j].text}`)
  return {
    refWords: a.N, correct: a.correct, accuracyPct: +((100 * a.correct) / a.N).toFixed(1),
    werPct: +((100 * (a.S + a.D + a.I)) / a.N).toFixed(1), S: a.S, D: a.D, I: a.I, subs,
    startErrMs: { n: errs.length, median: q(0.5), p90: q(0.9), max: errs.at(-1), within300: +((100 * errs.filter((e) => e <= 300).length) / Math.max(1, errs.length)).toFixed(1) }
  }
}

// intervalos de fala como na ingestão do app: silencedetect −35 dB / 0,35 s, padding 120 ms
async function speechIntervalsOf(file, durMs) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=n=-35dB:d=0.35', '-f', 'null', '-'])
  const sils = [...stderr.matchAll(/silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g)].map((m) => [Number(m[1]) * 1000, Number(m[2]) * 1000])
  const speech = []
  let cur = 0
  for (const [a, b] of sils) { if (a > cur) speech.push({ fromMs: Math.max(0, cur - 120), toMs: a + 120 }); cur = b }
  if (cur < durMs) speech.push({ fromMs: Math.max(0, cur - 120), toMs: durMs })
  return { silences: sils, speech }
}
// palavra cujo início cai fora da fala → empurra para o início do próximo intervalo de fala; inícios não decrescentes
export function snapToSpeech(words, speech) {
  let last = 0
  return words.map((w) => {
    let ms = w.startUs / 1000
    if (!speech.some((s) => ms >= s.fromMs && ms < s.toMs)) {
      const next = speech.find((s) => s.fromMs > ms)
      if (next) ms = next.fromMs
    }
    ms = Math.max(ms, last)
    last = ms
    return { ...w, startUs: Math.round(ms * 1000) }
  })
}

// filtro: (1) segmento só com anotação entre colchetes/parênteses ("[Música]", "(risos)") → descarta;
//         (2) segmento com < 50 % dos tokens (t_dtw) dentro de fala (silencedetect −35 dB / 0,35 s, padding 120 ms, como a ingestão) → descarta.
//         (a sobreposição do intervalo do segmento é só informativa: os offsets do segmento invadem a pausa.)
export const isAnnotationOnly = (text) => /^\s*([[(*♪].*[\])*♪]\s*)+$/u.test(text)
export function tokenSpeechRatio(seg, speech) {
  const toks = (seg.tokens ?? []).filter((t) => !/^\[_.*\]$/.test(t.text) && t.t_dtw >= 0)
  if (!toks.length) return 0
  return toks.filter((t) => speech.some((s) => t.t_dtw * 10 >= s.fromMs && t.t_dtw * 10 < s.toMs)).length / toks.length
}
export function speechOverlapRatio(fromMs, toMs, speech) {
  const len = Math.max(1, toMs - fromMs)
  let inter = 0
  for (const s of speech) inter += Math.max(0, Math.min(toMs, s.toMs) - Math.max(fromMs, s.fromMs))
  return inter / len
}

const results = existsSync(join(out, 'results.json')) ? JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) : {}
const save = () => writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))

// ---------- amostra ----------
const wav = join(out, 'ptbr.wav')
let speech
if (!existsSync(`${wav}.words.json`)) speech = await synthSpeech({ ssmlOrText: SSML_PTBR, voice: 'pt-BR', outWav: wav })
else speech = { wav, ...JSON.parse(readFileSync(`${wav}.words.json`, 'utf8')) }
const audioS = speech.durationUs / 1e6
console.log(`amostra: ${audioS.toFixed(2)} s, ${speech.words.length} palavras`)
results.sample = { durationS: audioS, words: speech.words.length }

// ---------- desempenho ----------
if (!only || only === 'perf') {
  results.perf = []
  // greedy (-bs 1 -bo 1) em todas as combinações; beam 5 (padrão do whisper-cli) só como referência (cpu, 8 threads)
  const combos = []
  for (const bin of Object.keys(bins)) for (const m of ['base', 'small']) for (const t of [4, 8, 12]) combos.push({ bin, m, t, decode: 'greedy' })
  for (const m of ['base', 'small']) combos.push({ bin: Object.keys(bins)[0], m, t: 8, decode: 'beam5' })
  // modelo final: greedy + DTW (exige -nfa)
  for (const m of ['base', 'small']) for (const t of [4, 8, 12]) combos.push({ bin: Object.keys(bins)[0], m, t, decode: 'final' })
  for (const rep of [1, 2]) for (const { bin, m, t, decode } of combos) {
    const load = await loadPct()
    const dec = decode === 'greedy' ? ['-bs', '1', '-bo', '1'] : decode === 'final' ? ['-bs', '1', '-bo', '1', '--dtw', m, '-nfa'] : []
    const r = await whisper(bin, ['-m', model(m), '-f', wav, '-l', 'pt', '-t', String(t), ...dec, '-np', '-oj', '-of', join(out, `perf-${bin}-${m}-t${t}-${decode}`)])
    if (r.code !== 0) throw new Error(`whisper falhou (${bin} ${m} t${t}): ${r.stderr.slice(-500)}`)
    const json = JSON.parse(readFileSync(join(out, `perf-${bin}-${m}-t${t}-${decode}.json`), 'utf8'))
    const acc = score(speech.words, wordsFromSegments({ transcription: json.transcription.map((x) => ({ ...x, offsets: { from: 0 } })) }))
    const row = { bin, model: m, threads: t, decode, rep, accuracyPct: acc.accuracyPct, werPct: acc.werPct, wallS: +(r.wallMs / 1000).toFixed(2), rtf: +(audioS / (r.wallMs / 1000)).toFixed(2), loadBeforePct: load }
    console.log(JSON.stringify(row)); results.perf.push(row); save()
  }
}

// ---------- precisão + carimbos de palavra ----------
const T = Number(arg('--threads', '8'))
const tsBin = arg('--ts-bin', Object.keys(bins)[0])
if (!only || only === 'ts') {
  results.ts = {}
  for (const m of ['base', 'small']) {
    const base = ['-m', model(m), '-f', wav, '-l', 'pt', '-t', String(T), '-bs', '1', '-bo', '1', '-np']
    const variants = {
      ojf: [...base, '-ojf', '-of', join(out, `ts-${m}-ojf`)],
      ml1sow: [...base, '-ml', '1', '-sow', '-oj', '-of', join(out, `ts-${m}-ml1sow`)],
      dtw: [...base, '-ojf', '--dtw', m, '-nfa', '-of', join(out, `ts-${m}-dtw`)], // DTW exige -nfa (com flash attn, t_dtw = -1)
      nfa: [...base, '-ojf', '-nfa', '-of', join(out, `ts-${m}-nfa`)] // custo do -nfa isolado
    }
    results.ts[m] = {}
    for (const [k, a] of Object.entries(variants)) {
      const r = await whisper(tsBin, a)
      if (r.code !== 0) { results.ts[m][k] = { error: r.stderr.slice(-400) }; continue }
      const json = JSON.parse(readFileSync(`${a.at(-1)}.json`, 'utf8'))
      const words = k === 'ml1sow' ? wordsFromSegments(json) : wordsFromTokens(json, k === 'dtw' ? 'dtw' : 'offsets')
      results.ts[m][k] = { wallS: +(r.wallMs / 1000).toFixed(2), ...score(speech.words, words) }
      // dtw: também mede t_dtw do token anterior e os offsets normais do mesmo JSON
      if (k === 'dtw') {
        results.ts[m].dtwPrev = { wallS: results.ts[m][k].wallS, ...score(speech.words, wordsFromTokens(json, 'dtwPrev')) }
        results.ts[m].dtwOffsets = score(speech.words, wordsFromTokens(json, 'offsets'))
        const sp = await speechIntervalsOf(wav, speech.durationUs / 1000)
        results.ts[m].dtwPrevSnap = { wallS: results.ts[m][k].wallS, ...score(speech.words, snapToSpeech(wordsFromTokens(json, 'dtwPrev'), sp.speech)) }
        console.log(m, 'dtwPrevSnap', JSON.stringify({ ...results.ts[m].dtwPrevSnap, subs: undefined }))
        console.log(m, 'dtwPrev', JSON.stringify({ ...results.ts[m].dtwPrev, subs: undefined }))
      }
      console.log(m, k, JSON.stringify({ ...results.ts[m][k], subs: undefined }))
      save()
    }
  }
}

// ---------- silêncio / ruído ----------
if (!only || only === 'silence') {
  const sil = join(out, 'silence10.wav'), noise = join(out, 'noise10.wav')
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '10', '-c:a', 'pcm_s16le', sil])
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=r=16000:c=pink:a=0.003:s=7', '-t', '10', '-ac', '1', '-c:a', 'pcm_s16le', noise])
  results.silence = []
  for (const [name, f] of [['silence', sil], ['noise', noise]]) for (const m of ['base', 'small']) for (const [fl, extra] of [['default', []], ['sns', ['-sns']], ['nth0.3', ['-nth', '0.3']], ['sns+nf', ['-sns', '-nf']]]) {
    const ofp = join(out, `sil-${name}-${m}-${fl}`)
    const r = await whisper(tsBin, ['-m', model(m), '-f', f, '-l', 'pt', '-t', String(T), '-bs', '1', '-bo', '1', '--dtw', m, '-nfa', '-np', '-ojf', ...extra, '-of', ofp])
    const iv = await speechIntervalsOf(f, 10000)
    const json = r.code === 0 ? JSON.parse(readFileSync(`${ofp}.json`, 'utf8')) : null
    const segs = (json?.transcription ?? []).map((s) => {
      const toks = (s.tokens ?? []).filter((t) => !/^\[_.*\]$/.test(t.text))
      const avgP = toks.length ? toks.reduce((a, t) => a + t.p, 0) / toks.length : 0
      const ratio = speechOverlapRatio(s.offsets.from, s.offsets.to, iv.speech)
      const drop = isAnnotationOnly(s.text) ? 'annotation' : tokenSpeechRatio(s, iv.speech) < 0.5 ? 'outsideSpeech' : null
      return { text: s.text.slice(0, 120), from: s.offsets.from, to: s.offsets.to, avgP: +avgP.toFixed(3), minP: +Math.min(...toks.map((t) => t.p), 1).toFixed(3), nTok: toks.length, speechRatio: +ratio.toFixed(2), tokenSpeechRatio: +tokenSpeechRatio(s, iv.speech).toFixed(2), drop }
    })
    const row = { input: name, model: m, flags: fl, code: r.code, segments: segs }
    console.log(JSON.stringify(row)); results.silence.push(row); save()
  }
  // mesma estatística (avgP/minP por segmento) na fala, para escolher um limiar que não corte fala real
  results.speechSegP = {}
  for (const m of ['base', 'small']) {
    const f = join(out, `ts-${m}-ojf.json`)
    if (!existsSync(f)) continue
    const json = JSON.parse(readFileSync(f, 'utf8'))
    results.speechSegP[m] = json.transcription.map((s) => {
      const toks = (s.tokens ?? []).filter((t) => !/^\[_.*\]$/.test(t.text))
      return { text: s.text.trim().slice(0, 40), avgP: +(toks.reduce((a, t) => a + t.p, 0) / toks.length).toFixed(3), minP: +Math.min(...toks.map((t) => t.p)).toFixed(3) }
    })
  }
  save()
}

// ---------- lacuna dentro da fala + filtro recomendado ----------
// fala (0–17 s) + 10 s de silêncio digital + 10 s de ruído rosa baixo + fala (17–34 s)
if (!only || only === 'gap') {
  const sil = join(out, 'silence10.wav'), noise = join(out, 'noise10.wav'), gap = join(out, 'gap.wav')
  if (!existsSync(sil)) await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '10', '-c:a', 'pcm_s16le', sil])
  if (!existsSync(noise)) await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=r=16000:c=pink:a=0.003:s=7', '-t', '10', '-ac', '1', '-c:a', 'pcm_s16le', noise])
  await run(ffmpeg, ['-y', '-v', 'error', '-i', wav, '-i', sil, '-i', noise, '-filter_complex',
    '[0:a]atrim=0:17,asetpts=N/SR/TB[a];[0:a]atrim=17:34,asetpts=N/SR/TB[b];[a][1:a][2:a][b]concat=n=4:v=0:a=1[o]', '-map', '[o]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', gap])
  const { silences: sils, speech: speechIv } = await speechIntervalsOf(gap, 54000)
  results.gap = { silences: sils, speech: speechIv, runs: [] }
  for (const m of ['base', 'small']) {
    const ofp = join(out, `gap-${m}`)
    const r = await whisper(tsBin, ['-m', model(m), '-f', gap, '-l', 'pt', '-t', String(T), '-bs', '1', '-bo', '1', '-np', '-ojf', '--dtw', m, '-nfa', '-of', ofp])
    const json = JSON.parse(readFileSync(`${ofp}.json`, 'utf8'))
    const segs = json.transcription.map((s) => {
      const ratio = speechOverlapRatio(s.offsets.from, s.offsets.to, speechIv)
      const drop = isAnnotationOnly(s.text) ? 'annotation' : tokenSpeechRatio(s, speechIv) < 0.5 ? 'outsideSpeech' : null
      return { from: s.offsets.from, to: s.offsets.to, text: s.text.trim().slice(0, 80), speechRatio: +ratio.toFixed(2), tokenSpeechRatio: +tokenSpeechRatio(s, speechIv).toFixed(2), drop }
    })
    // verdade da lacuna: palavras de 0–17 s iguais; de 17–34 s deslocadas +20 s
    const truthGap = speech.words.filter((w) => w.startUs < 34e6).map((w) => (w.startUs >= 17e6 ? { ...w, startUs: w.startUs + 20e6 } : w))
    const kept = { ...json, transcription: json.transcription.filter((s, i) => !segs[i].drop) }
    const scores = {
      dtwPrev: score(truthGap, wordsFromTokens(kept, 'dtwPrev')),
      dtwPrevSnap: score(truthGap, snapToSpeech(wordsFromTokens(kept, 'dtwPrev'), speechIv)),
      offsets: score(truthGap, wordsFromTokens(kept, 'offsets'))
    }
    for (const [k, v] of Object.entries(scores)) console.log(m, 'gap', k, JSON.stringify({ ...v, subs: undefined }))
    results.gap.runs.push({ model: m, code: r.code, segments: segs, scores })
    console.log(m, JSON.stringify(segs, null, 1)); save()
  }
}

// ---------- caminhos com acento e espaço ----------
if (!only || only === 'paths') {
  const dir = join(out, 'ação com espaço')
  mkdirSync(dir, { recursive: true })
  const m2 = join(dir, 'modelo é.bin'), w2 = join(dir, 'fala ção.wav')
  if (!existsSync(m2)) copyFileSync(model('base'), m2)
  copyFileSync(wav, w2)
  const r = await whisper(tsBin, ['-m', m2, '-f', w2, '-l', 'pt', '-t', String(T), '-np', '-oj', '-of', join(dir, 'saída ç')])
  const okOut = existsSync(join(dir, 'saída ç.json'))
  results.paths = { absoluteUnicode: { code: r.code, outputWritten: okOut, stderrTail: r.stderr.slice(-300) } }
  // achado: só o caminho do MODELO com não-ASCII derruba o whisper-cli (0xC0000409); wav e -of aceitam Unicode.
  // contorno: cwd = pasta do modelo + nome relativo ASCII; wav/saída continuam absolutos com acento e espaço.
  const mAscii = join(dir, 'ggml-base.bin')
  if (!existsSync(mAscii)) copyFileSync(model('base'), mAscii)
  const r2 = await whisper(tsBin, ['-m', 'ggml-base.bin', '-f', w2, '-l', 'pt', '-t', String(T), '-np', '-oj', '-of', join(dir, 'saída rel')], { cwd: dir })
  results.paths.cwdModelRelative = { code: r2.code, outputWritten: existsSync(join(dir, 'saída rel.json')), stderrTail: r2.stderr.slice(-300) }
  // isolando: modelo ASCII absoluto fora da pasta acentuada + wav/saída com acento
  const r3 = await whisper(tsBin, ['-m', model('base'), '-f', w2, '-l', 'pt', '-t', String(T), '-np', '-oj', '-of', join(dir, 'saída abs')])
  results.paths.asciiModelUnicodeWavOut = { code: r3.code, outputWritten: existsSync(join(dir, 'saída abs.json')) }
  console.log(JSON.stringify(results.paths)); save()
}
console.log(`ok → ${join(out, 'results.json')}`)
