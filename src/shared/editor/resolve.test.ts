import { describe, expect, it } from 'vitest'
import { createEmptyProject, defaultVisual } from './factory'
import type { Asset, EffectItem, MediaItem, Project } from './project'
import * as ops from './ops'
import { activeItemsAt, resolveFrame, sourceTimeUs } from './resolve'
import type { MediaLayer } from './resolve'

const S = 1_000_000
const vid = (id = 'a1', dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
const img = (): Asset => ({ id: 'im', name: 'im', kind: 'image', source: { type: 'file', path: 'C:/i.png', size: 1, mtimeMs: 1 }, durationUs: null, video: { width: 100, height: 100, fps: 0, codec: 'png', rotation: 0, decodable: true, gopUs: 0 }, status: 'ready' })

function base(): { p: Project; v: string } {
  let p = ops.addAsset(createEmptyProject('t'), vid())
  const r = ops.addMediaFromAsset(p, 'a1', 0)
  p = r.project
  return { p, v: r.itemIds[0] }
}
const media = (p: Project, id: string): MediaItem => p.tracks.flatMap((t) => t.items).find((i) => i.id === id) as MediaItem

describe('sourceTimeUs', () => {
  it('speed 2 com inUs 1 s', () => {
    const { p, v } = base()
    const it = { ...media(p, v), inUs: S, speed: 2, startUs: 0 }
    expect(sourceTimeUs(it, p.assets[0], 0.5 * S)).toBe(2 * S)
  })
  it('reverse começa perto do fim da faixa de fonte', () => {
    const { p, v } = base()
    const it = { ...media(p, v), inUs: S, durationUs: 4 * S, reverse: true }
    expect(sourceTimeUs(it, p.assets[0], 0)).toBe(S + 4 * S - 33_333)
  })
  it('freeze usa atUs; clamp em [0, dur-1]', () => {
    const { p, v } = base()
    expect(sourceTimeUs({ ...media(p, v), freeze: { atUs: 3 * S } }, p.assets[0], 5 * S)).toBe(3 * S)
    expect(sourceTimeUs({ ...media(p, v), inUs: 9 * S, speed: 4 }, p.assets[0], 5 * S)).toBe(10 * S - 1)
  })
})

describe('resolveFrame', () => {
  it('duas faixas de vídeo: [fundo, topo]; áudio não gera camada', () => {
    let { p } = base()
    p = ops.addAsset(p, vid('a2'))
    const added = ops.addTrack(p, 'video')
    p = added.project
    p = ops.addMediaFromAsset(p, 'a2', 0, { videoTrackId: added.trackId }).project
    const layers = resolveFrame(p, S) as MediaLayer[]
    expect(layers.map((l) => l.assetId)).toEqual(['a1', 'a2'])
    expect(layers[0].srcUs).toBe(S)
  })
  it('faixa hidden some; fora de itens → []', () => {
    const { p } = base()
    const h = ops.updateTrack(p, p.tracks[0].id, { hidden: true })
    expect(resolveFrame(h, S)).toEqual([])
    expect(resolveFrame(p, 10 * S)).toEqual([])
    expect(activeItemsAt(p, S)).toHaveLength(2)
  })
  it('fadeIn 1 s em start+0,25 s → opacity 0,25', () => {
    const { p, v } = base()
    const q = ops.updateItem<MediaItem>(p, v, (d) => { d.visual = { ...defaultVisual(), fadeInUs: S } })
    const l = resolveFrame(q, 0.25 * S)[0] as MediaLayer
    expect(l.opacity).toBeCloseTo(0.25)
  })
  it('fadeOut e slideL de entrada', () => {
    const { p, v } = base()
    const q = ops.updateItem<MediaItem>(p, v, (d) => { d.visual = { ...defaultVisual(), fadeOutUs: S, animIn: { preset: 'slideL', durationUs: S } } })
    expect((resolveFrame(q, 9.5 * S)[0] as MediaLayer).opacity).toBeCloseTo(0.5)
    expect((resolveFrame(q, 0)[0] as MediaLayer).rect.cx).toBeCloseTo(-0.5)
    expect((resolveFrame(q, 2 * S)[0] as MediaLayer).rect.cx).toBeCloseTo(0.5)
  })
  it('imagem → srcUs null', () => {
    let p = ops.addAsset(createEmptyProject('t'), img())
    p = ops.addMediaFromAsset(p, 'im', 0).project
    expect((resolveFrame(p, S)[0] as MediaLayer).srcUs).toBeNull()
  })
  it('annotations → sessionMs; effect avalia region', () => {
    let { p } = base()
    const tid = p.tracks[0].id
    p = ops.insertItems(p, tid, [{ id: 'an', type: 'annotations', startUs: 20 * S, durationUs: 5 * S, sessionId: 's1', inUs: 2 * S }], 'overwrite')
    expect(resolveFrame(p, 21 * S)).toEqual([{ kind: 'annotations', itemId: 'an', trackId: tid, sessionId: 's1', sessionMs: 3000, autoFadeMs: null }])
    p = ops.insertItems(p, tid, [{ id: 'an2', type: 'annotations', startUs: 40 * S, durationUs: 5 * S, sessionId: 's1', inUs: 0, autoFadeMs: 2500 }], 'overwrite')
    expect(resolveFrame(p, 41 * S)[0]).toMatchObject({ kind: 'annotations', itemId: 'an2', autoFadeMs: 2500 })
    const fx: EffectItem = {
      id: 'fx', type: 'effect', effect: 'blur', startUs: 30 * S, durationUs: 2 * S, feather: 0, color: '#000', invert: false, scope: 'below',
      region: { shape: 'rect', x: { value: 0.5, keys: [{ tUs: 0, value: 0, ease: 'linear' }, { tUs: 2 * S, value: 1, ease: 'linear' }] }, y: { value: 0.5 }, w: { value: 0.2 }, h: { value: 0.2 }, rotation: { value: 0 } },
      strength: { value: 8 }
    }
    p = ops.insertItems(p, tid, [fx], 'overwrite')
    const l = resolveFrame(p, 31 * S)[0]
    expect(l).toMatchObject({ kind: 'effect', strength: 8, region: { x: 0.5 } })
  })
  it('effect: trackId e targetTrackId (sem alvo gravado) = faixa de vídeo visível logo abaixo (pula ocultas e de áudio)', () => {
    const { p: p0 } = base()
    const bottom = p0.tracks.find((t) => t.kind === 'video')!.id
    let p = p0
    const hidden = ops.addTrack(p, 'video')
    p = ops.updateTrack(hidden.project, hidden.trackId, { hidden: true })
    const top = ops.addTrack(p, 'video')
    p = top.project
    const fx: EffectItem = {
      id: 'fx', type: 'effect', effect: 'solid', startUs: 0, durationUs: 2 * S, feather: 0, color: '#000', invert: false, scope: 'track',
      region: { shape: 'rect', x: { value: 0.5 }, y: { value: 0.5 }, w: { value: 0.2 }, h: { value: 0.2 }, rotation: { value: 0 } }, strength: { value: 100 }
    }
    p = ops.insertItems(p, top.trackId, [fx], 'overwrite')
    expect(resolveFrame(p, S).find((l) => l.kind === 'effect')).toMatchObject({ trackId: top.trackId, targetTrackId: bottom })
    // na faixa de vídeo mais baixa: nada abaixo
    const low = ops.insertItems(p0, bottom, [{ ...fx, id: 'fx2', startUs: 20 * S }], 'overwrite')
    expect(resolveFrame(low, 21 * S)).toEqual([expect.objectContaining({ kind: 'effect', trackId: bottom, targetTrackId: null })])
  })
  it('enabled:false some do resolveFrame; reativar volta', () => {
    const { p: p0 } = base()
    const r = ops.addEffect(p0, 'blur', S)
    expect(resolveFrame(r.project, 2 * S).some((l) => l.kind === 'effect')).toBe(true)
    const off = ops.setItemEnabled(r.project, [r.itemId], false)
    expect(resolveFrame(off, 2 * S).some((l) => l.kind === 'effect')).toBe(false)
    expect(resolveFrame(ops.setItemEnabled(off, [r.itemId], true), 2 * S).some((l) => l.kind === 'effect')).toBe(true)
  })
})

describe('resolveFrame: propriedades animáveis da F4', () => {
  const k = (a: number, b: number, ease: import('./project').Ease = 'linear') => ({ value: a, keys: [{ tUs: 0, value: a, ease }, { tUs: 10 * S, value: b, ease: 'linear' as const }] })
  it('corte, ajuste e raio avaliados no instante (com o ease do key)', () => {
    const { p, v } = base()
    const q = ops.updateItem<MediaItem>(p, v, (d) => {
      d.visual!.crop = { l: k(0, 0.2), t: { value: 0.1 }, r: k(0, 0.4, 'in'), b: { value: 0 } }
      d.visual!.adjust = { brightness: k(0, 1), contrast: { value: 0.3 }, saturation: k(-1, 1, 'out') }
      d.visual!.radius = k(0, 20)
    })
    const m = resolveFrame(q, 5 * S).find((l): l is MediaLayer => l.kind === 'media')!
    expect(m.crop.l).toBeCloseTo(0.1)
    expect(m.crop.t).toBe(0.1)
    expect(m.crop.r).toBeCloseTo(0.05) // 0,4 × ½³
    expect(m.adjust).toEqual({ brightness: expect.closeTo(0.5, 6), contrast: 0.3, saturation: expect.closeTo(0.75, 6) })
    expect(m.radius).toBeCloseTo(10)
  })
  it('overshoot de curva: escala presa a ≥ 0, opacidade a [0,1], raio a ≥ 0', () => {
    const { p, v } = base()
    const back: import('./project').Ease = { bezier: [0.3, -1.5, 0.7, 1] } // desce abaixo de 0 antes de subir
    const q = ops.updateItem<MediaItem>(p, v, (d) => {
      d.visual!.transform.scale = k(0, 1, back)
      d.visual!.transform.opacity = k(0, 1, back)
      d.visual!.radius = k(0, 10, back)
    })
    const m = resolveFrame(q, 2 * S).find((l): l is MediaLayer => l.kind === 'media')!
    expect(m.rect.scale).toBe(0)
    expect(m.opacity).toBe(0)
    expect(m.radius).toBe(0)
  })
  it('texto: tamanho animado avaliado no estilo da camada', () => {
    const p = createEmptyProject('t')
    p.tracks[0].items = [{ id: 'tx', type: 'text', startUs: 0, durationUs: 10 * S, text: 'a', style: { font: 'Inter', size: k(10, 30), weight: 400, color: '#fff', align: 'left', lineHeight: 1 }, visual: defaultVisual() }]
    const l = resolveFrame(p, 5 * S)[0]
    expect(l.kind === 'text' && l.style.size).toBeCloseTo(20)
  })
})
