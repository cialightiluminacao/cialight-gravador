// Visão "Transcrição" da aba Legendas (lógica pura): as legendas como texto corrido com horários, busca sem diferenciar
// maiúsculas/acentos com os trechos destacados, o instante de cada palavra (para o clique levar o playhead) e o texto
// para "Copiar transcrição". Derivado só da faixa de legendas atual — nenhum estado novo no projeto.
import type { Us } from '@shared/editor/project'

export interface TranscriptCue { id: string; startUs: Us; durationUs: Us; text: string }
/** Pedaço de um token: destacado (bate com a busca) ou não. */
export interface Piece { text: string; hl: boolean }
/** Palavra (ou espaço) da legenda, com o deslocamento no texto original. */
export interface Token { offset: number; word: boolean; pieces: Piece[] }
export interface TranscriptRow { cue: TranscriptCue; time: string; tokens: Token[]; matchCount: number }

const WS = /\s/

/** Um caractere dobrado: minúsculo, sem acento (NFD sem marcas); espaços (inclusive quebra de linha) viram ' '. */
function foldChar(ch: string): string {
  const c = ch.charCodeAt(0)
  if (c < 128) {
    if (c >= 65 && c <= 90) return String.fromCharCode(c + 32)
    return c === 10 || c === 13 || c === 9 ? ' ' : ch
  }
  if (WS.test(ch)) return ' '
  return ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/**
 * Texto dobrado para a busca e o mapa índice dobrado → índice original (`map[folded.length]` = tamanho do original).
 * Um caractere pode virar zero ou vários: o mapa aponta todos para o original.
 */
export function foldForSearch(s: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let i = 0
  for (const ch of s) {
    const f = foldChar(ch)
    for (let k = 0; k < f.length; k++) map.push(i)
    folded += f
    i += ch.length
  }
  map.push(s.length)
  return { folded, map }
}

const foldQuery = (q: string): string => foldForSearch(q).folded.replace(/ +/g, ' ').trim()

/** Fim (exclusivo, no original) do trecho dobrado que termina em `b`. */
function origEnd(map: number[], b: number): number {
  const last = map[b - 1]
  let k = b
  while (k < map.length - 1 && map[k] <= last) k++
  return map[k] > last ? map[k] : map[map.length - 1]
}

function matchesFolded(f: { folded: string; map: number[] }, q: string): [number, number][] {
  const out: [number, number][] = []
  if (!q) return out
  let from = 0
  for (;;) {
    const a = f.folded.indexOf(q, from)
    if (a < 0) break
    const b = a + q.length
    out.push([f.map[a], origEnd(f.map, b)])
    from = b
  }
  return out
}

/** Ocorrências (sem sobreposição) da consulta no texto, como intervalos [início, fim) do texto original. */
export function findMatches(text: string, query: string): [number, number][] {
  return matchesFolded(foldForSearch(text), foldQuery(query))
}

/** Palavras e espaços da legenda, cada um partido nos limites das ocorrências. */
export function tokenizeCue(text: string, matches: readonly (readonly [number, number])[]): Token[] {
  const out: Token[] = []
  const re = /\S+|\s+/g
  let m: RegExpExecArray | null
  let mi = 0
  while ((m = re.exec(text))) {
    const a = m.index, b = a + m[0].length
    const pieces: Piece[] = []
    let pos = a
    while (mi < matches.length && matches[mi][1] <= a) mi++
    let j = mi
    while (pos < b) {
      const cur = j < matches.length ? matches[j] : null
      if (cur && cur[0] <= pos && pos < cur[1]) {
        const e = Math.min(b, cur[1])
        pieces.push({ text: text.slice(pos, e), hl: true })
        pos = e
        if (e === cur[1]) j++
      } else {
        const e = cur && cur[0] < b ? Math.max(pos, cur[0]) : b
        if (e === pos) {
          j++
          continue
        }
        pieces.push({ text: text.slice(pos, e), hl: false })
        pos = e
      }
    }
    out.push({ offset: a, word: !WS.test(m[0][0]), pieces })
  }
  return out
}

/** Instante de um deslocamento no texto da legenda: início + round(duração · deslocamento / tamanho). */
export function seekUsForOffset(cue: Pick<TranscriptCue, 'startUs' | 'durationUs' | 'text'>, charOffset: number): Us {
  if (!cue.text.length) return cue.startUs
  return cue.startUs + Math.round((cue.durationUs * charOffset) / cue.text.length)
}

const p2 = (n: number): string => String(n).padStart(2, '0')
/** mm:ss (os minutos passam de 59). */
export function formatClock(us: Us): string {
  const s = Math.floor(Math.max(0, us) / 1_000_000)
  return `${p2(Math.floor(s / 60))}:${p2(s % 60)}`
}

function sorted<T extends { startUs: Us }>(list: readonly T[]): readonly T[] {
  for (let k = 1; k < list.length; k++) if (list[k].startUs < list[k - 1].startUs) return [...list].sort((a, b) => a.startUs - b.startUs)
  return list
}

/** "mm:ss texto", uma linha por legenda (quebras de linha da legenda viram espaço), em ordem de início. */
export function transcriptText(cues: readonly TranscriptCue[]): string {
  return sorted(cues).map((c) => `${formatClock(c.startUs)} ${c.text.replace(/\s+/g, ' ').trim()}`).join('\n')
}

/** Linhas da transcrição (em ordem de início) com os destaques da consulta e o total de ocorrências. */
export function buildTranscript(cues: readonly TranscriptCue[], query: string): { rows: TranscriptRow[]; matches: number } {
  const q = foldQuery(query)
  let total = 0
  const rows = sorted(cues).map((cue) => {
    const ms = q ? matchesFolded(foldForSearch(cue.text), q) : []
    total += ms.length
    return { cue, time: formatClock(cue.startUs), tokens: tokenizeCue(cue.text, ms), matchCount: ms.length }
  })
  return { rows, matches: total }
}
