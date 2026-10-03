// Ocorrências de dados sensíveis (G3, sensitiveScan) → efeitos de privacidade ancorados (puro). Um efeito por
// (ocorrência × clipe que mostra o trecho da fonte), ancorado ao clipe (região no ESPAÇO DO CONTEÚDO: centro e tamanho
// em fração da fonte exibida — a mesma normalização das caixas da varredura, que decodifica já girado), vinculado ao
// grupo dele (acompanha mover/aparar/dividir/velocidade) e com keys de 'segurar' no tempo do efeito.
//
// Tempo (invariante 2: nunca cobrir menos): cada intervalo das keys da ocorrência [k_i, k_{i+1}) na FONTE vira o trecho
// da timeline em que sourceTimeUs cai nele — a inversa exata da conta do resolve (avanço, velocidade, reverso com o
// quadro de recuo, travas no trecho aparado e no fim do asset) —, alargado para fora (início para baixo, fim para cima)
// e por um quadro do projeto de cada lado, limitado ao clipe. Trechos que se cruzam (pela folga) ficam com a UNIÃO das
// caixas; nunca se perde uma caixa. Congelado: o clipe todo mostra só freeze.atUs → região parada daquele instante.
import { MIN_ITEM_US } from './project'
import type { Anim, Asset, EffectItem, EffectRegion, MediaItem, Project, Us } from './project'
import { createEffectItem } from './factory'
import { newId } from './ids'
import { addEffectItems } from './ops'
import { SENSITIVE_KIND_LABELS, type OcrBox } from './sensitive'
import { occurrenceKeys, occurrenceRegionAt, unionBox, type Occurrence } from './sensitiveScan'
import { frameDurUs, itemEndUs } from './time'

export interface HideOpts {
  /** 'blur' (padrão: valores do preset "Esconder texto") ou 'solid' (tarja preta). */
  style: 'blur' | 'solid'
  /** Só estes clipes (varredura pelo menu do clipe); ausente = todos os clipes visuais de mídia do asset. */
  clipIds?: string[]
}

export type HideSkipReason = 'notInClip' | 'locked'
export interface HideResult {
  project: Project
  itemIds: string[]
  skipped: { occurrenceId: string; reason: HideSkipReason }[]
}

/** Trecho da timeline [a, b) com a caixa (fonte, topo-esquerda normalizada) que precisa ficar coberta. */
export interface TimelineSpan { a: Us; b: Us; box: OcrBox }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Trechos da timeline (ordenados, contíguos) em que o clipe `m` mostra a ocorrência e a caixa de cada um. Vazio = o
 * clipe não mostra nenhum instante dela. Conservador: ver o cabeçalho.
 */
export function occurrenceSpans(p: Project, m: MediaItem, asset: Asset, occ: Occurrence): TimelineSpan[] {
  const S = m.startUs, E = itemEndUs(m)
  if (E <= S) return []
  const assetMax = asset.durationUs != null ? Math.max(0, asset.durationUs - 1) : Infinity
  // imagem (sem tempo) e congelado: o clipe todo mostra um instante só
  if (asset.kind === 'image' || m.freeze) {
    const box = occurrenceRegionAt(occ, Math.round(clamp(m.freeze?.atUs ?? 0, 0, assetMax)))
    return box ? [{ a: S, b: E, box }] : []
  }
  const keys = occurrenceKeys(occ)
  if (keys.length === 0) return []
  const pad = frameDurUs(p.canvas.fps || 30)
  const fd = frameDurUs(asset.video?.fps || 30)
  const dur = m.durationUs, sp = m.speed, inUs = m.inUs
  // trecho da fonte que o clipe mostra (as travas de sourceTimeUs)
  const hiRaw = inUs + Math.max(0, Math.ceil(dur * sp) - 1)
  const srcLo = Math.min(Math.max(inUs, 0), assetMax), srcHi = Math.min(Math.max(hiRaw, 0), assetMax)
  const raw: TimelineSpan[] = []
  for (let i = 0; i < keys.length; i++) {
    // [a, b) na fonte; a última key vale até endUs inclusive
    const a = keys[i].tUs, b = i + 1 < keys.length ? keys[i + 1].tUs : occ.endUs + 1
    if (b <= a || b <= srcLo || a > srcHi) continue
    let ta: number, tb: number
    if (!m.reverse) {
      // src = round(in + (t − S)·speed): src ≥ a ⇔ t ≥ S + (a − ½ − in)/speed; src < b ⇔ t < S + (b − ½ − in)/speed
      ta = a <= srcLo ? -Infinity : S + (a - 0.5 - inUs) / sp
      tb = b > srcHi ? Infinity : S + (b - 0.5 - inUs) / sp
    } else {
      // src = round(in + (dur − (t − S))·speed − fd), decrescente: src < b ⇔ t > S + dur − (b − ½ + fd − in)/speed;
      // src ≥ a ⇔ t ≤ S + dur − (a − ½ + fd − in)/speed (fechado: +1 µs)
      ta = b > srcHi ? -Infinity : S + dur - (b - 0.5 + fd - inUs) / sp
      tb = a <= srcLo ? Infinity : S + dur - (a - 0.5 + fd - inUs) / sp + 1
    }
    const lo = clamp(Number.isFinite(ta) ? Math.floor(ta) - pad : S, S, E)
    const hi = clamp(Number.isFinite(tb) ? Math.ceil(tb) + pad : E, S, E)
    if (hi > lo) raw.push({ a: lo, b: hi, box: keys[i].box })
  }
  if (raw.length === 0) return []
  // varredura: em cada trecho elementar, a união das caixas de todos os intervalos que o cobrem
  raw.sort((x, y) => x.a - y.a || x.b - y.b)
  const cuts = [...new Set(raw.flatMap((r) => [r.a, r.b]))].sort((x, y) => x - y)
  const out: TimelineSpan[] = []
  let next = 0
  let active: TimelineSpan[] = []
  let prevBox: OcrBox | null = null
  for (let c = 0; c + 1 < cuts.length; c++) {
    const u = cuts[c], v = cuts[c + 1]
    while (next < raw.length && raw[next].a <= u) active.push(raw[next++])
    active = active.filter((r) => r.b > u)
    // vão (não deveria haver: os intervalos da fonte são contíguos) — segura a caixa anterior (cobre mais, nunca menos)
    let box: OcrBox | null = prevBox
    if (active.length > 0) {
      box = active[0].box
      for (let j = 1; j < active.length; j++) box = unionBox(box, active[j].box)
    }
    if (!box) continue
    const last = out[out.length - 1]
    if (last && last.b === u && sameBox(last.box, box)) last.b = v
    else out.push({ a: u, b: v, box })
    prevBox = box
  }
  return out
}

const sameBox = (a: OcrBox, b: OcrBox): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** Caixa da fonte (topo-esquerda) → região do conteúdo (centro e tamanho na fração da fonte exibida). */
const contentOf = (b: OcrBox): { x: number; y: number; w: number; h: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h })

/** Região de 'segurar' (tempo local do efeito que começa em `startUs`) a partir dos trechos. */
function regionFromSpans(spans: readonly TimelineSpan[], startUs: Us): EffectRegion {
  const vals = spans.map((s) => ({ t: s.a - startUs, ...contentOf(s.box) }))
  const ch = (k: 'x' | 'y' | 'w' | 'h'): Anim<number> =>
    vals.length === 1 ? { value: vals[0][k] } : { value: vals[0][k], keys: vals.map((v) => ({ tUs: v.t, value: v[k], ease: 'hold' as const })) }
  return { shape: 'rect', x: ch('x'), y: ch('y'), w: ch('w'), h: ch('h'), rotation: { value: 0 } }
}

/** Nome do efeito: tipo + texto MASCARADO (nunca o valor). */
export const occurrenceEffectName = (occ: Occurrence): string => `${SENSITIVE_KIND_LABELS[occ.kind] ?? 'Dado sensível'} ${occ.masked}`

/**
 * Esconde as ocorrências `occs` do asset: um efeito por (ocorrência × clipe que mostra o trecho), ancorado e vinculado
 * ao clipe, nas faixas de efeitos (addEffectItems: reaproveita as livres, cria as que faltam). Um projeto novo = um
 * passo de desfazer. Clipes: os de mídia visuais (faixas de vídeo, inclusive ocultas e clipes desativados — mostrar a
 * faixa ou reativar o clipe depois não pode revelar o dado; ruling R25) do asset, ou só `opts.clipIds`.
 * Pulados (o efeito NÃO é criado; quem chama avisa):
 * - 'locked': clipe numa faixa bloqueada e sem grupo de vínculo — vincular exigiria editar a faixa bloqueada, e um
 *   efeito ancorado sem vínculo ficaria para trás se o clipe fosse movido depois (perda silenciosa). Com grupo, o
 *   efeito entra nele sem tocar no clipe;
 * - 'notInClip': nenhum clipe mostra a ocorrência.
 * Faixa de efeitos bloqueada: não é usada (como no addEffect) — o efeito vai para outra ou para uma faixa nova.
 */
export function hideOccurrences(p: Project, assetId: string, occs: readonly Occurrence[], opts: HideOpts): HideResult {
  const asset = p.assets.find((a) => a.id === assetId)
  const skipped: HideResult['skipped'] = []
  if (!asset) return { project: p, itemIds: [], skipped: occs.map((o) => ({ occurrenceId: o.id, reason: 'notInClip' as const })) }
  const only = opts.clipIds ? new Set(opts.clipIds) : null
  const clips: { m: MediaItem; trackId: string; locked: boolean }[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    for (const it of t.items) {
      if (it.type !== 'media' || it.assetId !== assetId || !it.visual || (only && !only.has(it.id))) continue
      clips.push({ m: it, trackId: t.id, locked: t.locked && !it.linkId })
    }
  }
  const preset = opts.style === 'solid' ? 'solid' : 'blurText'
  const items: EffectItem[] = []
  const linkTo: string[] = []
  for (const occ of occs) {
    const reasons = new Set<HideSkipReason>()
    let made = 0
    for (const c of clips) {
      const spans = occurrenceSpans(p, c.m, asset, occ)
      if (spans.length === 0) continue
      if (c.locked) { reasons.add('locked'); continue }
      let a = spans[0].a, b = spans[spans.length - 1].b
      // nenhum item menor que MIN_ITEM_US: alarga para dentro do clipe (a última caixa segue valendo)
      if (b - a < MIN_ITEM_US) {
        b = Math.min(itemEndUs(c.m), a + MIN_ITEM_US)
        a = Math.max(c.m.startUs, b - MIN_ITEM_US)
      }
      if (b - a < MIN_ITEM_US) { reasons.add('notInClip'); continue }
      const base = createEffectItem(preset, a, b - a)
      items.push({
        ...base,
        id: newId('i_'),
        name: occurrenceEffectName(occ),
        region: regionFromSpans(spans, a),
        scope: 'below',
        invert: false,
        targetTrackId: c.trackId,
        attach: { mediaItemId: c.m.id }
      })
      linkTo.push(c.m.id)
      made++
    }
    if (made === 0 && reasons.size === 0) reasons.add('notInClip')
    for (const r of reasons) skipped.push({ occurrenceId: occ.id, reason: r })
  }
  return { project: addEffectItems(p, items, linkTo), itemIds: items.map((i) => i.id), skipped }
}
