import { describe, expect, it } from 'vitest'
import { createEmptyProject, defaultVisual } from './factory'
import { MIN_ITEM_US, type Asset, type EffectItem, type Item, type MediaItem, type Project, type ShapeItem } from './project'
import * as ops from './ops'
import { validateProject } from './schema'
import { itemEndUs as end } from './time'
import { resolveFrame } from './resolve'
import { privacyWarnings } from './privacy'

// F3 Task 2: congelar quadro (freezeFrameAt) e reverso (setReverse), com vínculos e efeitos seguindo o clipe.
const S = 1_000_000
const vid = (id = 'a1', dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
/** Clipe v [0,10 s) na "Vídeo 1" + áudio a vinculado. */
function base(): { p: Project; v: string; a: string } {
  const p = ops.addAsset(createEmptyProject('t'), vid())
  const r = ops.addMediaFromAsset(p, 'a1', 0)
  return { p: r.project, v: r.itemIds[0], a: r.itemIds[1] }
}
const it_ = (p: Project, id: string): Item => ops.findItem(p, id)!.item
const media = (p: Project, ti: number): MediaItem[] => p.tracks[ti].items as MediaItem[]
const fx = (p: Project, id: string): EffectItem => it_(p, id) as EffectItem
/** base + efeito vinculado [2,10) com region.x: 0,2 em 2 s → 0,9 em 10 s (linear). */
function linked(): { p: Project; v: string; a: string; f: string } {
  const b = base()
  const r = ops.addEffect(b.p, 'blur', 2 * S)
  let p = ops.setAnimValue(r.project, r.itemId, 'region.x', 2 * S, 0.2)
  p = ops.toggleKeyframe(p, r.itemId, 'region.x', 2 * S)
  p = ops.toggleKeyframe(p, r.itemId, 'region.x', 10 * S)
  p = ops.setAnimValue(p, r.itemId, 'region.x', 10 * S, 0.9)
  return { p, v: b.v, a: b.a, f: r.itemId }
}
const fxLayerX = (p: Project, tUs: number): number | undefined => {
  const l = resolveFrame(p, tUs).find((x) => x.kind === 'effect')
  return l?.kind === 'effect' ? l.region.x : undefined
}

describe('freezeFrameAt', () => {
  it('no meio: divide, insere o quadro congelado do playhead e empurra o resto (todas as faixas)', () => {
    const { p, v, a } = base()
    const q = ops.freezeFrameAt(p, v, 4 * S, 2 * S)
    const vs = media(q, 0)
    expect(vs.map((i) => [i.startUs, i.durationUs, i.inUs])).toEqual([[0, 4 * S, 0], [4 * S, 2 * S, 4 * S], [6 * S, 6 * S, 4 * S]])
    expect(vs[0].id).toBe(v)
    expect(vs[1].freeze).toEqual({ atUs: 4 * S })
    expect([vs[1].speed, vs[1].reverse, vs[1].audio.enabled]).toEqual([1, false, false])
    expect(vs[0].freeze).toBeUndefined()
    expect(vs[2].freeze).toBeUndefined()
    // áudio vinculado: dividido e empurrado (silêncio durante o congelado)
    expect(media(q, 1).map((i) => [i.startUs, i.durationUs, i.inUs])).toEqual([[0, 4 * S, 0], [6 * S, 6 * S, 4 * S]])
    expect(media(q, 1)[0].id).toBe(a)
    // o pedaço congelado fica no grupo da esquerda; a direita ganha um vínculo próprio
    expect(vs[1].linkId).toBe(vs[0].linkId)
    expect(vs[2].linkId).toBe(media(q, 1)[1].linkId)
    expect(vs[2].linkId).not.toBe(vs[0].linkId)
    // resolveFrame mostra o quadro 4 s durante todo o congelado
    for (const t of [4 * S, 5 * S, 6 * S - 1]) {
      const l = resolveFrame(q, t).find((x) => x.kind === 'media')
      expect(l?.kind === 'media' && l.srcUs).toBe(4 * S)
    }
    expect(validateProject(q)).toEqual([])
  })
  it('borda: perto do início congela o 1º quadro antes do clipe; no fim congela o último depois dele', () => {
    const { p, v } = base()
    const s = ops.freezeFrameAt(p, v, 10_000, 2 * S)
    expect(media(s, 0).map((i) => [i.startUs, i.durationUs, i.freeze?.atUs])).toEqual([[0, 2 * S, 0], [2 * S, 10 * S, undefined]])
    expect(media(s, 0)[1].id).toBe(v)
    const e = ops.freezeFrameAt(p, v, 10 * S - 10_000, S)
    expect(media(e, 0).map((i) => [i.startUs, i.durationUs, i.freeze?.atUs])).toEqual([[0, 10 * S, undefined], [10 * S, S, 10 * S - 1]])
    expect(validateProject(s)).toEqual([])
    expect(validateProject(e)).toEqual([])
  })
  it('respeita velocidade e reverso no quadro congelado; duração mínima', () => {
    const { p, v } = base()
    const fast = ops.setSpeed(p, v, 2) // [0,5 s) lendo [0,10 s)
    expect(media(ops.freezeFrameAt(fast, v, S, S), 0)[1].freeze).toEqual({ atUs: 2 * S })
    const rev = ops.setReverse(p, [v], true)
    expect(media(ops.freezeFrameAt(rev, v, 3 * S, S), 0)[1].freeze).toEqual({ atUs: 7 * S - 33_333 })
    expect(media(ops.freezeFrameAt(p, v, 4 * S, 1), 0)[1].durationUs).toBe(MIN_ITEM_US)
  })
  it('efeitos seguem: o efeito que cruza o ponto cobre o congelado com a região parada; os seguintes andam', () => {
    const { p, v, f } = linked()
    const before = fxLayerX(p, 6 * S)!
    const q = ops.freezeFrameAt(p, v, 6 * S, 2 * S)
    // dividido em at+D (revisão 1): [2,8) com o trecho parado + [8,12) do grupo da direita — cobre o mesmo [2,12)
    expect([fx(q, f).startUs, end(fx(q, f))]).toEqual([2 * S, 8 * S])
    expect(q.tracks[1].items.map((i) => [i.startUs, end(i)])).toEqual([[2 * S, 8 * S], [8 * S, 12 * S]])
    // região parada no valor do instante congelado, depois continua de onde estava
    expect(fxLayerX(q, 6 * S)).toBeCloseTo(before, 6)
    expect(fxLayerX(q, 7.5 * S)).toBeCloseTo(before, 6)
    expect(fxLayerX(q, 12 * S - 1)).toBeCloseTo(0.9, 3)
    expect(fxLayerX(q, 9 * S)).toBeCloseTo(fxLayerX(p, 7 * S)!, 6)
    // o efeito continua vinculado (ao pedaço da esquerda e ao congelado)
    expect(fx(q, f).linkId).toBe(it_(q, v).linkId)
    // efeito que começa depois do ponto anda com o resto
    const e2 = ops.addEffect(base().p, 'blur', 7 * S, { durationUs: S })
    const v2 = e2.project.tracks[0].items[0].id
    const q2 = ops.freezeFrameAt(e2.project, v2, 4 * S, 2 * S)
    expect([fx(q2, e2.itemId).startUs, fx(q2, e2.itemId).durationUs]).toEqual([9 * S, S])
    expect(validateProject(q)).toEqual([])
    expect(validateProject(q2)).toEqual([])
  })
  it('revisão 1: o efeito do grupo é dividido em at+D — a parte da direita vai com o clipe da direita (reverter a direita não vaza)', () => {
    const { p, v, f } = linked()
    const q = ops.freezeFrameAt(p, v, 6 * S, 2 * S)
    // esquerda [2,8) com o trecho parado, no grupo da esquerda; direita [8,12) no grupo do pedaço da direita
    const right = media(q, 0).find((i) => i.startUs === 8 * S)!
    const fxs = q.tracks[1].items as EffectItem[]
    expect(fxs.map((i) => [i.startUs, end(i)])).toEqual([[2 * S, 8 * S], [8 * S, 12 * S]])
    expect(fxs[0].id).toBe(f)
    expect(fxs[0].linkId).toBe(it_(q, v).linkId)
    expect(fxs[1].linkId).toBe(right.linkId)
    expect(right.linkId).not.toBe(it_(q, v).linkId)
    expect(fxLayerX(q, 7.5 * S)).toBeCloseTo(fxLayerX(p, 6 * S)!, 6)
    // reverter o pedaço da direita: o efeito dele espelha junto (o conteúdo em t aparece em 20 − t)
    const r = ops.setReverse(q, [right.id], true)
    for (const t of [8.5 * S, 10 * S, 11.5 * S]) expect(fxLayerX(r, 20 * S - t)).toBeCloseTo(fxLayerX(q, t)!, 6)
    // a esquerda e o congelado não mudam
    expect(fxLayerX(r, 7 * S)).toBeCloseTo(fxLayerX(q, 7 * S)!, 6)
    expect(ops.unlinkedEffectsOver(r, right.id)).toEqual([])
    expect(validateProject(r)).toEqual([])
  })
  it('revisão 7/8: o trecho depois do parado segue com o ease do trecho; imagem/sobreposição sem vínculo é esticada inteira', () => {
    const b = base()
    let p = ops.updateItem<MediaItem>(b.p, b.v, (d) => {
      d.visual!.transform.x = { value: 0.5, keys: [{ tUs: 0, value: 0, ease: 'in' }, { tUs: 10 * S, value: 1, ease: 'linear' }] }
    })
    const img: Asset = { id: 'img', name: 'logo.png', kind: 'image', source: { type: 'file', path: 'C:/logo.png', size: 1, mtimeMs: 1 }, durationUs: null, status: 'ready' }
    p = ops.addAsset(p, img)
    const added = ops.addMediaFromAsset(p, 'img', 2 * S) // [2,7) numa faixa de vídeo nova
    const q = ops.freezeFrameAt(added.project, b.v, 4 * S, 2 * S)
    const logo = it_(q, added.itemIds[0])
    expect([logo.startUs, end(logo)]).toEqual([2 * S, 9 * S])
    // efeito com keys: o resto do trecho 'in' depois do parado continua 'in'
    const e = ops.addEffect(b.p, 'blur', 0, { durationUs: 10 * S })
    let pe = ops.toggleKeyframe(e.project, e.itemId, 'region.x', 0)
    pe = ops.toggleKeyframe(pe, e.itemId, 'region.x', 10 * S)
    pe = ops.setAnimValue(pe, e.itemId, 'region.x', 10 * S, 0.9)
    pe = ops.updateItem<EffectItem>(pe, e.itemId, (d) => { d.region.x.keys![0].ease = 'in' })
    const fq = ops.freezeFrameAt(pe, pe.tracks[0].items[0].id, 4 * S, 2 * S)
    const keys = fx(fq, e.itemId).region.x.keys!
    expect(keys.map((k) => [k.tUs, k.ease])).toEqual([[0, 'in'], [4 * S, 'linear'], [6 * S, 'in']])
  })
  it('revisão 2: forma vinculada com fades dividida no corte como o splitInPlace — nenhum pedaço faz fade no corte', () => {
    const b = base()
    const shape: ShapeItem = { id: 'sh', type: 'shape', shape: 'rect', fill: '#ff0000', stroke: '#000000', strokeWidth: 0, startUs: 2 * S, durationUs: 6 * S, visual: { ...defaultVisual(), fadeInUs: 500_000, fadeOutUs: 700_000 } }
    let p = ops.addTrack(b.p, 'video').project
    const tId = p.tracks.find((t) => t.kind === 'video' && t.items.length === 0)!.id
    p = ops.insertItems(p, tId, [shape], 'overwrite')
    p = ops.linkItems(p, [b.v, 'sh'])
    const q = ops.freezeFrameAt(p, b.v, 4 * S, 2 * S)
    const pieces = [...(q.tracks.find((t) => t.id === tId)!.items as ShapeItem[])].sort((x, y) => x.startUs - y.startUs)
    expect(pieces.map((i) => [i.startUs, end(i)])).toEqual([[2 * S, 6 * S], [6 * S, 10 * S]])
    expect([pieces[0].visual.fadeInUs, pieces[0].visual.fadeOutUs]).toEqual([500_000, 0])
    expect([pieces[1].visual.fadeInUs, pieces[1].visual.fadeOutUs]).toEqual([0, 700_000])
    expect(pieces[1].linkId).toBe(media(q, 0).find((i) => i.startUs === 6 * S)!.linkId)
    expect(validateProject(q)).toEqual([])
  })
  it('revisão 2 (a): o grupo do clipe congelado acha a direita na faixa do próprio clipe (áudio vinculado terminando junto ao ponto)', () => {
    const { p, v, a, f } = linked()
    // áudio do grupo termina 10 ms depois do ponto: não é dividido (pedaço < MIN_ITEM_US)
    const short = ops.trimItem(p, a, 'end', 6 * S + 10_000, { includeLinked: false })
    const q = ops.freezeFrameAt(short, v, 6 * S, 2 * S)
    const right = media(q, 0).find((i) => i.startUs === 8 * S)!
    const fxs = q.tracks[1].items as EffectItem[]
    expect(fxs.map((i) => [i.startUs, end(i)])).toEqual([[2 * S, 8 * S], [8 * S, 12 * S]])
    expect(fxs.find((i) => i.id === f)!.linkId).toBe(it_(q, v).linkId)
    expect(fxs.find((i) => i.id !== f)!.linkId).toBe(right.linkId)
    expect(validateProject(q)).toEqual([])
  })
  it('recusa áudio, imagem, faixa bloqueada e instante fora do item', () => {
    const { p, v, a } = base()
    expect(() => ops.freezeFrameAt(p, a, 4 * S, S)).toThrow(ops.EditError)
    expect(() => ops.freezeFrameAt(p, v, 11 * S, S)).toThrow(ops.EditError)
    const locked = ops.updateTrack(p, p.tracks[0].id, { locked: true })
    expect(() => ops.freezeFrameAt(locked, v, 4 * S, S)).toThrow(/bloquead/)
  })
})

describe('setReverse', () => {
  it('liga o reverso no clipe e nos vinculados, mantém duração e fonte, espelha keyframes no tempo', () => {
    const { p, v, a } = base()
    const k = ops.updateItem<MediaItem>(p, v, (d) => {
      d.visual!.transform.x = { value: 0.5, keys: [{ tUs: S, value: 0.1, ease: 'in' }, { tUs: 4 * S, value: 0.7, ease: 'linear' }] }
    })
    const q = ops.setReverse(k, [v], true)
    const rv = it_(q, v) as MediaItem
    const ra = it_(q, a) as MediaItem
    expect([rv.reverse, ra.reverse]).toEqual([true, true])
    expect([rv.startUs, rv.durationUs, rv.inUs, ra.durationUs]).toEqual([0, 10 * S, 0, 10 * S])
    // espelhado: 4 s → 6 s (0,7), 1 s → 9 s (0,1); o ease do trecho é espelhado ('in' → 'out')
    expect(rv.visual!.transform.x.keys).toEqual([{ tUs: 6 * S, value: 0.7, ease: 'out' }, { tUs: 9 * S, value: 0.1, ease: 'linear' }])
    // a curva espelhada: valor em t = valor original em dur − t
    const cx = (x: Project, t: number): number => (resolveFrame(x, t).find((l) => l.kind === 'media') as { rect: { cx: number } }).rect.cx
    for (const t of [6.5 * S, 7.3 * S, 8.8 * S]) expect(cx(q, t)).toBeCloseTo(cx(k, 10 * S - t), 6)
    // desligar volta ao original
    const back = ops.setReverse(q, [v], false)
    expect((it_(back, v) as MediaItem).visual!.transform.x).toEqual((it_(k, v) as MediaItem).visual!.transform.x)
    expect(validateProject(q)).toEqual([])
  })
  it('efeitos vinculados espelham posição e keyframes dentro do clipe; repetir não muda nada', () => {
    const { p, v, f } = linked()
    const q = ops.setReverse(p, [v], true)
    expect([fx(q, f).startUs, end(fx(q, f))]).toEqual([0, 8 * S])
    // o conteúdo que estava em t aparece em 10 − t: a região acompanha
    for (const t of [3 * S, 5.5 * S, 9 * S]) expect(fxLayerX(q, 10 * S - t)).toBeCloseTo(fxLayerX(p, t)!, 6)
    expect(ops.setReverse(q, [v], true)).toBe(q)
    // efeito curto no meio: [2,4) → [6,8)
    const e = ops.addEffect(base().p, 'blur', 2 * S, { durationUs: 2 * S })
    const v2 = e.project.tracks[0].items[0].id
    const r = ops.setReverse(e.project, [v2], true)
    expect([fx(r, e.itemId).startUs, fx(r, e.itemId).durationUs]).toEqual([6 * S, 2 * S])
    expect(validateProject(r)).toEqual([])
  })
  it('revisão 10: efeito sem vínculo sobre o trecho invertido → unlinkedEffectsOver e aviso unlinkedOverEdited', () => {
    const b = base()
    const fxp = ops.addEffect(b.p, 'blur', 2 * S, { durationUs: 2 * S }).project
    const e = fxp.tracks[1].items[0]
    const free = ops.unlinkItems(fxp, [e.id])
    expect(privacyWarnings(free, 0, 10 * S).filter((w) => w.kind === 'unlinkedOverEdited')).toEqual([])
    const r = ops.setReverse(free, [b.v], true)
    expect(ops.unlinkedEffectsOver(r, b.v)).toEqual([e.id])
    const w = privacyWarnings(r, 0, 10 * S).filter((x) => x.kind === 'unlinkedOverEdited')
    expect(w).toEqual([{ itemId: e.id, kind: 'unlinkedOverEdited', message: 'Efeito não vinculado sobre um trecho invertido — confira se ainda cobre o conteúdo', tUs: 2 * S }])
    // vinculado ao clipe: segue o conteúdo, sem aviso
    const linkedRev = ops.setReverse(fxp, [b.v], true)
    expect(privacyWarnings(linkedRev, 0, 10 * S).filter((x) => x.kind === 'unlinkedOverEdited')).toEqual([])
  })
  it('a partir do efeito não reverte nada; faixa bloqueada recusa; congelado é ignorado', () => {
    const { p, v, f } = linked()
    expect(ops.setReverse(p, [f], true)).toBe(p)
    const locked = ops.updateTrack(p, p.tracks[0].id, { locked: true })
    expect(() => ops.setReverse(locked, [v], true)).toThrow(/bloquead/)
    const b = base()
    const fr = ops.freezeFrameAt(b.p, b.v, 4 * S, S)
    const frozen = media(fr, 0)[1]
    expect((it_(ops.setReverse(fr, [frozen.id], true), frozen.id) as MediaItem).reverse).toBe(false)
  })
})
