import { describe, expect, it } from 'vitest'
import type { PipKeyframe } from '@shared/types'
import { pipOverrideFor } from './pipChoice'

const kf = (tMs: number, visible: boolean): PipKeyframe => ({ tMs, x: 0.7, y: 0.6, w: 0.2, h: 0.35, shape: 'circle', visible })

describe('pipOverrideFor', () => {
  it('"como gravado" não sobrescreve nada', () => {
    expect(pipOverrideFor({ mode: 'original' }, 1920, 1080, [kf(0, true)])).toBeNull()
  })

  it('"fixa" sem keyframes gravados vira um único keyframe visível no canto pedido', () => {
    const r = pipOverrideFor({ mode: 'fixed', corner: 'br', size: 'm', shape: 'rounded' }, 1920, 1080, [])
    expect(r).toHaveLength(1)
    const k = r![0]
    expect(k.tMs).toBe(0)
    expect(k.visible).toBe(true)
    expect(k.shape).toBe('rounded')
    expect(k.w).toBeCloseTo(0.2)
    expect(k.h).toBeCloseTo(0.2 * (16 / 9))
    expect(k.x + k.w).toBeLessThan(1)
    expect(k.y + k.h).toBeLessThan(1)
    expect(k.x).toBeGreaterThan(0.5)
    expect(k.y).toBeGreaterThan(0.5)
  })

  it('"fixa" preserva a linha do tempo de visibilidade (câmera desligada com F2)', () => {
    const recorded = [kf(0, true), kf(3000, true), kf(5000, false), kf(9000, true)]
    const r = pipOverrideFor({ mode: 'fixed', corner: 'tl', size: 'p', shape: 'circle' }, 1920, 1080, recorded)!
    // keyframes redundantes (mesma visibilidade) são descartados; posição igual em todos
    expect(r.map((k) => [k.tMs, k.visible])).toEqual([
      [0, true],
      [5000, false],
      [9000, true]
    ])
    for (const k of r) {
      expect(k.x).toBeCloseTo(0.03)
      expect(k.w).toBeCloseTo(0.16)
      expect(k.shape).toBe('circle')
    }
  })

  it('ordena keyframes fora de ordem antes de filtrar', () => {
    const r = pipOverrideFor({ mode: 'fixed', corner: 'tr', size: 'g', shape: 'circle' }, 1280, 720, [kf(4000, false), kf(0, true)])!
    expect(r.map((k) => k.tMs)).toEqual([0, 4000])
    expect(r[1].visible).toBe(false)
  })
})
