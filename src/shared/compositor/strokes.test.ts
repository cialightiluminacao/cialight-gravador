import { describe, expect, it } from 'vitest'
import type { Stroke, StrokePoint } from '../types'
import { visibleStrokesAt } from './strokes'

const pts = (...t: number[]): StrokePoint[] => t.map((tMs, i) => ({ x: i * 0.1, y: i * 0.05, tMs }))

const stroke = (id: string, tMs: number, points: StrokePoint[], extra: Partial<Stroke> = {}): Stroke => ({
  id,
  tMs,
  tool: 'pen',
  points,
  color: '#ff3b30',
  width: 6,
  ...extra
})

describe('visibleStrokesAt', () => {
  it('traço futuro não aparece', () => {
    expect(visibleStrokesAt([stroke('a', 1000, pts(1000, 1100))], [], 500, null)).toEqual([])
  })

  it('caneta: desenho progressivo (só pontos com tMs <= t)', () => {
    const s = stroke('a', 1000, pts(1000, 1050, 1100, 1150))
    const v = visibleStrokesAt([s], [], 1100, null)
    expect(v).toHaveLength(1)
    expect(v[0].stroke).toBe(s)
    expect(v[0].points.map((p) => p.tMs)).toEqual([1000, 1050, 1100])
    expect(v[0].alpha).toBe(1)
  })

  it('caneta: todos os pontos após concluído', () => {
    const s = stroke('a', 1000, pts(1000, 1050, 1100))
    expect(visibleStrokesAt([s], [], 5000, null)[0].points).toHaveLength(3)
  })

  it('traço com stroke.tMs <= t mas sem nenhum ponto registrado ainda não é listado', () => {
    const s = stroke('a', 1000, pts(1010, 1020))
    expect(visibleStrokesAt([s], [], 1005, null)).toEqual([])
  })

  it('linha/seta concluída: apenas primeiro e último ponto', () => {
    const s = stroke('a', 1000, pts(1000, 1050, 1100, 1150), { tool: 'line' })
    const v = visibleStrokesAt([s], [], 2000, null)
    expect(v[0].points.map((p) => p.tMs)).toEqual([1000, 1150])
    const a = stroke('b', 1000, pts(1000, 1050, 1100, 1150), { tool: 'arrow' })
    expect(visibleStrokesAt([a], [], 2000, null)[0].points.map((p) => p.tMs)).toEqual([1000, 1150])
  })

  it('linha/seta em andamento: primeiro ponto até o último já registrado', () => {
    const s = stroke('a', 1000, pts(1000, 1050, 1100, 1150), { tool: 'arrow' })
    const v = visibleStrokesAt([s], [], 1100, null)
    expect(v[0].points.map((p) => p.tMs)).toEqual([1000, 1100])
  })

  it('linha com um único ponto registrado retorna só ele', () => {
    const s = stroke('a', 1000, pts(1000, 1050), { tool: 'line' })
    expect(visibleStrokesAt([s], [], 1000, null)[0].points).toHaveLength(1)
  })

  it('erasedAtMs <= t oculta o traço; antes disso continua visível', () => {
    const s = stroke('a', 1000, pts(1000, 1050), { erasedAtMs: 3000 })
    expect(visibleStrokesAt([s], [], 2999, null)).toHaveLength(1)
    expect(visibleStrokesAt([s], [], 3000, null)).toHaveLength(0)
  })

  it('clear entre stroke.tMs e t oculta; clear anterior ao traço não afeta; clear futuro não afeta', () => {
    const s = stroke('a', 1000, pts(1000, 1050))
    expect(visibleStrokesAt([s], [{ tMs: 2000 }], 2500, null)).toHaveLength(0)
    expect(visibleStrokesAt([s], [{ tMs: 2000 }], 2000, null)).toHaveLength(0)
    expect(visibleStrokesAt([s], [{ tMs: 500 }], 2500, null)).toHaveLength(1)
    expect(visibleStrokesAt([s], [{ tMs: 3000 }], 2500, null)).toHaveLength(1)
    // clear no mesmo instante do traço não o apaga (stroke.tMs < clear.tMs)
    expect(visibleStrokesAt([s], [{ tMs: 1000 }], 2500, null)).toHaveLength(1)
  })

  it('autoFadeMs conta a partir do ÚLTIMO ponto: alpha 1 até fim-500, fade linear a 0 nos 500 ms finais, depois some', () => {
    const s = stroke('a', 1000, pts(1000, 1050))
    // último ponto em 1050 → some em 4050; fade de 3550 a 4050
    const at = (t: number) => visibleStrokesAt([s], [], t, 3000)
    expect(at(3550)[0].alpha).toBe(1)
    expect(at(3800)[0].alpha).toBeCloseTo(0.5)
    expect(at(3950)[0].alpha).toBeCloseTo(0.2)
    expect(at(4050)).toHaveLength(0)
    expect(at(9000)).toHaveLength(0)
  })

  it('autoFadeMs <= 0 equivale a desligado', () => {
    const s = stroke('a', 1000, pts(1000))
    expect(visibleStrokesAt([s], [], 99999, 0)[0].alpha).toBe(1)
  })

  it('autoFadeMs menor que 500 ainda limita alpha a 1', () => {
    const s = stroke('a', 1000, pts(1000))
    expect(visibleStrokesAt([s], [], 1000, 200)[0].alpha).toBeLessThanOrEqual(1)
    expect(visibleStrokesAt([s], [], 1100, 200)[0].alpha).toBeCloseTo(0.2)
  })

  it('múltiplos traços mantêm ordem original', () => {
    const a = stroke('a', 1000, pts(1000))
    const b = stroke('b', 2000, pts(2000))
    const c = stroke('c', 3000, pts(3000))
    expect(visibleStrokesAt([a, b, c], [], 2500, null).map((v) => v.stroke.id)).toEqual(['a', 'b'])
  })
})
