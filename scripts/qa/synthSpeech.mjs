// Fala sintética para testes de transcrição (System.Speech via synth-speech.ps1) — NUNCA o microfone.
// synthSpeech({ ssmlOrText, voice?: 'pt-BR'|'en-US', outWav, rate? })
//   → Promise<{ wav, words: {text, startUs, endUs}[], durationUs }>
// - WAV 16 kHz 16-bit mono; tempos de verdade-base pelo SpeakProgress (AudioPosition).
// - endUs = início da próxima palavra (inclui pausas) ou o fim do áudio.
// - Grava o sidecar "<wav>.words.json". Só escreve dentro de test-out/.
// CLI: node scripts/qa/synthSpeech.mjs <entrada.ssml|.txt> <saida.wav> [pt-BR|en-US] [rate]
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const testOut = join(root, 'test-out')

/** Duração (µs) de um WAV PCM lendo o cabeçalho (procura o chunk "data"). */
export function wavDurationUs(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('não é WAV RIFF')
  let off = 12
  let byteRate = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16)
    if (id === 'data') {
      if (!byteRate) throw new Error('WAV sem chunk fmt antes de data')
      const dataBytes = Math.min(size, buf.length - off - 8)
      return Math.round((dataBytes * 1e6) / byteRate)
    }
    off += 8 + size + (size & 1)
  }
  throw new Error('WAV sem chunk data')
}

/**
 * Eventos brutos do SpeakProgress → início de cada palavra ESCRITA.
 * O normalizador do TTS agrupa número + palavra seguinte numa unidade ("120 clientes", "14 horas", "15 de")
 * e dispara um evento por palavra FALADA (cento / e / vinte / clientes), todos com a mesma posição de caractere.
 * Regra: a 1ª palavra escrita recebe o 1º evento; as k−1 palavras escritas seguintes recebem os k−1 últimos eventos.
 */
export function groupedStarts(list) {
  const groups = new Map()
  for (const w of list) {
    const text = String(w.text).trim()
    if (!text) continue
    const key = Number(w.charPos)
    if (!groups.has(key)) groups.set(key, { text, events: [] })
    groups.get(key).events.push(Math.round(Number(w.startUs)))
  }
  const out = []
  for (const { text, events } of groups.values()) {
    events.sort((a, b) => a - b)
    const written = text.split(/\s+/)
    const k = Math.min(written.length, events.length)
    out.push({ text: written[0], startUs: events[0] })
    for (let i = 1; i < written.length; i++) {
      // eventos insuficientes: as palavras restantes herdam o último evento disponível
      const ev = i < k ? events[events.length - (k - i)] : events[events.length - 1]
      out.push({ text: written[i], startUs: ev })
    }
  }
  return out.sort((a, b) => a.startUs - b.startUs)
}

export async function synthSpeech({ ssmlOrText, voice = 'pt-BR', outWav, rate = 0 }) {
  const wav = resolve(outWav)
  const rel = relative(testOut, wav)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`synthSpeech só escreve em test-out/ (recebido ${wav})`)
  mkdirSync(dirname(wav), { recursive: true })
  const isSsml = ssmlOrText.trimStart().startsWith('<speak')
  const inFile = `${wav}.in.${isSsml ? 'ssml' : 'txt'}`
  const rawJson = `${wav}.raw.json`
  writeFileSync(inFile, ssmlOrText, 'utf8')
  try {
    await run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'synth-speech.ps1'),
      '-InFile', inFile, '-OutWav', wav, '-OutJson', rawJson, '-Voice', voice, '-Rate', String(rate)
    ], { windowsHide: true, maxBuffer: 16 << 20 })
    const raw = JSON.parse(readFileSync(rawJson, 'utf8').replace(/^﻿/, ''))
    const durationUs = wavDurationUs(readFileSync(wav))
    const list = Array.isArray(raw.words) ? raw.words : raw.words ? [raw.words] : []
    const starts = groupedStarts(list)
    const words = starts.map((w, i) => ({
      text: w.text,
      startUs: w.startUs,
      endUs: i + 1 < starts.length ? starts[i + 1].startUs : durationUs
    }))
    const result = { wav, words, durationUs }
    writeFileSync(`${wav}.words.json`, JSON.stringify({ voice: raw.voice, durationUs, words }, null, 2), 'utf8')
    return result
  } finally {
    rmSync(inFile, { force: true })
    rmSync(rawJson, { force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, out, voice = 'pt-BR', rate = '0'] = process.argv.slice(2)
  if (!input || !out) {
    console.error('uso: node scripts/qa/synthSpeech.mjs <entrada.ssml|.txt> <saida.wav (em test-out/)> [pt-BR|en-US] [rate]')
    process.exit(1)
  }
  const r = await synthSpeech({ ssmlOrText: readFileSync(input, 'utf8'), voice, outWav: out, rate: Number(rate) })
  console.log(`${r.wav}: ${(r.durationUs / 1e6).toFixed(2)} s, ${r.words.length} palavras`)
}
