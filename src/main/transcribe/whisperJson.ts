// Saída `-ojf` do whisper-cli (com --dtw) → palavras com tempo (µs inteiros, relativos ao início do WAV).
// Puro (sem Electron/Node). Algoritmo medido no spike (docs/research/2026-10-03-whisper-spike.md §4–§5,
// scripts/qa/whisper-spike.mjs: wordsFromTokens 'dtwPrev' + snapToSpeech + isAnnotationOnly + tokenSpeechRatio):
// - tokens BPE → palavras: token com espaço inicial abre palavra, sem espaço continua a anterior; especiais
//   ("[_BEG_]", "[_TT_n]", "<|…|>") são ignorados;
// - início da 1ª palavra do segmento = offsets.from do token; das demais = t_dtw (centésimos de s) do token
//   não especial ANTERIOR no mesmo segmento (o t_dtw marca o fim do token ≈ início do próximo);
// - fim da palavra = início da próxima palavra do segmento ou o fim (offsets.to) do segmento; nunca ≤ início
//   (mínimo MIN_WORD_US, limitado pelo início da palavra seguinte);
// - descarta segmentos só de anotação ("[Música]", "(risos)", "♪…♪") e, nos segmentos mantidos, as palavras que formam
//   blocos de anotação;
// - com fala detectada (silencedetect −35 dB / 0,35 s, folga 120 ms): descarta segmentos com < 50 % dos tokens
//   (t_dtw ≥ 0) dentro da fala e leva a palavra que começa fora da fala ao início do próximo intervalo de fala
//   (inícios não decrescentes). Sem fala detectada (voz abaixo de −35 dB), esses dois passos não se aplicam: as
//   palavras não anotação ficam e `unfiltered` avisa o chamador.
// Diferença deliberada do script do spike: a palavra nunca atravessa segmentos (o 1º token de um segmento sempre
// abre palavra), já que o fim da palavra é limitado pelo segmento.
import type { SpeechInterval } from '@shared/editor/speech'
import type { SourceWord } from '@shared/editor/transcribePlan'

export interface WhisperToken { text: string; offsets: { from: number; to: number }; p?: number; t_dtw?: number }
export interface WhisperSegment { offsets: { from: number; to: number }; text: string; tokens?: WhisperToken[] }
export interface WhisperJson { transcription: WhisperSegment[] }

export interface ParsedWords {
  words: SourceWord[]
  /** Segmentos descartados (anotação ou fora da fala). */
  dropped: number
  /** Sem fala detectada no áudio: palavras mantidas sem o filtro de silêncio (há palavras e nenhum intervalo de fala). */
  unfiltered: boolean
}

const isSpecial = (t: string): boolean => /^\[_.*\]$/.test(t) || /^<\|.*\|>$/.test(t)
/**
 * Texto só de blocos de anotação inteiros ("[Música]", "(risos)", "*tosse*", "♪ lá ♪"), em sequência. Corrigido na G2 T4:
 * a regex do spike tinha `.*` guloso e descartava " [Música] vamos começar [Música]" inteiro.
 */
export const isAnnotationOnly = (text: string): boolean => /^\s*(?:(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪[^♪]*♪)\s*)+$/u.test(text)
const CLOSER: Record<string, string> = { '[': ']', '(': ')', '*': '*', '♪': '♪' }
/** Duração mínima de uma palavra (fim nunca ≤ início); limitada pelo início da palavra seguinte, se houver. */
export const MIN_WORD_US = 80_000

/**
 * Índices das palavras dentro de blocos de anotação num segmento mantido ("[Música]", "[MÚSICA DE FUNDO]" quebrado em
 * várias palavras, "(risos)"): do token que abre até o que fecha o mesmo bloco. Bloco sem fechamento fica.
 */
function annotationWordIndexes(words: { text: string }[]): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i < words.length; i++) {
    const t = words[i].text
    const close = CLOSER[t[0]]
    if (!close) continue
    for (let j = i; j < words.length; j++) {
      const body = j === i ? words[j].text.slice(1) : words[j].text
      if (body.replace(/[.,!?;:…"'”»]+$/u, '').endsWith(close)) {
        for (let k = i; k <= j; k++) out.add(k)
        i = j
        break
      }
    }
  }
  return out
}
const MS = 1000
const CS = 10_000
const inSpeech = (us: number, speech: SpeechInterval[]): boolean => speech.some((s) => us >= s.fromUs && us < s.toUs)

/** Fração dos tokens não especiais com t_dtw ≥ 0 cujo t_dtw cai dentro da fala (0 se não houver nenhum). */
export function tokenSpeechRatio(seg: WhisperSegment, speech: SpeechInterval[]): number {
  const toks = (seg.tokens ?? []).filter((t) => !isSpecial(t.text) && (t.t_dtw ?? -1) >= 0)
  if (!toks.length) return 0
  return toks.filter((t) => inSpeech((t.t_dtw ?? 0) * CS, speech)).length / toks.length
}

interface Draft { text: string; startUs: number; probs: number[] }

function segmentWords(seg: WhisperSegment): Draft[] {
  const out: Draft[] = []
  let prevDtw = -1
  for (const tk of seg.tokens ?? []) {
    if (typeof tk.text !== 'string' || isSpecial(tk.text)) continue
    const startUs = prevDtw >= 0 ? prevDtw * CS : Math.round((tk.offsets?.from ?? seg.offsets.from) * MS)
    prevDtw = tk.t_dtw ?? -1
    const p = typeof tk.p === 'number' ? [tk.p] : []
    if (tk.text.startsWith(' ') || out.length === 0) out.push({ text: tk.text.trim(), startUs: Math.round(startUs), probs: p })
    else {
      const w = out[out.length - 1]
      w.text += tk.text
      w.probs.push(...p)
    }
  }
  return out
}

export function parseWhisperJson(json: WhisperJson, speech: SpeechInterval[]): ParsedWords {
  const hasSpeech = speech.length > 0
  const segs = Array.isArray(json?.transcription) ? json.transcription : []
  let dropped = 0
  const kept: { seg: WhisperSegment; words: Draft[] }[] = []
  for (const seg of segs) {
    if (isAnnotationOnly(seg.text ?? '')) {
      dropped++
      continue
    }
    if (hasSpeech && tokenSpeechRatio(seg, speech) < 0.5) {
      dropped++
      continue
    }
    kept.push({ seg, words: segmentWords(seg) })
  }

  // ajuste à fala (só com fala detectada): fora da fala → início do próximo intervalo; inícios não decrescentes
  if (hasSpeech) {
    let last = 0
    for (const k of kept) {
      for (const w of k.words) {
        let us = w.startUs
        if (!inSpeech(us, speech)) {
          const next = speech.find((s) => s.fromUs > us)
          if (next) us = next.fromUs
        }
        us = Math.max(us, last)
        last = us
        w.startUs = us
      }
    }
  }

  const words: SourceWord[] = []
  for (const { seg, words: ws } of kept) {
    const segEndUs = Math.round(seg.offsets.to * MS)
    // fins calculados com todas as palavras (inclusive anotações): a palavra antes de "[Música]" não se estende sobre ela
    const skip = annotationWordIndexes(ws)
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i]
      if (!w.text || skip.has(i)) continue
      const nextStart = i + 1 < ws.length ? ws[i + 1].startUs : null
      let endUs = Math.max(w.startUs + MIN_WORD_US, nextStart ?? segEndUs)
      if (nextStart !== null && nextStart > w.startUs) endUs = Math.min(endUs, nextStart)
      const word: SourceWord = { text: w.text, startUs: w.startUs, endUs }
      if (w.probs.length) word.prob = Math.round((w.probs.reduce((a, b) => a + b, 0) / w.probs.length) * 1000) / 1000
      words.push(word)
    }
  }
  return { words, dropped, unfiltered: !hasSpeech && words.length > 0 }
}
