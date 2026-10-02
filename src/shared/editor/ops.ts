import { produce } from 'immer'
import { copyKeys, evalAnim, insertKeyExact, pasteKeys, removeKey, setEase, setKey, setValue, sliceKeys } from './anim'
import { ANIM_PATHS, assignAnim, getAnim, mapItemAnims as mapAnims, mapVisualAnims as mapVisual, type AnimPath } from './animPaths'
import { maintainAttachments } from './attachment'
import { createEffectItem, createMediaItem, createShapeItem, createTextItem, patchTextStyle } from './factory'
import { conservativeRegion, regionAabb } from './contentPose'
import { effectRegionAt, sourceTimeUs, visualTrackBelow } from './resolve'
import type { EffectPresetId, EffectRegionInit, ShapePresetId, TextPresetId } from './factory'
import { newId } from './ids'
import { frameDurUs, itemEndUs } from './time'
import { MAX_SPEED, MIN_ITEM_US, MIN_SPEED } from './project'
import type { Anim, Asset, Ease, EffectItem, Item, Keyframe, MediaItem, Project, ShapeItem, TextItem, TextStyle, Track, TrackKind, TransitionKind, Us } from './project'
import { canTransition, DEFAULT_TRANSITION_US, maxTransitionUs, MIN_TRANSITION_US, transitionPairOk } from './transitions'
import type { Cue } from './srt'

export { getAnim, type AnimPath } from './animPaths'

// Operações de edição puras: (project, ...) => Project. Lançam EditError quando a operação é inválida.

export type EditErrorCode = 'overlap' | 'locked' | 'bounds' | 'notFound' | 'invalid'
export class EditError extends Error {
  readonly code: EditErrorCode
  constructor(code: EditErrorCode, msg: string) {
    super(msg)
    this.name = 'EditError'
    this.code = code
  }
}

export type InsertMode = 'overwrite' | 'insert'

const end = itemEndUs
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
/** Faixa de efeitos (role 'effects': só recebe efeitos; mídia nunca entra nela)? Pelo papel, nunca pelo nome. */
export const isFxTrack = (t: Track): boolean => t.kind === 'video' && t.role === 'effects'
/** Faixa de legendas (role 'captions': só textos; no máximo uma, sempre a faixa de vídeo do topo)? */
export const isCaptionsTrack = (t: Track): boolean => t.kind === 'video' && t.role === 'captions'
/**
 * Faixa de sobreposição: de vídeo, sem papel, com itens e todos texto/forma. Fica acima das faixas de efeitos (o texto
 * não é desfocado pelos efeitos de privacidade) e abaixo da de legendas. Vazia não conta (como a de anotações).
 */
export const isOverlayTrack = (t: Track): boolean =>
  t.kind === 'video' && t.role === undefined && t.items.length > 0 && t.items.every((i) => i.type === 'text' || i.type === 'shape')
/** Faixa de vídeo com conteúdo visual (mídia, anotações ou vazia) — nem efeitos, nem legendas, nem sobreposição. */
const isContentTrack = (t: Track): boolean => t.kind === 'video' && !isFxTrack(t) && !isCaptionsTrack(t) && !isOverlayTrack(t)
/**
 * A faixa no índice i está acima de alguma faixa de efeitos ou da de legendas? Colocação AUTOMÁTICA de mídia nunca usa
 * nem cria faixa nessa posição (ficaria por cima dos efeitos de privacidade) — inclusive uma faixa "Texto" que ficou
 * vazia. Mover explicitamente continua livre (privacyWarnings 'covered' avisa).
 */
function aboveGuard(p: Project, i: number): boolean {
  const g = p.tracks.findIndex((t) => isFxTrack(t) || isCaptionsTrack(t))
  return g >= 0 && i > g
}

/**
 * Efeito "só a faixa abaixo" sem targetTrackId (projeto antigo): grava a faixa a que ele está ligado agora pela
 * posição (visualTrackBelow), antes de qualquer edição mexer na ordem das faixas. Daí em diante a ligação é explícita.
 */
function stampLegacyTargets(d: Project): void {
  for (const t of d.tracks) {
    for (const it of t.items) {
      if (it.type !== 'effect' || it.scope !== 'track' || it.targetTrackId) continue
      const below = visualTrackBelow(d, t.id)
      // faixa com texto/forma: gravar a ligação faria o efeito passar a agir no texto (o alvo antigo só vale para
      // mídia/anotações — resolve legacyTarget); fica sem gravar, com o mesmo comportamento de antes
      if (below && !d.tracks.find((x) => x.id === below)!.items.some((x) => x.type === 'text' || x.type === 'shape')) it.targetTrackId = below
    }
  }
}

/**
 * produce do immer com stampLegacyTargets antes da receita (toda edição grava as ligações antigas) e as âncoras dos
 * efeitos mantidas depois (maintainAttachments: pedaço certo do clipe e caixa de reserva).
 */
function edit(p: Project, recipe: (d: Project) => void): Project {
  const next = produce(p, (d) => {
    stampLegacyTargets(d)
    recipe(d)
    maintainAttachments(d)
  })
  return normalizeTransitions(p, next)
}

/**
 * Passada única O(itens) depois de toda edição (via edit/deleteRanges): nas faixas que a edição mudou (e não
 * bloqueadas), a transição de entrada de cada item sai se o anterior não estiver encostado/elegível ou se o máximo do
 * par ficar abaixo do mínimo, e é limitada ao máximo (floor(min/2)). Cobre split/trim/move/apagar/velocidade/congelar/
 * ripple/duplicar sem lógica em cada op. Faixas não mudadas ficam intactas (o mesmo objeto). `enabled` não conta
 * (desativar é reversível; quem desenha pula o par). Efeito colateral aceito: qualquer mudança no objeto da faixa —
 * inclusive só de propriedades dela (desbloquear, ocultar, renomear) — normaliza a faixa toda, então uma transição
 * inválida gravada fora do editor (ex.: arquivo editado na v1.3) é corrigida/removida nessa hora.
 */
function normalizeTransitions(prev: Project, next: Project): Project {
  if (prev === next) return next
  const before = new Map(prev.tracks.map((t) => [t.id, t]))
  const fixes: { ti: number; ii: number; d: Us | null }[] = []
  next.tracks.forEach((t, ti) => {
    if (t.locked || before.get(t.id) === t) return
    for (let ii = 0; ii < t.items.length; ii++) {
      const b = t.items[ii]
      if ((b.type !== 'media' && b.type !== 'text') || !b.transitionIn) continue
      const a = ii > 0 ? t.items[ii - 1] : undefined
      const max = transitionPairOk(t, a, b) ? maxTransitionUs(a, b) : -1
      if (max < MIN_TRANSITION_US) fixes.push({ ti, ii, d: null })
      else if (b.transitionIn.durationUs > max) fixes.push({ ti, ii, d: max })
    }
  })
  if (!fixes.length) return next
  return produce(next, (d) => {
    for (const f of fixes) {
      const it = d.tracks[f.ti].items[f.ii] as MediaItem
      if (f.d === null) delete it.transitionIn
      else it.transitionIn!.durationUs = f.d
    }
  })
}

// ---------------------------------------------------------------- consultas

export function findItem(p: Project, itemId: string): { track: Track; item: Item; trackIndex: number; itemIndex: number } | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti]
    const ii = track.items.findIndex((i) => i.id === itemId)
    if (ii >= 0) return { track, item: track.items[ii], trackIndex: ti, itemIndex: ii }
  }
  return null
}

/** O grupo `linkId` tem algum item que não é efeito (clipe de vídeo/áudio, etc.)? */
function groupHasMedia(p: Project, linkId: string): boolean {
  return p.tracks.some((t) => t.items.some((i) => i.linkId === linkId && i.type !== 'effect'))
}

/**
 * Inclui o próprio item (primeiro); vazio se não existir. Efeito vinculado a um clipe é "seguidor": acompanha as
 * edições do clipe (a partir do clipe vêm todos, inclusive os efeitos), mas a partir do efeito só ele mesmo — mexer
 * no efeito nunca arrasta o clipe.
 */
export function linkedIds(p: Project, itemId: string): string[] {
  const f = findItem(p, itemId)
  if (!f) return []
  const link = f.item.linkId
  if (!link || (f.item.type === 'effect' && groupHasMedia(p, link))) return [itemId]
  const out = [itemId]
  for (const t of p.tracks) for (const i of t.items) if (i.linkId === link && i.id !== itemId) out.push(i.id)
  return out
}

/** Efeito vinculado a um clipe (segue as edições dele)? */
function isFollower(p: Project, it: Item): boolean {
  return it.type === 'effect' && !!it.linkId && groupHasMedia(p, it.linkId)
}

export function projectDurationUs(p: Project): Us {
  let max = 0
  for (const t of p.tracks) if (!t.hidden) for (const i of t.items) max = Math.max(max, end(i))
  return max
}

/**
 * Fim do conteúdo exportável: como projectDurationUs, mas sem efeitos e sem itens desativados (um efeito solto
 * depois do fim da mídia não estica a exportação "Tudo" com quadros pretos).
 */
export function contentEndUs(p: Project): Us {
  let max = 0
  for (const t of p.tracks) if (!t.hidden) for (const i of t.items) if (i.type !== 'effect' && i.enabled !== false) max = Math.max(max, end(i))
  return max
}

// ---------------------------------------------------------------- helpers internos

function mustFind(p: Project, itemId: string): NonNullable<ReturnType<typeof findItem>> {
  const f = findItem(p, itemId)
  if (!f) throw new EditError('notFound', `Item não encontrado: ${itemId}`)
  return f
}

function mustTrack(p: Project, trackId: string): Track {
  const t = p.tracks.find((x) => x.id === trackId)
  if (!t) throw new EditError('notFound', `Faixa não encontrada: ${trackId}`)
  return t
}

function assertUnlocked(track: Track): void {
  if (track.locked) throw new EditError('locked', `Faixa bloqueada: ${track.name}`)
}

/**
 * Ripple que deixa faixas bloqueadas para trás desalinha efeitos de privacidade: com uma faixa de VÍDEO bloqueada
 * (mídia ou efeitos) e algum efeito terminando depois de `fromUs`, efeito e conteúdo que ele esconde se separam.
 * Regra única do congelar quadro e da remoção de silêncios (faixa de áudio bloqueada só sai de sincronia).
 */
export function lockedVideoDesyncsEffects(p: Project, fromUs: Us): boolean {
  return p.tracks.some((t) => t.locked && t.kind === 'video') && p.tracks.some((t) => t.items.some((i) => i.type === 'effect' && end(i) > fromUs))
}

/** Ids dados + (opcionalmente) vinculados, sem repetição; lança se algum não existir. */
function expand(p: Project, itemIds: string[], includeLinked: boolean): string[] {
  const out: string[] = []
  for (const id of itemIds) {
    mustFind(p, id)
    for (const x of includeLinked ? linkedIds(p, id) : [id]) if (!out.includes(x)) out.push(x)
  }
  return out
}

/** Item visual (não-áudio) só pode ficar em faixa de vídeo. */
function fitsTrack(it: Item, kind: TrackKind): boolean {
  if (kind === 'video') return it.type !== 'media' || !!it.visual
  return it.type === 'media' && !it.visual
}

function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out = { ...obj }
  for (const k of keys) delete out[k]
  return out
}

function withLink<T extends Item>(it: T, linkId: string | undefined): T {
  return linkId ? { ...it, linkId } : (omit(it, 'linkId') as T)
}

function mapLink(linkMap: Map<string, string>, linkId: string | undefined): string | undefined {
  if (!linkId) return undefined
  let n = linkMap.get(linkId)
  if (!n) linkMap.set(linkId, (n = newId('l_')))
  return n
}

/** Zera o que pertence à entrada (fade/anim/transição de entrada) e/ou à saída de um pedaço. */
function clearEdges<T extends Item>(it: T, inSide: boolean, outSide: boolean): T {
  if (!inSide && !outSide) return it
  let out = { ...it } as Item
  if ('visual' in out && out.visual) {
    let v = { ...out.visual }
    if (inSide) v = { ...omit(v, 'animIn'), fadeInUs: 0 }
    if (outSide) v = { ...omit(v, 'animOut'), fadeOutUs: 0 }
    out = { ...out, visual: v } as Item
  }
  if (out.type === 'media') {
    out = { ...out, audio: { ...out.audio, ...(inSide ? { fadeInUs: 0 } : {}), ...(outSide ? { fadeOutUs: 0 } : {}) } }
  }
  if (inSide && 'transitionIn' in out) out = omit(out, 'transitionIn') as Item
  return out as T
}

/**
 * Recorta o item para o intervalo absoluto [from,to) (pode estender além das bordas no trim):
 * ajusta inUs (considerando speed e reverse) e reparte os keyframes com sliceKeys.
 */
function sliceItem<T extends Item>(it: T, from: Us, to: Us, clearCut: boolean): T {
  const s = it.startUs, e = end(it)
  let out = mapAnims(it, (a) => sliceKeys(a, from - s, to - s)) as Item
  out = { ...out, startUs: from, durationUs: to - from }
  if (out.type === 'media') {
    const m = it as MediaItem
    const off = m.reverse ? e - to : from - s
    out = { ...out, inUs: Math.max(0, m.inUs + Math.round(off * m.speed)) }
  } else if (out.type === 'annotations') {
    out = { ...out, inUs: Math.max(0, out.inUs + (from - s)) }
  } else if (out.type === 'text' && out.counter && clearCut) {
    // pedaço de um corte (dividir/apagar trecho): a contagem continua de onde estava no ponto do corte (valores exatos,
    // sem arredondar — não é tempo). Aparar (clearCut false) mantém from/to: a contagem cobre a nova duração.
    const c = out.counter, dur = it.durationUs
    const at = (t: Us): number => (t <= s ? c.from : t >= e ? c.to : c.from + ((c.to - c.from) * (t - s)) / dur)
    out = { ...out, counter: { from: at(from), to: at(to) } }
  }
  return (clearCut ? clearEdges(out, from > s, to < e) : out) as T
}

/**
 * Recorta/divide os itens da faixa que cruzam [from,to); pedaços menores que MIN_ITEM_US somem.
 * Acumula em `cutLinks` os linkIds de itens divididos em dois (para relinkAcross).
 */
function overwriteRange(track: Track, from: Us, to: Us, cutLinks: Set<string>): void {
  const out: Item[] = []
  for (const it of track.items) {
    const s = it.startUs, e = end(it)
    if (e <= from || s >= to) { out.push(it); continue }
    const left = s < from && from - s >= MIN_ITEM_US
    if (left) out.push(sliceItem(it, s, from, true))
    if (e > to && e - to >= MIN_ITEM_US) {
      const right = sliceItem(it, to, e, true)
      out.push(left ? { ...right, id: newId('i_') } : right)
      if (left && it.linkId) cutLinks.add(it.linkId)
    }
  }
  track.items = out
}

/**
 * Depois de um corte em [from,to): nos grupos vinculados que foram divididos, os membros à direita
 * (startUs ≥ to) recebem um linkId novo comum; o original fica só com os da esquerda (startUs < from).
 */
function relinkAcross(d: Project, from: Us, to: Us, cutLinks: Set<string>): void {
  for (const link of cutLinks) {
    const members = d.tracks.flatMap((t) => t.items.filter((i) => i.linkId === link))
    // com clipe no grupo, quem decide a divisão é a mídia (cortar só o efeito seguidor não o desvincula do
    // clipe); os efeitos vão para o lado em que começam
    const media = members.filter((i) => i.type !== 'effect')
    const deciders = media.length ? media : members
    if (!deciders.some((i) => i.startUs < from) || !deciders.some((i) => i.startUs >= to)) continue
    const n = newId('l_')
    for (const i of members) if (i.startUs >= to) i.linkId = n
  }
}

/** Divide os alvos que contêm atUs com ≥ MIN_ITEM_US dos dois lados; 'all' = faixas desbloqueadas. */
function splitInPlace(d: Project, targets: Set<string> | 'all', atUs: Us): number {
  let count = 0
  const cutLinks = new Set<string>()
  for (const t of d.tracks) {
    if (targets === 'all' && t.locked) continue
    const out: Item[] = []
    let hits = 0
    for (const it of t.items) {
      const s = it.startUs, e = end(it)
      const hit = (targets === 'all' || targets.has(it.id)) && atUs - s >= MIN_ITEM_US && e - atUs >= MIN_ITEM_US
      if (!hit) { out.push(it); continue }
      assertUnlocked(t)
      out.push(sliceItem(it, s, atUs, true))
      out.push({ ...sliceItem(it, atUs, e, true), id: newId('i_') })
      if (it.linkId) cutLinks.add(it.linkId)
      hits++
    }
    if (hits > 0) t.items = out
    count += hits
  }
  relinkAcross(d, atUs, atUs, cutLinks)
  return count
}

/**
 * Abre espaço [point, point+D) em todas as faixas desbloqueadas (ripple global para manter sincronia):
 * divide o que cruza o ponto e empurra tudo a partir dele. Se o ponto cair a menos de MIN_ITEM_US
 * da borda de um item da faixa alvo, encaixa na borda. Devolve o ponto efetivo.
 */
function makeRoom(d: Project, pointUs: Us, D: Us, targetTrackId: string): Us {
  let point = pointUs
  const target = mustTrack(d, targetTrackId)
  const cross = target.items.find((i) => i.startUs < point && end(i) > point)
  if (cross) {
    if (point - cross.startUs < MIN_ITEM_US) point = cross.startUs
    else if (end(cross) - point < MIN_ITEM_US) point = end(cross)
  }
  splitInPlace(d, 'all', point)
  for (const t of d.tracks) {
    if (t.locked) continue
    for (const it of t.items) if (it.startUs >= point) it.startUs += D
  }
  return point
}

/**
 * Desloca itens com startUs ≥ pivot por shift nas faixas desbloqueadas. Ao puxar para trás (shift < 0),
 * faixas fora de `forced` só se movem se o intervalo [pivot+shift, pivot) estiver vazio nelas.
 * Os marcadores ≥ pivot só se deslocam se todas as faixas desbloqueadas foram deslocadas.
 * Efeitos vinculados a um clipe não decidem pela própria posição nem bloqueiam a faixa: andam junto com a mídia
 * do grupo (se ela andou), mesmo começando antes do pivô.
 */
function rippleShift(d: Project, pivotUs: Us, shift: Us, exclude: Set<string>, forced: Set<string>): string[] {
  if (shift === 0) return []
  const fol = new Set<string>()
  for (const t of d.tracks) for (const i of t.items) if (isFollower(d, i)) fol.add(i.id)
  const movedLinks = new Set<string>()
  let all = true
  for (const t of d.tracks) {
    if (t.locked) continue
    if (shift < 0 && !forced.has(t.id)) {
      const g0 = pivotUs + shift
      if (t.items.some((i) => !exclude.has(i.id) && !fol.has(i.id) && i.startUs < pivotUs && end(i) > g0)) { all = false; continue }
    }
    for (const it of t.items) {
      if (exclude.has(it.id) || fol.has(it.id) || it.startUs < pivotUs) continue
      it.startUs += shift
      if (it.linkId) movedLinks.add(it.linkId)
    }
  }
  const followed: string[] = []
  for (const t of d.tracks) {
    if (t.locked) continue
    for (const it of t.items) {
      if (!fol.has(it.id) || exclude.has(it.id) || !movedLinks.has(it.linkId!)) continue
      it.startUs += shift
      followed.push(it.id)
    }
  }
  if (all) for (const m of d.markers) if (m.tUs >= pivotUs) m.tUs += shift
  // um seguidor que bate em outro item da faixa dele muda de faixa (nunca recorta nem é recortado)
  relocateFollowers(d, followed)
  return followed
}

function isFree(t: Track, s: Us, e: Us, exclude?: Set<string>): boolean {
  return !t.items.some((i) => !exclude?.has(i.id) && i.startUs < e && end(i) > s)
}

/** Próximo nome livre de faixa de efeitos: "Efeitos", "Efeitos 2", … */
function nextFxName(p: Project): string {
  let name = 'Efeitos', n = 2
  while (p.tracks.some((t) => t.name === name)) name = `Efeitos ${n++}`
  return name
}

/**
 * Põe o efeito `it` (já fora de qualquer faixa) numa faixa: `prefer` se estiver livre e desbloqueada; senão uma
 * faixa de efeitos existente acima de toda a mídia, visível, desbloqueada e livre no intervalo; senão uma "Efeitos N"
 * nova no topo do bloco de efeitos — nunca abaixo de mídia. A ligação do escopo `track` é explícita
 * (targetTrackId), então a faixa do efeito não importa para ela.
 */
function placeEffect(d: Project, it: Item, prefer?: Track): void {
  const s = it.startUs, e = end(it)
  if (prefer && !prefer.locked && isFree(prefer, s, e)) { prefer.items.push(it); return }
  const t = fxTrackFor(d, s, e)
  ;(t ?? mustTrack(d, createTrack(d, 'video', fxInsertIndex(d), nextFxName(d), 'effects'))).items.push(it)
}

/**
 * Bloco de efeitos: entre a última faixa de conteúdo visual (lo) e a primeira de sobreposição/legendas acima dela (hi,
 * exclusivo). Sem texto nem legendas, o bloco vai até o topo (como antes da F5).
 */
function fxBlock(p: Project): { lo: number; hi: number } {
  const lo = p.tracks.reduce((m, t, i) => (isContentTrack(t) ? i : m), -1)
  const hi = p.tracks.findIndex((t, i) => i > lo && (isOverlayTrack(t) || isCaptionsTrack(t)))
  return { lo, hi: hi < 0 ? Infinity : hi }
}

/** Faixa de efeitos do bloco (acima de toda a mídia, abaixo de texto/legendas) visível, desbloqueada e livre em [s, e). */
function fxTrackFor(p: Project, s: Us, e: Us): Track | undefined {
  const { lo, hi } = fxBlock(p)
  return p.tracks.find((t, i) => i > lo && i < hi && isFxTrack(t) && !t.locked && !t.hidden && isFree(t, s, e))
}

/** Índice de uma faixa de efeitos nova: logo abaixo da 1ª de sobreposição/legendas acima da mídia; sem elas, o topo. */
function fxInsertIndex(p: Project): number {
  const { hi } = fxBlock(p)
  return hi === Infinity ? aboveLastVideo(p) : hi
}

/** Faixa do clipe de vídeo do grupo do efeito (o que cruza o intervalo dele, se houver); null = sem clipe vinculado. */
function linkedClipTrack(p: Project, it: Item): string | null {
  if (!it.linkId) return null
  let best: string | null = null
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    for (const m of t.items) {
      if (m.linkId !== it.linkId || m.type !== 'media' || !m.visual) continue
      if (!best || (m.startUs < end(it) && end(m) > it.startUs)) best = t.id
    }
  }
  return best
}

/** Faixa de anotações (traços da gravação): só itens de anotações. Não é alvo nem clipe de efeito. */
const isAnnotationsTrack = (t: Track): boolean => t.items.length > 0 && t.items.every((i) => i.type === 'annotations')

/** Faixa de mídia visível mais próxima abaixo de trackId (pula ocultas, de áudio, de efeitos e de anotações); null = nenhuma. */
function mediaTrackBelow(p: Project, trackId: string): string | null {
  for (let i = p.tracks.findIndex((t) => t.id === trackId) - 1; i >= 0; i--) {
    const t = p.tracks[i]
    if (t.kind === 'video' && !t.hidden && !isFxTrack(t) && !isAnnotationsTrack(t)) return t.id
  }
  return null
}

/** Faixa que o escopo `track` do efeito afeta hoje: targetTrackId (projeto antigo: a de vídeo visível logo abaixo). */
export function scopeTargetTrack(p: Project, itemId: string): Track | null {
  const f = findItem(p, itemId)
  if (!f || f.item.type !== 'effect') return null
  const id = f.item.targetTrackId ?? visualTrackBelow(p, f.track.id)
  return p.tracks.find((t) => t.id === id) ?? null
}

/** Alvo do escopo `track` de um efeito na faixa effectTrackId: a faixa do clipe vinculado, senão a mídia logo abaixo. */
function scopeTarget(p: Project, it: Item, effectTrackId: string): string | undefined {
  return linkedClipTrack(p, it) ?? mediaTrackBelow(p, effectTrackId) ?? undefined
}

/**
 * Escopo do efeito. "Só a faixa abaixo" (`track`) grava targetTrackId: a faixa do clipe vinculado, senão a de mídia
 * visível mais próxima abaixo do efeito. "Tudo abaixo" apaga a ligação.
 */
export function setEffectScope(p: Project, itemId: string, scope: EffectItem['scope']): Project {
  const f = mustFind(p, itemId)
  if (f.item.type !== 'effect') throw new EditError('invalid', 'Só efeitos têm escopo')
  assertUnlocked(f.track)
  const target = scope === 'track' ? scopeTarget(p, f.item, f.track.id) : undefined
  return edit(p, (d) => {
    const it = mustFind(d, itemId).item as EffectItem
    it.scope = scope
    if (target) it.targetTrackId = target
    else delete it.targetTrackId
  })
}

/**
 * Sobrescrever [s, e) numa faixa: nunca recorta seguidores numa faixa "Efeitos" (são tirados da faixa e devolvidos
 * para recolocar com placeEffect depois); clipe de mídia apagado por inteiro tira o vínculo dos efeitos órfãos.
 */
function overwriteIn(d: Project, t: Track, s: Us, e: Us): Item[] {
  let lifted: Item[] = []
  if (isFxTrack(t)) {
    lifted = t.items.filter((i) => isFollower(d, i) && i.startUs < e && end(i) > s)
    if (lifted.length) t.items = t.items.filter((i) => !lifted.includes(i))
  }
  const media = t.items.filter((i) => i.type !== 'effect' && i.linkId).map((i) => [i.id, i.linkId!] as const)
  const cut = new Set<string>()
  overwriteRange(t, s, e, cut)
  relinkAcross(d, s, e, cut)
  dropOrphanLinks(d, media.filter(([id]) => !t.items.some((i) => i.id === id)).map(([, l]) => l))
  return lifted
}

/** Mídia (não-efeito) não entra em faixa "Efeitos": ficaria por cima dos efeitos das faixas de baixo. */
function assertNotFxTrackFor(it: Item, t: Track): void {
  if (it.type !== 'effect' && isFxTrack(t)) throw new EditError('invalid', `A faixa "${t.name}" é só para efeitos`)
  if (it.type !== 'text' && isCaptionsTrack(t)) throw new EditError('invalid', `A faixa "${t.name}" é só para legendas (textos)`)
}

/**
 * Seguidores (efeitos vinculados a um clipe) que ficaram sobrepostos a outro item da própria faixa saem dela para
 * outra faixa de efeitos (placeEffect). Sobrescrever nunca vale para seguidores: nem eles recortam, nem são recortados.
 */
function relocateFollowers(d: Project, ids: Iterable<string>): void {
  for (const id of ids) {
    const f = findItem(d, id)
    if (!f || !isFollower(d, f.item) || isFree(f.track, f.item.startUs, end(f.item), new Set([id]))) continue
    f.track.items.splice(f.itemIndex, 1)
    placeEffect(d, f.item)
  }
}

/** Grupos de `links` que ficaram sem mídia: os efeitos que sobraram perdem o vínculo (não seguem mais nada). */
function dropOrphanLinks(d: Project, links: Iterable<string>): void {
  for (const link of links) {
    if (groupHasMedia(d, link)) continue
    for (const t of d.tracks) for (const it of t.items) if (it.linkId === link && it.type === 'effect') delete it.linkId
  }
}

/** linkIds dos itens de mídia (não-efeito) dados. */
function mediaLinks(p: Project, ids: Iterable<string>): string[] {
  const out: string[] = []
  for (const id of ids) {
    const it = findItem(p, id)?.item
    if (it && it.type !== 'effect' && it.linkId) out.push(it.linkId)
  }
  return out
}

/** Ordena itens, remove linkId órfão (sem par) e garante que nenhuma faixa tenha sobreposição. */
function finalize(d: Project): void {
  const count = new Map<string, number>()
  for (const t of d.tracks) {
    if (t.items.some((it, i) => i > 0 && t.items[i - 1].startUs > it.startUs)) t.items = [...t.items].sort((a, b) => a.startUs - b.startUs)
    for (const it of t.items) if (it.linkId) count.set(it.linkId, (count.get(it.linkId) ?? 0) + 1)
  }
  for (const t of d.tracks) {
    for (const it of t.items) if (it.linkId && (count.get(it.linkId) ?? 0) < 2) delete it.linkId
    let maxEnd = -Infinity
    for (const it of t.items) {
      if (it.startUs < maxEnd) throw new EditError('overlap', `Sobreposição na faixa "${t.name}"`)
      maxEnd = Math.max(maxEnd, end(it))
    }
  }
}

/** "Música", "Música 2"… (nome livre para uma faixa de música nova). */
export function musicTrackName(p: Project): string {
  if (!p.tracks.some((t) => t.name === 'Música')) return 'Música'
  let n = 2
  while (p.tracks.some((t) => t.name === `Música ${n}`)) n++
  return `Música ${n}`
}

/** `base`, "`base` 2", "`base` 3"… — o primeiro nome que nenhuma faixa usa. */
function freeTrackName(p: Project, base: string): string {
  if (!p.tracks.some((t) => t.name === base)) return base
  let n = 2
  while (p.tracks.some((t) => t.name === `${base} ${n}`)) n++
  return `${base} ${n}`
}

/**
 * Faixa de áudio de papel Voz para um item em [s, e): a primeira desbloqueada e livre nesse trecho (com `named`, só as
 * chamadas `name` ou "`name` N"); sem nenhuma, cria "`name`" (ou "`name` N", se o nome já existe) no fim, com papel Voz.
 */
export function voiceTrackFor(p: Project, s: Us, e: Us, opts: { name: string; named?: boolean }): { project: Project; trackId: string } {
  const named = (t: Track): boolean => t.name === opts.name || (t.name.startsWith(`${opts.name} `) && /^\d+$/.test(t.name.slice(opts.name.length + 1)))
  const found = p.tracks.find((t) => t.kind === 'audio' && t.role === 'voice' && !t.locked && (!opts.named || named(t)) && isFree(t, s, e))
  if (found) return { project: p, trackId: found.id }
  return addTrack(p, 'audio', undefined, freeTrackName(p, opts.name), 'voice')
}

function defaultTrackName(p: Project, kind: TrackKind): string {
  const prefix = kind === 'video' ? 'Vídeo' : 'Áudio'
  let n = p.tracks.filter((t) => t.kind === kind && !isFxTrack(t)).length + 1
  while (p.tracks.some((t) => t.name === `${prefix} ${n}`)) n++
  return `${prefix} ${n}`
}

/** Índice logo acima da última faixa de vídeo (0 = fundo). */
function aboveLastVideo(p: Project): number {
  let last = -1
  p.tracks.forEach((t, i) => { if (t.kind === 'video') last = i })
  return last + 1
}

/**
 * Cria faixa no draft. Índice padrão: vídeo logo acima da última faixa de vídeo, mas abaixo do bloco de faixas
 * "Efeitos" do topo (mídia nova nunca fica por cima dos efeitos de privacidade); áudio no fim.
 */
function createTrack(d: Project, kind: TrackKind, index?: number, name?: string, role?: Track['role']): string {
  let at = index
  if (at === undefined) {
    if (kind === 'audio') at = d.tracks.length
    else {
      // abaixo do bloco do topo: efeitos, sobreposições (texto/forma), legendas e qualquer faixa de vídeo acima de
      // efeitos/legendas (ex.: "Texto" vazia)
      at = aboveLastVideo(d)
      const up = (t: Track, i: number): boolean => isFxTrack(t) || isOverlayTrack(t) || isCaptionsTrack(t) || (t.kind === 'video' && aboveGuard(d, i))
      while (at > 0 && up(d.tracks[at - 1], at - 1)) at--
    }
  }
  // nenhuma faixa de vídeo acima da de legendas
  const cap = d.tracks.findIndex(isCaptionsTrack)
  if (kind === 'video' && role !== 'captions' && cap >= 0 && at > cap) at = cap
  const id = newId('t_')
  d.tracks.splice(clamp(at, 0, d.tracks.length), 0, {
    id, kind, name: name ?? defaultTrackName(d, kind), muted: false, hidden: false, locked: false, volume: 1, ...(role ? { role } : {}), items: []
  })
  return id
}

// ---------------------------------------------------------------- assets

export function addAsset(p: Project, a: Asset): Project {
  if (p.assets.some((x) => x.id === a.id)) throw new EditError('invalid', `Asset já existe: ${a.id}`)
  return edit(p, (d) => { d.assets.push(a) })
}

export function updateAsset(p: Project, id: string, patch: Partial<Asset>): Project {
  const i = p.assets.findIndex((x) => x.id === id)
  if (i < 0) throw new EditError('notFound', `Asset não encontrado: ${id}`)
  return edit(p, (d) => { Object.assign(d.assets[i], omit(patch, 'id')) })
}

/** Remove o asset e todos os itens que o usam (inclusive em faixas bloqueadas). */
export function removeAsset(p: Project, id: string): Project {
  if (!p.assets.some((x) => x.id === id)) throw new EditError('notFound', `Asset não encontrado: ${id}`)
  return edit(p, (d) => {
    d.assets = d.assets.filter((x) => x.id !== id)
    const links = d.tracks.flatMap((t) => t.items.filter((i) => i.type === 'media' && i.assetId === id && i.linkId).map((i) => i.linkId!))
    for (const t of d.tracks) {
      if (t.items.some((i) => i.type === 'media' && i.assetId === id)) t.items = t.items.filter((i) => !(i.type === 'media' && i.assetId === id))
    }
    dropOrphanLinks(d, links)
    finalize(d)
  })
}

// ---------------------------------------------------------------- faixas

export function addTrack(p: Project, kind: TrackKind, index?: number, name?: string, role?: Track['role']): { project: Project; trackId: string } {
  let trackId = ''
  const project = edit(p, (d) => { trackId = createTrack(d, kind, index, name, role) })
  return { project, trackId }
}

export function removeTrack(p: Project, trackId: string): Project {
  assertUnlocked(mustTrack(p, trackId))
  const links = mediaLinks(p, mustTrack(p, trackId).items.map((i) => i.id))
  return edit(p, (d) => {
    d.tracks = d.tracks.filter((t) => t.id !== trackId)
    dropOrphanLinks(d, links)
    finalize(d)
  })
}

export function moveTrack(p: Project, trackId: string, toIndex: number): Project {
  const from = p.tracks.findIndex((t) => t.id === trackId)
  if (from < 0) throw new EditError('notFound', `Faixa não encontrada: ${trackId}`)
  const to = clamp(Math.round(toIndex), 0, p.tracks.length - 1)
  if (to === from) return p
  // só a relação da faixa movida com a de legendas (um projeto já fora da regra não trava todos os movimentos)
  const order = [...p.tracks]
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  const cap = order.findIndex(isCaptionsTrack)
  const bad = isCaptionsTrack(moved) ? order.some((t, i) => i > to && t.kind === 'video') : moved.kind === 'video' && cap >= 0 && to > cap
  if (bad) throw new EditError('invalid', 'A faixa de legendas fica sempre no topo')
  return edit(p, (d) => {
    const [t] = d.tracks.splice(from, 1)
    d.tracks.splice(to, 0, t)
  })
}

/** Não exige faixa desbloqueada (é assim que se desbloqueia). */
export function updateTrack(p: Project, trackId: string, patch: Partial<Omit<Track, 'id' | 'items' | 'kind'>>): Project {
  const i = p.tracks.findIndex((t) => t.id === trackId)
  if (i < 0) throw new EditError('notFound', `Faixa não encontrada: ${trackId}`)
  // o papel de legendas só nasce em ensureCaptionsTrack (uma faixa, no topo, só textos)
  if (patch.role === 'captions' && !isCaptionsTrack(p.tracks[i])) throw new EditError('invalid', 'Use "Legendas" para criar a faixa de legendas')
  return edit(p, (d) => { Object.assign(d.tracks[i], patch) })
}

// ---------------------------------------------------------------- inserção

/**
 * overwrite: recorta/divide o que estiver embaixo; insert: empurra tudo a partir de items[0].startUs
 * pela soma das durações (todas as faixas desbloqueadas). Se os itens tiverem buracos entre si, usa o vão total.
 */
export function insertItems(p: Project, trackId: string, items: Item[], mode: InsertMode): Project {
  if (items.length === 0) return p
  const track = mustTrack(p, trackId)
  assertUnlocked(track)
  for (const it of items) {
    if (!fitsTrack(it, track.kind)) throw new EditError('invalid', `Item ${it.id} não cabe numa faixa de ${track.kind === 'video' ? 'vídeo' : 'áudio'}`)
    assertNotFxTrackFor(it, track)
    if (it.durationUs < MIN_ITEM_US) throw new EditError('invalid', `Item ${it.id} menor que a duração mínima`)
    if (it.startUs < 0) throw new EditError('bounds', `Item ${it.id} começa antes de 0`)
  }
  const ids = items.map((i) => i.id)
  if (new Set(ids).size !== ids.length || ids.some((id) => findItem(p, id))) throw new EditError('invalid', 'Id de item repetido')
  const sorted = [...items].sort((a, b) => a.startUs - b.startUs)
  return edit(p, (d) => {
    const t = mustTrack(d, trackId)
    let placed = sorted
    let lifted: Item[] = []
    if (mode === 'insert') {
      const first = sorted[0].startUs
      const sum = sorted.reduce((acc, i) => acc + i.durationUs, 0)
      const span = Math.max(...sorted.map(end)) - first
      const point = makeRoom(d, first, Math.max(sum, span), trackId)
      placed = sorted.map((i) => ({ ...i, startUs: i.startUs + point - first }))
    } else {
      for (const i of sorted) lifted.push(...overwriteIn(d, t, i.startUs, end(i)))
    }
    t.items.push(...placed)
    for (const it of lifted) placeEffect(d, it)
    finalize(d)
  })
}

/**
 * Escolhe a faixa: explícita; com modo → primeira desbloqueada do tipo; sem modo → primeira livre (ou cria).
 * Faixas "Efeitos" não recebem mídia automaticamente (ela ficaria por cima dos efeitos das faixas de baixo).
 * `music`: arquivo só de áudio (música) vai para as faixas de papel 'music' (ou cria "Música"); o som de um vídeo
 * nunca vai para elas sozinho (o ducking abaixaria a voz do vídeo).
 */
function pickTrack(p: Project, kind: TrackKind, explicitId: string | undefined, mode: InsertMode | undefined, s: Us, e: Us, music = false): { project: Project; trackId: string; mode: InsertMode } {
  if (explicitId) {
    const t = mustTrack(p, explicitId)
    if (t.kind !== kind) throw new EditError('invalid', `Faixa ${t.name} não é de ${kind === 'video' ? 'vídeo' : 'áudio'}`)
    return { project: p, trackId: t.id, mode: mode ?? 'overwrite' }
  }
  const candidates = p.tracks.filter((t, i) => t.kind === kind && !t.locked && !isFxTrack(t) && !isCaptionsTrack(t) && !isOverlayTrack(t) && !(kind === 'video' && aboveGuard(p, i)) && (kind !== 'audio' || (t.role === 'music') === music))
  const chosen = mode ? candidates[0] : candidates.find((t) => isFree(t, s, e))
  if (chosen) return { project: p, trackId: chosen.id, mode: mode ?? 'overwrite' }
  const r = music ? addTrack(p, 'audio', undefined, musicTrackName(p), 'music') : addTrack(p, kind)
  return { project: r.project, trackId: r.trackId, mode: 'overwrite' }
}

/**
 * Vídeo com áudio → item na faixa de vídeo (audio.enabled=false) + item de áudio vinculado (sem visual);
 * cria faixas se necessário. Devolve [vídeo, áudio] (ou só o que existir).
 */
export function addMediaFromAsset(p: Project, assetId: string, atUs: Us, opts?: { videoTrackId?: string; audioTrackId?: string; mode?: InsertMode }): { project: Project; itemIds: string[] } {
  const asset = p.assets.find((a) => a.id === assetId)
  if (!asset) throw new EditError('notFound', `Asset não encontrado: ${assetId}`)
  const hasVideo = asset.kind !== 'audio'
  const hasAudio = asset.kind === 'audio' || (asset.kind === 'video' && !!asset.audio)
  let at = Math.max(0, Math.round(atUs))
  let q = p
  const itemIds: string[] = []
  if (hasVideo) {
    const base = createMediaItem(asset, at, 'video')
    const it: MediaItem = { ...base, audio: { ...base.audio, enabled: false } }
    const r = pickTrack(q, 'video', opts?.videoTrackId, opts?.mode, at, end(it))
    q = insertItems(r.project, r.trackId, [it], r.mode)
    at = mustFind(q, it.id).item.startUs // insert pode encaixar o ponto numa borda
    itemIds.push(it.id)
  }
  if (hasAudio) {
    const it = createMediaItem(asset, at, 'audio')
    // em modo insert o espaço já foi aberto em todas as faixas pela inserção do vídeo
    const mode = hasVideo && opts?.mode === 'insert' ? 'overwrite' : opts?.mode
    const r = pickTrack(q, 'audio', opts?.audioTrackId, mode, at, end(it), !hasVideo)
    q = insertItems(r.project, r.trackId, [it], r.mode)
    itemIds.push(it.id)
  }
  if (itemIds.length > 1) q = linkItems(q, itemIds)
  return { project: q, itemIds }
}

// ---------------------------------------------------------------- split / trim / move / delete

/**
 * Divide os itens (e vinculados) que contêm atUs estritamente, com ≥ MIN_ITEM_US dos dois lados.
 * O pedaço da esquerda mantém id/linkId/transitionIn; os da direita ganham ids novos e um linkId novo comum.
 */
export function splitAt(p: Project, itemIds: string[] | 'all', atUs: Us): Project {
  const targets = itemIds === 'all' ? 'all' : new Set(expand(p, itemIds, true))
  const at = Math.round(atUs)
  const would = p.tracks.some((t) =>
    t.items.some((i) => (targets === 'all' ? !t.locked : targets.has(i.id)) && at - i.startUs >= MIN_ITEM_US && end(i) - at >= MIN_ITEM_US)
  )
  if (!would) return p
  return edit(p, (d) => {
    splitInPlace(d, targets, at)
    finalize(d)
  })
}

/** Máximo que o item pode estender (µs de timeline) no início e no fim sem sair da fonte. */
function sourceExtent(p: Project, it: Item): [Us, Us] {
  if (it.type === 'annotations') return [it.inUs, Infinity]
  if (it.type !== 'media' || it.freeze) return [Infinity, Infinity]
  const a = p.assets.find((x) => x.id === it.assetId)
  if (!a || a.kind === 'image' || a.durationUs == null) return [Infinity, Infinity]
  const before = Math.max(0, it.inUs)
  const after = Math.max(0, a.durationUs - it.inUs - Math.round(it.durationUs * it.speed))
  const ext: [Us, Us] = [Math.floor(before / it.speed), Math.floor(after / it.speed)]
  return it.reverse ? [ext[1], ext[0]] : ext
}

/**
 * start: muda startUs e inUs (limitado por inUs ≥ 0 e vizinho anterior); end: muda durationUs (limitado pela
 * fonte e pelo próximo vizinho). ripple: o início fica parado e os itens posteriores (todas as faixas) se deslocam.
 * Efeitos vinculados ao clipe: o que tem a borda alinhada à borda aparada (±½ quadro) acompanha a borda; os
 * demais seguem o conteúdo (parados; no ripple pelo início, deslocados junto com o conteúdo do clipe).
 */
export function trimItem(p: Project, itemId: string, edge: 'start' | 'end', toUs: Us, opts?: { ripple?: boolean; includeLinked?: boolean }): Project {
  const main = mustFind(p, itemId).item
  const ripple = !!opts?.ripple
  const tol = frameDurUs(p.canvas.fps) / 2
  const edgeOf = (it: Item): Us => (edge === 'start' ? it.startUs : end(it))
  const group = expand(p, [itemId], opts?.includeLinked ?? true)
  const isFx = (id: string): boolean => id !== itemId && main.type !== 'effect' && mustFind(p, id).item.type === 'effect'
  const aligned = (id: string): boolean => Math.abs(edgeOf(mustFind(p, id).item) - edgeOf(main)) <= tol
  const ids = group.filter((id) => !isFx(id) || aligned(id))
  const fxEdge = new Set(ids.filter(isFx))
  const fxContent = group.filter((id) => !ids.includes(id))
  const idSet = new Set(ids)
  let delta = Math.round(toUs) - (edge === 'start' ? main.startUs : end(main))
  let lo = -Infinity, hi = Infinity
  for (const id of ids) {
    const f = mustFind(p, id)
    assertUnlocked(f.track)
    const it = f.item
    const [extStart, extEnd] = sourceExtent(p, it)
    const others = f.track.items.filter((i) => !idSet.has(i.id))
    // efeito seguidor não limita pelo vizinho da faixa dele: se bater, muda de faixa (relocateFollowers)
    const free = fxEdge.has(id)
    if (edge === 'start') {
      hi = Math.min(hi, it.durationUs - MIN_ITEM_US)
      lo = Math.max(lo, -extStart)
      if (!ripple && !free) {
        const prevEnd = Math.max(0, ...others.filter((i) => i.startUs < it.startUs).map(end))
        lo = Math.max(lo, -Math.max(0, it.startUs - prevEnd))
      }
    } else {
      lo = Math.max(lo, MIN_ITEM_US - it.durationUs)
      hi = Math.min(hi, extEnd)
      if (!ripple && !free) {
        const nextStart = Math.min(Infinity, ...others.filter((i) => i.startUs >= end(it)).map((i) => i.startUs))
        hi = Math.min(hi, nextStart - end(it))
      }
    }
  }
  delta = lo > hi ? 0 : clamp(delta, lo, hi)
  if (delta === 0) return p
  return edit(p, (d) => {
    const forced = new Set<string>()
    for (const id of ids) {
      const f = mustFind(d, id)
      const it = f.item
      forced.add(f.track.id)
      // efeito alinhado: a borda vai exatamente para a nova borda do clipe
      const s0 = fxEdge.has(id) ? main.startUs : it.startUs
      const e0 = fxEdge.has(id) ? end(main) : end(it)
      let n: Item
      if (edge === 'start') {
        n = sliceItem(it, s0 + delta, end(it), false)
        if (ripple) n = { ...n, startUs: s0 }
      } else n = sliceItem(it, it.startUs, e0 + delta, false)
      f.track.items[f.itemIndex] = n
    }
    // efeitos vinculados que não estão na borda: no ripple acompanham o conteúdo do clipe
    for (const id of fxContent) {
      if (!ripple) break
      const f = mustFind(d, id)
      const it = f.item
      if (edge === 'end') {
        if (it.startUs >= end(main)) f.track.items[f.itemIndex] = { ...it, startUs: it.startUs + delta }
        continue
      }
      if (it.startUs < main.startUs) continue
      // ripple pelo início: o conteúdo do clipe anda −delta; a parte do efeito sobre o trecho cortado sai
      const cut = main.startUs + delta
      if (it.startUs >= cut) f.track.items[f.itemIndex] = { ...it, startUs: it.startUs - delta }
      else if (end(it) - cut >= MIN_ITEM_US) f.track.items[f.itemIndex] = { ...sliceItem(it, cut, end(it), false), startUs: main.startUs }
    }
    // trilhas de seguidores não são "forçadas" (o seguidor anda pela mídia e, se bater, muda de faixa)
    for (const id of fxEdge) forced.delete(mustFind(d, id).track.id)
    for (const id of ids) if (!fxEdge.has(id)) forced.add(mustFind(d, id).track.id)
    if (ripple) rippleShift(d, end(main), edge === 'start' ? -delta : delta, new Set([...idSet, ...fxContent]), forced)
    relocateFollowers(d, [...fxEdge, ...fxContent])
    finalize(d)
  })
}

/**
 * Move (por padrão com vinculados) por deltaUs, limitando o início em 0. toTrackId vale para os itens dados
 * (os vinculados ficam nas suas faixas). Sobreposição no destino: 'overwrite' recorta, 'insert' abre espaço,
 * sem modo lança EditError('overlap').
 */
export function moveItems(p: Project, itemIds: string[], deltaUs: Us, opts?: { toTrackId?: string; includeLinked?: boolean; mode?: InsertMode }): Project {
  const ids = expand(p, itemIds, opts?.includeLinked ?? true)
  if (ids.length === 0) return p
  const primary = new Set(itemIds)
  const dest = opts?.toTrackId ? mustTrack(p, opts.toTrackId) : null
  const plan = ids.map((id) => {
    const f = mustFind(p, id)
    assertUnlocked(f.track)
    const to = dest && primary.has(id) ? dest : f.track
    assertUnlocked(to)
    if (!fitsTrack(f.item, to.kind)) throw new EditError('invalid', `Item ${id} não cabe na faixa ${to.name}`)
    if (to.id !== f.track.id) assertNotFxTrackFor(f.item, to)
    return { id, fromTrackId: f.track.id, toTrackId: to.id, item: f.item }
  })
  const minStart = Math.min(...plan.map((x) => x.item.startUs))
  const delta = Math.max(Math.round(deltaUs), -minStart)
  if (delta === 0 && plan.every((x) => x.fromTrackId === x.toTrackId)) return p
  const idSet = new Set(ids)
  return edit(p, (d) => {
    for (const t of d.tracks) if (t.items.some((i) => idSet.has(i.id))) t.items = t.items.filter((i) => !idSet.has(i.id))
    let moved = plan.map((x) => ({ ...x, item: { ...x.item, startUs: x.item.startUs + delta } as Item }))
    const lifted: Item[] = []
    if (opts?.mode === 'insert') {
      const blockStart = Math.min(...moved.map((x) => x.item.startUs))
      const span = Math.max(...moved.map((x) => end(x.item))) - blockStart
      const point = makeRoom(d, blockStart, span, (moved.find((x) => primary.has(x.id)) ?? moved[0]).toTrackId)
      moved = moved.map((x) => ({ ...x, item: { ...x.item, startUs: x.item.startUs + point - blockStart } }))
    } else {
      for (const x of moved) {
        // seguidor nunca sobrescreve (recortaria o efeito de outro clipe): se o destino estiver ocupado, muda de faixa
        if (isFollower(p, x.item)) continue
        const t = mustTrack(d, x.toTrackId)
        if (isFree(t, x.item.startUs, end(x.item))) continue
        if (opts?.mode !== 'overwrite') throw new EditError('overlap', `Sobreposição na faixa "${t.name}"`)
        lifted.push(...overwriteIn(d, t, x.item.startUs, end(x.item)))
      }
    }
    for (const x of moved) mustTrack(d, x.toTrackId).items.push(x.item)
    for (const it of lifted) placeEffect(d, it)
    // clipe que mudou de faixa: os efeitos vinculados a ele passam a mirar a faixa nova
    for (const x of moved) {
      if (x.fromTrackId === x.toTrackId || x.item.type === 'effect' || !x.item.linkId) continue
      for (const t of d.tracks) for (const it of t.items) if (it.type === 'effect' && it.linkId === x.item.linkId && it.targetTrackId === x.fromTrackId) it.targetTrackId = x.toTrackId
    }
    relocateFollowers(d, moved.map((x) => x.id))
    finalize(d)
  })
}

/**
 * Apaga itens (por padrão com vinculados). ripple: fecha cada buraco deslocando os posteriores de todas as
 * faixas desbloqueadas — somente se o intervalo estiver vazio em todas elas (não causa dessincronia);
 * caso contrário, mantém o buraco.
 */
export function deleteItems(p: Project, itemIds: string[], opts?: { ripple?: boolean; includeLinked?: boolean }): Project {
  const ids = expand(p, itemIds, opts?.includeLinked ?? true)
  if (ids.length === 0) return p
  const ranges: [Us, Us][] = []
  for (const id of ids) {
    const f = mustFind(p, id)
    assertUnlocked(f.track)
    ranges.push([f.item.startUs, end(f.item)])
  }
  const idSet = new Set(ids)
  const links = mediaLinks(p, ids)
  return edit(p, (d) => {
    for (const t of d.tracks) if (t.items.some((i) => idSet.has(i.id))) t.items = t.items.filter((i) => !idSet.has(i.id))
    // apagar o clipe sem os vinculados (Alt): os efeitos que eram dele perdem o vínculo
    dropOrphanLinks(d, links)
    if (opts?.ripple) {
      // une intervalos sobrepostos/encostados e fecha do último para o primeiro
      ranges.sort((a, b) => a[0] - b[0])
      const merged: [Us, Us][] = []
      for (const r of ranges) {
        const last = merged[merged.length - 1]
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
        else merged.push([r[0], r[1]])
      }
      for (const [s, e] of merged.reverse()) {
        // tudo ou nada (intencional): só fecha se o trecho estiver vazio em todas as faixas desbloqueadas,
        // para nunca dessincronizar as faixas entre si
        const empty = d.tracks.every((t) => t.locked || isFree(t, s, e))
        if (empty) rippleShift(d, e, -(e - s), new Set(), new Set())
      }
    }
    finalize(d)
  })
}

/** Apaga [from,to) nas faixas desbloqueadas (ou nas dadas) e puxa tudo depois de toUs por −(to−from). */
export function deleteRange(p: Project, fromUs: Us, toUs: Us, opts?: { trackIds?: string[] }): Project {
  const from = Math.max(0, Math.round(fromUs)), to = Math.round(toUs)
  if (to <= from) throw new EditError('invalid', 'Intervalo vazio')
  const trackIds = opts?.trackIds
    ? opts.trackIds.map((id) => { const t = mustTrack(p, id); assertUnlocked(t); return id })
    : p.tracks.filter((t) => !t.locked).map((t) => t.id)
  return edit(p, (d) => {
    const cut = new Set<string>()
    const before = mediaLinks(d, trackIds.flatMap((id) => mustTrack(d, id).items.map((i) => i.id)))
    for (const id of trackIds) overwriteRange(mustTrack(d, id), from, to, cut)
    dropOrphanLinks(d, before)
    relinkAcross(d, from, to, cut)
    for (const id of trackIds) for (const it of mustTrack(d, id).items) if (it.startUs >= to) it.startUs -= to - from
    // marcadores acompanham só quando o corte vale para todas as faixas desbloqueadas
    if (d.tracks.every((t) => t.locked || trackIds.includes(t.id))) {
      d.markers = d.markers.filter((m) => m.tUs < from || m.tUs >= to)
      for (const m of d.markers) if (m.tUs >= to) m.tUs -= to - from
    }
    finalize(d)
  })
}

/**
 * Vários deleteRange de uma vez (remover silêncios: centenas de cortes num projeto longo), com o MESMO resultado de
 * aplicar deleteRange do último intervalo para o primeiro — mas numa única edição: cada faixa é varrida uma vez contra
 * os intervalos ordenados (do fim para o início), os pedaços ficam em tempo original e só no fim andam o total cortado
 * antes deles. Os vínculos repetem passo a passo o que cada deleteRange faria (relinkAcross por intervalo sobre os
 * pedaços, efeitos órfãos, linkId sem par), mas só nos grupos que o intervalo tocou. Intervalos sobrepostos: EditError.
 */
export function deleteRanges(p: Project, ranges: readonly { fromUs: Us; toUs: Us }[], opts?: { trackIds?: string[] }): Project {
  const rs = ranges.map((r) => ({ from: Math.max(0, Math.round(r.fromUs)), to: Math.round(r.toUs) })).sort((a, b) => a.from - b.from)
  if (!rs.length) return p
  rs.forEach((r, i) => {
    if (r.to <= r.from) throw new EditError('invalid', 'Intervalo vazio')
    if (i > 0 && r.from < rs[i - 1].to) throw new EditError('invalid', 'Intervalos sobrepostos')
  })
  const trackIds = opts?.trackIds
    ? opts.trackIds.map((id) => { const t = mustTrack(p, id); assertUnlocked(t); return id })
    : p.tracks.filter((t) => !t.locked).map((t) => t.id)
  const base = produce(p, stampLegacyTargets)
  const cutTracks = new Set(trackIds)

  // nós = itens em evolução (tempo original); `link` é o vínculo corrente (o linkId do item é reescrito no fim)
  interface Node { it: Item; link: string | undefined }
  const members = new Map<string, Set<Node>>()
  const mediaCount = new Map<string, number>()
  const isMedia = (n: Node): boolean => n.it.type !== 'effect'
  const join = (n: Node, link: string | undefined): void => {
    n.link = link
    if (!link) return
    let s = members.get(link)
    if (!s) members.set(link, (s = new Set()))
    s.add(n)
    if (isMedia(n)) mediaCount.set(link, (mediaCount.get(link) ?? 0) + 1)
  }
  const leave = (n: Node): void => {
    if (!n.link) return
    members.get(n.link)?.delete(n)
    if (isMedia(n)) mediaCount.set(n.link, (mediaCount.get(n.link) ?? 1) - 1)
    n.link = undefined
  }
  const pending: Node[][] = [] // por faixa cortada: itens ainda não alcançados pelos cortes, ordenados por início
  const done: Node[][] = [] // por faixa: itens prontos
  base.tracks.forEach((t, ti) => {
    const nodes = t.items.map((it) => { const n: Node = { it, link: undefined }; join(n, it.linkId); return n })
    pending[ti] = cutTracks.has(t.id) ? [...nodes].sort((a, b) => a.it.startUs - b.it.startUs) : []
    done[ti] = cutTracks.has(t.id) ? [] : nodes
  })

  for (let j = rs.length - 1; j >= 0; j--) {
    const { from, to } = rs[j]
    const cutLinks = new Set<string>()
    const removedMedia = new Set<string>()
    const touched = new Set<string>()
    base.tracks.forEach((_, ti) => {
      const pend = pending[ti]
      // começam depois do corte: nenhum corte anterior os alcança
      while (pend.length && pend[pend.length - 1].it.startUs >= to) done[ti].push(pend.pop()!)
      // cruzam o corte (sem sobreposição na faixa: são os últimos com fim > from)
      const crossing: Node[] = []
      while (pend.length && end(pend[pend.length - 1].it) > from) crossing.push(pend.pop()!)
      const back: Node[] = []
      for (const n of crossing.reverse()) {
        const it = n.it, s = it.startUs, e = end(it)
        const left = s < from && from - s >= MIN_ITEM_US
        const right = e > to && e - to >= MIN_ITEM_US
        if (n.link) touched.add(n.link)
        if (left && right && n.link) cutLinks.add(n.link)
        if (right) {
          const r = sliceItem(it, to, e, true)
          if (left) {
            const rn: Node = { it: { ...r, id: newId('i_') }, link: undefined }
            join(rn, n.link)
            done[ti].push(rn)
          } else {
            n.it = r
            done[ti].push(n)
          }
        }
        if (left) {
          n.it = sliceItem(it, s, from, true)
          back.push(n)
        }
        if (!left && !right) {
          if (n.link && isMedia(n)) removedMedia.add(n.link)
          leave(n)
        }
      }
      pend.push(...back)
    })
    // dropOrphanLinks: grupo sem mídia → os efeitos perdem o vínculo
    for (const link of removedMedia) {
      if ((mediaCount.get(link) ?? 0) > 0) continue
      for (const n of [...(members.get(link) ?? [])]) leave(n)
    }
    // relinkAcross: os membros depois do corte ganham um vínculo novo comum
    for (const link of cutLinks) {
      const mem = [...(members.get(link) ?? [])]
      const media = mem.filter(isMedia)
      const deciders = media.length ? media : mem
      if (!deciders.some((n) => n.it.startUs < from) || !deciders.some((n) => n.it.startUs >= to)) continue
      const nl = newId('l_')
      touched.add(nl)
      for (const n of mem) if (n.it.startUs >= to) { leave(n); join(n, nl) }
    }
    // finalize: linkId sem par sai (no 1º corte aplicado, em todos os grupos, como o finalize do deleteRange)
    for (const link of j === rs.length - 1 ? [...members.keys()] : touched) {
      const mem = members.get(link)
      if (mem && mem.size < 2) for (const n of [...mem]) leave(n)
    }
  }

  // deslocamento: total cortado antes do início (em tempo original: nenhum item fica dentro de um corte)
  const ends = rs.map((r) => r.to)
  const removedBefore: Us[] = [0]
  for (const r of rs) removedBefore.push(removedBefore[removedBefore.length - 1] + r.to - r.from)
  const shiftOf = (t: Us): Us => {
    let lo = 0, hi = ends.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ends[mid] <= t) lo = mid + 1
      else hi = mid
    }
    return removedBefore[lo]
  }
  const out = produce(base, (d) => {
    base.tracks.forEach((t, ti) => {
      const cut = cutTracks.has(t.id)
      const nodes = [...done[ti], ...pending[ti]]
      d.tracks[ti].items = nodes.map((n) => {
        let it = n.link === n.it.linkId ? n.it : withLink(n.it, n.link)
        if (cut) {
          const sh = shiftOf(it.startUs)
          if (sh) it = { ...it, startUs: it.startUs - sh }
        }
        return it
      })
    })
    if (d.tracks.every((t) => t.locked || cutTracks.has(t.id))) {
      d.markers = d.markers.filter((m) => !rs.some((r) => m.tUs >= r.from && m.tUs < r.to))
      for (const m of d.markers) m.tUs -= shiftOf(m.tUs)
    }
    finalize(d)
    maintainAttachments(d)
  })
  return normalizeTransitions(p, out)
}

// ---------------------------------------------------------------- vínculo / áudio

export function linkItems(p: Project, itemIds: string[]): Project {
  const ids = [...new Set(itemIds)]
  if (ids.length < 2) throw new EditError('invalid', 'Selecione ao menos dois itens para vincular')
  for (const id of ids) mustFind(p, id)
  const linkId = newId('l_')
  return edit(p, (d) => {
    for (const id of ids) mustFind(d, id).item.linkId = linkId
    finalize(d)
  })
}

export function unlinkItems(p: Project, itemIds: string[]): Project {
  for (const id of itemIds) mustFind(p, id)
  return edit(p, (d) => {
    for (const id of itemIds) delete mustFind(d, id).item.linkId
    finalize(d)
  })
}

/**
 * "Desvincular" a partir de um item. De um efeito: só ele. De mídia: só a mídia do grupo se separa — os efeitos
 * continuam vinculados ao clipe de vídeo (o item visual do grupo; o próprio item se for ele).
 */
export function unlinkMedia(p: Project, itemId: string): Project {
  const f = mustFind(p, itemId)
  if (f.item.type === 'effect' || !f.item.linkId) return unlinkItems(p, [itemId])
  const group = linkedIds(p, itemId)
  const media = group.filter((id) => mustFind(p, id).item.type !== 'effect')
  if (media.length === group.length) return unlinkItems(p, group)
  const isClip = (id: string): boolean => { const g = mustFind(p, id); return g.track.kind === 'video' && g.item.type === 'media' && !!g.item.visual }
  const anchor = isClip(itemId) ? itemId : (media.find(isClip) ?? itemId)
  const rest = media.filter((id) => id !== anchor)
  // só efeitos no grupo além do clipe: "Desvincular efeitos" solta todos (nunca um clique sem efeito)
  return rest.length ? unlinkItems(p, rest) : unlinkItems(p, group)
}

/**
 * Item de vídeo com áudio próprio: cria item de áudio (mesmo tempo) numa faixa de áudio livre (ou nova),
 * desativa o áudio do vídeo e vincula os dois. Se já estiver vinculado a outra mídia, apenas desvincula a mídia
 * (unlinkMedia: os efeitos ficam com o vídeo).
 */
export function detachAudio(p: Project, itemId: string): Project {
  const f = mustFind(p, itemId)
  const it = f.item
  if (it.type !== 'media') throw new EditError('invalid', 'Somente itens de mídia têm áudio')
  // vinculado a outra mídia (o áudio já separado): desvincula; vinculado só a efeitos ainda separa o áudio
  const partners = linkedIds(p, itemId).filter((id) => id !== itemId)
  if (partners.some((id) => mustFind(p, id).item.type !== 'effect')) return unlinkMedia(p, itemId)
  if (f.track.kind !== 'video') throw new EditError('invalid', 'O item já é de áudio')
  const asset = p.assets.find((a) => a.id === it.assetId)
  if (!it.audio.enabled || !asset?.audio) throw new EditError('invalid', 'O item não tem áudio para separar')
  assertUnlocked(f.track)
  const linkId = it.linkId ?? newId('l_')
  const audioItem: MediaItem = { ...omit(it, 'visual', 'transitionIn'), id: newId('i_'), linkId, audio: { ...it.audio, enabled: true } }
  return edit(p, (d) => {
    const target = d.tracks.find((t) => t.kind === 'audio' && !t.locked && isFree(t, it.startUs, end(it)))
    const trackId = target ? target.id : createTrack(d, 'audio')
    const v = mustFind(d, itemId).item as MediaItem
    v.audio.enabled = false
    v.linkId = linkId
    mustTrack(d, trackId).items.push(audioItem)
    finalize(d)
  })
}

// ---------------------------------------------------------------- velocidade / item

/**
 * Limita speed a MIN/MAX; durationUs = round(durationUs*old/new) e keyframes escalados no tempo; os
 * vinculados recebem a mesma velocidade. Colisão com o próximo item: ripple (padrão) desloca os posteriores
 * de todas as faixas desbloqueadas; sem ripple lança EditError('overlap'). Efeitos vinculados acompanham o
 * conteúdo: o tempo a partir do início do clipe é escalado pela mesma razão (início, duração e keyframes).
 */
export function setSpeed(p: Project, itemId: string, speed: number, opts?: { ripple?: boolean }): Project {
  const main = mustFind(p, itemId).item
  if (main.type !== 'media') throw new EditError('invalid', 'Velocidade só se aplica a itens de mídia')
  const s = clamp(speed, MIN_SPEED, MAX_SPEED)
  const changes: { id: string; item: Item; oldEnd: Us; fx?: boolean }[] = []
  // instante da timeline → instante depois da mudança (o conteúdo do clipe estica/encolhe a partir do início)
  const r0 = main.speed / s
  const remap = (t: Us): Us => (t <= main.startUs ? t : main.startUs + Math.round((t - main.startUs) * r0))
  for (const id of linkedIds(p, itemId)) {
    const f = mustFind(p, id)
    if (f.item.type === 'effect') {
      if (r0 === 1) continue
      assertUnlocked(f.track)
      const fx = f.item
      const ns = remap(fx.startUs)
      const dur = Math.max(MIN_ITEM_US, remap(end(fx)) - ns)
      const scaled = mapAnims(fx, (a) => (a.keys ? { ...a, keys: a.keys.map((k) => ({ ...k, tUs: clamp(remap(fx.startUs + k.tUs) - ns, 0, dur) })) } : a))
      changes.push({ id, item: { ...scaled, startUs: ns, durationUs: dur }, oldEnd: end(fx), fx: true })
      continue
    }
    if (f.item.type !== 'media' || f.item.speed === s) continue
    assertUnlocked(f.track)
    const ratio = f.item.speed / s
    const dur = Math.round(f.item.durationUs * ratio)
    if (dur < MIN_ITEM_US) throw new EditError('invalid', 'Duração resultante menor que o mínimo')
    const scaled = mapAnims(f.item, (a) => (a.keys ? { ...a, keys: a.keys.map((k) => ({ ...k, tUs: Math.round(k.tUs * ratio) })) } : a))
    // fades e animações acompanham a escala de tempo, limitados à nova duração (a transição de entrada é da timeline:
    // não escala; normalizeTransitions a limita ao novo máximo do par)
    const fit = (us: Us, max: Us): Us => Math.min(max, Math.round(us * ratio))
    // fadeIn + fadeOut nunca passam da duração (o arredondamento de cada um poderia somar 1 µs a mais)
    const fades = (fin: Us, fout: Us): { fadeInUs: Us; fadeOutUs: Us } => {
      const fadeInUs = fit(fin, dur)
      return { fadeInUs, fadeOutUs: fit(fout, dur - fadeInUs) }
    }
    let n: MediaItem = { ...scaled, speed: s, durationUs: dur, audio: { ...scaled.audio, ...fades(scaled.audio.fadeInUs, scaled.audio.fadeOutUs) } }
    if (n.visual) {
      const v = n.visual
      n = {
        ...n,
        visual: {
          ...v,
          ...fades(v.fadeInUs, v.fadeOutUs),
          ...(v.animIn ? { animIn: { ...v.animIn, durationUs: fit(v.animIn.durationUs, dur) } } : {}),
          ...(v.animOut ? { animOut: { ...v.animOut, durationUs: fit(v.animOut.durationUs, dur) } } : {})
        }
      }
    }
    changes.push({ id, item: n, oldEnd: end(f.item) })
  }
  if (!changes.some((c) => !c.fx)) return p
  const idSet = new Set(changes.map((c) => c.id))
  let collision = false
  for (const c of changes) {
    if (c.fx) continue // seguidor que bater muda de faixa (relocateFollowers), não empurra nem é recusado
    const t = mustFind(p, c.id).track
    const next = Math.min(Infinity, ...t.items.filter((i) => !idSet.has(i.id) && i.startUs >= c.oldEnd).map((i) => i.startUs))
    if (end(c.item) > next) collision = true
  }
  if (collision && opts?.ripple === false) throw new EditError('overlap', 'A nova duração colide com o próximo item')
  return edit(p, (d) => {
    for (const c of changes) {
      const f = mustFind(d, c.id)
      f.track.items[f.itemIndex] = c.item
    }
    if (collision) {
      // pivô e deslocamento pela mídia; os efeitos do grupo já foram reposicionados pela escala
      const media = changes.filter((c) => !c.fx)
      const pivot = Math.min(...media.map((c) => c.oldEnd))
      const shift = Math.max(...media.map((c) => end(c.item) - c.oldEnd))
      rippleShift(d, pivot, shift, idSet, new Set())
    }
    relocateFollowers(d, changes.filter((c) => c.fx).map((c) => c.id))
    finalize(d)
  })
}

/** Duração padrão do "Congelar quadro" do inspetor. */
export const FREEZE_DEFAULT_US = 2_000_000

/** Curva de um trecho percorrida de trás para frente: E'(q) = 1 − E(1 − q). 'hold' não tem par (tratado em mirrorKeys). */
function mirrorEase(e: Ease): Ease {
  if (typeof e === 'object') {
    const [x1, y1, x2, y2] = e.bezier
    return { bezier: [1 - x2, 1 - y2, 1 - x1, 1 - y1] }
  }
  return e === 'in' ? 'out' : e === 'out' ? 'in' : e
}

/**
 * Keyframes espelhados no tempo dentro de [0, dur]: o key em t vai para dur − t e cada trecho leva a curva espelhada.
 * O ease do último key (sem trecho depois) guarda o do último original, então espelhar duas vezes devolve o original.
 * Trecho 'hold' (valor parado e salto no fim) vira salto no início: um key extra 1 µs depois com o valor parado.
 */
function mirrorKeys(a: Anim<number>, dur: Us): Anim<number> {
  const k = a.keys
  if (!k || k.length === 0) return a
  const out: Keyframe<number>[] = []
  for (let j = k.length - 1; j >= 0; j--) {
    const t = dur - k[j].tUs
    if (j === 0) {
      out.push({ tUs: t, value: k[0].value, ease: k[k.length - 1].ease })
      continue
    }
    const seg = k[j - 1].ease
    if (seg !== 'hold') {
      out.push({ tUs: t, value: k[j].value, ease: mirrorEase(seg) })
      continue
    }
    out.push({ tUs: t, value: k[j].value, ease: 'hold' })
    if (k[j].tUs - k[j - 1].tUs > 2) out.push({ tUs: t + 1, value: k[j - 1].value, ease: 'hold' })
  }
  return { ...a, keys: out }
}

/**
 * Insere um trecho parado de D µs no instante local `local` das animações do item (o valor de `local` fica até
 * local + D; os keys depois andam D). O resto do trecho que continha `local` segue com o pedaço exato da curva desse
 * trecho (insertKeyExact): a animação antes e depois do congelado é a mesma de antes. Constantes não mudam.
 */
function holdAnimAt(a: Anim<number>, local: Us, D: Us): Anim<number> {
  if (!a.keys || a.keys.length === 0) return a
  const k = insertKeyExact(a, local).keys!
  const at = k.find((x) => x.tUs === local)!
  const before = k.filter((x) => x.tUs < local)
  const after = k.filter((x) => x.tUs > local).map((x) => ({ ...x, tUs: x.tUs + D }))
  return { ...a, keys: [...before, { tUs: local, value: at.value, ease: 'linear' }, { tUs: local + D, value: at.value, ease: at.ease }, ...after] }
}

/** Sobreposição visual que o congelar estica sobre o quadro parado (não é conteúdo da fonte): efeito, texto, forma, imagem. */
function isOverlay(p: Project, it: Item): boolean {
  if (it.type === 'effect' || it.type === 'text' || it.type === 'shape') return true
  return it.type === 'media' && !!it.visual && p.assets.find((a) => a.id === it.assetId)?.kind === 'image'
}

/**
 * Efeitos sem vínculo com o clipe (ou vinculados a outro) que cruzam o trecho dele numa faixa de vídeo: depois de
 * reverter/congelar, não acompanham o conteúdo e podem não cobrir mais o que cobriam.
 */
export function unlinkedEffectsOver(p: Project, itemId: string): string[] {
  const f = findItem(p, itemId)
  if (!f) return []
  const s = f.item.startUs, e = end(f.item), link = f.item.linkId
  const out: string[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    for (const it of t.items) if (it.type === 'effect' && (!link || it.linkId !== link) && it.startUs < e && end(it) > s) out.push(it.id)
  }
  return out
}

/**
 * Congelar quadro: divide o clipe de vídeo em atUs e insere um pedaço `freeze` de durationUs (≥ MIN_ITEM_US) com o
 * quadro da fonte mostrado naquele instante (com velocidade/reverso), abrindo espaço com ripple em todas as faixas
 * desbloqueadas (o áudio vinculado é dividido e empurrado: o congelado é mudo). A menos de MIN_ITEM_US de uma borda,
 * o ponto vai para a borda (antes do 1º quadro / depois do último). O pedaço fica no grupo do lado esquerdo
 * (linkId original). Efeitos que cruzam o ponto não são divididos: cobrem o congelado com a região parada no valor do
 * instante congelado (a proteção continua sobre o quadro parado); os que começam depois andam com o resto.
 */
export function freezeFrameAt(p: Project, itemId: string, atUs: Us, durationUs: Us): Project {
  const f = mustFind(p, itemId)
  const item = f.item
  if (item.type !== 'media' || f.track.kind !== 'video' || !item.visual) throw new EditError('invalid', 'Congelar quadro só se aplica a clipes de vídeo')
  const asset = p.assets.find((a) => a.id === item.assetId)
  if (!asset || asset.kind !== 'video') throw new EditError('invalid', 'Congelar quadro só se aplica a clipes de vídeo')
  assertUnlocked(f.track)
  let at = Math.round(atUs)
  if (at < item.startUs || at > end(item)) throw new EditError('bounds', 'O playhead não está sobre o clipe')
  if (at - item.startUs < MIN_ITEM_US) at = item.startUs
  else if (end(item) - at < MIN_ITEM_US) at = end(item)
  if (lockedVideoDesyncsEffects(p, at)) throw new EditError('locked', 'Há faixas de vídeo bloqueadas com efeitos depois deste ponto: desbloqueie-as para congelar o quadro (senão os efeitos sairiam de cima do conteúdo).')
  const D = Math.max(MIN_ITEM_US, Math.round(durationUs))
  const srcUs = sourceTimeUs(item, asset, Math.min(at, end(item) - 1))
  const piece: MediaItem = {
    ...clearEdges(omit(item, 'freeze'), true, true),
    id: newId('i_'), startUs: at, durationUs: D, inUs: srcUs, speed: 1, reverse: false, freeze: { atUs: srcUs },
    audio: { ...item.audio, enabled: false, volume: { value: evalAnim(item.audio.volume, at - item.startUs) } },
    visual: mapVisual(item.visual, (a) => ({ value: evalAnim(a, at - item.startUs) }))
  }
  return edit(p, (d) => {
    // sobreposições (efeitos, texto, formas, imagens) que cruzam o ponto saem antes do makeRoom (que as dividiria no
    // ponto) e voltam esticadas sobre o congelado, paradas no valor do instante
    const held: { track: Track; item: Item }[] = []
    // grupo vinculado → uma mídia dele que cruza o ponto (a faixa onde achar o pedaço da direita depois do makeRoom)
    const crossingMedia = new Map<string, string>()
    for (const t of d.tracks) {
      if (t.locked) continue
      for (const i of t.items) if (i.linkId && !isOverlay(d, i) && i.type !== 'effect' && i.startUs < at && end(i) > at) crossingMedia.set(i.linkId, t.id)
    }
    // o grupo do próprio clipe: a faixa dele (outra mídia do grupo pode cruzar o ponto sem ser dividida, a < MIN_ITEM_US)
    if (item.linkId && end(item) > at && item.startUs < at) crossingMedia.set(item.linkId, f.track.id)
    for (const t of d.tracks) {
      if (t.locked) continue
      const crossing = t.items.filter((i) => isOverlay(d, i) && i.startUs < at && end(i) > at)
      if (!crossing.length) continue
      t.items = t.items.filter((i) => !crossing.includes(i))
      for (const i of crossing) held.push({ track: t, item: { ...mapAnims(i, (a) => holdAnimAt(a, at - i.startUs, D)), durationUs: i.durationUs + D } })
    }
    makeRoom(d, at, D, f.track.id)
    mustTrack(d, f.track.id).items.push(piece)
    // efeito ancorado que cruza o ponto: dividido nele — o pedaço do congelado ancora no pedaço congelado (mesmo grupo;
    // maintainAttachments), com a região parada no valor do instante (a pose do congelado é a do clipe naquele instante)
    const place = (t: Track, it: Item): void => {
      if (it.type !== 'effect' || !it.attach || at - it.startUs < MIN_ITEM_US || end(it) - at < MIN_ITEM_US) {
        t.items.push(it)
        return
      }
      t.items.push(sliceItem(it, it.startUs, at, true), { ...sliceItem(it, at, end(it), true), id: newId('i_') })
    }
    for (const h of held) {
      const it = h.item
      // grupo dividido pelo makeRoom (mídia dos dois lados): como no splitInPlace/relinkAcross, a parte da sobreposição
      // depois do congelado [at+D, fim) vai para o grupo da direita; [início, at+D) com o trecho parado fica no da esquerda
      const mediaTrack = it.linkId ? crossingMedia.get(it.linkId) : undefined
      const rightLink = mediaTrack ? mustTrack(d, mediaTrack).items.find((x) => x.startUs === at + D && x.type !== 'effect')?.linkId : undefined
      const cut = at + D
      if (!rightLink || rightLink === it.linkId || end(it) - cut < MIN_ITEM_US) {
        place(h.track, it)
        continue
      }
      // corte como o do splitInPlace: fades, animações e transição do lado do corte saem dos dois pedaços
      place(h.track, sliceItem(it, it.startUs, cut, true))
      h.track.items.push({ ...sliceItem(it, cut, end(it), true), id: newId('i_'), linkId: rightLink })
    }
    finalize(d)
  })
}

/**
 * Liga/desliga o reverso dos clipes (e da mídia vinculada), mantendo duração e trecho da fonte. O conteúdo que
 * estava em t (a partir do início do clipe) passa a aparecer em dur − t, então os keyframes do clipe são espelhados
 * no tempo e os efeitos vinculados (seguidores) também: posição dentro do clipe e keyframes. Pedaços congelados não
 * mudam; a partir de um efeito não há o que reverter (devolve o projeto).
 */
export function setReverse(p: Project, itemIds: string[], reverse: boolean): Project {
  const ids = expand(p, itemIds, true)
  const targets = ids
    .map((id) => mustFind(p, id))
    .filter((x): x is typeof x & { item: MediaItem } => x.item.type === 'media' && !x.item.freeze && x.item.reverse !== reverse)
  if (targets.length === 0) return p
  for (const x of targets) assertUnlocked(x.track)
  // seguidores dos grupos alterados, cada um espelhado em torno do clipe de vídeo do grupo que o cruza
  const followers: { id: string; clip: MediaItem }[] = []
  for (const t of p.tracks) {
    for (const it of t.items) {
      if (!isFollower(p, it)) continue
      const clips = targets.filter((x) => x.item.linkId === it.linkId && x.track.kind === 'video' && x.item.visual).map((x) => x.item)
      const clip = clips.find((c) => c.startUs < end(it) && end(c) > it.startUs) ?? clips[0]
      if (!clip) continue
      assertUnlocked(t)
      followers.push({ id: it.id, clip })
    }
  }
  return edit(p, (d) => {
    for (const x of targets) {
      const f = mustFind(d, x.item.id)
      const m = f.item as MediaItem
      f.track.items[f.itemIndex] = { ...mapAnims(m, (a) => mirrorKeys(a, m.durationUs)), reverse }
    }
    for (const { id, clip } of followers) {
      const f = mustFind(d, id)
      const it = f.item
      const ns = Math.max(0, clip.startUs + end(clip) - end(it))
      f.track.items[f.itemIndex] = { ...mapAnims(it, (a) => mirrorKeys(a, it.durationUs)), startUs: ns }
    }
    relocateFollowers(d, followers.map((x) => x.id))
    finalize(d)
  })
}

/** Edita o item via immer; valida duração ≥ MIN_ITEM_US e início ≥ 0. */
export function updateItem<T extends Item>(p: Project, itemId: string, recipe: (draft: T) => void): Project {
  const f = mustFind(p, itemId)
  assertUnlocked(f.track)
  return edit(p, (d) => {
    const it = d.tracks[f.trackIndex].items[f.itemIndex]
    recipe(it as unknown as T)
    if (it.durationUs < MIN_ITEM_US) throw new EditError('invalid', `Duração menor que o mínimo (${MIN_ITEM_US} µs)`)
    if (it.startUs < 0) throw new EditError('bounds', 'O item não pode começar antes de 0')
    finalize(d)
  })
}

/**
 * Duplica os itens (com vinculados) em atUs (padrão: logo após o fim do bloco). Os vínculos são
 * recriados entre as cópias. Se não couber na faixa de origem, cria uma faixa do mesmo tipo logo acima; efeito
 * copiado que não cabe vai para outra faixa de efeitos (placeEffect), nunca para uma "Vídeo N". `detached`: cópias de
 * efeitos ancorados que vieram sem o clipe da âncora e ficaram soltos (a interface avisa).
 */
export function duplicateItems(p0: Project, itemIds: string[], atUs?: Us): { project: Project; itemIds: string[]; detached: string[] } {
  // cópias a partir do projeto já com os alvos antigos gravados (a cópia de um efeito antigo herda o alvo e é remapeada)
  const p = produce(p0, stampLegacyTargets)
  const ids = expand(p, itemIds, true)
  if (ids.length === 0) return { project: p0, itemIds: [], detached: [] }
  const found = ids.map((id) => mustFind(p, id))
  const blockStart = Math.min(...found.map((f) => f.item.startUs))
  const at = Math.max(0, Math.round(atUs ?? Math.max(...found.map((f) => end(f.item)))))
  const linkMap = new Map<string, string>()
  const copies = found.map((f) => ({
    trackId: f.track.id,
    item: withLink({ ...f.item, id: newId('i_'), startUs: f.item.startUs + at - blockStart }, mapLink(linkMap, f.item.linkId))
  }))
  // efeito ancorado: a cópia ancora na cópia do clipe; colado sem o clipe, fica solto na caixa de reserva (a região do
  // quadro que envolvia a região ancorada; nunca continua preso ao clipe original, em outro instante)
  const copyOf = new Map(found.map((f, i) => [f.item.id, copies[i].item.id]))
  const detached: string[] = []
  copies.forEach((c, i) => {
    if (c.item.type !== 'effect' || !c.item.attach) return
    const to = copyOf.get(c.item.attach.mediaItemId)
    if (to) c.item = { ...c.item, attach: { ...c.item.attach, mediaItemId: to } }
    else {
      c.item = looseEffect(p, found[i].item as EffectItem, c.item)
      detached.push(c.item.id)
    }
  })
  const movedTrack = new Map<string, string>()
  const project = edit(p, (d) => {
    for (const trackId of [...new Set(copies.filter((c) => c.item.type !== 'effect').map((c) => c.trackId))]) {
      const group = copies.filter((c) => c.trackId === trackId && c.item.type !== 'effect').map((c) => c.item)
      const src = mustTrack(d, trackId)
      const fits = !src.locked && group.every((i) => isFree(src, i.startUs, end(i)))
      const target = fits ? src : mustTrack(d, createTrack(d, src.kind, d.tracks.indexOf(src) + 1))
      target.items.push(...group)
      movedTrack.set(trackId, target.id)
    }
    for (const c of copies) {
      if (c.item.type !== 'effect') continue
      // a cópia do efeito mira a faixa onde a cópia do clipe foi parar
      const tgt = c.item.targetTrackId
      if (tgt && movedTrack.has(tgt)) c.item.targetTrackId = movedTrack.get(tgt)
      placeEffect(d, c.item, mustTrack(d, c.trackId))
    }
    finalize(d)
  })
  return { project, itemIds: copies.map((c) => c.item.id), detached }
}

/**
 * Cópia `copy` do efeito ancorado `orig` sem a âncora: a região do quadro passa a ser conservativeRegion da caixa de
 * reserva (sem ela, a caixa da região no início do efeito), parada — como o resolve desenha a âncora perdida: elipse
 * cresce √2; invertido, o buraco nulo (esconde o quadro inteiro; o usuário redesenha o buraco).
 */
function looseEffect(p: Project, orig: EffectItem, copy: EffectItem): EffectItem {
  const f = orig.attach?.fallback ?? ((b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, w: b.x1 - b.x0, h: b.y1 - b.y0 }))(regionAabb(effectRegionAt(p, orig, orig.startUs), p.canvas.width, p.canvas.height))
  const r = conservativeRegion(orig, f)
  return { ...omit(copy, 'attach'), region: { shape: orig.region.shape, x: { value: r.x }, y: { value: r.y }, w: { value: r.w }, h: { value: r.h }, rotation: { value: r.rotation } } }
}

/**
 * Encosta os itens da faixa a partir de 0, removendo os vãos. Os vinculados de outras faixas se movem
 * pelo mesmo delta; se colidirem com algo (ou a faixa estiver bloqueada), ficam onde estão.
 */
export function closeGaps(p: Project, trackId: string): Project {
  assertUnlocked(mustTrack(p, trackId))
  return edit(p, (d) => {
    const t = mustTrack(d, trackId)
    t.items = [...t.items].sort((a, b) => a.startUs - b.startUs)
    const deltas = new Map<string, Us>()
    let cursor = 0
    for (const it of t.items) {
      const delta = cursor - it.startUs
      if (delta !== 0) {
        it.startUs = cursor
        // efeito seguidor não arrasta o clipe dele (só a mídia propaga o deslocamento ao grupo)
        if (it.linkId && !deltas.has(it.linkId) && !isFollower(d, it)) deltas.set(it.linkId, delta)
      }
      cursor = end(it)
    }
    for (const o of d.tracks) {
      if (o.id === trackId || o.locked) continue
      // deltas são negativos: da esquerda para a direita, cada movimento libera espaço para os seguintes
      for (const it of [...o.items].sort((a, b) => a.startUs - b.startUs)) {
        const delta = it.linkId ? deltas.get(it.linkId) : undefined
        if (!delta) continue
        const ns = it.startUs + delta
        if (ns >= 0 && isFree(o, ns, ns + it.durationUs, new Set([it.id]))) it.startUs = ns
      }
    }
    finalize(d)
  })
}

export function addMarker(p: Project, tUs: Us, label = ''): Project {
  return edit(p, (d) => {
    d.markers.push({ id: newId('m_'), tUs: Math.max(0, Math.round(tUs)), label, color: '#f59e0b' })
    d.markers.sort((a, b) => a.tUs - b.tUs)
  })
}

// ---------------------------------------------------------------- efeitos de privacidade e keyframes

function editAnim(p: Project, itemId: string, path: AnimPath, tUs: Us, fn: (a: Anim<number>, localUs: Us) => Anim<number>): Project {
  const f = mustFind(p, itemId)
  assertUnlocked(f.track)
  if (!getAnim(f.item, path)) throw new EditError('invalid', `O item ${itemId} não tem a propriedade ${path}`)
  const local = tUs - f.item.startUs
  if (local < 0 || local > f.item.durationUs) throw new EditError('bounds', 'Instante fora do item')
  return edit(p, (d) => {
    const it = d.tracks[f.trackIndex].items[f.itemIndex]
    assignAnim(it, path, fn(getAnim(it, path)!, local))
  })
}

/** Grava o valor em tUs (absoluto): sem keys altera o valor base; animado cria/atualiza o key. */
export function setAnimValue(p: Project, itemId: string, path: AnimPath, tUs: Us, value: number): Project {
  return editAnim(p, itemId, path, tUs, (a, local) => setValue(a, local, value))
}

/** Há key a ±meio quadro de tUs → remove; senão adiciona um key com o valor avaliado ali. */
export function toggleKeyframe(p: Project, itemId: string, path: AnimPath, tUs: Us): Project {
  const tol = frameDurUs(p.canvas.fps) / 2
  return editAnim(p, itemId, path, tUs, (a, local) => {
    const near = (a.keys ?? []).find((k) => Math.abs(k.tUs - local) <= tol)
    return near ? removeKey(a, near.tUs) : setKey(a, local, evalAnim(a, local))
  })
}

/** Próximo (dir 1) ou anterior (dir -1) keyframe, em tempo absoluto, estritamente além de fromUs; null se não houver. */
export function nextKeyframeUs(p: Project, itemId: string, path: AnimPath | 'any', fromUs: Us, dir: 1 | -1): Us | null {
  const f = findItem(p, itemId)
  if (!f) return null
  let best: Us | null = null
  for (const pt of path === 'any' ? ANIM_PATHS : [path]) {
    for (const k of getAnim(f.item, pt)?.keys ?? []) {
      const t = f.item.startUs + k.tUs
      if (dir === 1 ? t <= fromUs : t >= fromUs) continue
      if (best === null || (dir === 1 ? t < best : t > best)) best = t
    }
  }
  return best
}

/** Ativa/desativa itens (enabled só é gravado quando false). */
export function setItemEnabled(p: Project, itemIds: string[], enabled: boolean): Project {
  for (const id of itemIds) assertUnlocked(mustFind(p, id).track)
  return edit(p, (d) => {
    for (const id of itemIds) {
      const it = findItem(d, id)!.item
      if (enabled) delete it.enabled
      else it.enabled = false
    }
  })
}

/** Propriedades que o "keyframe" do item (Alt+K, losango da região) liga/desliga juntas. */
export function keyframePaths(item: Item, trackKind: TrackKind): AnimPath[] {
  if (item.type === 'effect') return ['region.x', 'region.y', 'region.w', 'region.h', 'region.rotation']
  if (item.type === 'media' && (trackKind === 'audio' || !item.visual)) return ['audio.volume']
  if (item.type === 'annotations') return []
  return ['transform.x', 'transform.y', 'transform.scale', 'transform.rotation', 'transform.opacity']
}

/**
 * Keyframe em grupo em tUs (absoluto): se alguma das propriedades tem key a ±meio quadro, remove os
 * keys desse instante (de todas); senão adiciona um key com o valor avaliado em cada uma.
 */
export function toggleKeyframes(p: Project, itemId: string, paths: AnimPath[], tUs: Us): Project {
  const f = mustFind(p, itemId)
  const tol = frameDurUs(p.canvas.fps) / 2
  const local = tUs - f.item.startUs
  const any = paths.some((pt) => (getAnim(f.item, pt)?.keys ?? []).some((k) => Math.abs(k.tUs - local) <= tol))
  let q = p
  for (const pt of paths) {
    const near = (getAnim(f.item, pt)?.keys ?? []).some((k) => Math.abs(k.tUs - local) <= tol)
    if (near === any) q = toggleKeyframe(q, itemId, pt, tUs)
  }
  return q
}

/** Instantes locais (µs) com key em qualquer propriedade do item, ordenados; keys a ±1 µs contam uma vez. */
export function keyframeTimesUs(item: Item): Us[] {
  const all = ANIM_PATHS.flatMap((pt) => (getAnim(item, pt)?.keys ?? []).map((k) => k.tUs)).sort((a, b) => a - b)
  return all.filter((t, i) => i === 0 || t - all[i - 1] > 1)
}

/** Aplica `fn` a cada propriedade animável do item (draft); null = não muda. Recusa faixa bloqueada. */
function editAllAnims(p: Project, itemId: string, fn: (a: Anim<number>, durationUs: Us, path: AnimPath) => Anim<number> | null): Project {
  const f = mustFind(p, itemId)
  assertUnlocked(f.track)
  const changes: [AnimPath, Anim<number>][] = []
  for (const pt of ANIM_PATHS) {
    const a = getAnim(f.item, pt)
    const next = a ? fn(a, f.item.durationUs, pt) : null
    if (next) changes.push([pt, next])
  }
  if (changes.length === 0) return p
  return edit(p, (d) => {
    const it = d.tracks[f.trackIndex].items[f.itemIndex]
    for (const [pt, a] of changes) assignAnim(it, pt, a)
  })
}

/**
 * Move os keys do instante local fromUs (±1 µs, em todas as propriedades) para toUs, preso a
 * [0, duração]. Um key de outro instante a ±meio quadro do destino é substituído (sem colisão).
 */
export function moveKeyframes(p: Project, itemId: string, fromUs: Us, toUs: Us): Project {
  const tol = frameDurUs(p.canvas.fps) / 2
  return editAllAnims(p, itemId, (a, dur) => {
    const to = Math.max(0, Math.min(dur, Math.round(toUs)))
    const keys = a.keys ?? []
    const moving = keys.find((k) => Math.abs(k.tUs - fromUs) <= 1)
    if (!moving || moving.tUs === to) return null
    const rest = keys.filter((k) => k !== moving && Math.abs(k.tUs - to) > tol)
    return { ...a, keys: [...rest, { ...moving, tUs: to }].sort((x, y) => x.tUs - y.tUs) }
  })
}

/** Remove os keys do instante local tUs (±1 µs) em todas as propriedades do item. */
export function removeKeyframesAt(p: Project, itemId: string, localUs: Us): Project {
  return editAllAnims(p, itemId, (a) => {
    const k = (a.keys ?? []).find((x) => Math.abs(x.tUs - localUs) <= 1)
    return k ? removeKey(a, k.tUs) : null
  })
}

/** Um key de uma propriedade: instante local (µs desde o início do item). */
export interface KeyRef { path: AnimPath; tUs: Us }

/** O key da propriedade a ±1 µs de tUs. */
const keyAt = (a: Anim<number>, tUs: Us): Keyframe<number> | undefined => (a.keys ?? []).find((k) => Math.abs(k.tUs - tUs) <= 1)

/**
 * Move os keys escolhidos (por propriedade) pelo mesmo delta, mantendo as distâncias: o delta é limitado para o
 * grupo inteiro ficar em [0, duração]. Um key que fica a ±meio quadro do destino de um key movido (na mesma
 * propriedade) é substituído, como em moveKeyframes. Delta efetivo 0 ou nenhum key → igual.
 */
export function moveKeys(p: Project, itemId: string, refs: readonly KeyRef[], deltaUs: Us): Project {
  const f = mustFind(p, itemId)
  const found = refs.flatMap((r) => {
    const a = getAnim(f.item, r.path)
    const k = a && keyAt(a, r.tUs)
    return k ? [{ path: r.path, key: k }] : []
  })
  if (found.length === 0) return p
  const lo = Math.min(...found.map((x) => x.key.tUs)), hi = Math.max(...found.map((x) => x.key.tUs))
  const d = Math.round(Math.max(-lo, Math.min(f.item.durationUs - hi, deltaUs)))
  if (d === 0) return p
  const tol = frameDurUs(p.canvas.fps) / 2
  return editAllAnims(p, itemId, (a, _dur, path) => {
    const moving = new Set(found.filter((x) => x.path === path).map((x) => x.key))
    if (moving.size === 0) return null
    const dest = [...moving].map((k) => k.tUs + d)
    const rest = (a.keys ?? []).filter((k) => !moving.has(k) && dest.every((t) => Math.abs(k.tUs - t) > tol))
    return { ...a, keys: [...rest, ...[...moving].map((k) => ({ ...k, tUs: k.tUs + d }))].sort((x, y) => x.tUs - y.tUs) }
  })
}

/** Remove os keys escolhidos (por propriedade); nenhum encontrado → igual. */
export function removeKeys(p: Project, itemId: string, refs: readonly KeyRef[]): Project {
  return editAllAnims(p, itemId, (a, _dur, path) => {
    const gone = refs.filter((r) => r.path === path).map((r) => keyAt(a, r.tUs)).filter((k) => !!k)
    return gone.length ? gone.reduce((acc, k) => removeKey(acc, k.tUs), a) : null
  })
}

/**
 * Troca a curva (ease) do key mais próximo de tUs (absoluto, até ±meio quadro) da propriedade: é a curva do trecho
 * que começa nele. Sem key ali → igual. Bezier com x1/x2 fora de [0,1] é recusado (a curva deixaria de ser função do
 * tempo).
 */
export function setKeyEase(p: Project, itemId: string, path: AnimPath, tUs: Us, ease: Ease): Project {
  if (typeof ease === 'object' && [ease.bezier[0], ease.bezier[2]].some((x) => !(x >= 0 && x <= 1))) throw new EditError('invalid', 'Curva inválida: x1 e x2 precisam ficar entre 0 e 1')
  const tol = frameDurUs(p.canvas.fps) / 2
  return editAnim(p, itemId, path, tUs, (a, local) => {
    let near: Keyframe<number> | undefined
    for (const k of a.keys ?? []) if (Math.abs(k.tUs - local) <= tol && (!near || Math.abs(k.tUs - local) < Math.abs(near.tUs - local))) near = k
    return near ? setEase(a, near.tUs, ease) : a
  })
}

/** Keyframes copiados: por propriedade, com tempos relativos ao 1º key copiado (de qualquer propriedade). */
export interface KeyframeClipboard { keys: Partial<Record<AnimPath, Keyframe<number>[]>> }

/**
 * Copia os keys do item em [fromUs, toUs] (absolutos; padrão = o item inteiro) das propriedades dadas (padrão =
 * todas), ou exatamente os keys de `keys` (instantes locais). Os tempos ficam relativos ao primeiro key copiado, preservando a distância entre propriedades. null = nada.
 */
export function copyKeyframes(p: Project, itemId: string, opts?: { paths?: AnimPath[]; fromUs?: Us; toUs?: Us; keys?: readonly KeyRef[] }): KeyframeClipboard | null {
  const it = mustFind(p, itemId).item
  const from = Math.max(0, (opts?.fromUs ?? it.startUs) - it.startUs)
  const to = Math.min(it.durationUs, (opts?.toUs ?? end(it)) - it.startUs)
  const found: [AnimPath, Keyframe<number>[]][] = []
  for (const pt of opts?.paths ?? ANIM_PATHS) {
    const a = getAnim(it, pt)
    // keys: só os escolhidos (linhas de keyframes); senão o trecho [from, to]
    const picked = opts?.keys?.filter((r) => r.path === pt)
    const keys = !a ? [] : picked ? picked.map((r) => keyAt(a, r.tUs)).filter((k) => !!k).sort((x, y) => x.tUs - y.tUs) : copyKeys(a, from, to)
    if (keys.length) found.push([pt, keys])
  }
  if (found.length === 0) return null
  const t0 = Math.min(...found.map(([, k]) => k[0].tUs))
  return { keys: Object.fromEntries(found.map(([pt, k]) => [pt, k.map((x) => ({ ...x, tUs: x.tUs - t0 }))])) }
}

/** Propriedades do clipboard que o item pode receber (as que ele tem; Tarja não tem intensidade animável). */
export function pastablePaths(item: Item, clip: KeyframeClipboard): AnimPath[] {
  return (Object.entries(clip.keys) as [AnimPath, Keyframe<number>[]][])
    .filter(([pt, keys]) => keys.length > 0 && !!getAnim(item, pt) && !(pt === 'strength' && item.type === 'effect' && item.effect === 'solid'))
    .map(([pt]) => pt)
}

/**
 * Cola keyframes no item a partir de atUs (absoluto, dentro do item): tempos relativos preservados e presos à
 * duração do item (o que passar dela é cortado com key de borda exato, sem salto — pasteKeys). Propriedades que o
 * item não tem (ex.: tamanho do texto num vídeo) e a intensidade numa Tarja são ignoradas; nenhuma aplicável → igual.
 */
export function pasteKeyframes(p: Project, itemId: string, clip: KeyframeClipboard, atUs: Us): Project {
  const f = mustFind(p, itemId)
  assertUnlocked(f.track)
  const local = Math.round(atUs) - f.item.startUs
  if (local < 0 || local > f.item.durationUs) throw new EditError('bounds', 'Instante fora do item')
  const changes: [AnimPath, Anim<number>][] = []
  // Tarja não tem intensidade animável (convertEffects tira os keys): não cola nela (pastablePaths)
  for (const pt of pastablePaths(f.item, clip)) changes.push([pt, pasteKeys(getAnim(f.item, pt)!, clip.keys[pt]!, local, f.item.durationUs)])
  if (changes.length === 0) return p
  return edit(p, (d) => {
    const it = d.tracks[f.trackIndex].items[f.itemIndex]
    for (const [pt, a] of changes) assignAnim(it, pt, a)
  })
}

/**
 * Troca o tipo dos efeitos (os outros itens e os que já são do tipo são ignorados). Tarja: borda suave 0
 * (cor exata, irreversível) e sem keys de intensidade (não valem para cor sólida). Saindo da Tarja, a
 * borda suave volta ao padrão do tipo.
 */
export function convertEffects(p: Project, itemIds: string[], effect: EffectItem['effect']): Project {
  const ids = itemIds.filter((id) => {
    const f = findItem(p, id)
    return f?.item.type === 'effect' && f.item.effect !== effect
  })
  if (ids.length === 0) return p
  for (const id of ids) assertUnlocked(mustFind(p, id).track)
  const presetFeather = createEffectItem(effect, 0, MIN_ITEM_US).feather
  return edit(p, (d) => {
    for (const id of ids) {
      const it = findItem(d, id)!.item as EffectItem
      if (effect === 'solid') {
        it.feather = 0
        it.strength = { value: it.strength.value }
      } else if (it.effect === 'solid') it.feather = presetFeather
      it.effect = effect
    }
  })
}

/**
 * Itens que ativar/desativar alcança: os dados e, com vínculo, a mídia vinculada — os efeitos vinculados a um
 * clipe ficam como estão (desativar o clipe não desliga a proteção sobre o que aparece no lugar dele).
 */
export function enableGroupIds(p: Project, itemIds: string[], includeLinked: boolean): string[] {
  const given = new Set(itemIds)
  return expand(p, itemIds, includeLinked).filter((id) => given.has(id) || mustFind(p, id).item.type !== 'effect')
}

/**
 * Ativar/desativar (Shift+E, menu): com vínculo, o grupo todo (vídeo + áudio vinculado; ver enableGroupIds). Se
 * algum do grupo está ativo, desativa todos; senão reativa todos.
 */
export function toggleEnabled(p: Project, itemIds: string[], includeLinked: boolean): Project {
  const ids = enableGroupIds(p, itemIds, includeLinked)
  if (ids.length === 0) return p
  const anyOn = ids.some((id) => mustFind(p, id).item.enabled !== false)
  return setItemEnabled(p, ids, !anyOn)
}

/**
 * Clipe visível sob atUs: item ativo (nem efeito, nem anotações — os traços da gravação não são o conteúdo a
 * esconder) da faixa de vídeo visível mais alta que tem algo ali.
 */
function clipUnder(p: Project, atUs: Us): { track: Track; item: Item } | null {
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    const t = p.tracks[i]
    if (t.kind !== 'video' || t.hidden) continue
    // só mídia: texto/forma não são conteúdo a esconder (ficam acima dos efeitos)
    const under = t.items.find((it) => it.type === 'media' && it.enabled !== false && it.startUs <= atUs && atUs < end(it))
    if (under) return { track: t, item: under }
  }
  return null
}

/** Duração padrão de um efeito em atUs: até o fim do clipe visível sob ele (faixa mais alta, não-efeito) ou 5 s. */
export function defaultEffectDurationUs(p: Project, at: Us): Us {
  const atUs = Math.max(0, Math.round(at))
  const under = clipUnder(p, atUs)
  return under ? Math.max(MIN_ITEM_US, end(under.item) - atUs) : 5_000_000
}

/**
 * Uma faixa pode receber um efeito em [s, e)? Precisa ser de vídeo, visível, desbloqueada e não ter mídia
 * visível por cima: nenhuma faixa de vídeo visível mais alta com item ativo (não-efeito) no intervalo — essa
 * mídia sairia sem proteção.
 */
export function effectTrackAllowed(p: Project, trackId: string, s: Us, e: Us): boolean {
  const ti = p.tracks.findIndex((t) => t.id === trackId)
  const t = p.tracks[ti]
  if (!t || t.kind !== 'video' || t.hidden || t.locked) return false
  // texto/forma por cima não contam: são sobreposições do usuário, não conteúdo a esconder
  return !p.tracks.some((o, i) => i > ti && o.kind === 'video' && !o.hidden && o.items.some((it) => it.type !== 'effect' && it.type !== 'text' && it.type !== 'shape' && it.enabled !== false && it.startUs < e && end(it) > s))
}

/**
 * Cria um efeito de privacidade em atUs. Duração padrão: até o fim do clipe visível sob o playhead
 * (faixa mais alta, sem contar efeitos) ou 5 s. Faixa: a explícita, se effectTrackAllowed (senão cai na
 * automática); automática: uma faixa "Efeitos" visível acima de todas as demais faixas de vídeo e livre no
 * intervalo; senão cria uma nova no topo. Criado sobre um clipe (de mídia, em outra faixa), o efeito é
 * vinculado a ele (e ao áudio vinculado): passa a acompanhar mover/aparar/ripple/dividir/apagar/duplicar/velocidade.
 */
export function addEffect(p: Project, preset: EffectPresetId, at: Us, opts?: { durationUs?: Us; trackId?: string; region?: EffectRegionInit }): { project: Project; itemId: string } {
  const atUs = Math.max(0, Math.round(at))
  const durationUs = opts?.durationUs === undefined ? defaultEffectDurationUs(p, atUs) : Math.max(MIN_ITEM_US, Math.round(opts.durationUs))
  const item = createEffectItem(preset, atUs, durationUs, opts?.region)
  let q = p
  let trackId: string | undefined
  if (opts?.trackId) {
    if (mustTrack(p, opts.trackId).kind !== 'video') throw new EditError('invalid', 'Efeitos só podem ficar em faixas de vídeo')
    if (effectTrackAllowed(p, opts.trackId, atUs, atUs + durationUs)) trackId = opts.trackId
  }
  if (!trackId) trackId = fxTrackFor(p, atUs, atUs + durationUs)?.id
  if (!trackId) {
    // acima da última faixa com mídia, abaixo das de texto/forma e da de legendas
    const r = addTrack(p, 'video', fxInsertIndex(p), nextFxName(p), 'effects')
    q = r.project
    trackId = r.trackId
  }
  q = insertItems(q, trackId, [item], 'overwrite')
  // vínculo com o clipe sob o efeito (o de outra faixa: na mesma faixa o efeito o recortaria)
  const clip = clipUnder(p, atUs)
  const linked = !!clip && clip.item.type === 'media' && clip.track.id !== trackId && !clip.track.locked
  const fxTrackId = trackId
  // alvo do escopo `track` (se o usuário trocar para "só a faixa abaixo"): a faixa do clipe, senão a mídia logo abaixo
  const target = linked ? clip!.track.id : mediaTrackBelow(q, fxTrackId)
  q = edit(q, (d) => {
    const fx = mustFind(d, item.id).item as EffectItem
    if (target) fx.targetTrackId = target
    if (!linked) return
    const linkId = clip!.item.linkId ?? newId('l_')
    mustFind(d, clip!.item.id).item.linkId = linkId
    fx.linkId = linkId
  })
  return { project: q, itemId: item.id }
}

// ---------------------------------------------------------------- transições

/** B (o item da direita, que guarda a transição) e o anterior A na faixa; lança se a faixa estiver bloqueada. */
function transitionPair(p: Project, rightItemId: string): { track: Track; a: Item | undefined; b: Item } {
  const f = mustFind(p, rightItemId)
  assertUnlocked(f.track)
  // itens ficam ordenados por startUs (finalize)
  return { track: f.track, a: f.itemIndex > 0 ? f.track.items[f.itemIndex - 1] : undefined, b: f.item }
}

/**
 * Transição de entrada em B (rightItemId) a partir do item anterior encostado na mesma faixa de vídeo (modelo em
 * transitions.ts). durationUs ausente = DEFAULT_TRANSITION_US; sempre limitada a [MIN_TRANSITION_US, máximo do par].
 * Substituir uma transição existente é esta mesma operação.
 */
export function addTransition(p: Project, rightItemId: string, kind: TransitionKind, durationUs?: Us): Project {
  if (durationUs !== undefined && !Number.isFinite(durationUs)) throw new EditError('invalid', 'Duração de transição inválida')
  const { track, a, b } = transitionPair(p, rightItemId)
  const why = canTransition(p, track.id, a?.id, b.id)
  if (why) throw new EditError('invalid', why)
  const d = clamp(Math.round(durationUs ?? DEFAULT_TRANSITION_US), MIN_TRANSITION_US, maxTransitionUs(a!, b))
  return edit(p, (dr) => {
    const it = mustFind(dr, rightItemId).item as MediaItem
    it.transitionIn = { kind, durationUs: d }
  })
}

/** Remove a transição de entrada de B (nada a fazer = o mesmo projeto). */
export function removeTransition(p: Project, rightItemId: string): Project {
  const { b } = transitionPair(p, rightItemId)
  if ((b.type !== 'media' && b.type !== 'text') || !b.transitionIn) return p
  return edit(p, (d) => {
    delete (mustFind(d, rightItemId).item as MediaItem).transitionIn
  })
}

/** Nova duração da transição de B, limitada a [MIN_TRANSITION_US, máximo do par] (gesto de arrastar: em transação). */
export function setTransitionDuration(p: Project, rightItemId: string, durationUs: Us): Project {
  if (!Number.isFinite(durationUs)) throw new EditError('invalid', 'Duração de transição inválida')
  const { track, a, b } = transitionPair(p, rightItemId)
  if ((b.type !== 'media' && b.type !== 'text') || !b.transitionIn) throw new EditError('invalid', 'Este clipe não tem transição de entrada')
  // regra estrutural (como a normalização): ajustar a duração de uma transição com um lado desativado é permitido
  if (!transitionPairOk(track, a, b)) throw new EditError('invalid', 'Transição só entre dois clipes encostados na mesma faixa')
  if (maxTransitionUs(a, b) < MIN_TRANSITION_US) throw new EditError('invalid', 'Clipes curtos demais para a transição')
  const d = clamp(Math.round(durationUs), MIN_TRANSITION_US, maxTransitionUs(a, b))
  if (d === b.transitionIn.durationUs) return p
  return edit(p, (dr) => {
    ;(mustFind(dr, rightItemId).item as MediaItem).transitionIn!.durationUs = d
  })
}

// ---------------------------------------------------------------- texto, formas e legendas

/** Duração padrão de uma legenda nova (addCaption). */
export const CAPTION_DEFAULT_US = 2_000_000

/** Índice de uma faixa de sobreposição nova: no topo das de vídeo, logo abaixo da de legendas. */
function overlayInsertIndex(p: Project): number {
  const cap = p.tracks.findIndex(isCaptionsTrack)
  return cap >= 0 ? cap : aboveLastVideo(p)
}

/**
 * Põe um texto/forma novo: na faixa dada (de vídeo, desbloqueada, não de efeitos, livre; a de legendas só aceita
 * texto) ou na faixa de sobreposição mais alta, visível, desbloqueada e livre no trecho; senão cria "`baseName`" no
 * topo das de vídeo (abaixo da de legendas). Um passo de desfazer.
 */
function addOverlayItem(p: Project, item: TextItem | ShapeItem, baseName: string, trackId: string | undefined): { project: Project; itemId: string } {
  const s = item.startUs, e = end(item)
  if (trackId) {
    const t = mustTrack(p, trackId)
    if (t.kind !== 'video') throw new EditError('invalid', `Textos e formas só podem ficar em faixas de vídeo ("${t.name}" é de áudio)`)
    assertUnlocked(t)
    assertNotFxTrackFor(item, t)
    if (!isFree(t, s, e)) throw new EditError('overlap', `Já há um item na faixa "${t.name}" nesse trecho`)
  }
  const project = edit(p, (d) => {
    let t = trackId ? mustTrack(d, trackId) : undefined
    for (let i = d.tracks.length - 1; !t && i >= 0; i--) {
      const x = d.tracks[i]
      // só sobreposições sem faixa de efeitos acima (abaixo de uma, o texto novo seria desfocado)
      if (isOverlayTrack(x) && !x.locked && !x.hidden && isFree(x, s, e) && !d.tracks.some((y, j) => j > i && isFxTrack(y))) t = x
    }
    if (!t) t = mustTrack(d, createTrack(d, 'video', overlayInsertIndex(d), freeTrackName(d, baseName)))
    t.items.push(item)
    finalize(d)
  })
  return { project, itemId: item.id }
}

/** Texto novo a partir de um modelo em atUs (TEXT_PRESETS; duração padrão do modelo). Faixa: ver addOverlayItem. */
export function addText(p: Project, preset: TextPresetId, atUs: Us, opts?: { trackId?: string; text?: string; durationUs?: Us }): { project: Project; itemId: string } {
  const at = Math.max(0, Math.round(atUs))
  const item = createTextItem(preset, at, {
    ...(opts?.text !== undefined ? { text: opts.text } : {}),
    ...(opts?.durationUs !== undefined ? { durationUs: Math.max(MIN_ITEM_US, Math.round(opts.durationUs)) } : {})
  })
  return addOverlayItem(p, item, 'Texto', opts?.trackId)
}

/** Forma nova a partir de um modelo em atUs (SHAPE_PRESETS; 3 s). Faixa: ver addOverlayItem (legendas não aceitam). */
export function addShape(p: Project, preset: ShapePresetId, atUs: Us, opts?: { trackId?: string; durationUs?: Us }): { project: Project; itemId: string } {
  const at = Math.max(0, Math.round(atUs))
  const item = createShapeItem(preset, at, opts?.durationUs !== undefined ? { durationUs: Math.max(MIN_ITEM_US, Math.round(opts.durationUs)) } : undefined)
  return addOverlayItem(p, item, 'Formas', opts?.trackId)
}

/** A faixa de legendas do projeto; sem ela, cria "Legendas" no topo das faixas de vídeo. */
export function ensureCaptionsTrack(p: Project): { project: Project; trackId: string } {
  const found = p.tracks.find(isCaptionsTrack)
  if (found) return { project: p, trackId: found.id }
  let trackId = ''
  const project = edit(p, (d) => { trackId = createTrack(d, 'video', aboveLastVideo(d), freeTrackName(d, 'Legendas'), 'captions') })
  return { project, trackId }
}

/**
 * Legenda nova em atUs (cria a faixa de legendas se preciso). Estilo: o da legenda mais próxima no tempo, senão o do
 * modelo 'caption'. Duração: `durationUs` (padrão CAPTION_DEFAULT_US) limitada ao espaço até a próxima legenda; menos
 * que MIN_ITEM_US (ou atUs dentro de uma legenda) → EditError.
 */
export function addCaption(p: Project, atUs: Us, text: string, opts?: { durationUs?: Us }): { project: Project; itemId: string } {
  const at = Math.max(0, Math.round(atUs))
  const r = ensureCaptionsTrack(p)
  const t = mustTrack(r.project, r.trackId)
  assertUnlocked(t)
  if (t.items.some((i) => i.startUs <= at && at < end(i))) throw new EditError('overlap', 'Já há uma legenda neste ponto')
  const next = Math.min(Infinity, ...t.items.filter((i) => i.startUs > at).map((i) => i.startUs))
  const want = opts?.durationUs === undefined ? CAPTION_DEFAULT_US : Math.max(MIN_ITEM_US, Math.round(opts.durationUs))
  const dur = Math.min(want, next - at)
  if (dur < MIN_ITEM_US) throw new EditError('overlap', 'Não há espaço para uma legenda aqui: a próxima começa logo em seguida')
  const dist = (i: Item): number => (i.startUs > at ? i.startUs - at : at - end(i))
  const near = t.items.filter((i): i is TextItem => i.type === 'text').reduce<TextItem | null>((b, i) => (!b || dist(i) < dist(b) ? i : b), null)
  const item = createTextItem('caption', at, { text, durationUs: dur })
  if (near) {
    item.style = structuredClone(near.style)
    item.visual.transform.y = structuredClone(near.visual.transform.y)
  }
  const project = edit(r.project, (d) => {
    mustTrack(d, r.trackId).items.push(item)
    finalize(d)
  })
  return { project, itemId: item.id }
}

/**
 * Aplica `patch` ao estilo de TODAS as legendas (um passo de desfazer; `undefined` numa chave remove o campo; sombra
 * coerente, ver patchTextStyle). Sem faixa de legendas ou sem legendas: o mesmo projeto.
 */
export function setCaptionStyle(p: Project, patch: Partial<TextStyle>): Project {
  const t = p.tracks.find(isCaptionsTrack)
  if (!t || !t.items.some((i) => i.type === 'text')) return p
  assertUnlocked(t)
  const styles = new Map(t.items.filter((i): i is TextItem => i.type === 'text').map((i) => [i.id, patchTextStyle(i.style, structuredClone(patch))]))
  return edit(p, (d) => {
    for (const it of mustTrack(d, t.id).items) if (it.type === 'text') it.style = styles.get(it.id)!
  })
}

/** Estilo e posição vertical comuns das legendas (os da primeira legenda; sem legendas, os do modelo 'caption'). */
function commonCaption(t: Track | undefined): { style: TextStyle; y: Anim<number> } {
  const first = t?.items.find((i): i is TextItem => i.type === 'text')
  if (first) return { style: first.style, y: first.visual.transform.y }
  const base = createTextItem('caption', 0)
  return { style: base.style, y: base.visual.transform.y }
}

const fmtS = (us: Us): string => `${(us / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} s`

/**
 * Importa legendas (cues de um SRT) para a faixa de legendas (criada se preciso), num único passo de desfazer.
 * `replace` limpa a faixa antes; `append` mantém as existentes e encaixa as novas nos vãos (cue que colide é
 * encurtada; sem espaço ≥ MIN_ITEM_US, descartada — com aviso). `offsetUs` desloca todas; o que ficar antes de 0 é
 * cortado. Estilo e posição vertical = os comuns atuais das legendas (ou os do modelo). Faixa bloqueada → EditError.
 */
export function importCaptions(p: Project, cues: readonly Cue[], opts: { mode: 'replace' | 'append'; offsetUs?: Us }): { project: Project; count: number; warnings: string[] } {
  const existing = p.tracks.find(isCaptionsTrack)
  if (existing) assertUnlocked(existing)
  const warnings: string[] = []
  const off = Math.round(opts.offsetUs ?? 0)
  const { style, y } = commonCaption(existing)
  // ocupado: as legendas que ficam (append), em ordem; as novas entram depois de `lastEnd`
  const keep = opts.mode === 'append' && existing ? existing.items : []
  const sorted = cues.map((c, i) => ({ c, i })).sort((a, b) => a.c.startUs - b.c.startUs || a.i - b.i)
  const add: TextItem[] = []
  let j = 0
  let lastEnd = 0
  for (const { c, i } of sorted) {
    const label = `Legenda ${i + 1} (${fmtS(Math.max(0, c.startUs + off))})`
    let s = Math.round(c.startUs) + off
    let e = Math.round(c.endUs) + off
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= Math.max(0, s)) {
      warnings.push(`${label}: fica antes do início do vídeo — descartada`)
      continue
    }
    let changed = false
    if (s < 0) {
      s = 0
      changed = true
    }
    if (s < lastEnd) {
      s = lastEnd
      changed = true
    }
    // pula as existentes que terminam antes; empurra o início para depois das que o cobrem
    while (j < keep.length && end(keep[j]) <= s) j++
    while (j < keep.length && keep[j].startUs <= s) {
      s = Math.max(s, end(keep[j]))
      changed = true
      j++
    }
    if (j < keep.length && keep[j].startUs < e) {
      e = keep[j].startUs
      changed = true
    }
    if (e - s < MIN_ITEM_US) {
      warnings.push(`${label}: ${changed ? 'sem espaço entre as legendas existentes' : 'curta demais'} — descartada`)
      continue
    }
    if (changed) warnings.push(`${label}: colidia com outra legenda — ajustada para ${fmtS(s)}–${fmtS(e)}`)
    const item = createTextItem('caption', s, { text: c.text, durationUs: e - s })
    item.style = structuredClone(style)
    item.visual.transform.y = structuredClone(y)
    add.push(item)
    lastEnd = e
  }
  const project = edit(p, (d) => {
    let t = d.tracks.find(isCaptionsTrack)
    if (!t) t = mustTrack(d, createTrack(d, 'video', aboveLastVideo(d), freeTrackName(d, 'Legendas'), 'captions'))
    t.items = opts.mode === 'replace' ? add : [...t.items, ...add]
    finalize(d)
  })
  return { project, count: add.length, warnings }
}

/** Legendas habilitadas da faixa de legendas, em ordem (para exportar SRT). */
export function captionCues(p: Project): Cue[] {
  const t = p.tracks.find(isCaptionsTrack)
  if (!t) return []
  return t.items
    .filter((i): i is TextItem => i.type === 'text' && i.enabled !== false)
    .map((i) => ({ startUs: i.startUs, endUs: end(i), text: i.text }))
    .sort((a, b) => a.startUs - b.startUs)
}

/**
 * Novo início e fim (µs) de uma legenda (lista de legendas). Fim ≤ início + MIN_ITEM_US ou início < 0 → 'invalid';
 * sobrepor outra legenda → 'overlap'. Sem mudança: o mesmo projeto.
 */
export function setCaptionTimes(p: Project, itemId: string, startUs: Us, endUs: Us): Project {
  const f = mustFind(p, itemId)
  if (!isCaptionsTrack(f.track)) throw new EditError('invalid', 'Este item não é uma legenda')
  assertUnlocked(f.track)
  const s = Math.round(startUs), e = Math.round(endUs)
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0) throw new EditError('invalid', 'Tempo de legenda inválido')
  if (e - s < MIN_ITEM_US) throw new EditError('invalid', 'O fim da legenda precisa ser depois do início')
  if (s === f.item.startUs && e === end(f.item)) return p
  const other = f.track.items.find((i) => i.id !== itemId && i.startUs < e && end(i) > s)
  if (other) throw new EditError('overlap', `A legenda sobreporia a ${other.startUs < f.item.startUs ? 'anterior' : 'seguinte'}`)
  return edit(p, (d) => {
    const it = mustFind(d, itemId).item
    it.startUs = s
    it.durationUs = e - s
    finalize(d)
  })
}

/** Posição vertical (centro, 0–1) de TODAS as legendas, num passo. Sem legendas: o mesmo projeto. */
export function setCaptionPosition(p: Project, y: number): Project {
  const t = p.tracks.find(isCaptionsTrack)
  if (!t || !t.items.some((i) => i.type === 'text')) return p
  assertUnlocked(t)
  const v = clamp(y, 0, 1)
  return edit(p, (d) => {
    for (const it of mustTrack(d, t.id).items) if (it.type === 'text') it.visual.transform.y = { value: v }
  })
}

/**
 * Cópia do projeto com a faixa de legendas escondida (exportação sem "queimar" as legendas). Não é uma edição: não
 * entra no histórico. A faixa de legendas é sempre a de vídeo do topo — escondê-la não muda o que os efeitos cobrem.
 */
export function withCaptionsHidden(p: Project): Project {
  if (!p.tracks.some((t) => isCaptionsTrack(t) && !t.hidden)) return p
  return { ...p, tracks: p.tracks.map((t) => (isCaptionsTrack(t) ? { ...t, hidden: true } : t)) }
}
