import { describe, expect, it } from 'vitest'
import { easeValue } from '@shared/editor/anim'
import type { Anim } from '@shared/editor/project'
import { CURVE_PRESETS, curveGraph, curveKeyFor, curvePath, handlesOf, presetOf, viewRange, withHandle } from './curveMath'

const S = 1_000_000

describe('presets da curva', () => {
  it('os seis, na ordem, com os nomes da interface', () => {
    expect(CURVE_PRESETS.map((p) => p.label)).toEqual(['Linear', 'Segurar', 'Suavizar entrada', 'Suavizar saída', 'Suavizar ambos', 'Overshoot'])
  })
  it('presetOf reconhece cada preset; bezier qualquer = nenhum', () => {
    for (const p of CURVE_PRESETS) expect(presetOf(p.ease)).toBe(p.id)
    expect(presetOf({ bezier: [0.1, 0.2, 0.3, 0.4] })).toBeNull()
  })
  it('alças de partida: a bezier do preset (aproximada nos cúbicos) ou a própria', () => {
    expect(handlesOf('linear')).toEqual([0.25, 0.25, 0.75, 0.75])
    expect(handlesOf({ bezier: [0.1, 1.8, 0.9, -0.5] })).toEqual([0.1, 1.8, 0.9, -0.5])
    // entrada/saída são cúbicas exatas como bezier (x(t) = t); só "ambos" é aproximada
    expect(handlesOf('in')).toEqual([1 / 3, 0, 2 / 3, 0])
    expect(handlesOf('out')).toEqual([1 / 3, 1, 2 / 3, 1])
    for (const e of ['in', 'out'] as const) for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) expect(easeValue({ bezier: handlesOf(e) }, p)).toBeCloseTo(easeValue(e, p), 6)
    for (const p of [0.25, 0.5, 0.75]) expect(easeValue({ bezier: handlesOf('inOut') }, p)).toBeCloseTo(easeValue('inOut', p), 1)
  })
})

describe('alças', () => {
  it('x preso a [0,1]; y livre em −1..2', () => {
    expect(withHandle([0.25, 0.25, 0.75, 0.75], 1, -0.3, 2.7)).toEqual([0, 2, 0.75, 0.75])
    expect(withHandle([0.25, 0.25, 0.75, 0.75], 2, 1.4, -1.6)).toEqual([0.25, 0.25, 1, -1])
    expect(withHandle([0.25, 0.25, 0.75, 0.75], 2, 0.123456, 1.55555)).toEqual([0.25, 0.25, 0.123, 1.556])
  })
  it('vista do gráfico cobre 0..1 com folga e as alças fora dele', () => {
    const r = viewRange([0.25, 0.25, 0.75, 0.75])
    expect(r.lo).toBeLessThan(0)
    expect(r.hi).toBeGreaterThan(1)
    const o = viewRange([0.34, 1.56, 0.64, -0.8])
    expect(o.hi).toBeGreaterThan(1.56)
    expect(o.lo).toBeLessThan(-0.8)
  })
  it('curveGraph: ida e volta entre a curva (0..1) e os px do gráfico', () => {
    const g = curveGraph(200, 160, { lo: -0.2, hi: 1.2 }, 10)
    expect(g.toPx(0, 1.2)).toEqual({ x: 10, y: 10 })
    expect(g.toPx(1, -0.2)).toEqual({ x: 190, y: 150 })
    const back = g.fromPx(g.toPx(0.4, 0.7).x, g.toPx(0.4, 0.7).y)
    expect(back.x).toBeCloseTo(0.4, 9)
    expect(back.y).toBeCloseTo(0.7, 9)
  })
  it('curvePath segue o ease (segurar = degrau no fim)', () => {
    const g = curveGraph(100, 100, { lo: 0, hi: 1 }, 0)
    expect(curvePath('hold', g)).toBe('M0 100L100 100L100 0')
    expect(curvePath('linear', g, 4)).toBe('M0 100L25 75L50 50L75 25L100 0')
  })
})

describe('curveKeyFor (◇ com botão direito)', () => {
  const a: Anim<number> = { value: 0, keys: [{ tUs: S, value: 0, ease: 'linear' }, { tUs: 3 * S, value: 1, ease: 'in' }, { tUs: 5 * S, value: 0, ease: 'linear' }] }
  it('o key no playhead (±tolerância); senão o que começa o trecho do playhead; antes do 1º, o 1º', () => {
    expect(curveKeyFor(a, 3 * S + 10_000, 16_667)!.tUs).toBe(3 * S)
    expect(curveKeyFor(a, 4 * S, 16_667)!.tUs).toBe(3 * S)
    expect(curveKeyFor(a, 0, 16_667)!.tUs).toBe(S)
    expect(curveKeyFor(a, 6 * S, 16_667)!.tUs).toBe(5 * S)
    expect(curveKeyFor({ value: 0 }, 0, 16_667)).toBeNull()
  })
})
