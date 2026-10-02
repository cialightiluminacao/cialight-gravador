import { produce } from 'immer'
import { evalAnim, removeKey, setKey, setValue, sliceKeys } from './anim'
import { createEffectItem, createMediaItem } from './factory'
import { visualTrackBelow } from './resolve'
import type { EffectPresetId, EffectRegionInit } from './factory'
import { newId } from './ids'
import { frameDurUs, itemEndUs } from './time'
import { MAX_SPEED, MIN_ITEM_US, MIN_SPEED } from './project'
import type { Anim, Asset, EffectItem, Item, MediaItem, Project, Track, TrackKind, Us, VisualProps } from './project'

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

/**
 * Efeito "só a faixa abaixo" sem targetTrackId (projeto antigo): grava a faixa a que ele está ligado agora pela
 * posição (visualTrackBelow), antes de qualquer edição mexer na ordem das faixas. Daí em diante a ligação é explícita.
 */
function stampLegacyTargets(d: Project): void {
  for (const t of d.tracks) {
    for (const it of t.items) {
      if (it.type !== 'effect' || it.scope !== 'track' || it.targetTrackId) continue
      const below = visualTrackBelow(d, t.id)
      if (below) it.targetTrackId = below
    }
  }
}

/** produce do immer com stampLegacyTargets antes da receita (toda edição grava as ligações antigas). */
function edit(p: Project, recipe: (d: Project) => void): Project {
  return produce(p, (d) => {
    stampLegacyTargets(d)
    recipe(d)
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

function mapVisual(v: VisualProps, f: (a: Anim<number>) => Anim<number>): VisualProps {
  const t = v.transform
  return { ...v, transform: { x: f(t.x), y: f(t.y), scale: f(t.scale), rotation: f(t.rotation), opacity: f(t.opacity) } }
}

/** Aplica f a todas as animações com keyframes do item (transform, volume, região e força do efeito). */
function mapAnims<T extends Item>(it: T, f: (a: Anim<number>) => Anim<number>): T {
  const i = it as Item
  switch (i.type) {
    case 'media':
      return { ...i, audio: { ...i.audio, volume: f(i.audio.volume) }, ...(i.visual ? { visual: mapVisual(i.visual, f) } : {}) } as T
    case 'text':
    case 'shape':
      return { ...i, visual: mapVisual(i.visual, f) } as T
    case 'effect': {
      const r = i.region
      return { ...i, region: { ...r, x: f(r.x), y: f(r.y), w: f(r.w), h: f(r.h), rotation: f(r.rotation) }, strength: f(i.strength) } as T
    }
    default:
      return it
  }
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
  const lastMedia = d.tracks.reduce((m, t, i) => (t.kind === 'video' && !isFxTrack(t) ? i : m), -1)
  const t = d.tracks.find((x, i) => i > lastMedia && isFxTrack(x) && !x.locked && !x.hidden && isFree(x, s, e))
  ;(t ?? mustTrack(d, createTrack(d, 'video', aboveLastVideo(d), nextFxName(d), 'effects'))).items.push(it)
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

/** Faixa de mídia visível mais próxima abaixo de trackId (pula ocultas, de áudio e de efeitos); null = nenhuma. */
function mediaTrackBelow(p: Project, trackId: string): string | null {
  for (let i = p.tracks.findIndex((t) => t.id === trackId) - 1; i >= 0; i--) {
    const t = p.tracks[i]
    if (t.kind === 'video' && !t.hidden && !isFxTrack(t)) return t.id
  }
  return null
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
      at = aboveLastVideo(d)
      while (at > 0 && isFxTrack(d.tracks[at - 1])) at--
    }
  }
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
  return edit(p, (d) => {
    const [t] = d.tracks.splice(from, 1)
    d.tracks.splice(to, 0, t)
  })
}

/** Não exige faixa desbloqueada (é assim que se desbloqueia). */
export function updateTrack(p: Project, trackId: string, patch: Partial<Omit<Track, 'id' | 'items' | 'kind'>>): Project {
  const i = p.tracks.findIndex((t) => t.id === trackId)
  if (i < 0) throw new EditError('notFound', `Faixa não encontrada: ${trackId}`)
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
 */
function pickTrack(p: Project, kind: TrackKind, explicitId: string | undefined, mode: InsertMode | undefined, s: Us, e: Us): { project: Project; trackId: string; mode: InsertMode } {
  if (explicitId) {
    const t = mustTrack(p, explicitId)
    if (t.kind !== kind) throw new EditError('invalid', `Faixa ${t.name} não é de ${kind === 'video' ? 'vídeo' : 'áudio'}`)
    return { project: p, trackId: t.id, mode: mode ?? 'overwrite' }
  }
  const candidates = p.tracks.filter((t) => t.kind === kind && !t.locked && !isFxTrack(t))
  const chosen = mode ? candidates[0] : candidates.find((t) => isFree(t, s, e))
  if (chosen) return { project: p, trackId: chosen.id, mode: mode ?? 'overwrite' }
  const r = addTrack(p, kind)
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
    const r = pickTrack(q, 'audio', opts?.audioTrackId, mode, at, end(it))
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
    // fades, animações e transição acompanham a escala de tempo, limitados à nova duração
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
    if (n.transitionIn) n = { ...n, transitionIn: { ...n.transitionIn, durationUs: fit(n.transitionIn.durationUs, Math.floor(dur / 2)) } }
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
 * copiado que não cabe vai para outra faixa de efeitos (placeEffect), nunca para uma "Vídeo N".
 */
export function duplicateItems(p: Project, itemIds: string[], atUs?: Us): { project: Project; itemIds: string[] } {
  const ids = expand(p, itemIds, true)
  if (ids.length === 0) return { project: p, itemIds: [] }
  const found = ids.map((id) => mustFind(p, id))
  const blockStart = Math.min(...found.map((f) => f.item.startUs))
  const at = Math.max(0, Math.round(atUs ?? Math.max(...found.map((f) => end(f.item)))))
  const linkMap = new Map<string, string>()
  const copies = found.map((f) => ({
    trackId: f.track.id,
    item: withLink({ ...f.item, id: newId('i_'), startUs: f.item.startUs + at - blockStart }, mapLink(linkMap, f.item.linkId))
  }))
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
  return { project, itemIds: copies.map((c) => c.item.id) }
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

export type AnimPath =
  | 'transform.x' | 'transform.y' | 'transform.scale' | 'transform.rotation' | 'transform.opacity'
  | 'region.x' | 'region.y' | 'region.w' | 'region.h' | 'region.rotation'
  | 'strength' | 'audio.volume'

const ANIM_PATHS: AnimPath[] = [
  'transform.x', 'transform.y', 'transform.scale', 'transform.rotation', 'transform.opacity',
  'region.x', 'region.y', 'region.w', 'region.h', 'region.rotation', 'strength', 'audio.volume'
]
type RegionKey = 'x' | 'y' | 'w' | 'h' | 'rotation'
type TransformKey = keyof VisualProps['transform']

/** Animação do item no caminho dado; null se o tipo de item não tem essa propriedade. */
export function getAnim(item: Item, path: AnimPath): Anim<number> | null {
  if (path === 'strength') return item.type === 'effect' ? item.strength : null
  if (path === 'audio.volume') return item.type === 'media' ? item.audio.volume : null
  if (path.startsWith('region.')) return item.type === 'effect' ? item.region[path.slice(7) as RegionKey] : null
  const v = item.type === 'media' || item.type === 'text' || item.type === 'shape' ? item.visual : undefined
  return v ? v.transform[path.slice(10) as TransformKey] : null
}

/** Grava a animação no item (draft do immer); o caminho já foi validado por getAnim. */
function assignAnim(item: Item, path: AnimPath, a: Anim<number>): void {
  if (item.type === 'effect') {
    if (path === 'strength') item.strength = a
    else item.region[path.slice(7) as RegionKey] = a
  } else if (path === 'audio.volume') {
    if (item.type === 'media') item.audio.volume = a
  } else if (item.type === 'media' || item.type === 'text' || item.type === 'shape') {
    if (item.visual) item.visual.transform[path.slice(10) as TransformKey] = a
  }
}

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
function editAllAnims(p: Project, itemId: string, fn: (a: Anim<number>, durationUs: Us) => Anim<number> | null): Project {
  const f = mustFind(p, itemId)
  assertUnlocked(f.track)
  const changes: [AnimPath, Anim<number>][] = []
  for (const pt of ANIM_PATHS) {
    const a = getAnim(f.item, pt)
    const next = a ? fn(a, f.item.durationUs) : null
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

/** Clipe visível sob atUs: item não-efeito ativo da faixa de vídeo visível mais alta que tem algo ali. */
function clipUnder(p: Project, atUs: Us): { track: Track; item: Item } | null {
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    const t = p.tracks[i]
    if (t.kind !== 'video' || t.hidden) continue
    const under = t.items.find((it) => it.type !== 'effect' && it.enabled !== false && it.startUs <= atUs && atUs < end(it))
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
  return !p.tracks.some((o, i) => i > ti && o.kind === 'video' && !o.hidden && o.items.some((it) => it.type !== 'effect' && it.enabled !== false && it.startUs < e && end(it) > s))
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
  if (!trackId) {
    const lastMedia = p.tracks.reduce((m, t, i) => (t.kind === 'video' && !isFxTrack(t) ? i : m), -1)
    trackId = p.tracks.find((t, i) => i > lastMedia && isFxTrack(t) && !t.locked && !t.hidden && isFree(t, atUs, atUs + durationUs))?.id
  }
  if (!trackId) {
    const r = addTrack(p, 'video', aboveLastVideo(p), nextFxName(p), 'effects')
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
