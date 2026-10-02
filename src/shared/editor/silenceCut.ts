// Remover silêncios (puro): os intervalos de fala das faixas de voz de referência, levados ao tempo da timeline
// (speechOnTimeline: inUs/speed/reverse/trim), definem os silêncios; cada silêncio longo vira um corte com margem,
// aplicado com deleteRange em todas as faixas desbloqueadas (tela, webcam, anotações, efeitos) — num passo só.
import { speechOnTimeline } from './audioPlan'
import { deleteRange } from './ops'
import { MIN_ITEM_US } from './project'
import type { Project, Us } from './project'
import type { SpeechInterval } from './speech'
import { itemEndUs } from './time'

export interface SilenceCut { fromUs: Us; toUs: Us }

/**
 * O limiar de volume (−35 dB) e o silêncio mínimo da detecção (0,35 s) são fixados na análise da ingestão
 * (speech.json guarda só os silêncios brutos, sem o nível): aqui só dá para exigir silêncios MAIS longos e ajustar
 * a margem — nunca um limiar diferente. Tempos em µs de timeline.
 */
export interface SilenceCutOpts {
  /** Faixas cuja fala decide o que é silêncio (voz de referência). */
  sourceTrackIds: string[]
  /** Silêncio (na timeline) mais curto que isto fica. */
  minSilenceUs: Us
  /** Margem mantida antes e depois da fala. */
  paddingUs: Us
  /** Só corta dentro deste intervalo (I–O). */
  range?: { fromUs: Us; toUs: Us }
}

export interface SilenceCutPlan {
  /** Ordenados e disjuntos, em tempo da timeline ANTES dos cortes. */
  cuts: SilenceCut[]
  savedUs: Us
  /** Faixas bloqueadas: não são cortadas (ficam fora de sincronia com o resto). */
  lockedTrackIds: string[]
  /** Por que o corte não pode ser aplicado (null = pode). */
  blocked: string | null
  /** Assets dos itens de voz sem dados de fala (o trecho deles não é analisado). */
  missingAssetIds: string[]
}

export const SILENCE_DEFAULTS = { minSilenceUs: 700_000, paddingUs: 150_000 } as const

/**
 * Como carregar a fala para a remoção de silêncio (speechFromFile): sem margem nem mescla — a margem e a duração
 * mínima são do diálogo e valem em tempo de timeline. Falas curtas (estalos < 100 ms) continuam descartadas.
 */
export const SILENCE_SPEECH_OPTS = { padUs: 0, mergeGapUs: 0 } as const

type Span = { fromUs: Us; toUs: Us }

/** União de intervalos (ordenada, encostados emendam). */
function union(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a.fromUs - b.fromUs)) {
    if (s.toUs <= s.fromUs) continue
    const last = out[out.length - 1]
    if (last && s.fromUs <= last.toUs) last.toUs = Math.max(last.toUs, s.toUs)
    else out.push({ ...s })
  }
  return out
}

/**
 * Cortes que deixam algum efeito com um pedaço menor que um quadro (deleteRange descarta pedaços < MIN_ITEM_US — o
 * conteúdo sob ele ficaria descoberto) encolhem até o pedaço ter um quadro; corte que fica curto demais sai.
 */
function protectEffects(p: Project, cuts: Span[]): Span[] {
  const fx = p.tracks.filter((t) => !t.locked).flatMap((t) => t.items.filter((i) => i.type === 'effect').map((i) => ({ s: i.startUs, e: itemEndUs(i) })))
  let out = cuts.map((c) => ({ ...c }))
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const { s, e } of fx) {
      // pedaços do efeito que sobram entre os cortes que o cruzam
      let x = s
      let prev: Span | null = null
      for (const c of out) {
        if (c.toUs <= s || c.fromUs >= e) continue
        if (c.fromUs > x && c.fromUs - x < MIN_ITEM_US) {
          c.fromUs = x + MIN_ITEM_US // pedaço que acaba no corte: o corte começa um quadro depois
          changed = true
        }
        x = Math.max(x, c.toUs)
        prev = c
      }
      if (prev && x < e && e - x < MIN_ITEM_US) {
        prev.toUs = e - MIN_ITEM_US // pedaço final depois do último corte: o corte termina um quadro antes
        changed = true
      }
      out = out.filter((c) => c.toUs - c.fromUs >= MIN_ITEM_US)
    }
    if (!changed) break
  }
  return out
}

/**
 * Cortes de silêncio. `speech`: intervalos de fala por assetId em tempo da FONTE (speechFromFile com
 * SILENCE_SPEECH_OPTS), carregados por quem chama. Só há silêncio onde há item de voz analisado: fora deles (ou em
 * item sem dados de fala) nada é cortado. Cada silêncio ≥ minSilenceUs vira [início + margem, fim − margem).
 */
export function planSilenceCuts(p: Project, opts: SilenceCutOpts, speech: Readonly<Record<string, readonly SpeechInterval[]>>): SilenceCutPlan {
  const known: Span[] = []
  const talk: Span[] = []
  const missing = new Set<string>()
  const sources = p.tracks.filter((t) => opts.sourceTrackIds.includes(t.id))
  for (const t of sources) {
    for (const it of t.items) {
      if (it.type !== 'media' || it.enabled === false || it.freeze) continue
      const asset = p.assets.find((a) => a.id === it.assetId)
      if (!asset || asset.kind === 'image' || !asset.audio) continue
      const sp = speech[it.assetId]
      if (!sp) {
        missing.add(it.assetId)
        continue
      }
      known.push({ fromUs: it.startUs, toUs: itemEndUs(it) })
      talk.push(...speechOnTimeline({ startUs: it.startUs, durationUs: it.durationUs, srcInUs: it.inUs, speed: it.speed, reverse: it.reverse }, sp))
    }
  }
  const spoken = union(talk)
  const pad = Math.max(0, Math.round(opts.paddingUs))
  const minSilence = Math.max(0, Math.round(opts.minSilenceUs))
  const lo = opts.range ? Math.round(opts.range.fromUs) : -Infinity
  const hi = opts.range ? Math.round(opts.range.toUs) : Infinity
  let cuts: Span[] = []
  for (const k of union(known)) {
    // silêncios = trecho analisado menos a fala
    let cursor = k.fromUs
    const gaps: Span[] = []
    for (const s of spoken) {
      if (s.toUs <= k.fromUs || s.fromUs >= k.toUs) continue
      if (s.fromUs > cursor) gaps.push({ fromUs: cursor, toUs: s.fromUs })
      cursor = Math.max(cursor, s.toUs)
    }
    if (cursor < k.toUs) gaps.push({ fromUs: cursor, toUs: k.toUs })
    for (const g of gaps) {
      if (g.toUs - g.fromUs < minSilence) continue
      const c = { fromUs: Math.max(lo, g.fromUs + pad), toUs: Math.min(hi, g.toUs - pad) }
      if (c.toUs - c.fromUs >= MIN_ITEM_US) cuts.push(c)
    }
  }
  cuts = protectEffects(p, cuts)
  const lockedTrackIds = p.tracks.filter((t) => t.locked).map((t) => t.id)
  let blocked: string | null = null
  if (cuts.length) {
    const first = cuts[0].fromUs
    const hasFx = p.tracks.some((t) => t.items.some((i) => i.type === 'effect' && itemEndUs(i) > first))
    if (sources.some((t) => t.locked)) blocked = 'A faixa de voz de referência está bloqueada. Desbloqueie-a para remover os silêncios.'
    else if (lockedTrackIds.length && hasFx) blocked = 'Há faixas bloqueadas e efeitos de privacidade: cortar só as faixas desbloqueadas tiraria os efeitos de cima do que eles escondem. Desbloqueie as faixas para remover os silêncios.'
  }
  return { cuts, savedUs: cuts.reduce((n, c) => n + c.toUs - c.fromUs, 0), lockedTrackIds, blocked, missingAssetIds: [...missing] }
}

/**
 * Aplica os cortes (tempo de antes dos cortes) do último para o primeiro com deleteRange em todas as faixas
 * desbloqueadas: os anteriores não se movem. Um projeto só no fim — um passo de desfazer para quem aplicar no store.
 */
export function applySilenceCuts(p: Project, cuts: readonly SilenceCut[]): Project {
  return [...cuts].sort((a, b) => b.fromUs - a.fromUs).reduce((q, c) => deleteRange(q, c.fromUs, c.toUs), p)
}
