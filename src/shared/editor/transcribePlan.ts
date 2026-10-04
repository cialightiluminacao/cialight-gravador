// Legendas automáticas (G2): quais trechos da FONTE transcrever e como as palavras (tempo da fonte) voltam para a
// timeline. Puro e imutável; µs inteiros.
//
// O whisper transcreve o áudio ORIGINAL de cada asset em tempo da fonte (o main extrai cada job e soma o início do
// trecho às palavras); aqui as palavras são levadas à timeline com a mesma conta do mixer, então as legendas seguem
// velocidade, aparas, cortes e silêncios removidos exatamente.
import { planAudio, voiceSegments, type AudioSegment } from './audioPlan'
import type { Project, Us } from './project'

/** Trecho da fonte (asset) a transcrever, em µs. */
export interface TranscribeJob { assetId: string; fromUs: Us; toUs: Us }
export interface TranscribeSourcePlan { segments: AudioSegment[]; jobs: TranscribeJob[]; scope: 'voice' | 'fallback' | 'none' }
/** Palavra em tempo da fonte (asset). */
export interface SourceWord { text: string; startUs: Us; endUs: Us; prob?: number }
/** Palavra em tempo da timeline, com o item/faixa do segmento que a fez soar. */
export interface TimedWord { text: string; startUs: Us; endUs: Us; prob?: number; itemId: string; trackId: string }

/** Margem de cada lado do trecho lido (contexto para o whisper não cortar a primeira/última palavra). */
export const TRANSCRIBE_PAD_US = 300_000
/** Trechos do mesmo asset a até esta distância (depois da margem) viram um job só. */
export const TRANSCRIBE_MERGE_GAP_US = 2_000_000

const maxGain = (s: AudioSegment): number => s.gain.reduce((m, g) => Math.max(m, g.gain), 0)

/**
 * Segmentos a transcrever e os jobs (trechos da fonte por asset).
 *
 * Só segmentos que soam: não mudos pela velocidade, não reversos (a fala ao contrário não se transcreve) e com ganho
 * > 0 em algum ponto do envelope (faixa/item com volume 0 ficam de fora; faixa muda, áudio desligado e item
 * desativado já não entram no planAudio).
 *
 * Escopo: 'voice' = faixas `role: 'voice'`. Sem elas, 'fallback' = faixas que não são música nem efeitos sonoros. Numa
 * gravação real (fromSession.ts) o microfone vira a faixa "mic" com papel 'voice' e o áudio do sistema a faixa
 * "system" com papel 'sfx' (nunca transcrita); a tela não tem áudio. O fallback cobre projetos sem microfone com mídia
 * importada: o áudio próprio de um vídeo (item com áudio ligado na faixa de vídeo) ou faixas de áudio sem papel.
 */
export function planTranscription(p: Project): TranscribeSourcePlan {
  const audible = planAudio(p).filter((s) => s.mode !== 'mute' && !s.reverse && maxGain(s) > 0)
  let scope: TranscribeSourcePlan['scope'] = 'voice'
  let segments = voiceSegments(p, audible)
  if (!segments.length) {
    const excluded = new Set(p.tracks.filter((t) => t.role === 'music' || t.role === 'sfx').map((t) => t.id))
    segments = audible.filter((s) => !excluded.has(s.trackId))
    scope = 'fallback'
  }
  if (!segments.length) return { segments: [], jobs: [], scope: 'none' }

  const durations = new Map<string, Us | null>(p.assets.map((a) => [a.id, a.durationUs]))
  // trechos lidos por asset, na ordem em que os assets aparecem
  const ranges = new Map<string, { from: Us; to: Us }[]>()
  for (const s of segments) {
    const dur = durations.get(s.assetId) ?? null
    const from = Math.max(0, s.srcInUs - TRANSCRIBE_PAD_US)
    let to = s.srcInUs + Math.round(s.durationUs * s.speed) + TRANSCRIBE_PAD_US
    if (dur != null) to = Math.min(dur, to)
    if (to <= from) continue
    const list = ranges.get(s.assetId)
    if (list) list.push({ from, to })
    else ranges.set(s.assetId, [{ from, to }])
  }
  const jobs: TranscribeJob[] = []
  for (const [assetId, list] of ranges) {
    const sorted = [...list].sort((a, b) => a.from - b.from)
    let cur = { ...sorted[0] }
    for (let k = 1; k < sorted.length; k++) {
      const r = sorted[k]
      if (r.from - cur.to <= TRANSCRIBE_MERGE_GAP_US) cur.to = Math.max(cur.to, r.to)
      else {
        jobs.push({ assetId, fromUs: cur.from, toUs: cur.to })
        cur = { ...r }
      }
    }
    jobs.push({ assetId, fromUs: cur.from, toUs: cur.to })
  }
  return { segments, jobs, scope }
}

/** Palavras ordenadas por início (cópia só se a entrada não estiver) e a maior duração (limite da busca binária). */
interface SortedWords { list: readonly SourceWord[]; maxDur: Us }
function sortedWords(words: readonly SourceWord[]): SortedWords {
  let ordered = true
  let maxDur = 0
  for (let k = 0; k < words.length; k++) {
    if (k > 0 && words[k].startUs < words[k - 1].startUs) ordered = false
    maxDur = Math.max(maxDur, words[k].endUs - words[k].startUs)
  }
  return { list: ordered ? words : [...words].sort((a, b) => a.startUs - b.startUs), maxDur }
}

/** Texto para comparar duplicatas: minúsculas, sem pontuação/símbolos, sem espaços nas pontas. */
const normText = (t: string): string => t.toLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim()

interface Mapped { word: TimedWord; order: number; seq: number; norm: string }

/**
 * Palavras da fonte → timeline. Por segmento (só para a frente; reverso é ignorado), entram as palavras do asset
 * cujo meio cai no trecho lido [srcIn, srcIn + dur·speed); início e fim vão para t = start + round((src − srcIn)/speed)
 * (a conta do speechOnTimeline), presos ao item; sai a que fica vazia. A primeira candidata sai por busca binária.
 *
 * Duplicatas (o mesmo áudio em duas faixas): mesmo texto normalizado e sobreposição ≥ 50 % da menor → fica uma (prob
 * maior; empate → a faixa que vem primeiro). Textos diferentes sobrepostos (duas pessoas) ficam os dois.
 * Saída ordenada por início e, no empate, pela ordem das faixas (estável).
 */
export function wordsToTimeline(segments: readonly AudioSegment[], words: Readonly<Record<string, readonly SourceWord[]>>): TimedWord[] {
  // ordem das faixas = ordem de aparição nos segmentos (o planAudio percorre as faixas em ordem)
  const trackOrder = new Map<string, number>()
  for (const s of segments) if (!trackOrder.has(s.trackId)) trackOrder.set(s.trackId, trackOrder.size)
  const cache = new Map<string, SortedWords>()
  const mapped: Mapped[] = []
  for (const seg of segments) {
    if (seg.reverse || !(seg.speed > 0)) continue
    const src = words[seg.assetId]
    if (!src?.length) continue
    let sw = cache.get(seg.assetId)
    if (!sw) cache.set(seg.assetId, (sw = sortedWords(src)))
    const { list, maxDur } = sw
    const srcLo = seg.srcInUs
    const srcHi = seg.srcInUs + seg.durationUs * seg.speed
    const segEnd = seg.startUs + seg.durationUs
    // meio ≥ srcLo exige início ≥ srcLo − duração ≥ srcLo − maxDur: 1ª candidata por busca binária
    const bound = srcLo - maxDur
    let lo = 0, hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].startUs < bound) lo = mid + 1
      else hi = mid
    }
    // início ≥ srcHi → meio ≥ srcHi: acabou
    for (let k = lo; k < list.length && list[k].startUs < srcHi; k++) {
      const wd = list[k]
      const m = (wd.startUs + wd.endUs) / 2
      if (m < srcLo || m >= srcHi) continue
      const toTl = (u: Us): Us => Math.min(segEnd, Math.max(seg.startUs, seg.startUs + Math.round((u - srcLo) / seg.speed)))
      const startUs = toTl(wd.startUs)
      const endUs = toTl(wd.endUs)
      if (endUs <= startUs) continue
      const word: TimedWord = { text: wd.text, startUs, endUs, ...(wd.prob !== undefined ? { prob: wd.prob } : {}), itemId: seg.itemId, trackId: seg.trackId }
      mapped.push({ word, order: trackOrder.get(seg.trackId)!, seq: mapped.length, norm: normText(wd.text) })
    }
  }
  const byTime = (a: Mapped, b: Mapped): number => a.word.startUs - b.word.startUs || a.order - b.order || a.seq - b.seq
  mapped.sort(byTime)

  // varredura: compara só com as mantidas que ainda se sobrepõem ao início da palavra atual
  const kept: Mapped[] = []
  let active: number[] = [] // índices em `kept`
  const prob = (x: Mapped): number => x.word.prob ?? -1
  for (const cur of mapped) {
    active = active.filter((i) => kept[i].word.endUs > cur.word.startUs)
    let dup = -1
    for (const i of active) {
      const o = kept[i]
      if (o.norm !== cur.norm) continue
      const overlap = Math.min(o.word.endUs, cur.word.endUs) - Math.max(o.word.startUs, cur.word.startUs)
      const shorter = Math.min(o.word.endUs - o.word.startUs, cur.word.endUs - cur.word.startUs)
      if (overlap > 0 && overlap * 2 >= shorter) {
        dup = i
        break
      }
    }
    if (dup < 0) {
      active.push(kept.length)
      kept.push(cur)
      continue
    }
    const o = kept[dup]
    if (prob(cur) > prob(o) || (prob(cur) === prob(o) && cur.order < o.order)) kept[dup] = cur
  }
  return kept.sort(byTime).map((x) => x.word)
}
