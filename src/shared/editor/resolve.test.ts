import { describe, expect, it } from 'vitest'
import { createEmptyProject, defaultVisual } from './factory'
import type { Asset, EffectItem, MediaItem, Project } from './project'
import * as ops from './ops'
import { activeItemsAt, resolveFrame, sourceTimeUs, visualStateAt } from './resolve'
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

describe('sourceTimeUs: nunca fora do trecho aparado (privacidade)', () => {
  // até a v1.4 o reverso lia, no fim do clipe, até um quadro ANTES de inUs (− 1 quadro da fórmula): um quadro do
  // trecho cortado aparecia. Denso: a cada 1/240 s, nos 3 µs das bordas e com início desalinhado ao quadro.
  for (const speed of [0.5, 1, 2]) {
    for (const reverse of [true, false]) {
      it(`${reverse ? 'reverso' : 'normal'} a ${speed}×: srcUs em [inUs, inUs + ⌈dur·speed⌉ − 1] em todo instante`, () => {
        const { p, v } = base()
        for (const [startUs, durationUs, inUs] of [[0, 3 * S, 2 * S], [1_234_567, 2_345_679, 1_000_001], [S / 3, 33_333 * 7, 4 * S]] as const) {
          const it = { ...media(p, v), startUs, durationUs, inUs, speed, reverse }
          const lo = inUs, hi = inUs + Math.ceil(durationUs * speed) - 1
          const ts: number[] = []
          for (let t = startUs; t < startUs + durationUs; t += Math.round(S / 240)) ts.push(t)
          for (let k = 0; k < 3; k++) ts.push(startUs + k, startUs + durationUs - 1 - k)
          const bad = ts.map((t) => [t, sourceTimeUs(it, p.assets[0], t)]).filter(([, src]) => src < lo || src > hi)
          expect(bad).toEqual([])
          expect(sourceTimeUs(it, p.assets[0], startUs + durationUs - 1)).toBe(reverse ? lo : Math.min(hi, Math.round(inUs + (durationUs - 1) * speed)))
          // resolveFrame usa a mesma trava (camada de mídia = preview = exportação)
          const q = { ...p, tracks: p.tracks.map((tr) => ({ ...tr, items: tr.items.map((x) => (x.id === v ? it : x)) })) }
          const l = resolveFrame(q, startUs + durationUs - 1).find((x) => x.kind === 'media') as MediaLayer
          expect(l.srcUs! >= lo && l.srcUs! <= hi).toBe(true)
        }
      })
    }
  }
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
  it('opacidade com overshoot é presa antes dos fades/presets; ajuste preso a [−1, 1]', () => {
    const { p, v } = base()
    const q = ops.updateItem<MediaItem>(p, v, (d) => {
      d.visual!.transform.opacity = { value: 3 } // > 1: sem a trava antes, o fade de 1 s chegaria a 1 já em 1/3 s
      d.visual!.fadeInUs = S
      d.visual!.adjust = { brightness: k(0, 4, { bezier: [0.3, 0, 0.7, 1] }), contrast: { value: -3 }, saturation: { value: 2 } }
    })
    const at = (t: number) => resolveFrame(q, t).find((l): l is MediaLayer => l.kind === 'media')!
    expect(at(S / 2).opacity).toBeCloseTo(0.5)
    expect(at(9 * S).adjust).toEqual({ brightness: 1, contrast: -1, saturation: 1 })
  })
  it('texto: tamanho animado avaliado no estilo da camada', () => {
    const p = createEmptyProject('t')
    p.tracks[0].items = [{ id: 'tx', type: 'text', startUs: 0, durationUs: 10 * S, text: 'a', style: { font: 'Inter', size: k(10, 30), weight: 400, color: '#fff', align: 'left', lineHeight: 1 }, visual: defaultVisual() }]
    const l = resolveFrame(p, 5 * S)[0]
    expect(l.kind === 'text' && l.style.size).toBeCloseTo(20)
  })
})

describe('visualStateAt: animações de entrada/saída (F4)', () => {
  type Ease = import('./project').PresetEase
  type Preset = import('./project').AnimPreset
  const D = 10 * S
  /** Estado em p ∈ [0,1] da entrada de 1 s (local = p s). */
  const inAt = (preset: Preset, p: number, ease?: Ease, over: Partial<import('./project').VisualProps> = {}) =>
    visualStateAt({ ...defaultVisual(), ...over, animIn: { preset, durationUs: S, ...(ease ? { ease } : {}) } }, D, Math.round(p * S))
  /** Estado em p ∈ [0,1] da saída de 1 s (p = 0 no começo da saída, 1 no fim do item). */
  const outAt = (preset: Preset, p: number, ease?: Ease) =>
    visualStateAt({ ...defaultVisual(), animOut: { preset, durationUs: S, ...(ease ? { ease } : {}) } }, D, D - S + Math.round(p * S))
  const rest = { rect: { cx: 0.5, cy: 0.5, scale: 1, rotation: 0 }, opacity: 1, blur: 0 }

  it('fade: opacidade 0 → ½ → 1 (linear, como na F1)', () => {
    expect([0, 0.5, 1].map((p) => inAt('fade', p).opacity)).toEqual([0, 0.5, 1])
    expect([0, 0.5, 1].map((p) => outAt('fade', p).opacity)).toEqual([1, 0.5, 0])
  })
  it('deslizar L/R/U/D: de fora do quadro até a posição (suavizar saída por padrão, como na F1)', () => {
    // ½ com 'out': 1 − ½³ = 0,875 do caminho → falta 0,125
    expect([0, 0.5, 1].map((p) => inAt('slideL', p).rect.cx)).toEqual([-0.5, 0.375, 0.5])
    expect([0, 0.5, 1].map((p) => inAt('slideR', p).rect.cx)).toEqual([1.5, 0.625, 0.5])
    expect([0, 0.5, 1].map((p) => inAt('slideU', p).rect.cy)).toEqual([-0.5, 0.375, 0.5])
    expect([0, 0.5, 1].map((p) => inAt('slideD', p).rect.cy)).toEqual([1.5, 0.625, 0.5])
    expect(inAt('slideL', 0).opacity).toBe(1)
    // saída: sai pelo mesmo lado
    expect([0, 0.5, 1].map((p) => outAt('slideL', p).rect.cx)).toEqual([0.5, -0.375, -0.5])
  })
  it('zoom: escala 0,8 → 1 e aparece na 1ª metade', () => {
    const s = [0, 0.5, 1].map((p) => inAt('zoom', p, 'linear'))
    expect(s.map((x) => x.rect.scale)).toEqual([0.8, 0.9, 1].map((v) => expect.closeTo(v, 12)))
    expect(s.map((x) => x.opacity)).toEqual([0, 1, 1])
    expect(inAt('zoom', 0.25, 'linear').opacity).toBeCloseTo(0.5, 12)
  })
  it('pop: escala 0,6 → 1,05 (aos 70 %) → 1', () => {
    const at = (p: number) => inAt('pop', p, 'linear').rect.scale
    expect(at(0)).toBeCloseTo(0.6, 12)
    expect(at(0.5)).toBeCloseTo(0.6 + 0.45 * (0.5 / 0.7), 12)
    expect(at(0.7)).toBeCloseTo(1.05, 12)
    expect(at(1)).toBe(1)
    expect([0, 0.5, 1].map((p) => inAt('pop', p, 'linear').opacity)).toEqual([0, 1, 1])
  })
  it('girar: rotação −15° → 0 (aparece na 1ª metade)', () => {
    expect([0, 0.5, 1].map((p) => inAt('rotate', p, 'linear').rect.rotation)).toEqual([-15, -7.5, 0])
    expect([0, 0.5, 1].map((p) => inAt('rotate', p, 'linear').opacity)).toEqual([0, 1, 1])
  })
  it('quicar: desliza de baixo, passa do ponto (overshoot) e volta', () => {
    const cy = (p: number) => inAt('bounce', p).rect.cy
    expect(cy(0)).toBeCloseTo(1.5, 12)
    // recuo (easeOutBack, c = 1,70158): no meio já passou 8,8 % do quadro acima da posição final
    expect(cy(0.5)).toBeCloseTo(0.5 - 0.0876975, 6)
    expect(cy(1)).toBe(0.5)
    const min = Math.min(...Array.from({ length: 101 }, (_, i) => cy(i / 100)))
    expect(min).toBeLessThan(0.4)
    expect(inAt('bounce', 0).opacity).toBe(1)
  })
  it('desfoque: 20 → 0 px (aparece na 1ª metade)', () => {
    expect([0, 0.5, 1].map((p) => inAt('blur', p, 'linear').blur)).toEqual([20, 10, 0])
    expect([0, 0.5, 1].map((p) => inAt('blur', p, 'linear').opacity)).toEqual([0, 1, 1])
    expect(inAt('blur', 0.5, 'linear').rect).toEqual(rest.rect)
  })
  it('ease configurável (padrão: suavizar saída) e saída espelhada', () => {
    expect(inAt('zoom', 0.5).rect.scale).toBeCloseTo(0.8 + 0.2 * 0.875, 12) // padrão 'out'
    expect(inAt('zoom', 0.5, 'in').rect.scale).toBeCloseTo(0.8 + 0.2 * 0.125, 12)
    expect(inAt('zoom', 0.5, { bezier: [0.25, 0.25, 0.75, 0.75] }).rect.scale).toBeCloseTo(0.9, 6)
    // saída: o caminho inverso (em repouso no começo, 0,8 e invisível no fim)
    expect(outAt('zoom', 0, 'linear')).toEqual(rest)
    expect(outAt('zoom', 1, 'linear').rect.scale).toBeCloseTo(0.8, 12)
    expect(outAt('zoom', 1, 'linear').opacity).toBe(0)
    expect(outAt('pop', 0.3, 'linear').rect.scale).toBeCloseTo(1.05, 12)
    expect(outAt('blur', 1, 'linear').blur).toBe(20)
    expect(outAt('rotate', 1, 'linear').rect.rotation).toBe(-15)
  })
  it('compõe com o transform do item (escala multiplica, rotação soma) e com fade/entrada+saída sobrepostas', () => {
    const t = { ...defaultVisual().transform, scale: { value: 0.5 }, rotation: { value: 10 } }
    const s = inAt('zoom', 0, 'linear', { transform: t })
    expect(s.rect.scale).toBeCloseTo(0.4, 12)
    expect(inAt('rotate', 0, 'linear', { transform: t }).rect.rotation).toBe(-5)
    // item curto (1 s) com pop na entrada e desfoque na saída, as duas de 1 s: valem juntas
    const both = visualStateAt({ ...defaultVisual(), animIn: { preset: 'pop', durationUs: S, ease: 'linear' }, animOut: { preset: 'blur', durationUs: S, ease: 'linear' } }, S, S / 2)
    expect(both.rect.scale).toBeCloseTo(0.6 + 0.45 * (0.5 / 0.7), 12)
    expect(both.blur).toBe(10)
  })
  it('invisível no 1º instante de quem aparece (opacidade exatamente 0); camada leva o desfoque só quando > 0', () => {
    for (const preset of ['fade', 'zoom', 'pop', 'rotate', 'blur'] as const) expect(inAt(preset, 0).opacity).toBe(0)
    const { p, v } = base()
    const q = ops.updateItem<MediaItem>(p, v, (d) => { d.visual = { ...defaultVisual(), animIn: { preset: 'blur', durationUs: S, ease: 'linear' } } })
    expect((resolveFrame(q, S / 2)[0] as MediaLayer).blur).toBe(10)
    expect(resolveFrame(q, 2 * S)[0]).not.toHaveProperty('blur')
  })
})
