// Comparação de palavras transcritas com a verdade-base (testes e test:transcribe). Mesmo método do spike
// (scripts/qa/whisper-spike.mjs): normalização (minúsculas, hífen/travessão → espaço, sem pontuação, acentos mantidos)
// e alinhamento por distância de edição entre as listas de palavras. Puro.

export interface ScoreWord { text: string; startUs: number }

export function normalizeText(s: string): string[] {
  return s.toLowerCase().replace(/[-–—]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

/** Pares [ref, hyp] alinhados (iguais ou substituição) e contagens S/D/I. */
export function alignWords(ref: string[], hyp: string[]): { pairs: { i: number; j: number; sub: boolean }[]; S: number; D: number; I: number } {
  const n = ref.length
  const m = hyp.length
  const D: Int32Array[] = Array.from({ length: n + 1 }, (_, i) => Int32Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
    }
  }
  const pairs: { i: number; j: number; sub: boolean }[] = []
  let i = n
  let j = m
  let S = 0
  let Del = 0
  let I = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      const sub = ref[i - 1] !== hyp[j - 1]
      if (sub) S++
      pairs.push({ i: i - 1, j: j - 1, sub })
      i--
      j--
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      Del++
      i--
    } else {
      I++
      j--
    }
  }
  pairs.reverse()
  return { pairs, S, D: Del, I }
}

export interface WordScore {
  refWords: number
  correct: number
  /** correct / refWords (0–1). */
  accuracy: number
  wer: number
  /** Erro absoluto de início das palavras casadas (µs). */
  startErrMedianUs: number
  startErrP90Us: number
  startErrMaxUs: number
  /** Fração das palavras casadas com erro de início ≤ 300 ms. */
  within300: number
  subs: string[]
}

/** Uma palavra escrita pode virar várias normalizadas ("bem-vindos"): todas herdam o início dela. */
function expand(words: ScoreWord[]): ScoreWord[] {
  const out: ScoreWord[] = []
  for (const w of words) for (const t of normalizeText(w.text)) out.push({ text: t, startUs: w.startUs })
  return out
}

export function scoreWords(truth: ScoreWord[], hyp: ScoreWord[]): WordScore {
  const ref = expand(truth)
  const h = expand(hyp)
  const a = alignWords(ref.map((w) => w.text), h.map((w) => w.text))
  const matched = a.pairs.filter((p) => !p.sub)
  const errs = matched.map((p) => Math.abs(h[p.j].startUs - ref[p.i].startUs)).sort((x, y) => x - y)
  const q = (f: number): number => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(f * errs.length))] : NaN)
  const n = Math.max(1, ref.length)
  return {
    refWords: ref.length,
    correct: matched.length,
    accuracy: matched.length / n,
    wer: (a.S + a.D + a.I) / n,
    startErrMedianUs: q(0.5),
    startErrP90Us: q(0.9),
    startErrMaxUs: errs.length ? errs[errs.length - 1] : NaN,
    within300: errs.filter((e) => e <= 300_000).length / Math.max(1, errs.length),
    subs: a.pairs.filter((p) => p.sub).map((p) => `${ref[p.i].text}→${h[p.j].text}`)
  }
}
