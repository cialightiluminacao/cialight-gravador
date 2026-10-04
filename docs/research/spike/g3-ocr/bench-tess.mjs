// Spike G3 — mede tesseract.js (WASM) no mesmo corpus. tesseract.js fica instalado FORA do package.json do repo:
//   cd test-out/g3-ocr/tess && npm init -y && npm i tesseract.js
//   + por/eng.traineddata.gz (4.0.0_best_int) baixados uma vez em test-out/g3-ocr/tess/lang (sem CDN em tempo de execução)
// Uso: node docs/research/spike/g3-ocr/bench-tess.mjs [--variants png] [--scales 1,2] [--psm 3] [--langs por+eng] [--reps 1]
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTruth, scoreScreen, aggregate, printTable, median } from './metrics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../..')
const TESS = join(ROOT, 'test-out/g3-ocr/tess')
const FFMPEG = join(ROOT, 'resources/ffmpeg/ffmpeg.exe')
const CORPUS = join(ROOT, 'test-out/g3-ocr/corpus')
const RES = join(ROOT, 'test-out/g3-ocr/results')
mkdirSync(RES, { recursive: true })
const { createWorker, OEM } = createRequire(join(TESS, 'package.json'))('tesseract.js')

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const variants = arg('variants', 'png').split(',')
const scales = arg('scales', '1,2').split(',').map(Number)
const psm = arg('psm', '3')
const langs = arg('langs', 'por+eng').split('+')
const reps = Number(arg('reps', '1'))

// quadro → BMP em memória (pipe do ffmpeg); o tesseract.js decodifica com leptonica
function decodeBmp(file, scale) {
  const t0 = performance.now()
  const vf = scale === 1 ? [] : ['-vf', `scale=iw*${scale}:ih*${scale}:flags=lanczos`]
  return new Promise((res, rej) => execFile(FFMPEG, ['-v', 'error', '-i', file, ...vf, '-pix_fmt', 'gray', '-f', 'image2pipe', '-c:v', 'bmp', '-'],
    { encoding: 'buffer', maxBuffer: 256 << 20 }, (e, out) => (e ? rej(e) : res({ buf: out, ms: performance.now() - t0 }))))
}

function toLines(data) {
  const lines = []
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    const w = l.words.map((x) => [x.text, x.bbox.x0, x.bbox.y0, x.bbox.x1 - x.bbox.x0, x.bbox.y1 - x.bbox.y0])
    lines.push({ t: w.map((x) => x[0]).join(' '), w })
  }
  return lines
}

async function main() {
  const truth = loadTruth(join(CORPUS, 'truth.json'))
  const t0 = performance.now()
  const worker = await createWorker(langs, OEM.LSTM_ONLY, { langPath: join(TESS, 'lang'), cacheMethod: 'none', gzip: true })
  await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' })
  const startMs = performance.now() - t0
  console.log(`tesseract.js pronto em ${startMs.toFixed(0)} ms (langs=${langs.join('+')}, psm=${psm})`)
  const summary = { engine: 'tesseract.js', langs, psm, startMs, runs: [] }
  for (const variant of variants) for (const scale of scales) for (let rep = 0; rep < reps; rep++) {
    const recs = []
    const times = { decode: [], ocr: [] }
    const raw = {}
    for (const s of truth.screens) {
      const { buf, ms } = await decodeBmp(join(CORPUS, variant, `${s.name}.png`), scale)
      const t1 = performance.now()
      const { data } = await worker.recognize(buf, {}, { blocks: true, text: false })
      times.decode.push(ms); times.ocr.push(performance.now() - t1)
      raw[s.name] = toLines(data)
      recs.push(...scoreScreen(truth.items.filter((i) => i.screen === s.name), { lines: raw[s.name] }, scale))
      process.stdout.write('.')
    }
    const t = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, median(v)]))
    const tag = `tess ${variant} ×${scale} psm${psm} rep${rep + 1}`
    console.log(`\n=== ${tag}: mediana ms/quadro decode=${t.decode.toFixed(0)} ocr=${t.ocr.toFixed(0)}`)
    const bySize = aggregate(recs, 'size')
    const small = aggregate(recs.filter((r) => r.size <= 14), () => '12-14px')
    const all = aggregate(recs, () => 'todos')
    if (rep === 0) {
      printTable(`${tag} — por tamanho`, [...bySize, ...small, ...all])
      printTable(`${tag} — por categoria (12–14px)`, aggregate(recs.filter((r) => r.size <= 14), 'cat'))
      printTable(`${tag} — por fonte (12–14px)`, aggregate(recs.filter((r) => r.size <= 14), 'font'))
      writeFileSync(join(RES, `tess-${langs.join('+')}-psm${psm}-${variant}-x${scale}-ocr.json`), JSON.stringify({ raw, recs }))
    }
    summary.runs.push({ variant, scale, rep, times: t, bySize, small, all })
  }
  await worker.terminate()
  writeFileSync(join(RES, `tess-${langs.join('+')}-psm${psm}-${variants.join('+')}-x${scales.join('+')}-r${reps}.json`), JSON.stringify(summary, null, 1))
}
main().catch((e) => { console.error(e); process.exit(1) })
