import { describe, expect, it } from 'vitest'
import type { Anim } from '@shared/editor/project'
import { curveSegments, easeKind, valueRange, valueToY } from './laneMath'

const S = 1_000_000
const OVERSHOOT: [number, number, number, number] = [0.34, 1.56, 0.64, 1]

describe('easeKind', () => {
  it('presets pelo nome; bezier = personalizada', () => {
    expect(['linear', 'hold', 'in', 'out', 'inOut'].map((e) => easeKind(e as never))).toEqual(['linear', 'hold', 'in', 'out', 'inOut'])
    expect(easeKind({ bezier: OVERSHOOT })).toBe('custom')
  })
})

describe('mini-curva: valor → y', () => {
  it('máximo no topo, mínimo embaixo (com margem), meio no meio', () => {
    const r = { min: 0, max: 1 }
    expect(valueToY(1, r, 20, 3)).toBe(3)
    expect(valueToY(0, r, 20, 3)).toBe(17)
    expect(valueToY(0.5, r, 20, 3)).toBe(10)
  })
  it('faixa de valores: keys e o que a curva passa entre eles (overshoot)', () => {
    const a: Anim<number> = { value: 0, keys: [{ tUs: 0, value: 0, ease: { bezier: OVERSHOOT } }, { tUs: S, value: 1, ease: 'linear' }] }
    const r = valueRange(a)
    expect(r.min).toBe(0)
    expect(r.max).toBeGreaterThan(1.05)
    expect(valueRange({ value: 0, keys: [{ tUs: 0, value: 5, ease: 'linear' }, { tUs: S, value: 1, ease: 'in' }] })).toEqual({ min: 1, max: 5 })
  })
  it('valor constante: faixa aberta em volta (a linha fica no meio)', () => {
    const r = valueRange({ value: 0, keys: [{ tUs: 0, value: 2, ease: 'linear' }, { tUs: S, value: 2, ease: 'linear' }] })
    expect(valueToY(2, r, 20, 3)).toBe(10)
  })
})

describe('curveSegments', () => {
  const lin: Anim<number> = { value: 0, keys: [{ tUs: S, value: 0, ease: 'linear' }, { tUs: 2 * S, value: 1, ease: 'hold' }, { tUs: 3 * S, value: 0, ease: 'linear' }] }
  it('trecho antes do 1º key e depois do último ficam planos; cada trecho tem a cor do ease do key que o começa', () => {
    const segs = curveSegments(lin, 4 * S, 100, 0, 1000, 20)
    expect(segs.map((s) => s.kind)).toEqual(['flat', 'linear', 'hold', 'flat'])
    // 100 px/s: key em 1 s → x 100; y: valor 0 → 17, valor 1 → 3 (h 20, margem 3)
    expect(segs[0].d).toBe('M0 17L100 17')
    expect(segs[1].d).toBe('M100 17L200 3')
    // segurar: degrau no fim do trecho
    expect(segs[2].d).toBe('M200 3L300 3L300 17')
    expect(segs[3].d).toBe('M300 17L400 17')
  })
  it('coordenadas relativas à parte visível; trechos fora dela ficam de fora', () => {
    const segs = curveSegments(lin, 4 * S, 100, 250, 100, 20)
    expect(segs.map((s) => s.kind)).toEqual(['hold', 'flat'])
    expect(segs[0].d).toBe('M-50 3L50 3L50 17')
  })
  it('curva não linear vira polilinha que passa pelos keys', () => {
    const a: Anim<number> = { value: 0, keys: [{ tUs: 0, value: 0, ease: 'in' }, { tUs: S, value: 1, ease: 'linear' }] }
    const [seg] = curveSegments(a, S, 200, 0, 400, 20)
    const pts = seg.d.slice(1).split('L').map((p) => p.split(' ').map(Number))
    expect(pts.length).toBeGreaterThan(8)
    expect(pts[0]).toEqual([0, 17])
    expect(pts[pts.length - 1]).toEqual([200, 3])
    // 'in' (cúbica): no meio do trecho ainda está perto do valor inicial
    const mid = pts.find(([x]) => x >= 100)!
    expect(mid[1]).toBeGreaterThan(14)
  })
  it('sem keys: nada a desenhar', () => {
    expect(curveSegments({ value: 3 }, S, 100, 0, 100, 20)).toEqual([])
  })
})
