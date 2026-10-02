import { describe, expect, it } from 'vitest'
import { createEffectItem } from '@shared/editor/factory'
import type { Anim, EffectItem } from '@shared/editor/project'
import { concreteRefs, dragGroup, isKeySelected, keysInLaneBox, pruneSel, shiftSelKeys, toggleKey, type KeyframeSel } from './keyframeSelection'

const S = 1_000_000
const k = (...ts: number[]): Anim<number> => ({ value: 0, keys: ts.map((tUs) => ({ tUs, value: tUs / S, ease: 'linear' as const })) })
/** Efeito de 4 s: região X com keys em 0, 1 s e 2 s; intensidade em 1 s e 3 s. */
function fx(): EffectItem {
  const it = createEffectItem('blur', 0, 4 * S)
  return { ...it, id: 'fx', region: { ...it.region, x: k(0, S, 2 * S) }, strength: k(S, 3 * S) }
}

describe('seleção de keyframes', () => {
  it('toggleKey: soma/tira no mesmo item; outro item recomeça; vazia → null', () => {
    let sel: KeyframeSel | null = toggleKey(null, 'fx', { path: 'region.x', tUs: S })
    expect(sel).toEqual({ itemId: 'fx', keys: [{ path: 'region.x', tUs: S }] })
    sel = toggleKey(sel, 'fx', { path: 'strength', tUs: S })
    expect(sel!.keys).toHaveLength(2)
    sel = toggleKey(sel, 'fx', { path: 'region.x', tUs: S + 1 }) // ±1 µs = o mesmo key
    expect(sel!.keys).toEqual([{ path: 'strength', tUs: S }])
    expect(toggleKey(sel, 'fx', { path: 'strength', tUs: S })).toBeNull()
    expect(toggleKey(sel, 'outro', { path: null, tUs: 0 })).toEqual({ itemId: 'outro', keys: [{ path: null, tUs: 0 }] })
  })
  it('isKeySelected: o losango combinado (path null) seleciona todas as propriedades naquele instante', () => {
    const sel: KeyframeSel = { itemId: 'fx', keys: [{ path: null, tUs: S }, { path: 'region.x', tUs: 2 * S }] }
    expect(isKeySelected(sel, 'fx', 'strength', S)).toBe(true)
    expect(isKeySelected(sel, 'fx', null, S)).toBe(true)
    expect(isKeySelected(sel, 'fx', 'region.x', 2 * S)).toBe(true)
    expect(isKeySelected(sel, 'fx', null, 2 * S)).toBe(false) // só uma propriedade naquele instante
    expect(isKeySelected(sel, 'fx', 'strength', 3 * S)).toBe(false)
    expect(isKeySelected(sel, 'outro', 'strength', S)).toBe(false)
  })
  it('concreteRefs: expande o combinado nas propriedades com key ali, sem repetir', () => {
    const refs = concreteRefs(fx(), [{ path: null, tUs: S }, { path: 'strength', tUs: S }, { path: 'region.x', tUs: 2 * S }])
    expect(refs).toEqual([{ path: 'region.x', tUs: S }, { path: 'strength', tUs: S }, { path: 'region.x', tUs: 2 * S }])
    expect(concreteRefs(fx(), [{ path: 'strength', tUs: 2 * S }])).toEqual([]) // sem key ali
  })
  it('keysInLaneBox: keys das linhas e do intervalo (locais) cruzados pela caixa, em qualquer direção', () => {
    const it = fx()
    const paths = ['region.x', 'strength'] as const
    expect(keysInLaneBox(it, [...paths], 0.5 * S, 2.5 * S, 0, 0)).toEqual([{ path: 'region.x', tUs: S }, { path: 'region.x', tUs: 2 * S }])
    expect(keysInLaneBox(it, [...paths], 3.5 * S, 0.5 * S, 1, 0)).toEqual([{ path: 'region.x', tUs: S }, { path: 'region.x', tUs: 2 * S }, { path: 'strength', tUs: S }, { path: 'strength', tUs: 3 * S }])
  })
  it('shiftSelKeys e pruneSel (keys que sumiram saem; nenhum → null)', () => {
    expect(shiftSelKeys([{ path: null, tUs: S }, { path: 'strength', tUs: 3 * S }], -S)).toEqual([{ path: null, tUs: 0 }, { path: 'strength', tUs: 2 * S }])
    const sel: KeyframeSel = { itemId: 'fx', keys: [{ path: null, tUs: 2 * S }, { path: 'strength', tUs: 2 * S }, { path: 'strength', tUs: 3 * S }] }
    expect(pruneSel(sel, fx())).toEqual({ itemId: 'fx', keys: [{ path: null, tUs: 2 * S }, { path: 'strength', tUs: 3 * S }] })
    expect(pruneSel({ itemId: 'fx', keys: [{ path: 'strength', tUs: 2 * S }] }, fx())).toBeNull()
    const same: KeyframeSel = { itemId: 'fx', keys: [{ path: 'strength', tUs: 3 * S }] }
    expect(pruneSel(same, fx())).toBe(same) // nada mudou: o mesmo objeto (sem re-render)
  })
})

describe('dragGroup (o que anda ao arrastar um losango)', () => {
  it('losango mostrado como selecionado (inclusive pelo combinado) leva a seleção inteira; fora dela, só ele', () => {
    const mixed: KeyframeSel = { itemId: 'fx', keys: [{ path: null, tUs: S }, { path: 'strength', tUs: 3 * S }] }
    // a linha da região em 1 s aparece selecionada por causa do combinado: arrastá-la leva o grupo
    expect(dragGroup(mixed, 'fx', { path: 'region.x', tUs: S })).toBe(mixed.keys)
    expect(dragGroup(mixed, 'fx', { path: 'strength', tUs: 3 * S })).toBe(mixed.keys)
    expect(dragGroup(mixed, 'fx', { path: 'region.x', tUs: 2 * S })).toEqual([{ path: 'region.x', tUs: 2 * S }])
    expect(dragGroup(mixed, 'outro', { path: null, tUs: S })).toEqual([{ path: null, tUs: S }])
    expect(dragGroup(null, 'fx', { path: null, tUs: S })).toEqual([{ path: null, tUs: S }])
  })
  it('grupo misto (combinado + linha) vira os keys de verdade de cada propriedade', () => {
    const refs = concreteRefs(fx(), [{ path: null, tUs: S }, { path: 'strength', tUs: 3 * S }])
    expect(refs).toEqual([{ path: 'region.x', tUs: S }, { path: 'strength', tUs: S }, { path: 'strength', tUs: 3 * S }])
  })
})
