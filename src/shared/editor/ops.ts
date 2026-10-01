import { produce } from 'immer'
import { sliceKeys } from './anim'
import { createMediaItem } from './factory'
import { newId } from './ids'
import { itemEndUs } from './time'
import { MAX_SPEED, MIN_ITEM_US, MIN_SPEED } from './project'
import type { Anim, Asset, Item, MediaItem, Project, Track, TrackKind, Us, VisualProps } from './project'

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

// ---------------------------------------------------------------- consultas

export function findItem(p: Project, itemId: string): { track: Track; item: Item; trackIndex: number; itemIndex: number } | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti]
    const ii = track.items.findIndex((i) => i.id === itemId)
    if (ii >= 0) return { track, item: track.items[ii], trackIndex: ti, itemIndex: ii }
  }
  return null
}

/** Inclui o próprio item (primeiro); vazio se não existir. */
export function linkedIds(p: Project, itemId: string): string[] {
  const f = findItem(p, itemId)
  if (!f) return []
  const link = f.item.linkId
  if (!link) return [itemId]
  const out = [itemId]
  for (const t of p.tracks) for (const i of t.items) if (i.linkId === link && i.id !== itemId) out.push(i.id)
  return out
}

export function projectDurationUs(p: Project): Us {
  let max = 0
  for (const t of p.tracks) if (!t.hidden) for (const i of t.items) max = Math.max(max, end(i))
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

/** Recorta/divide os itens da faixa que cruzam [from,to); pedaços menores que MIN_ITEM_US somem. */
function overwriteRange(track: Track, from: Us, to: Us, linkMap: Map<string, string>): void {
  const out: Item[] = []
  for (const it of track.items) {
    const s = it.startUs, e = end(it)
    if (e <= from || s >= to) { out.push(it); continue }
    if (s < from && from - s >= MIN_ITEM_US) out.push(sliceItem(it, s, from, true))
    if (e > to && e - to >= MIN_ITEM_US) {
      const right = sliceItem(it, to, e, true)
      out.push(s < from ? withLink({ ...right, id: newId('i_') }, mapLink(linkMap, it.linkId)) : right)
    }
  }
  track.items = out
}

/** Divide os alvos que contêm atUs com ≥ MIN_ITEM_US dos dois lados; 'all' = faixas desbloqueadas. */
function splitInPlace(d: Project, targets: Set<string> | 'all', atUs: Us, linkMap: Map<string, string>): number {
  let count = 0
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
      out.push(withLink({ ...sliceItem(it, atUs, e, true), id: newId('i_') }, mapLink(linkMap, it.linkId)))
      hits++
    }
    if (hits > 0) t.items = out
    count += hits
  }
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
  splitInPlace(d, 'all', point, new Map())
  for (const t of d.tracks) {
    if (t.locked) continue
    for (const it of t.items) if (it.startUs >= point) it.startUs += D
  }
  return point
}

/**
 * Desloca itens com startUs ≥ pivot por shift nas faixas desbloqueadas. Ao puxar para trás (shift < 0),
 * faixas fora de `forced` só se movem se o intervalo [pivot+shift, pivot) estiver vazio nelas.
 */
function rippleShift(d: Project, pivotUs: Us, shift: Us, exclude: Set<string>, forced: Set<string>): void {
  if (shift === 0) return
  for (const t of d.tracks) {
    if (t.locked) continue
    if (shift < 0 && !forced.has(t.id)) {
      const g0 = pivotUs + shift
      if (t.items.some((i) => !exclude.has(i.id) && i.startUs < pivotUs && end(i) > g0)) continue
    }
    for (const it of t.items) if (!exclude.has(it.id) && it.startUs >= pivotUs) it.startUs += shift
  }
}

function isFree(t: Track, s: Us, e: Us, exclude?: Set<string>): boolean {
  return !t.items.some((i) => !exclude?.has(i.id) && i.startUs < e && end(i) > s)
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
  let n = p.tracks.filter((t) => t.kind === kind).length + 1
  while (p.tracks.some((t) => t.name === `${prefix} ${n}`)) n++
  return `${prefix} ${n}`
}

/** Cria faixa no draft. Índice padrão: vídeo logo acima da última faixa de vídeo (0 = fundo); áudio no fim. */
function createTrack(d: Project, kind: TrackKind, index?: number, name?: string): string {
  let at = index
  if (at === undefined) {
    if (kind === 'audio') at = d.tracks.length
    else {
      let last = -1
      d.tracks.forEach((t, i) => { if (t.kind === 'video') last = i })
      at = last + 1
    }
  }
  const id = newId('t_')
  d.tracks.splice(clamp(at, 0, d.tracks.length), 0, {
    id, kind, name: name ?? defaultTrackName(d, kind), muted: false, hidden: false, locked: false, volume: 1, items: []
  })
  return id
}

// ---------------------------------------------------------------- assets

export function addAsset(p: Project, a: Asset): Project {
  if (p.assets.some((x) => x.id === a.id)) throw new EditError('invalid', `Asset já existe: ${a.id}`)
  return produce(p, (d) => { d.assets.push(a) })
}

export function updateAsset(p: Project, id: string, patch: Partial<Asset>): Project {
  const i = p.assets.findIndex((x) => x.id === id)
  if (i < 0) throw new EditError('notFound', `Asset não encontrado: ${id}`)
  return produce(p, (d) => { Object.assign(d.assets[i], patch) })
}

/** Remove o asset e todos os itens que o usam (inclusive em faixas bloqueadas). */
export function removeAsset(p: Project, id: string): Project {
  if (!p.assets.some((x) => x.id === id)) throw new EditError('notFound', `Asset não encontrado: ${id}`)
  return produce(p, (d) => {
    d.assets = d.assets.filter((x) => x.id !== id)
    for (const t of d.tracks) {
      if (t.items.some((i) => i.type === 'media' && i.assetId === id)) t.items = t.items.filter((i) => !(i.type === 'media' && i.assetId === id))
    }
    finalize(d)
  })
}

// ---------------------------------------------------------------- faixas

export function addTrack(p: Project, kind: TrackKind, index?: number, name?: string): { project: Project; trackId: string } {
  let trackId = ''
  const project = produce(p, (d) => { trackId = createTrack(d, kind, index, name) })
  return { project, trackId }
}

export function removeTrack(p: Project, trackId: string): Project {
  assertUnlocked(mustTrack(p, trackId))
  return produce(p, (d) => {
    d.tracks = d.tracks.filter((t) => t.id !== trackId)
    finalize(d)
  })
}

export function moveTrack(p: Project, trackId: string, toIndex: number): Project {
  const from = p.tracks.findIndex((t) => t.id === trackId)
  if (from < 0) throw new EditError('notFound', `Faixa não encontrada: ${trackId}`)
  const to = clamp(Math.round(toIndex), 0, p.tracks.length - 1)
  if (to === from) return p
  return produce(p, (d) => {
    const [t] = d.tracks.splice(from, 1)
    d.tracks.splice(to, 0, t)
  })
}

/** Não exige faixa desbloqueada (é assim que se desbloqueia). */
export function updateTrack(p: Project, trackId: string, patch: Partial<Omit<Track, 'id' | 'items' | 'kind'>>): Project {
  const i = p.tracks.findIndex((t) => t.id === trackId)
  if (i < 0) throw new EditError('notFound', `Faixa não encontrada: ${trackId}`)
  return produce(p, (d) => { Object.assign(d.tracks[i], patch) })
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
    if (it.durationUs < MIN_ITEM_US) throw new EditError('invalid', `Item ${it.id} menor que a duração mínima`)
    if (it.startUs < 0) throw new EditError('bounds', `Item ${it.id} começa antes de 0`)
  }
  const sorted = [...items].sort((a, b) => a.startUs - b.startUs)
  return produce(p, (d) => {
    const t = mustTrack(d, trackId)
    let placed = sorted
    if (mode === 'insert') {
      const first = sorted[0].startUs
      const sum = sorted.reduce((acc, i) => acc + i.durationUs, 0)
      const span = Math.max(...sorted.map(end)) - first
      const point = makeRoom(d, first, Math.max(sum, span), trackId)
      placed = sorted.map((i) => ({ ...i, startUs: i.startUs + point - first }))
    } else {
      const linkMap = new Map<string, string>()
      for (const i of sorted) overwriteRange(t, i.startUs, end(i), linkMap)
    }
    t.items.push(...placed)
    finalize(d)
  })
}

/** Escolhe a faixa: explícita; com modo → primeira desbloqueada do tipo; sem modo → primeira livre (ou cria). */
function pickTrack(p: Project, kind: TrackKind, explicitId: string | undefined, mode: InsertMode | undefined, s: Us, e: Us): { project: Project; trackId: string; mode: InsertMode } {
  if (explicitId) {
    const t = mustTrack(p, explicitId)
    if (t.kind !== kind) throw new EditError('invalid', `Faixa ${t.name} não é de ${kind === 'video' ? 'vídeo' : 'áudio'}`)
    return { project: p, trackId: t.id, mode: mode ?? 'overwrite' }
  }
  const candidates = p.tracks.filter((t) => t.kind === kind && !t.locked)
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
  return produce(p, (d) => {
    splitInPlace(d, targets, at, new Map())
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
 */
export function trimItem(p: Project, itemId: string, edge: 'start' | 'end', toUs: Us, opts?: { ripple?: boolean; includeLinked?: boolean }): Project {
  const main = mustFind(p, itemId).item
  const ripple = !!opts?.ripple
  const ids = expand(p, [itemId], opts?.includeLinked ?? true)
  const idSet = new Set(ids)
  let delta = Math.round(toUs) - (edge === 'start' ? main.startUs : end(main))
  let lo = -Infinity, hi = Infinity
  for (const id of ids) {
    const f = mustFind(p, id)
    assertUnlocked(f.track)
    const it = f.item
    const [extStart, extEnd] = sourceExtent(p, it)
    const others = f.track.items.filter((i) => !idSet.has(i.id))
    if (edge === 'start') {
      hi = Math.min(hi, it.durationUs - MIN_ITEM_US)
      lo = Math.max(lo, -extStart)
      if (!ripple) {
        const prevEnd = Math.max(0, ...others.filter((i) => i.startUs < it.startUs).map(end))
        lo = Math.max(lo, -Math.max(0, it.startUs - prevEnd))
      }
    } else {
      lo = Math.max(lo, MIN_ITEM_US - it.durationUs)
      hi = Math.min(hi, extEnd)
      if (!ripple) {
        const nextStart = Math.min(Infinity, ...others.filter((i) => i.startUs >= end(it)).map((i) => i.startUs))
        hi = Math.min(hi, nextStart - end(it))
      }
    }
  }
  delta = lo > hi ? 0 : clamp(delta, lo, hi)
  if (delta === 0) return p
  return produce(p, (d) => {
    const forced = new Set<string>()
    for (const id of ids) {
      const f = mustFind(d, id)
      const it = f.item
      forced.add(f.track.id)
      let n: Item
      if (edge === 'start') {
        n = sliceItem(it, it.startUs + delta, end(it), false)
        if (ripple) n = { ...n, startUs: it.startUs }
      } else n = sliceItem(it, it.startUs, end(it) + delta, false)
      f.track.items[f.itemIndex] = n
    }
    if (ripple) rippleShift(d, end(main), edge === 'start' ? -delta : delta, idSet, forced)
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
    return { id, fromTrackId: f.track.id, toTrackId: to.id, item: f.item }
  })
  const minStart = Math.min(...plan.map((x) => x.item.startUs))
  const delta = Math.max(Math.round(deltaUs), -minStart)
  if (delta === 0 && plan.every((x) => x.fromTrackId === x.toTrackId)) return p
  const idSet = new Set(ids)
  return produce(p, (d) => {
    for (const t of d.tracks) if (t.items.some((i) => idSet.has(i.id))) t.items = t.items.filter((i) => !idSet.has(i.id))
    let moved = plan.map((x) => ({ ...x, item: { ...x.item, startUs: x.item.startUs + delta } as Item }))
    if (opts?.mode === 'insert') {
      const blockStart = Math.min(...moved.map((x) => x.item.startUs))
      const span = Math.max(...moved.map((x) => end(x.item))) - blockStart
      const point = makeRoom(d, blockStart, span, (moved.find((x) => primary.has(x.id)) ?? moved[0]).toTrackId)
      moved = moved.map((x) => ({ ...x, item: { ...x.item, startUs: x.item.startUs + point - blockStart } }))
    } else {
      const linkMap = new Map<string, string>()
      for (const x of moved) {
        const t = mustTrack(d, x.toTrackId)
        if (isFree(t, x.item.startUs, end(x.item))) continue
        if (opts?.mode !== 'overwrite') throw new EditError('overlap', `Sobreposição na faixa "${t.name}"`)
        overwriteRange(t, x.item.startUs, end(x.item), linkMap)
      }
    }
    for (const x of moved) mustTrack(d, x.toTrackId).items.push(x.item)
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
  return produce(p, (d) => {
    for (const t of d.tracks) if (t.items.some((i) => idSet.has(i.id))) t.items = t.items.filter((i) => !idSet.has(i.id))
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
  return produce(p, (d) => {
    const linkMap = new Map<string, string>()
    for (const id of trackIds) {
      const t = mustTrack(d, id)
      overwriteRange(t, from, to, linkMap)
      for (const it of t.items) if (it.startUs >= to) it.startUs -= to - from
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
  return produce(p, (d) => {
    for (const id of ids) mustFind(d, id).item.linkId = linkId
    finalize(d)
  })
}

export function unlinkItems(p: Project, itemIds: string[]): Project {
  for (const id of itemIds) mustFind(p, id)
  return produce(p, (d) => {
    for (const id of itemIds) delete mustFind(d, id).item.linkId
    finalize(d)
  })
}

/**
 * Item de vídeo com áudio próprio: cria item de áudio (mesmo tempo) numa faixa de áudio livre (ou nova),
 * desativa o áudio do vídeo e vincula os dois. Se já estiver vinculado, apenas desvincula o grupo.
 */
export function detachAudio(p: Project, itemId: string): Project {
  const f = mustFind(p, itemId)
  const it = f.item
  if (it.type !== 'media') throw new EditError('invalid', 'Somente itens de mídia têm áudio')
  if (it.linkId) return unlinkItems(p, linkedIds(p, itemId))
  if (f.track.kind !== 'video') throw new EditError('invalid', 'O item já é de áudio')
  const asset = p.assets.find((a) => a.id === it.assetId)
  if (!it.audio.enabled || !asset?.audio) throw new EditError('invalid', 'O item não tem áudio para separar')
  assertUnlocked(f.track)
  const linkId = newId('l_')
  const audioItem: MediaItem = { ...omit(it, 'visual', 'transitionIn'), id: newId('i_'), linkId, audio: { ...it.audio, enabled: true } }
  return produce(p, (d) => {
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
 * de todas as faixas desbloqueadas; sem ripple lança EditError('overlap').
 */
export function setSpeed(p: Project, itemId: string, speed: number, opts?: { ripple?: boolean }): Project {
  const main = mustFind(p, itemId).item
  if (main.type !== 'media') throw new EditError('invalid', 'Velocidade só se aplica a itens de mídia')
  const s = clamp(speed, MIN_SPEED, MAX_SPEED)
  const changes: { id: string; item: MediaItem; oldEnd: Us }[] = []
  for (const id of linkedIds(p, itemId)) {
    const f = mustFind(p, id)
    if (f.item.type !== 'media' || f.item.speed === s) continue
    assertUnlocked(f.track)
    const ratio = f.item.speed / s
    const dur = Math.round(f.item.durationUs * ratio)
    if (dur < MIN_ITEM_US) throw new EditError('invalid', 'Duração resultante menor que o mínimo')
    const scaled = mapAnims(f.item, (a) => (a.keys ? { ...a, keys: a.keys.map((k) => ({ ...k, tUs: Math.round(k.tUs * ratio) })) } : a))
    changes.push({ id, item: { ...scaled, speed: s, durationUs: dur }, oldEnd: end(f.item) })
  }
  if (changes.length === 0) return p
  const idSet = new Set(changes.map((c) => c.id))
  let collision = false
  for (const c of changes) {
    const t = mustFind(p, c.id).track
    const next = Math.min(Infinity, ...t.items.filter((i) => !idSet.has(i.id) && i.startUs >= c.oldEnd).map((i) => i.startUs))
    if (end(c.item) > next) collision = true
  }
  if (collision && opts?.ripple === false) throw new EditError('overlap', 'A nova duração colide com o próximo item')
  return produce(p, (d) => {
    for (const c of changes) {
      const f = mustFind(d, c.id)
      f.track.items[f.itemIndex] = c.item
    }
    if (collision) {
      const pivot = Math.min(...changes.map((c) => c.oldEnd))
      const shift = Math.max(...changes.map((c) => end(c.item) - c.oldEnd))
      rippleShift(d, pivot, shift, idSet, new Set())
    }
    finalize(d)
  })
}

/** Edita o item via immer; valida duração ≥ MIN_ITEM_US e início ≥ 0. */
export function updateItem<T extends Item>(p: Project, itemId: string, recipe: (draft: T) => void): Project {
  const f = mustFind(p, itemId)
  assertUnlocked(f.track)
  return produce(p, (d) => {
    const it = d.tracks[f.trackIndex].items[f.itemIndex]
    recipe(it as unknown as T)
    if (it.durationUs < MIN_ITEM_US) throw new EditError('invalid', `Duração menor que o mínimo (${MIN_ITEM_US} µs)`)
    if (it.startUs < 0) throw new EditError('bounds', 'O item não pode começar antes de 0')
    finalize(d)
  })
}

/**
 * Duplica os itens (com vinculados) em atUs (padrão: logo após o fim do bloco). Os vínculos são
 * recriados entre as cópias. Se não couber na faixa de origem, cria uma faixa do mesmo tipo logo acima.
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
  const project = produce(p, (d) => {
    for (const trackId of [...new Set(copies.map((c) => c.trackId))]) {
      const group = copies.filter((c) => c.trackId === trackId).map((c) => c.item)
      const src = mustTrack(d, trackId)
      const fits = !src.locked && group.every((i) => isFree(src, i.startUs, end(i)))
      const target = fits ? src : mustTrack(d, createTrack(d, src.kind, d.tracks.indexOf(src) + 1))
      target.items.push(...group)
    }
    finalize(d)
  })
  return { project, itemIds: copies.map((c) => c.item.id) }
}

/** Encosta os itens da faixa a partir de 0, removendo os vãos. */
export function closeGaps(p: Project, trackId: string): Project {
  assertUnlocked(mustTrack(p, trackId))
  return produce(p, (d) => {
    const t = mustTrack(d, trackId)
    t.items = [...t.items].sort((a, b) => a.startUs - b.startUs)
    let cursor = 0
    for (const it of t.items) {
      if (it.startUs !== cursor) it.startUs = cursor
      cursor = end(it)
    }
    finalize(d)
  })
}

export function addMarker(p: Project, tUs: Us, label = ''): Project {
  return produce(p, (d) => {
    d.markers.push({ id: newId('m_'), tUs: Math.max(0, Math.round(tUs)), label, color: '#f59e0b' })
    d.markers.sort((a, b) => a.tUs - b.tUs)
  })
}
