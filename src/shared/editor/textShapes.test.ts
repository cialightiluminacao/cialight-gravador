import { describe, expect, it } from 'vitest'
import {
  createEmptyProject, createShapeItem, createTextItem, patchTextStyle, SHAPE_PRESETS, TEXT_PRESETS,
  type ShapePresetId, type TextPresetId
} from './factory'
import { DEFAULT_SHAPE_BOX, DEFAULT_TEXT_SHADOW, MIN_ITEM_US, textContentAt } from './project'
import type { Asset, Item, Project, ShapeItem, TextItem, Track } from './project'
import * as ops from './ops'
import { parseProject, toDiskProject, validateProject } from './schema'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'

const S = 1_000_000
const vid = (id: string, dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
/** Projeto com um vídeo de 10 s em V1 (áudio vinculado em A1). */
function withClip(): { p: Project; clip: string } {
  const r = ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid('a')), 'a', 0)
  return { p: r.project, clip: r.itemIds[0] }
}
const item = <T extends Item = Item>(p: Project, id: string): T => ops.findItem(p, id)!.item as T
const trackOf = (p: Project, id: string): Track => ops.findItem(p, id)!.track
const idx = (p: Project, trackId: string): number => p.tracks.findIndex((t) => t.id === trackId)
const videoNames = (p: Project): string[] => p.tracks.filter((t) => t.kind === 'video').map((t) => t.name)
const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return `${(e as ops.EditError).code}: ${(e as Error).message}` }
  return 'ok'
}
const disk = (p: Project): unknown => JSON.parse(JSON.stringify(toDiskProject(p)))

describe('textContentAt', () => {
  const cd = createTextItem('countdown', 0)
  it('contagem 3→0 em 3 s: 0 s→3, 0,5 s→3, 1 s→2, 2,999 s→1', () => {
    expect(cd.counter).toEqual({ from: 3, to: 0 })
    expect(cd.durationUs).toBe(3 * S)
    expect([0, 0.5 * S, S, 2.999 * S].map((t) => textContentAt(cd, t))).toEqual(['3', '3', '2', '1'])
  })
  it('crescente usa floor; sem contagem devolve o texto; local fora do item é limitado', () => {
    const up: TextItem = { ...cd, counter: { from: 0, to: 10 }, durationUs: 10 * S }
    expect([0, 0.999 * S, S, 9.5 * S, 20 * S].map((t) => textContentAt(up, t))).toEqual(['0', '0', '1', '9', '10'])
    expect(textContentAt(cd, -S)).toBe('3')
    expect(textContentAt(createTextItem('title', 0, { text: 'Olá' }), S)).toBe('Olá')
  })
  it('nunca mostra "-0"', () => {
    const neg: TextItem = { ...cd, counter: { from: 1, to: -1 }, durationUs: 2 * S }
    expect(textContentAt(neg, 1.5 * S)).toBe('0')
  })
})

describe('modelos de texto e forma (factory)', () => {
  it('rótulos pt-BR e valores principais dos modelos de texto', () => {
    expect(Object.fromEntries(Object.entries(TEXT_PRESETS).map(([k, v]) => [k, v.label]))).toEqual({
      title: 'Título', subtitle: 'Subtítulo', lowerThird: 'Terço inferior', caption: 'Legenda', quote: 'Citação', countdown: 'Contagem'
    })
    expect(TEXT_PRESETS.title.animIn?.preset).toBe('fade')
    expect(TEXT_PRESETS.caption.style).toMatchObject({ background: '#000000b3', maxWidth: 0.8, align: 'center' })
    expect(TEXT_PRESETS.caption.y).toBeGreaterThan(0.8)
    expect(TEXT_PRESETS.lowerThird.style).toMatchObject({ align: 'left' })
    expect(TEXT_PRESETS.lowerThird.style.background).toMatch(/^#[0-9a-f]{8}$/)
    expect(TEXT_PRESETS.lowerThird.style.padding).toBeGreaterThan(0)
    expect(TEXT_PRESETS.lowerThird.x).toBeLessThan(0.5)
    expect(TEXT_PRESETS.lowerThird.y).toBeGreaterThan(0.7)
    expect(TEXT_PRESETS.quote.style.italic).toBe(true)
    expect(TEXT_PRESETS.countdown).toMatchObject({ counter: { from: 3, to: 0 }, durationUs: 3 * S, x: 0.5, y: 0.5 })
  })
  it.each(Object.keys(TEXT_PRESETS) as TextPresetId[])('createTextItem(%s): 3 s, posição do modelo, sombra coerente, sem compartilhar objetos', (id) => {
    const t = createTextItem(id, 2 * S)
    expect(t).toMatchObject({ type: 'text', startUs: 2 * S, durationUs: 3 * S, text: TEXT_PRESETS[id].text })
    expect(t.visual.transform.x.value).toBe(TEXT_PRESETS[id].x)
    expect(t.visual.transform.y.value).toBe(TEXT_PRESETS[id].y)
    expect(!!t.style.shadow).toBe(!!t.style.shadowStyle)
    expect(t.style).toEqual(TEXT_PRESETS[id].style)
    expect(t.style).not.toBe(TEXT_PRESETS[id].style)
    expect(t.style.size).not.toBe(TEXT_PRESETS[id].style.size)
    expect(createTextItem(id, 0, { text: 'x', durationUs: S })).toMatchObject({ text: 'x', durationUs: S })
  })
  it('rótulos e valores dos modelos de forma; shape continua rect/ellipse/arrow', () => {
    expect(Object.fromEntries(Object.entries(SHAPE_PRESETS).map(([k, v]) => [k, v.label]))).toEqual({
      rect: 'Retângulo', ellipse: 'Elipse', arrow: 'Seta', highlight: 'Destaque', spotlight: 'Holofote'
    })
    const hl = createShapeItem('highlight', 0)
    expect(hl).toMatchObject({ shape: 'rect', fill: 'none', stroke: '#ffd400', durationUs: 3 * S })
    expect(hl.strokeWidth).toBeGreaterThanOrEqual(8)
    expect(hl.cornerRadius).toBeGreaterThan(0)
    expect(createShapeItem('spotlight', 0)).toMatchObject({ shape: 'ellipse', fill: 'none', stroke: 'none', spotlight: { dim: 0.6 } })
    for (const id of Object.keys(SHAPE_PRESETS) as ShapePresetId[]) expect(['rect', 'ellipse', 'arrow']).toContain(createShapeItem(id, 0).shape)
    expect(DEFAULT_SHAPE_BOX).toEqual({ w: 0.3, h: 0.2 })
  })
  it('patchTextStyle: shadow sempre igual a !!shadowStyle; undefined remove o campo', () => {
    const base = createTextItem('caption', 0).style
    expect(base.shadow).toBeUndefined()
    const on = patchTextStyle(base, { shadow: true })
    expect(on).toMatchObject({ shadow: true, shadowStyle: DEFAULT_TEXT_SHADOW })
    expect(patchTextStyle(on, { shadow: false })).toEqual(base)
    const custom = patchTextStyle(base, { shadowStyle: { color: '#ff0000', blur: 0.1, dx: 0, dy: 0.1 } })
    expect(custom.shadow).toBe(true)
    expect(patchTextStyle(custom, { shadowStyle: undefined })).toEqual(base)
    expect('maxWidth' in patchTextStyle(base, { maxWidth: undefined })).toBe(false)
    expect(patchTextStyle(base, { italic: true }).italic).toBe(true)
  })
})

describe('addText / addShape: colocação', () => {
  it('sem faixa: cria "Texto" no topo; outro no mesmo trecho cria "Texto 2" acima; fora do trecho reaproveita a mais alta livre', () => {
    const { p } = withClip()
    const a = ops.addText(p, 'title', S)
    const ta = trackOf(a.project, a.itemId)
    expect(ta.name).toBe('Texto')
    expect(idx(a.project, ta.id)).toBe(a.project.tracks.filter((t) => t.kind === 'video').length - 1)
    const b = ops.addText(a.project, 'subtitle', 2 * S)
    expect(trackOf(b.project, b.itemId).name).toBe('Texto 2')
    expect(idx(b.project, trackOf(b.project, b.itemId).id)).toBeGreaterThan(idx(b.project, ta.id))
    // depois de 5 s as duas estão livres: vai para a mais alta (Texto 2); formas usam as mesmas faixas
    const c = ops.addShape(b.project, 'arrow', 6 * S)
    expect(trackOf(c.project, c.itemId).name).toBe('Texto 2')
    expect(validateProject(c.project)).toEqual([])
  })
  it('forma sem faixa de sobreposição livre cria "Formas"; texto/opts.text/opts.durationUs', () => {
    const { p } = withClip()
    const s = ops.addShape(p, 'rect', 0)
    expect(trackOf(s.project, s.itemId).name).toBe('Formas')
    const t = ops.addText(s.project, 'quote', 0, { text: 'Oi', durationUs: 1 })
    expect(item<TextItem>(t.project, t.itemId)).toMatchObject({ text: 'Oi', durationUs: MIN_ITEM_US })
    expect(trackOf(t.project, t.itemId).name).toBe('Texto')
  })
  it('com legendas: a faixa nova fica abaixo da de legendas', () => {
    const { p } = withClip()
    const cap = ops.ensureCaptionsTrack(p)
    const t = ops.addText(cap.project, 'title', 0)
    const q = t.project
    expect(idx(q, trackOf(q, t.itemId).id)).toBe(idx(q, cap.trackId) - 1)
    expect(q.tracks.filter((x) => x.kind === 'video').at(-1)!.id).toBe(cap.trackId)
  })
  it('com trackId: valida faixa (áudio, bloqueada, efeitos, ocupada, legendas só texto) com mensagens em pt-BR', () => {
    const { p, clip } = withClip()
    const audio = p.tracks.find((t) => t.kind === 'audio')!.id
    const v1 = trackOf(p, clip).id
    expect(code(() => ops.addText(p, 'title', 0, { trackId: audio }))).toMatch(/^invalid: .*faixas de vídeo/)
    expect(code(() => ops.addText(p, 'title', 0, { trackId: v1 }))).toMatch(/^overlap: /)
    expect(ops.findItem(ops.addText(p, 'title', 11 * S, { trackId: v1 }).project, clip)).not.toBeNull()
    const locked = ops.updateTrack(p, v1, { locked: true })
    expect(code(() => ops.addText(locked, 'title', 11 * S, { trackId: v1 }))).toMatch(/^locked: /)
    const fx = ops.addEffect(p, 'blur', 0)
    const fxTrack = trackOf(fx.project, fx.itemId).id
    expect(code(() => ops.addShape(fx.project, 'rect', 20 * S, { trackId: fxTrack }))).toMatch(/^invalid: .*só para efeitos/)
    const cap = ops.ensureCaptionsTrack(p)
    expect(code(() => ops.addShape(cap.project, 'rect', 0, { trackId: cap.trackId }))).toMatch(/^invalid: .*só para legendas/)
    expect(code(() => ops.addText(cap.project, 'caption', 0, { trackId: cap.trackId }))).toBe('ok')
  })
  it('efeito novo não fica acima de uma faixa de texto pré-existente (nem da de legendas)', () => {
    const { p } = withClip()
    const t = ops.addText(p, 'title', 0, { durationUs: 10 * S })
    const c = ops.addCaption(t.project, 0, 'Oi')
    const fx = ops.addEffect(c.project, 'blur', S)
    const q = fx.project
    const fi = idx(q, trackOf(q, fx.itemId).id)
    expect(fi).toBeLessThan(idx(q, trackOf(q, t.itemId).id))
    expect(fi).toBeLessThan(idx(q, trackOf(q, c.itemId).id))
    expect(fi).toBeGreaterThan(idx(q, q.tracks.find((x) => x.name === 'Vídeo 1')!.id))
    // o efeito continua vinculado ao clipe (não ao texto, que está mais alto)
    expect(item(q, fx.itemId).linkId).toBeDefined()
    expect(item(q, fx.itemId).linkId).toBe(item(q, q.tracks[0].items[0].id).linkId)
    // um segundo efeito no mesmo trecho: outra faixa de efeitos, também abaixo do texto
    const fx2 = ops.addEffect(q, 'pixelate', S)
    expect(idx(fx2.project, trackOf(fx2.project, fx2.itemId).id)).toBeLessThan(idx(fx2.project, trackOf(fx2.project, t.itemId).id))
    // e a faixa de efeitos existente (abaixo do texto) é aceita explicitamente mesmo com o texto por cima
    expect(ops.effectTrackAllowed(q, trackOf(q, fx.itemId).id, 20 * S, 21 * S)).toBe(true)
  })
  it('mídia nova não entra em faixa de texto nem de legendas; faixa de vídeo nova fica abaixo delas', () => {
    const { p } = withClip()
    const t = ops.addText(p, 'title', 0, { durationUs: 2 * S })
    const c = ops.addCaption(t.project, 0, 'Oi')
    const q = ops.addAsset(c.project, vid('b'))
    // V1 ocupado em [0,10): não vai para a faixa Texto (livre em [5,15)) — cria vídeo novo abaixo do texto
    const m = ops.addMediaFromAsset(q, 'b', 5 * S)
    const r = m.project
    const mt = trackOf(r, m.itemIds[0])
    expect(mt.name).not.toBe('Texto')
    expect(mt.role).toBeUndefined()
    expect(idx(r, mt.id)).toBeLessThan(idx(r, trackOf(r, t.itemId).id))
    // addTrack de vídeo com índice acima das legendas fica logo abaixo delas
    const at = ops.addTrack(r, 'video', r.tracks.length)
    expect(idx(at.project, at.trackId)).toBe(idx(at.project, trackOf(at.project, c.itemId).id) - 1)
  })
})

describe('legendas', () => {
  it('ensureCaptionsTrack: cria "Legendas" (role captions) no topo das de vídeo; idempotente', () => {
    const { p } = withClip()
    const r = ops.ensureCaptionsTrack(p)
    const t = r.project.tracks.find((x) => x.id === r.trackId)!
    expect(t).toMatchObject({ kind: 'video', name: 'Legendas', role: 'captions', items: [] })
    expect(r.project.tracks.filter((x) => x.kind === 'video').at(-1)).toBe(t)
    const again = ops.ensureCaptionsTrack(r.project)
    expect(again.project).toBe(r.project)
    expect(again.trackId).toBe(r.trackId)
  })
  it('addCaption: 2 s; limitada até a próxima; sem espaço ou dentro de outra → EditError', () => {
    const { p } = withClip()
    const a = ops.addCaption(p, 5 * S, 'B')
    expect(item(a.project, a.itemId)).toMatchObject({ type: 'text', text: 'B', startUs: 5 * S, durationUs: 2 * S })
    expect(item<TextItem>(a.project, a.itemId).style).toEqual(TEXT_PRESETS.caption.style)
    const b = ops.addCaption(a.project, 4 * S, 'A')
    expect(item(b.project, b.itemId)).toMatchObject({ startUs: 4 * S, durationUs: S })
    expect(code(() => ops.addCaption(b.project, 5 * S - 10, 'x'))).toMatch(/^overlap: /)
    expect(code(() => ops.addCaption(b.project, 6 * S, 'x'))).toMatch(/^overlap: Já há uma legenda/)
    expect(code(() => ops.addCaption(b.project, 5 * S - MIN_ITEM_US - 10, 'x', { durationUs: 3 * S }))).toMatch(/^overlap: /)
    const c = ops.addCaption(b.project, 3 * S, 'x', { durationUs: 3 * S })
    expect(item(c.project, c.itemId).durationUs).toBe(S)
    expect(validateProject(c.project)).toEqual([])
  })
  it('addCaption copia o estilo da legenda mais próxima', () => {
    const { p } = withClip()
    const a = ops.addCaption(p, 0, 'A')
    const b = ops.addCaption(a.project, 10 * S, 'B')
    const q = ops.updateItem<TextItem>(b.project, b.itemId, (t) => { t.style.color = '#ffd400' })
    const near = ops.addCaption(q, 9 * S, 'C')
    expect(item<TextItem>(near.project, near.itemId).style.color).toBe('#ffd400')
    const far = ops.addCaption(q, 3 * S, 'D')
    expect(item<TextItem>(far.project, far.itemId).style.color).toBe('#ffffff')
  })
  it('setCaptionStyle aplica a TODAS as legendas numa única edição; sombra coerente; sem legendas = o mesmo projeto', () => {
    const { p } = withClip()
    expect(ops.setCaptionStyle(p, { color: '#ff0000' })).toBe(p)
    let q = ops.addCaption(p, 0, 'A').project
    q = ops.addCaption(q, 3 * S, 'B').project
    const patch = { color: '#00ff00', shadow: true }
    const r = ops.setCaptionStyle(q, patch)
    const caps = r.tracks.find(ops.isCaptionsTrack)!.items as TextItem[]
    expect(caps.map((c) => c.style.color)).toEqual(['#00ff00', '#00ff00'])
    expect(caps.every((c) => c.style.shadow === true && !!c.style.shadowStyle)).toBe(true)
    expect(Object.isFrozen(patch)).toBe(false)
    const locked = ops.updateTrack(q, q.tracks.find(ops.isCaptionsTrack)!.id, { locked: true })
    expect(code(() => ops.setCaptionStyle(locked, { color: '#000000' }))).toMatch(/^locked: /)
  })
  it('insertItems/moveItems de não-texto para a faixa de legendas → EditError; texto entra', () => {
    const { p } = withClip()
    const cap = ops.ensureCaptionsTrack(p)
    const sh = ops.addShape(cap.project, 'rect', 20 * S)
    expect(code(() => ops.insertItems(cap.project, cap.trackId, [createShapeItem('rect', 0)], 'overwrite'))).toMatch(/^invalid: .*legendas/)
    expect(code(() => ops.moveItems(sh.project, [sh.itemId], 0, { toTrackId: cap.trackId }))).toMatch(/^invalid: .*legendas/)
    const tx = ops.addText(sh.project, 'title', 30 * S)
    const moved = ops.moveItems(tx.project, [tx.itemId], 0, { toTrackId: cap.trackId })
    expect(trackOf(moved, tx.itemId).id).toBe(cap.trackId)
  })
  it('moveTrack: nada acima da faixa de legendas, nem ela fora do topo', () => {
    const { p } = withClip()
    const t = ops.addText(p, 'title', 0)
    const cap = ops.ensureCaptionsTrack(t.project)
    const q = cap.project
    const ci = idx(q, cap.trackId)
    expect(code(() => ops.moveTrack(q, cap.trackId, 0))).toMatch(/^invalid: A faixa de legendas fica sempre no topo/)
    expect(code(() => ops.moveTrack(q, q.tracks[0].id, ci))).toMatch(/^invalid: /)
    // mover faixas abaixo dela continua livre
    const tt = trackOf(q, t.itemId).id
    expect(code(() => ops.moveTrack(q, tt, 0))).toBe('ok')
  })
  it('validateProject: no máximo uma faixa de legendas, só textos; texto/forma só em faixa de vídeo', () => {
    const { p } = withClip()
    const q = ops.addCaption(p, 0, 'A').project
    const capT = q.tracks.find(ops.isCaptionsTrack)!
    const two: Project = { ...q, tracks: [...q.tracks, { ...capT, id: 't_cap2', items: [] }] }
    expect(validateProject(two)).toContain('Há mais de uma faixa de legendas')
    const withShape: Project = { ...q, tracks: q.tracks.map((t) => (t.id === capT.id ? { ...t, items: [...t.items, createShapeItem('rect', 10 * S)] } : t)) }
    expect(validateProject(withShape).some((m) => m.includes('só aceita textos'))).toBe(true)
    const onAudio: Project = { ...p, tracks: p.tracks.map((t) => (t.kind === 'audio' ? { ...t, items: [createTextItem('title', 20 * S)] } : t)) }
    expect(validateProject(onAudio).some((m) => m.includes('só pode ficar em faixa de vídeo'))).toBe(true)
  })
})

describe('edições existentes com texto/forma', () => {
  /** Contagem 10→0 em 10 s numa faixa Texto e uma forma. */
  function scene(): { p: Project; cd: string; sh: string } {
    const { p } = withClip()
    const a = ops.addText(p, 'countdown', 0, { durationUs: 10 * S })
    const withCounter = ops.updateItem<TextItem>(a.project, a.itemId, (t) => { t.counter = { from: 10, to: 0 }; t.style.color = '#ff00ff' })
    const s = ops.addShape(withCounter, 'highlight', 0, { durationUs: 4 * S })
    return { p: s.project, cd: a.itemId, sh: s.itemId }
  }
  it('split: o texto dividido mantém o estilo; a contagem da direita continua do ponto do corte', () => {
    const { p, cd } = scene()
    const q = ops.splitAt(p, [cd], 4 * S)
    const [l, r] = trackOf(q, cd).items as TextItem[]
    expect(l.style).toEqual(r.style)
    expect(r.style.color).toBe('#ff00ff')
    expect(l.counter).toEqual({ from: 10, to: 6 })
    expect(r.counter).toEqual({ from: 6, to: 0 })
    expect(textContentAt(l, 0)).toBe('10')
    expect(textContentAt(r, 0)).toBe('6')
    expect(textContentAt(r, 0.5 * S)).toBe('6')
    expect(textContentAt(r, S)).toBe('5')
    // corte fora de um múltiplo: valores exatos (não arredondados)
    const q3 = ops.splitAt(p, [cd], Math.round(10 * S / 3))
    const r3 = trackOf(q3, cd).items[1] as TextItem
    expect(r3.counter!.from).toBeCloseTo(10 - 3_333_333 / S, 9)
    expect(Number.isInteger(r3.counter!.from)).toBe(false)
  })
  it('trim mantém from/to (a contagem cobre a nova duração) e o estilo', () => {
    const { p, cd } = scene()
    const q = ops.trimItem(p, cd, 'end', 5 * S)
    expect(item<TextItem>(q, cd)).toMatchObject({ durationUs: 5 * S, counter: { from: 10, to: 0 } })
    expect(item<TextItem>(q, cd).style.color).toBe('#ff00ff')
  })
  it('move entre faixas, duplicate e deleteRanges preservam texto/forma', () => {
    const { p, cd, sh } = scene()
    const target = ops.addTrack(p, 'video', undefined, 'Outra')
    const moved = ops.moveItems(target.project, [sh], 20 * S, { toTrackId: target.trackId })
    expect(trackOf(moved, sh).id).toBe(target.trackId)
    expect(item<ShapeItem>(moved, sh)).toMatchObject({ startUs: 20 * S, shape: 'rect', stroke: '#ffd400', cornerRadius: 0.15, box: { w: 0.3, h: 0.15 } })

    const dup = ops.duplicateItems(p, [cd, sh])
    const [c2, s2] = dup.itemIds.map((id) => item(dup.project, id))
    expect(c2).toMatchObject({ type: 'text', startUs: 10 * S, counter: { from: 10, to: 0 } })
    expect(s2).toMatchObject({ type: 'shape', shape: 'rect', fill: 'none' })
    expect(validateProject(dup.project)).toEqual([])

    const del = ops.deleteRanges(p, [{ fromUs: 2 * S, toUs: 3 * S }, { fromUs: 6 * S, toUs: 8 * S }])
    const pieces = trackOf(del, cd).items as TextItem[]
    expect(pieces.map((i) => [i.startUs, i.durationUs])).toEqual([[0, 2 * S], [2 * S, 3 * S], [5 * S, 2 * S]])
    expect(pieces.map((i) => i.counter)).toEqual([{ from: 10, to: 8 }, { from: 7, to: 4 }, { from: 2, to: 0 }])
    expect(pieces.every((i) => i.style.color === '#ff00ff')).toBe(true)
    expect(validateProject(del)).toEqual([])
  })
  it('duplicar legenda que não cabe na faixa de legendas cria a faixa nova abaixo dela', () => {
    const { p } = withClip()
    const a = ops.addCaption(p, 0, 'A')
    const dup = ops.duplicateItems(a.project, [a.itemId], S)
    const q = dup.project
    const capIdx = idx(q, a.project.tracks.find(ops.isCaptionsTrack)!.id)
    expect(idx(q, trackOf(q, dup.itemIds[0]).id)).toBe(capIdx - 1)
    expect(q.tracks.filter((t) => t.kind === 'video').at(-1)!.role).toBe('captions')
  })
})

describe('compatibilidade com a v1.3 (invariante 1)', () => {
  /** Todos os modelos de texto (com contagem, sombra, maxWidth…), todas as formas e a faixa de legendas. */
  function full(): Project {
    let { p } = withClip()
    let t = 0
    for (const id of Object.keys(TEXT_PRESETS) as TextPresetId[]) p = ops.addText(p, id, (t += 4) * S).project
    for (const id of Object.keys(SHAPE_PRESETS) as ShapePresetId[]) p = ops.addShape(p, id, (t += 4) * S).project
    const tx = ops.addText(p, 'title', 0)
    p = ops.updateItem<TextItem>(tx.project, tx.itemId, (it) => {
      it.style = patchTextStyle(it.style, { shadowStyle: { color: '#ff000080', blur: 0.2, dx: -0.05, dy: 0.1 }, backgroundRadius: 0.3, padding: 0.4, background: '#11223344' })
    })
    const sh = ops.addShape(p, 'rect', 0)
    p = ops.updateItem<ShapeItem>(sh.project, sh.itemId, (it) => { it.cornerRadius = 0.5; it.box = { w: 0.5, h: 0.25 }; it.spotlight = { dim: 0.3 } })
    p = ops.addCaption(p, 0, 'Primeira').project
    p = ops.addCaption(p, 3 * S, 'Segunda').project
    p = ops.setCaptionStyle(p, { shadow: true, maxWidth: 0.6 })
    return p
  }
  it('v1.3 lê o disco e o parse novo devolve o mesmo projeto', () => {
    const p = full()
    expect(validateProject(p)).toEqual([])
    const d = disk(p) as { tracks: Record<string, unknown>[] }
    const v13 = parseProjectV13(d)
    expect(v13.success).toBe(true)
    const capDisk = d.tracks.find((t) => t.name === 'Legendas')!
    expect(capDisk.role).toBeUndefined()
    expect(capDisk.captionsV15).toBe(true)
    expect(parseProject(d)).toEqual(p)
    // não muda o projeto recebido
    expect(p.tracks.find(ops.isCaptionsTrack)).toBeDefined()
  })
  it('v1.3 regrava: continua válido; perde só os campos da v1.5 (legendas viram faixa de vídeo comum com textos)', () => {
    const p = full()
    const v = parseProjectV13(disk(p))
    expect(v.success).toBe(true)
    const back = parseProject(JSON.parse(JSON.stringify(v.data)))
    expect(validateProject(back)).toEqual([])
    const capBack = back.tracks.find((t) => t.name === 'Legendas')!
    expect(capBack.role).toBeUndefined()
    expect(capBack.items.map((i) => (i as TextItem).text)).toEqual(['Primeira', 'Segunda'])
    const texts = back.tracks.flatMap((t) => t.items).filter((i): i is TextItem => i.type === 'text')
    expect(texts.some((i) => i.counter || i.style.maxWidth !== undefined || i.style.italic !== undefined)).toBe(false)
    // shadow: true sobreviveu → a sombra padrão volta (shadow === !!shadowStyle)
    expect(texts.every((i) => !!i.style.shadow === !!i.style.shadowStyle)).toBe(true)
    expect(texts.filter((i) => i.style.shadow).every((i) => JSON.stringify(i.style.shadowStyle) === JSON.stringify(DEFAULT_TEXT_SHADOW))).toBe(true)
    const shapes = back.tracks.flatMap((t) => t.items).filter((i): i is ShapeItem => i.type === 'shape')
    expect(shapes.length).toBe(Object.keys(SHAPE_PRESETS).length + 1)
    expect(shapes.some((i) => i.box || i.cornerRadius !== undefined || i.spotlight)).toBe(false)
  })
  it('projeto antigo com shadow: true ganha a sombra padrão; shadowStyle sem shadow é corrigido', () => {
    const { p } = withClip()
    const t = ops.addText(p, 'caption', 0)
    const d = disk(t.project) as { tracks: { items: { type: string; style: Record<string, unknown> }[] }[] }
    const st = d.tracks.flatMap((x) => x.items).find((i) => i.type === 'text')!.style
    st.shadow = true
    expect((parseProject(d).tracks.flatMap((x) => x.items).find((i) => i.type === 'text') as TextItem).style.shadowStyle).toEqual(DEFAULT_TEXT_SHADOW)
    delete st.shadow
    st.shadowStyle = { color: '#000000', blur: 0, dx: 0, dy: 0 }
    expect((parseProject(d).tracks.flatMap((x) => x.items).find((i) => i.type === 'text') as TextItem).style.shadow).toBe(true)
  })
  it('migrateProject não confunde a faixa de legendas vazia chamada "Efeitos" com uma faixa de efeitos antiga', () => {
    const { p } = withClip()
    const cap = ops.ensureCaptionsTrack(p)
    const q = ops.updateTrack(cap.project, cap.trackId, { name: 'Efeitos' })
    const back = parseProject(disk(q))
    expect(back.tracks.find((t) => t.id === cap.trackId)!.role).toBe('captions')
    expect(back).toEqual(q)
    expect(parseProjectV13(disk(q)).success).toBe(true)
  })
  it('role captions direto no disco é aceito pelo parse novo e recusado pela v1.3 (por isso o disco usa captionsV15)', () => {
    const { p } = withClip()
    const q = ops.ensureCaptionsTrack(p).project
    const raw = JSON.parse(JSON.stringify(q))
    expect(parseProject(raw)).toEqual(q)
    expect(parseProjectV13(raw).success).toBe(false)
  })
  it('videoNames: sanity da ordem (mídia, texto, legendas)', () => {
    const p = full()
    const names = videoNames(p)
    expect(names[0]).toBe('Vídeo 1')
    expect(names.at(-1)).toBe('Legendas')
  })
})
