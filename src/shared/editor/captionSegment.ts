// Legendas automáticas (G2): palavras da timeline → cues (início, fim, texto em até maxLines linhas). Puro e
// imutável; µs inteiros; O(n) (cada fusão reduz o número de cues e só olha cues de poucas palavras).
import type { Us } from './project'
import type { Cue } from './srt'

export interface CaptionSegmentOpts {
  maxLineChars: number
  maxLines: number
  /** Duração mínima de uma cue. */
  minCueUs: Us
  /** Cue mais curta que isto estende o fim para dentro do silêncio seguinte (nunca além da próxima palavra). */
  targetMinCueUs: Us
  maxCueUs: Us
  /** Silêncio entre palavras a partir do qual a cue sempre quebra. */
  pauseBreakUs: Us
}
export const CAPTION_SEGMENT_DEFAULTS: CaptionSegmentOpts = {
  maxLineChars: 42, maxLines: 2, minCueUs: 700_000, targetMinCueUs: 1_000_000, maxCueUs: 6_000_000, pauseBreakUs: 600_000
}

interface W { t: string; s: Us; e: Us; n: number }
/** Cue em índices de palavras [a, b). */
interface R { a: number; b: number }
interface Out extends R { start: Us; end: Us }

const SENTENCE_END = /[.?!…]["'”’)\]»]*$/
const SOFT_END = /[,;:]["'”’)\]»]*$/

/**
 * Segmenta palavras (tempo da timeline) em cues.
 *
 * Quebras duras antes da palavra: silêncio ≥ pauseBreakUs, não caber em maxLines × maxLineChars, ou a cue passar de
 * maxCueUs. Quebras suaves depois de: . ? ! … (cue já com ≥ targetMinCueUs) e , ; : (texto ≥ 60 % da capacidade).
 * Linhas: uma se couber; senão duas equilibradas (minimiza a maior). Palavra maior que a linha fica sozinha nela (único
 * estouro permitido).
 *
 * Tempo: início = 1ª palavra, fim = última. Cue < targetMinCueUs estende o fim até o alvo, sem passar do início da
 * próxima palavra. Se ainda < minCueUs: funde com a vizinha (cabendo nos limites e sem silêncio ≥ pauseBreakUs entre
 * elas); senão puxa o início para trás no silêncio anterior (não antes do fim da cue anterior nem de 0); senão
 * (último recurso) funde com a vizinha IGNORANDO a regra de silêncio. O fim nunca passa do início da próxima palavra.
 * Exceções documentadas: o trecho inteiro mais curto que minCueUs fica como está; uma palavra mais longa que
 * maxCueUs tem o fim cortado em maxCueUs; se nenhuma fusão couber nos limites (palavras gigantes), a cue curta é mantida.
 */
export function segmentCaptions(words: readonly { text: string; startUs: Us; endUs: Us }[], opts?: Partial<CaptionSegmentOpts>): Cue[] {
  const o = { ...CAPTION_SEGMENT_DEFAULTS, ...opts }
  const cap = o.maxLines * o.maxLineChars
  let W: W[] = []
  for (const w of words) {
    const t = w.text.replace(/\s+/g, ' ').trim()
    if (t) W.push({ t, s: Math.round(w.startUs), e: Math.max(Math.round(w.endUs), Math.round(w.startUs)), n: t.length })
  }
  for (let k = 1; k < W.length; k++) {
    if (W[k].s < W[k - 1].s) {
      W = [...W].sort((a, b) => a.s - b.s)
      break
    }
  }
  if (!W.length) return []

  /** O texto das palavras [a, b) cabe em maxLines linhas (quebra gulosa = mínimo de linhas)? */
  const fits = (a: number, b: number): boolean => {
    let lines = 1, len = W[a].n
    for (let k = a + 1; k < b; k++) {
      if (len + 1 + W[k].n <= o.maxLineChars) len += 1 + W[k].n
      else if (++lines > o.maxLines) return false
      else len = W[k].n
    }
    return lines <= o.maxLines
  }

  // ---- passo 1: quebras duras e suaves
  const cues: R[] = []
  let a = 0, lines = 0, len = 0, total = 0
  for (let k = 0; k < W.length; k++) {
    const w = W[k]
    if (k > a) {
      const gap = w.s - W[k - 1].e
      const fitsLine = len + 1 + w.n <= o.maxLineChars
      const tooLong = !fitsLine && lines + 1 > o.maxLines
      if (gap >= o.pauseBreakUs || tooLong || w.e - W[a].s > o.maxCueUs) {
        cues.push({ a, b: k })
        a = k
      }
    }
    if (k === a) {
      lines = 1
      len = w.n
      total = w.n
    } else {
      total += 1 + w.n
      if (len + 1 + w.n <= o.maxLineChars) len += 1 + w.n
      else {
        lines++
        len = w.n
      }
    }
    const sentence = SENTENCE_END.test(w.t) && w.e - W[a].s >= o.targetMinCueUs
    const soft = SOFT_END.test(w.t) && total >= 0.6 * cap
    if (sentence || soft) {
      cues.push({ a, b: k + 1 })
      a = k + 1
    }
  }
  if (a < W.length) cues.push({ a, b: W.length })

  // ---- passo 2: tempos, extensões e fusões (pilha de saída; cada fusão consome uma cue)
  const out: Out[] = []
  const gapOk = (gap: Us, ignorePause: boolean): boolean => ignorePause || gap < o.pauseBreakUs
  let i = 0
  while (i < cues.length) {
    const cur: R = { ...cues[i] }
    let nextIdx = i + 1
    let final: { start: Us; end: Us }
    for (;;) {
      const start = W[cur.a].s
      const rawEnd = W[cur.b - 1].e
      const nextStart = nextIdx < cues.length ? W[cues[nextIdx].a].s : Infinity
      const prev = out.length ? out[out.length - 1] : null
      let end = Math.max(rawEnd, Math.min(start + o.targetMinCueUs, nextStart))
      end = Math.max(start + 1, Math.min(end, start + o.maxCueUs, nextStart))
      if (end - start >= o.minCueUs || (!prev && nextIdx >= cues.length)) {
        final = { start, end }
        break
      }

      const tryMerge = (ignorePause: boolean): boolean => {
        const nx = nextIdx < cues.length ? cues[nextIdx] : null
        const gn = nx ? W[nx.a].s - rawEnd : Infinity
        const gp = prev ? start - W[prev.b - 1].e : Infinity
        const okN = nx !== null && gapOk(gn, ignorePause) && W[nx.b - 1].e - start <= o.maxCueUs && fits(cur.a, nx.b)
        const okP = prev !== null && gapOk(gp, ignorePause) && rawEnd - W[prev.a].s <= o.maxCueUs && fits(prev.a, cur.b)
        if (okP && (!okN || gp <= gn)) {
          out.pop()
          cur.a = prev!.a
          return true
        }
        if (okN) {
          cur.b = nx!.b
          nextIdx++
          return true
        }
        return false
      }
      if (tryMerge(false)) continue
      // início para trás no silêncio anterior; a cue anterior só cede o que estendeu (fica ≥ raw e ≥ minCue)
      const bound = prev ? Math.min(prev.end, Math.max(W[prev.b - 1].e, prev.start + o.minCueUs)) : 0
      const newStart = Math.max(bound, end - o.minCueUs)
      if (end - newStart >= o.minCueUs) {
        if (prev && prev.end > newStart) prev.end = newStart
        final = { start: newStart, end }
        break
      }
      if (tryMerge(true)) continue
      final = { start, end }
      break
    }
    out.push({ a: cur.a, b: cur.b, ...final })
    i = nextIdx
  }

  return out.map((c) => ({ startUs: c.start, endUs: c.end, text: wrap(W, c.a, c.b, o) }))
}

/** Texto das palavras [a, b): uma linha se couber; senão duas equilibradas; mais de 2 linhas → gulosa. */
function wrap(W: readonly W[], a: number, b: number, o: CaptionSegmentOpts): string {
  let total = W[a].n
  for (let k = a + 1; k < b; k++) total += 1 + W[k].n
  const join = (x: number, y: number): string => {
    let s = W[x].t
    for (let k = x + 1; k < y; k++) s += ' ' + W[k].t
    return s
  }
  if (total <= o.maxLineChars || b - a === 1) return join(a, b)
  // gulosa (para saber se cabe em 2 linhas)
  let lines = 1, len = W[a].n
  for (let k = a + 1; k < b; k++) {
    if (len + 1 + W[k].n <= o.maxLineChars) len += 1 + W[k].n
    else {
      lines++
      len = W[k].n
    }
  }
  if (lines <= 2) {
    let best = a + 1, bestMax = Infinity, pre = W[a].n
    for (let k = a + 1; k < b; k++) {
      const m = Math.max(pre, total - pre - 1)
      if (m < bestMax) {
        bestMax = m
        best = k
      }
      pre += 1 + W[k].n
    }
    return join(a, best) + '\n' + join(best, b)
  }
  const rows: string[] = []
  let line = W[a].t
  len = W[a].n
  for (let k = a + 1; k < b; k++) {
    if (len + 1 + W[k].n <= o.maxLineChars) {
      line += ' ' + W[k].t
      len += 1 + W[k].n
    } else {
      rows.push(line)
      line = W[k].t
      len = W[k].n
    }
  }
  rows.push(line)
  return rows.join('\n')
}
