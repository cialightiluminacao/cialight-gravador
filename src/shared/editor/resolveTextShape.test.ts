import { describe, expect, it } from 'vitest'
import { createShapeItem } from './factory'
import * as ops from './ops'
import { findItem } from './ops'
import type { EffectItem, ShapeItem, TextItem } from './project'
import { privacyWarnings } from './privacy'
import { effectBound, resolveFrame, type TransitionLayer } from './resolve'
import { S, fx, project, textClip, tr, track, vclip, vid } from './__fixtures__/transitionScenes'

// F5 Task 4: texto e forma como camadas de faixa (trackId) — escopo `track` com alvo numa faixa de texto/forma e a
// condição noTarget da privacidade.

const shape = (id: string, startUs: number, durationUs: number): ShapeItem => ({ ...createShapeItem('rect', startUs, { durationUs }), id })

describe('TextLayer/ShapeLayer: trackId', () => {
  it('texto e forma levam o id da faixa', () => {
    const p = project([track('V1', 'video', [vclip('m', 'v', 0, 4 * S)]), track('T', 'video', [textClip('t', 0, 4 * S)]), track('F', 'video', [shape('f', 0, 4 * S)])], [vid('v')])
    const layers = resolveFrame(p, S)
    expect(layers.map((l) => [l.kind, 'trackId' in l ? l.trackId : null])).toEqual([['media', 'V1'], ['text', 'T'], ['shape', 'F']])
  })
})

describe('escopo `track` com alvo numa faixa de texto/forma', () => {
  const build = (target: 'T' | 'F') =>
    project(
      [
        track('V1', 'video', [vclip('m', 'v', 0, 4 * S)]),
        track('T', 'video', [textClip('t', 0, 4 * S)]),
        track('F', 'video', [shape('f', 0, 4 * S)]),
        track('FX', 'video', [fx('e', 'blur', 0, 4 * S, { scope: 'track', targetTrackId: target })])
      ],
      [vid('v')]
    )
  it('o efeito vai logo depois da camada de texto e age (effectBound)', () => {
    const layers = resolveFrame(build('T'), S)
    expect(layers.map((l) => l.kind)).toEqual(['media', 'text', 'effect', 'shape'])
    expect(effectBound(layers, 2)).toBe(true)
  })
  it('alvo na faixa da forma', () => {
    const layers = resolveFrame(build('F'), S)
    expect(layers.map((l) => l.kind)).toEqual(['media', 'text', 'shape', 'effect'])
    expect(effectBound(layers, 3)).toBe(true)
  })
  it('lado de uma transição com texto: o efeito `track` da faixa entra na sub-pilha do texto', () => {
    const p = project(
      [
        track('V1', 'video', [vclip('A', 'v', 0, 4 * S), textClip('B', 4 * S, 4 * S, { transitionIn: tr('crossfade', 2 * S) })]),
        track('FX', 'video', [fx('e', 'blur', 0, 8 * S, { scope: 'track', targetTrackId: 'V1' })])
      ],
      [vid('v')]
    )
    const t = resolveFrame(p, 4 * S + S / 2)[0] as TransitionLayer
    expect(t.kind).toBe('transition')
    expect(t.to.map((l) => l.kind)).toEqual(['text', 'effect'])
    expect(effectBound(t.to, 1)).toBe(true)
  })
})

describe('privacidade: noTarget considera texto/forma como alvo desenhado', () => {
  const noTarget = (target: 'T' | 'F', items: 'cheia' | 'lacuna') => {
    const gap = items === 'lacuna'
    const p = project(
      [
        track('T', 'video', [textClip('t', 0, gap ? 2 * S : 4 * S)]),
        track('F', 'video', [shape('f', 0, gap ? 2 * S : 4 * S)]),
        track('FX', 'video', [fx('e', 'pixelate', 0, 4 * S, { scope: 'track', targetTrackId: target })])
      ],
      []
    )
    return privacyWarnings(p, 0, 4 * S).filter((w) => w.kind === 'noTarget').map((w) => w.tUs)
  }
  it('faixa-alvo com texto o tempo todo: sem aviso', () => expect(noTarget('T', 'cheia')).toEqual([]))
  it('faixa-alvo com forma o tempo todo: sem aviso', () => expect(noTarget('F', 'cheia')).toEqual([]))
  it('texto acaba antes do efeito: aviso no fim dele', () => expect(noTarget('T', 'lacuna')).toEqual([2 * S]))
})

describe('escopo `track` sem targetTrackId (alvo antigo): só mídia/anotações da faixa abaixo, nunca texto/forma', () => {
  // efeito `track` sem ligação gravada logo acima de uma faixa de texto, sobre uma mídia
  const legacy = () =>
    project(
      [
        track('V1', 'video', [vclip('m', 'v', 0, 4 * S)]),
        track('T', 'video', [textClip('t', 0, 4 * S)]),
        track('FX', 'video', [fx('e', 'pixelate', 0, 4 * S, { scope: 'track' })])
      ],
      [vid('v')]
    )
  it('resolve: não se liga ao texto (fica no fim, sem efeito) e o noTarget avisa', () => {
    const p = legacy()
    const layers = resolveFrame(p, S)
    expect(layers.map((l) => l.kind)).toEqual(['media', 'text', 'effect'])
    expect(layers[2]).toMatchObject({ targetTrackId: 'T', legacyTarget: true })
    expect(effectBound(layers, 2)).toBe(false)
    expect(privacyWarnings(p, 0, 4 * S).filter((w) => w.kind === 'noTarget').map((w) => w.tUs)).toEqual([0])
  })
  it('uma edição qualquer grava o alvo com targetMediaOnly (congelado, e o comportamento continua o mesmo)', () => {
    const q = ops.updateItem<TextItem>(legacy(), 't', (d) => {
      d.text = 'outro'
    })
    const e = findItem(q, 'e')!.item as EffectItem
    expect(e).toMatchObject({ targetTrackId: 'T', targetMediaOnly: true })
    const layers = resolveFrame(q, S)
    expect(layers[layers.length - 1]).toMatchObject({ targetTrackId: 'T', legacyTarget: true })
    expect(effectBound(layers, layers.findIndex((l) => l.kind === 'effect'))).toBe(false)
  })
  it('alvo antigo com mídia na faixa abaixo continua ligado (e a edição grava a ligação)', () => {
    const p = project([track('V1', 'video', [vclip('m', 'v', 0, 4 * S)]), track('FX', 'video', [fx('e', 'pixelate', 0, 4 * S, { scope: 'track' })])], [vid('v')])
    const layers = resolveFrame(p, S)
    expect(effectBound(layers, 1)).toBe(true)
    const q = ops.updateItem<EffectItem>(p, 'e', (d) => {
      d.feather = 0.1
    })
    expect((findItem(q, 'e')!.item as EffectItem).targetTrackId).toBe('V1')
  })
  it('"Só a faixa abaixo" num efeito novo SEMPRE grava a ligação (faixa de texto logo abaixo = alvo explícito, age nele)', () => {
    const p = project([track('V1', 'video', [vclip('m', 'v', 0, 4 * S)]), track('T', 'video', [textClip('t', 0, 4 * S)]), track('FX', 'video', [fx('e', 'pixelate', 0, 4 * S)])], [vid('v')])
    const q = ops.setEffectScope(p, 'e', 'track')
    expect((findItem(q, 'e')!.item as EffectItem).targetTrackId).toBe('T')
    const layers = resolveFrame(q, S)
    expect(layers.map((l) => l.kind)).toEqual(['media', 'text', 'effect'])
    expect(effectBound(layers, 2)).toBe(true)
    // sem nenhuma faixa visual abaixo: sem ligação (alvo antigo nulo) — nada a afetar, avisa
    const lone = ops.setEffectScope(project([track('FX', 'video', [fx('e', 'pixelate', 0, 4 * S)])], []), 'e', 'track')
    expect((findItem(lone, 'e')!.item as EffectItem).targetTrackId).toBeUndefined()
    expect(privacyWarnings(lone, 0, 4 * S).some((w) => w.kind === 'noTarget')).toBe(true)
  })
})
