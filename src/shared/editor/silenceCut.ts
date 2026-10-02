// Remover silêncios (puro): os intervalos de fala das faixas de voz de referência, levados ao tempo da timeline
// (speechOnTimeline: inUs/speed/reverse/trim), definem os silêncios; cada silêncio longo vira um corte com margem,
// aplicado com deleteRanges em todas as faixas desbloqueadas (tela, webcam, anotações, efeitos) — num passo só.
import { speechOnTimeline } from './audioPlan'
import { deleteRanges } from './ops'
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
  /** Faixas de música desbloqueadas com algum corte por cima (a música também é cortada). */
  musicTrackIds: string[]
  /** Por que o corte não pode ser aplicado (null = pode). */
  blocked: string | null
  /** Assets dos itens de voz sem dados de fala (o trecho deles conta como fala: nunca é cortado). */
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
  // cada ajuste só encolhe um corte (início sobe ou fim desce): repete até nada mudar
  for (let changed = true; changed; ) {
    changed = false
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
  }
  return out
}

/** Fala de uma faixa já na timeline (itens com som, ativos e não congelados): trechos analisados, fala e assets sem dados. */
function trackSpeech(p: Project, trackId: string, speech: Readonly<Record<string, readonly SpeechInterval[]>>): { analyzed: Span[]; talk: Span[]; unanalyzed: Span[]; missing: string[] } {
  const out = { analyzed: [] as Span[], talk: [] as Span[], unanalyzed: [] as Span[], missing: [] as string[] }
  const t = p.tracks.find((x) => x.id === trackId)
  for (const it of t?.items ?? []) {
    if (it.type !== 'media' || it.enabled === false || it.freeze) continue
    const asset = p.assets.find((a) => a.id === it.assetId)
    if (!asset || asset.kind === 'image' || !asset.audio) continue
    const span = { fromUs: it.startUs, toUs: itemEndUs(it) }
    const sp = speech[it.assetId]
    if (!sp) {
      out.missing.push(it.assetId)
      out.unanalyzed.push(span)
      continue
    }
    out.analyzed.push(span)
    out.talk.push(...speechOnTimeline({ startUs: it.startUs, durationUs: it.durationUs, srcInUs: it.inUs, speed: it.speed, reverse: it.reverse }, sp))
  }
  return out
}

/**
 * Cortes de silêncio. `speech`: intervalos de fala por assetId em tempo da FONTE (speechFromFile com
 * SILENCE_SPEECH_OPTS), carregados por quem chama. Silêncio = trecho de item de voz analisado em que nenhuma faixa de
 * referência fala; item de referência sem dados de fala conta como fala (não se sabe onde há silêncio: não corta).
 * Fora dos itens de voz nada é cortado. Cada silêncio ≥ minSilenceUs vira [início + margem, fim − margem).
 */
export function planSilenceCuts(p: Project, opts: SilenceCutOpts, speech: Readonly<Record<string, readonly SpeechInterval[]>>): SilenceCutPlan {
  const known: Span[] = []
  const talk: Span[] = []
  const missing = new Set<string>()
  const sources = p.tracks.filter((t) => opts.sourceTrackIds.includes(t.id))
  for (const t of sources) {
    const r = trackSpeech(p, t.id, speech)
    known.push(...r.analyzed)
    talk.push(...r.talk, ...r.unanalyzed)
    for (const id of r.missing) missing.add(id)
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
    // efeitos cobrem imagem: faixa de VÍDEO bloqueada (com mídia ou com efeitos) desalinharia efeito e conteúdo;
    // faixa de áudio bloqueada só fica fora de sincronia (aviso)
    const lockedVideo = p.tracks.some((t) => t.locked && t.kind === 'video')
    if (sources.some((t) => t.locked)) blocked = 'Uma faixa de voz de referência está bloqueada. Desbloqueie-a para remover os silêncios.'
    else if (lockedVideo && hasFx) blocked = 'Há faixas de vídeo bloqueadas e efeitos de privacidade: cortar só as faixas desbloqueadas tiraria os efeitos de cima do que eles escondem. Desbloqueie as faixas para remover os silêncios.'
  }
  const hit = (s: Us, e: Us): boolean => cuts.some((c) => c.fromUs < e && c.toUs > s)
  const musicTrackIds = cuts.length ? p.tracks.filter((t) => t.role === 'music' && !t.locked && t.items.some((i) => hit(i.startUs, itemEndUs(i)))).map((t) => t.id) : []
  return { cuts, savedUs: cuts.reduce((n, c) => n + c.toUs - c.fromUs, 0), lockedTrackIds, musicTrackIds, blocked, missingAssetIds: [...missing] }
}

/**
 * Fala de outras faixas analisadas (ex.: áudio do sistema) dentro dos cortes: por faixa, quantos cortes têm fala
 * nela. Música fica de fora (o painel avisa à parte que ela é cortada); itens sem dados de fala não acusam nada.
 */
export function speechInCuts(p: Project, cuts: readonly SilenceCut[], trackIds: readonly string[], speech: Readonly<Record<string, readonly SpeechInterval[]>>): { trackId: string; cuts: number }[] {
  const out: { trackId: string; cuts: number }[] = []
  for (const id of trackIds) {
    const t = p.tracks.find((x) => x.id === id)
    if (!t || t.role === 'music') continue
    const talk = union(trackSpeech(p, id, speech).talk)
    const n = cuts.filter((c) => talk.some((s) => s.fromUs < c.toUs && s.toUs > c.fromUs)).length
    if (n) out.push({ trackId: id, cuts: n })
  }
  return out
}

/**
 * Aplica os cortes (tempo de antes dos cortes) com deleteRanges em todas as faixas desbloqueadas — o mesmo que
 * deleteRange do último para o primeiro, numa edição só: um passo de desfazer para quem aplicar no store.
 */
export function applySilenceCuts(p: Project, cuts: readonly SilenceCut[]): Project {
  return deleteRanges(p, cuts)
}
