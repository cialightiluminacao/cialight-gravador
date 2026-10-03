// Spike G3 — mede Windows.Media.Ocr via helper PowerShell persistente (ocr-winrt.ps1).
// Quadros: ffmpeg decodifica o PNG do corpus para bytes crus em MEMÓRIA (pipe) → stdin do helper. Sem arquivos temporários.
// Uso: node docs/research/spike/g3-ocr/bench-winrt.mjs [--variants png,h264] [--scales 1,2] [--fmt gray8] [--reps 1] [--lang pt-BR] [--flags lanczos]
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { loadTruth, scoreScreen, aggregate, printTable, median } from './metrics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../..')
const FFMPEG = join(ROOT, 'resources/ffmpeg/ffmpeg.exe')
const CORPUS = join(ROOT, 'test-out/g3-ocr/corpus')
const RES = join(ROOT, 'test-out/g3-ocr/results')
mkdirSync(RES, { recursive: true })

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const variants = arg('variants', 'png,h264').split(',')
const scales = arg('scales', '1,2').split(',').map(Number)
const fmt = arg('fmt', 'gray8')
const reps = Number(arg('reps', '1'))
const lang = arg('lang', 'pt-BR')
const flags = arg('flags', 'lanczos')

export class WinOcrHelper {
  constructor(lang) {
    const t0 = performance.now()
    this.proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'ocr-winrt.ps1'), '-Lang', lang], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    this.pending = new Map()
    this.nextId = 1
    this.ready = new Promise((res, rej) => {
      const rl = createInterface({ input: this.proc.stdout })
      rl.on('line', (line) => {
        const m = JSON.parse(line)
        if ('ready' in m) { m.wallStartMs = performance.now() - t0; return m.ready ? res(m) : rej(new Error(m.error)) }
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        p?.(m)
      })
      this.proc.on('exit', (c) => rej(new Error(`helper saiu (${c})`)))
    })
  }
  recognize(buf, w, h, fmt) {
    const id = this.nextId++
    const t0 = performance.now()
    return new Promise((res) => {
      this.pending.set(id, (m) => { m.wallMs = performance.now() - t0; res(m) })
      this.proc.stdin.write(JSON.stringify({ id, w, h, fmt, len: buf.length }) + '\n')
      this.proc.stdin.write(buf)
    })
  }
  quit() { this.proc.stdin.write('{"cmd":"quit"}\n'); this.proc.stdin.end() }
}

export function decodeRaw(file, scale, pixFmt, flags = 'lanczos') {
  const t0 = performance.now()
  const vf = scale === 1 ? [] : ['-vf', `scale=iw*${scale}:ih*${scale}:flags=${flags}`]
  return new Promise((res, rej) => execFile(FFMPEG, ['-v', 'error', '-i', file, ...vf, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'],
    { encoding: 'buffer', maxBuffer: 256 << 20 }, (e, out) => (e ? rej(e) : res({ buf: out, ms: performance.now() - t0 }))))
}

async function main() {
  const truth = loadTruth(join(CORPUS, 'truth.json'))
  const helper = new WinOcrHelper(lang)
  const ready = await helper.ready
  console.log(`helper pronto: lang=${ready.lang} maxDim=${ready.maxDim} partida interna=${ready.startMs} ms, parede=${ready.wallStartMs.toFixed(0)} ms`)
  const summary = { engine: 'winrt', lang, fmt, flags, startup: ready, runs: [] }
  // aquecimento (1º reconhecimento carrega o modelo)
  {
    const { buf } = await decodeRaw(join(CORPUS, 'png', `${truth.screens[0].name}.png`), 1, fmt === 'bgra8' ? 'bgra' : 'gray')
    const m = await helper.recognize(buf, 1920, 1080, fmt)
    if (!m.ok) throw new Error(m.error)
    summary.warmupMs = m.ms
    console.log(`aquecimento: ocr=${m.ms.ocr} ms`)
  }
  for (const variant of variants) for (const scale of scales) for (let rep = 0; rep < reps; rep++) {
    const recs = []
    const times = { decode: [], read: [], ocr: [], wall: [] }
    const raw = {}
    for (const s of truth.screens) {
      const { buf, ms } = await decodeRaw(join(CORPUS, variant, `${s.name}.png`), scale, fmt === 'bgra8' ? 'bgra' : 'gray', flags)
      const m = await helper.recognize(buf, 1920 * scale, 1080 * scale, fmt)
      if (!m.ok) throw new Error(`${s.name}: ${m.error}`)
      times.decode.push(ms); times.read.push(m.ms.read); times.ocr.push(m.ms.ocr); times.wall.push(m.wallMs)
      raw[s.name] = m.lines
      recs.push(...scoreScreen(truth.items.filter((i) => i.screen === s.name), m, scale))
    }
    const t = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, median(v)]))
    const tag = `${variant} ×${scale} ${fmt} rep${rep + 1}`
    console.log(`\n=== ${tag}: mediana ms/quadro decode=${t.decode.toFixed(0)} leitura=${t.read.toFixed(0)} ocr=${t.ocr.toFixed(0)} ida-e-volta=${t.wall.toFixed(0)}`)
    const bySize = aggregate(recs, 'size')
    const small = aggregate(recs.filter((r) => r.size <= 14), () => '12-14px')
    const all = aggregate(recs, () => 'todos')
    if (rep === 0) {
      printTable(`${tag} — por tamanho`, [...bySize, ...small, ...all])
      printTable(`${tag} — por categoria`, aggregate(recs, 'cat'))
      printTable(`${tag} — por fonte (12–14px)`, aggregate(recs.filter((r) => r.size <= 14), 'font'))
      printTable(`${tag} — por tema`, aggregate(recs, 'theme'))
      printTable(`${tag} — valor em cor de destaque?`, aggregate(recs, 'accent'))
    }
    summary.runs.push({ variant, scale, rep, times: t, bySize, small, all, byCat: aggregate(recs, 'cat'), byFontSmall: aggregate(recs.filter((r) => r.size <= 14), 'font'), byTheme: aggregate(recs, 'theme'), misses: recs.filter((r) => !r.norm).map((r) => r.id) })
    if (rep === 0) writeFileSync(join(RES, `winrt-${lang}-${variant}-x${scale}-${fmt}-ocr.json`), JSON.stringify({ raw, recs }))
  }
  helper.quit()
  const out = join(RES, `winrt-${lang}-${fmt}-${variants.join('+')}-x${scales.join('+')}-r${reps}.json`)
  writeFileSync(out, JSON.stringify(summary, null, 1))
  console.log(`\nresultados → ${out}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1) })
