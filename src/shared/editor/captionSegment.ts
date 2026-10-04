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
  /** Nenhum fim de cue passa daqui (ex.: fim do conteúdo da mídia, para a legenda não alongar o projeto). Padrão: sem limite. */
  endLimitUs?: Us
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
 * (último recurso) funde com a vizinha IGNORANDO a regra de silêncio; antes de desistir, reequilibra: passa até 3 palavras
 * do fim da cue anterior (ou do começo da seguinte) para ela, se a doadora continuar válida. O fim nunca passa do início
 * da próxima palavra nem de endLimitUs; o fim da cue é o maior fim entre as suas palavras (faixas sobrepostas).
 * Exceções documentadas: o trecho inteiro mais curto que minCueUs fica como está; uma palavra mais longa que
 * maxCueUs tem o fim cortado em maxCueUs; se nem fusão nem reequilíbrio couberem nos limites (palavras gigantes), a cue
 * curta é mantida; cue de duração zero (palavras no mesmo instante, timestamps colapsados) é fundida à vizinha sem
 * respeitar os limites de linha.
 */
export function segmentCaptions(words: readonly { text: string; startUs: Us; endUs: Us }[], opts?: Partial<CaptionSegmentOpts>): Cue[] {
  const o = { ...CAPTION_SEGMENT_DEFAULTS, ...opts }
  const cap = o.maxLines * o.maxLineChars
  const limit = o.endLimitUs ?? Infinity
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

  /** Maior fim entre as palavras [a, b). */
  const maxE = (a: number, b: number): Us => {
    let m = W[a].e
    for (let k = a + 1; k < b; k++) if (W[k].e > m) m = W[k].e
    return m
  }

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
  let a = 0, lines = 0, len = 0, total = 0, cm = 0
  for (let k = 0; k < W.length; k++) {
    const w = W[k]
    if (k > a) {
      const gap = w.s - cm
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
      cm = w.e
    } else {
      if (w.e > cm) cm = w.e
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

  // ---- passo 2: tempos, extensões, fusões e reequilíbrio (pilha de saída; cada fusão consome uma cue)
  const out: Out[] = []
  const gapOk = (gap: Us, mode: number): boolean => mode >= 1 || gap < o.pauseBreakUs
  let i = 0
  while (i < cues.length) {
    const cur: R = { ...cues[i] }
    let nextIdx = i + 1
    let final: { start: Us; end: Us }
    for (;;) {
      const start = W[cur.a].s
      const rawEnd = maxE(cur.a, cur.b)
      const nextStart = nextIdx < cues.length ? W[cues[nextIdx].a].s : Infinity
      const prev = out.length ? out[out.length - 1] : null
      const end = Math.min(Math.max(rawEnd, Math.min(start + o.targetMinCueUs, nextStart)), start + o.maxCueUs, nextStart, limit)
      if (!prev && nextIdx >= cues.length) {
        final = { start, end: Math.max(end, start + 1) }
        break
      }
      if (end - start >= o.minCueUs) {
        final = { start, end }
        break
      }

      // mode 0: respeita silêncio e limites; 1: ignora o silêncio; 2: ignora tudo (cue de duração zero)
      const tryMerge = (mode: number): boolean => {
        const nx = nextIdx < cues.length ? cues[nextIdx] : null
        const gn = nx ? W[nx.a].s - rawEnd : Infinity
        const gp = prev ? start - maxE(prev.a, prev.b) : Infinity
        const okN = nx !== null && (mode === 2 || (gapOk(gn, mode) && maxE(nx.a, nx.b) - start <= o.maxCueUs && fits(cur.a, nx.b)))
        const okP = prev !== null && (mode === 2 ? !okN : gapOk(gp, mode) && rawEnd - W[prev.a].s <= o.maxCueUs && fits(prev.a, cur.b))
        if (okP && (!okN || gp <= gn) && mode !== 2) {
          out.pop()
          cur.a = prev!.a
          return true
        }
        if (okN) {
          cur.b = nx!.b
          nextIdx++
          return true
        }
        if (okP) {
          out.pop()
          cur.a = prev!.a
          return true
        }
        return false
      }
      // passa até 3 palavras da vizinha para esta cue quando a doadora continua válida
      const rebalance = (): boolean => {
        if (prev) {
          for (let k = 1; k <= 3 && prev.b - prev.a - k >= 1; k++) {
            const m = prev.b - k
            if (W[cur.a].s - maxE(m, prev.b) >= o.pauseBreakUs || !fits(m, cur.b) || maxE(m, cur.b) - W[m].s > o.maxCueUs) break
            const pStart = W[prev.a].s
            const pEnd = Math.min(Math.max(maxE(prev.a, m), pStart + o.targetMinCueUs), W[m].s, pStart + o.maxCueUs, limit)
            if (pEnd - pStart < o.minCueUs) continue
            const nEnd = Math.min(Math.max(maxE(m, cur.b), W[m].s + o.targetMinCueUs), nextStart, W[m].s + o.maxCueUs, limit)
            if (nEnd - W[m].s < o.minCueUs) continue
            prev.b = m
            prev.end = pEnd
            cur.a = m
            return true
          }
        }
        const nx = nextIdx < cues.length ? cues[nextIdx] : null
        if (nx) {
          for (let k = 1; k <= 3 && nx.b - nx.a - k >= 1; k++) {
            const e = nx.a + k
            if (W[nx.a].s - rawEnd >= o.pauseBreakUs || !fits(cur.a, e) || maxE(cur.a, e) - start > o.maxCueUs) break
            const cEnd = Math.min(Math.max(maxE(cur.a, e), start + o.targetMinCueUs), W[e].s, start + o.maxCueUs, limit)
            if (cEnd - start < o.minCueUs) continue
            cur.b = e
            cues[nextIdx] = { a: e, b: nx.b }
            return true
          }
        }
        return false
      }
      if (end <= start) {
        if (tryMerge(0) || tryMerge(1) || tryMerge(2)) continue
        final = { start, end: start + 1 }
        break
      }
      if (tryMerge(0)) continue
      // início para trás no silêncio anterior; a cue anterior só cede o que estendeu (fica ≥ raw e ≥ minCue)
      const bound = prev ? Math.min(prev.end, Math.max(maxE(prev.a, prev.b), prev.start + o.minCueUs)) : 0
      const newStart = Math.max(bound, end - o.minCueUs)
      if (end - newStart >= o.minCueUs) {
        if (prev && prev.end > newStart) prev.end = newStart
        final = { start: newStart, end }
        break
      }
      if (tryMerge(1) || rebalance()) continue
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
