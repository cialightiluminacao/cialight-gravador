// Spike G3 — recalcula as métricas a partir das saídas de OCR salvas (test-out/g3-ocr/results/*-ocr.json),
// sem rodar o OCR de novo. Uso: node docs/research/spike/g3-ocr/rescore.mjs [filtro-de-nome] [--detail]
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTruth, scoreScreen, aggregate, printTable } from './metrics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../..')
const RES = join(ROOT, 'test-out/g3-ocr/results')
const truth = loadTruth(join(ROOT, 'test-out/g3-ocr/corpus/truth.json'))
const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : ''
const detail = process.argv.includes('--detail')

for (const f of readdirSync(RES).filter((f) => f.endsWith('-ocr.json') && f.includes(filter)).sort()) {
  const { raw } = JSON.parse(readFileSync(join(RES, f), 'utf8'))
  const scale = Number(/-x(\d+(?:\.\d+)?)/.exec(f)[1])
  const recs = []
  for (const s of truth.screens) recs.push(...scoreScreen(truth.items.filter((i) => i.screen === s.name), { lines: raw[s.name] }, scale))
  printTable(`${f} — por tamanho`, [...aggregate(recs, 'size'), ...aggregate(recs.filter((r) => r.size <= 14), () => '12-14px'), ...aggregate(recs, () => 'todos')])
  if (detail) {
    printTable(`${f} — por categoria (12–14px)`, aggregate(recs.filter((r) => r.size <= 14), 'cat'))
    printTable(`${f} — por fonte (12–14px)`, aggregate(recs.filter((r) => r.size <= 14), 'font'))
  }
}
