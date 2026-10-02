import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, EffectItem, Item, Project } from './project'
import * as ops from './ops'
import { validateProject } from './schema'
import { itemEndUs as end } from './time'
import { effectBound, resolveFrame } from './resolve'
import { privacyWarnings } from './privacy'

// Re-revisão 2 da F2: efeito "só a faixa abaixo" (escopo track) realocado continua escondendo; faixas "Efeitos" só
// recebem efeitos; sobrescrever não recorta seguidores; vínculos órfãos; "Desvincular efeitos".
const S = 1_000_000
const vid = (id = 'a1', dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
function base(): { p: Project; v: string; a: string } {
  const r = ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid()), 'a1', 0)
  return { p: r.project, v: r.itemIds[0], a: r.itemIds[1] }
}
const it_ = (p: Project, id: string): Item => ops.findItem(p, id)!.item
const fx = (p: Project, id: string): EffectItem => it_(p, id) as EffectItem
const trackOf = (p: Project, id: string): string => ops.findItem(p, id)!.track.name
const names = (p: Project): string[] => p.tracks.filter((t) => t.kind === 'video').map((t) => t.name)
const noTarget = (p: Project, from = 0, to = 20 * S) => privacyWarnings(p, from, to).filter((w) => w.kind === 'noTarget')

/** O efeito age (resolveFrame + a mesma condição de ligação do compositor, effectBound) em cada instante. */
function renders(p: Project, fxId: string, times: number[]): boolean[] {
  return times.map((t) => {
    const layers = resolveFrame(p, t)
    const i = layers.findIndex((l) => l.kind === 'effect' && l.itemId === fxId)
    return i >= 0 && effectBound(layers, i)
  })
}

/** Tela [0,10) na Vídeo 1, webcam [0,4) na Vídeo 2; blur da webcam só na faixa abaixo; blur do texto [6,10) na "Efeitos". */
function pipTrack(): { p: Project; cam: string; camFx: string; textFx: string } {
  const p0 = ops.addAsset(ops.addAsset(createEmptyProject('t'), vid('tela')), vid('cam', 4 * S))
  const sr = ops.addMediaFromAsset(p0, 'tela', 0)
  const cr = ops.addMediaFromAsset(sr.project, 'cam', 0)
  const a = ops.addEffect(cr.project, 'blurFace', 0)
  const b = ops.addEffect(a.project, 'blurText', 6 * S, { region: { x: 0.3, y: 0.3 } })
  const p = ops.updateItem<EffectItem>(b.project, a.itemId, (d) => { d.scope = 'track' })
  expect(renders(p, a.itemId, [S, 3 * S])).toEqual([true, true])
  expect(noTarget(p, 0, 10 * S)).toEqual([])
  return { p, cam: cr.itemIds[0], camFx: a.itemId, textFx: b.itemId }
}
const trackIdx = (p: Project, id: string): number => p.tracks.findIndex((t) => t.items.some((i) => i.id === id))

describe('efeito "só a faixa abaixo" realocado continua escondendo', () => {
  it('mover a webcam (sobrescrever): vai para uma faixa de efeitos logo acima da webcam e segue escondendo', () => {
    const { p, cam, camFx, textFx } = pipTrack()
    const q = ops.moveItems(p, [cam], 5 * S, { mode: 'overwrite' })
    expect(fx(q, camFx).scope).toBe('track')
    expect(trackIdx(q, camFx)).toBe(trackIdx(q, cam) + 1)
    expect(names(q)).toEqual(['Vídeo 1', 'Vídeo 2', 'Efeitos 2', 'Efeitos'])
    expect(renders(q, camFx, [5.5 * S, 7 * S, 8.9 * S])).toEqual([true, true, true])
    expect(renders(q, textFx, [7 * S])).toEqual([true])
    expect(ops.scopeDowngrades(p, q)).toBe(0)
    expect(noTarget(q, 0, 10 * S)).toEqual([])
    expect(validateProject(q)).toEqual([])
  })
  it('velocidade 0,25 na webcam: o blur esticado realoca acima da webcam e cobre os 16 s', () => {
    const { p, cam, camFx } = pipTrack()
    const q = ops.setSpeed(p, cam, 0.25)
    expect([fx(q, camFx).startUs, end(fx(q, camFx))]).toEqual([0, 16 * S])
    expect(renders(q, camFx, [S, 7 * S, 15.9 * S])).toEqual([true, true, true])
    expect(validateProject(q)).toEqual([])
  })
  it('aparar estendendo a webcam contra o efeito de outro clipe: realoca acima da webcam; o outro fica inteiro', () => {
    const { p, cam, camFx } = pipTrack()
    const short = ops.trimItem(p, cam, 'end', 2 * S)
    const other = ops.addEffect(short, 'solid', 3 * S, { durationUs: 2 * S }) // seguidor da tela em [3,5)
    expect(trackOf(other.project, other.itemId)).toBe('Efeitos')
    const q = ops.trimItem(other.project, cam, 'end', 4 * S)
    expect([fx(q, other.itemId).startUs, fx(q, other.itemId).durationUs]).toEqual([3 * S, 2 * S])
    expect(end(fx(q, camFx))).toBe(4 * S)
    expect(renders(q, camFx, [S, 3.5 * S])).toEqual([true, true])
  })
  it('ripple: o blur do 2º clipe da webcam, empurrado contra o do texto, realoca e segue escondendo', () => {
    const { p, cam } = pipTrack()
    const short = ops.trimItem(p, cam, 'end', 2 * S)
    const c2 = ops.addMediaFromAsset(short, 'cam', 2 * S, { videoTrackId: ops.findItem(short, cam)!.track.id })
    const e2 = ops.addEffect(c2.project, 'blurFace', 2 * S) // [2,6) vinculado ao 2º clipe
    const p2 = ops.updateItem<EffectItem>(e2.project, e2.itemId, (d) => { d.scope = 'track' })
    expect(trackOf(p2, e2.itemId)).toBe('Efeitos')
    const q = ops.trimItem(p2, cam, 'end', 3 * S, { ripple: true }) // o 2º clipe vai para [3,7) e bate no texto [6,10)
    expect(it_(q, c2.itemIds[0]).startUs).toBe(3 * S)
    expect([fx(q, e2.itemId).startUs, fx(q, e2.itemId).durationUs, fx(q, e2.itemId).scope]).toEqual([3 * S, 4 * S, 'track'])
    expect(renders(q, e2.itemId, [3.5 * S, 6.5 * S])).toEqual([true, true])
  })
  it('duplicar a webcam: a cópia do blur vai para logo acima da cópia da webcam e esconde', () => {
    const { p, cam } = pipTrack()
    const r = ops.duplicateItems(p, [cam])
    const copy = r.itemIds.map((id) => it_(r.project, id)).find((i) => i.type === 'effect') as EffectItem
    expect([copy.startUs, copy.scope, r.downgraded]).toEqual([4 * S, 'track', 0])
    expect(renders(r.project, copy.id, [5 * S, 7.5 * S])).toEqual([true, true])
  })
  it('sem faixa de efeitos possível logo acima da webcam (há mídia mais alta): passa a valer para tudo abaixo', () => {
    const { p, cam, camFx } = pipTrack()
    const top = ops.addTrack(p, 'video', p.tracks.findIndex((t) => t.name === 'Efeitos') + 1, 'Logo')
    const withLogo = ops.addMediaFromAsset(top.project, 'cam', 20 * S, { videoTrackId: top.trackId }).project
    const q = ops.moveItems(withLogo, [cam], 5 * S, { mode: 'overwrite' })
    expect(fx(q, camFx).scope).toBe('below')
    expect(ops.scopeDowngrades(withLogo, q)).toBe(1)
    expect(renders(q, camFx, [5.5 * S, 7 * S])).toEqual([true, true])
    expect(ops.duplicateItems(withLogo, [cam]).downgraded).toBe(1)
  })
  it('privacyWarnings noTarget: efeito "só a faixa abaixo" sem mídia embaixo em parte do trecho', () => {
    const { p, camFx } = pipTrack()
    const longer = ops.updateItem<EffectItem>(p, camFx, (d) => { d.durationUs = 5 * S }) // a webcam acaba em 4 s
    expect(noTarget(longer)).toEqual([{ itemId: camFx, kind: 'noTarget', message: "Efeito 'só a faixa abaixo' sem mídia embaixo neste trecho", tUs: 4 * S }])
    expect(noTarget(longer, 0, 3 * S)).toEqual([])
    // feito à mão: logo acima de outra faixa "Efeitos" (nenhuma camada de mídia embaixo)
    const fxTrack = ops.addTrack(p, 'video', p.tracks.findIndex((t) => t.name === 'Efeitos') + 1, 'Efeitos 9')
    const broken = ops.addEffect(fxTrack.project, 'blur', 6 * S, { trackId: fxTrack.trackId, durationUs: 2 * S })
    expect(trackOf(broken.project, broken.itemId)).toBe('Efeitos 9')
    const b2 = ops.updateItem<EffectItem>(broken.project, broken.itemId, (d) => { d.scope = 'track' })
    expect(noTarget(b2).map((w) => [w.itemId, w.tUs])).toEqual([[broken.itemId, 6 * S]])
    expect(renders(b2, broken.itemId, [7 * S])).toEqual([false]) // é o caso que o aviso pega
  })
})

describe('faixas "Efeitos" só com efeitos; sobrescrever não recorta seguidores; órfãos; Desvincular efeitos', () => {
  it('mídia não entra numa faixa "Efeitos" (inserir ou mover) → EditError invalid', () => {
    const b = base()
    const e = ops.addEffect(b.p, 'blur', 0)
    const fxTrack = ops.findItem(e.project, e.itemId)!.track.id
    expect(() => ops.addMediaFromAsset(e.project, 'a1', 20 * S, { videoTrackId: fxTrack })).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => ops.moveItems(e.project, [b.v], 20 * S, { toTrackId: fxTrack, includeLinked: false })).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
  it('inserir um efeito por cima (sobrescrever) numa faixa "Efeitos" não recorta o seguidor de outro clipe', () => {
    const b = base()
    const r = ops.addEffect(b.p, 'blurText', 2 * S) // seguidor [2,10)
    const fxTrack = ops.findItem(r.project, r.itemId)!.track.id
    const loose: Item = { ...ops.addEffect(createEmptyProject('x'), 'solid', 0).project.tracks[1].items[0], startUs: 4 * S, durationUs: 2 * S }
    const q = ops.insertItems(r.project, fxTrack, [loose], 'overwrite')
    expect([fx(q, r.itemId).startUs, fx(q, r.itemId).durationUs]).toEqual([2 * S, 8 * S])
    expect(ops.findItem(q, r.itemId)!.track.id).not.toBe(fxTrack)
    expect(ops.findItem(q, loose.id)!.track.id).toBe(fxTrack)
    expect(validateProject(q)).toEqual([])
  })
  it('sobrescrever que apaga um clipe inteiro tira o vínculo dos efeitos órfãos', () => {
    const b = base()
    const x = ops.addMediaFromAsset(ops.addAsset(b.p, vid('cam', 4 * S)), 'cam', 12 * S)
    const solo = ops.deleteItems(ops.unlinkItems(x.project, x.itemIds), [x.itemIds[1]])
    // dois efeitos no clipe (um só perderia o vínculo de qualquer jeito: finalize tira o linkId sem par)
    const e = ops.addEffect(solo, 'blur', 13 * S)
    const e2 = ops.addEffect(e.project, 'solid', 13 * S)
    expect(fx(e2.project, e.itemId).linkId).toBeDefined()
    expect([fx(e2.project, e.itemId).linkId, fx(e2.project, e2.itemId).linkId]).toEqual([it_(e2.project, x.itemIds[0]).linkId, it_(e2.project, x.itemIds[0]).linkId])
    const q = ops.moveItems(e2.project, [b.v], 10 * S, { mode: 'overwrite' }) // [10,20) cobre o clipe [12,16)
    expect(ops.findItem(q, x.itemIds[0])).toBeNull()
    expect([fx(q, e.itemId).linkId, fx(q, e2.itemId).linkId]).toEqual([undefined, undefined])
  })
  it('"Desvincular" num clipe vinculado só a efeitos solta os efeitos (nunca um clique sem efeito)', () => {
    const b = base()
    const solo = ops.deleteItems(ops.unlinkItems(b.p, [b.v, b.a]), [b.a])
    const e = ops.addEffect(solo, 'blur', 0)
    const q = ops.unlinkMedia(e.project, b.v)
    expect([it_(q, b.v).linkId, fx(q, e.itemId).linkId]).toEqual([undefined, undefined])
  })
})
