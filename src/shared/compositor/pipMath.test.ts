import { describe, expect, it } from 'vitest'
import type { PipKeyframe } from '../types'
import { clampPip, pipPixelRect, pipRectAt, type PipRect } from './pipMath'

const kf = (tMs: number, x: number, y: number, extra: Partial<PipKeyframe> = {}): PipKeyframe => ({
  tMs,
  x,
  y,
  w: 0.2,
  h: 0.3,
  shape: 'circle',
  visible: true,
  ...extra
})

describe('pipRectAt', () => {
  it('sem keyframes → null', () => {
    expect(pipRectAt([], 1000)).toBeNull()
  })

  it('antes do primeiro keyframe → primeiro', () => {
    const r = pipRectAt([kf(1000, 0.5, 0.5), kf(2000, 0.1, 0.1)], 0)
    expect(r).toMatchObject({ x: 0.5, y: 0.5, w: 0.2, h: 0.3, shape: 'circle', visible: true })
  })

  it('depois do último keyframe (além do easeMs) → último', () => {
    const r = pipRectAt([kf(0, 0.5, 0.5), kf(1000, 0.1, 0.1)], 5000)
    expect(r).toMatchObject({ x: 0.1, y: 0.1 })
  })

  it('exatamente no keyframe seguinte ainda está na posição anterior (movimento começa a partir dele)', () => {
    const r = pipRectAt([kf(0, 0.5, 0.5), kf(1000, 0.1, 0.1)], 1000)
    expect(r!.x).toBeCloseTo(0.5)
    expect(r!.y).toBeCloseTo(0.5)
  })

  it('interpola 50 % em t = kf.t + 75 com easeMs = 150', () => {
    const r = pipRectAt([kf(0, 0.5, 0.5, { w: 0.2, h: 0.2 }), kf(1000, 0.1, 0.1, { w: 0.4, h: 0.4 })], 1075)
    expect(r!.x).toBeCloseTo(0.3)
    expect(r!.y).toBeCloseTo(0.3)
    expect(r!.w).toBeCloseTo(0.3)
    expect(r!.h).toBeCloseTo(0.3)
  })

  it('após kf.t + easeMs segura o valor do keyframe', () => {
    const r = pipRectAt([kf(0, 0.5, 0.5), kf(1000, 0.1, 0.1)], 1150)
    expect(r!.x).toBeCloseTo(0.1)
    expect(r!.y).toBeCloseTo(0.1)
  })

  it('entre keyframes (fora da janela de ease) segura o último keyframe com tMs <= t', () => {
    const r = pipRectAt([kf(0, 0.5, 0.5), kf(1000, 0.1, 0.1), kf(3000, 0.9, 0.9)], 2500)
    expect(r).toMatchObject({ x: 0.1, y: 0.1 })
  })

  it('shape e visible não interpolam: usam o keyframe com tMs <= t', () => {
    const r = pipRectAt(
      [kf(0, 0.5, 0.5, { shape: 'circle', visible: true }), kf(1000, 0.1, 0.1, { shape: 'rounded', visible: false })],
      1075
    )
    expect(r!.shape).toBe('rounded')
    expect(r!.visible).toBe(false)
  })

  it('visible=false é preservado no keyframe vigente', () => {
    const r = pipRectAt([kf(0, 0.5, 0.5, { visible: false })], 10)
    expect(r!.visible).toBe(false)
  })

  it('ordena keyframes fora de ordem defensivamente', () => {
    const r = pipRectAt([kf(2000, 0.9, 0.9), kf(0, 0.1, 0.1)], 500)
    expect(r).toMatchObject({ x: 0.1, y: 0.1 })
  })

  it('easeMs = 0 salta direto para o novo keyframe', () => {
    const r = pipRectAt([kf(0, 0.5, 0.5), kf(1000, 0.1, 0.1)], 1000, 0)
    expect(r).toMatchObject({ x: 0.1, y: 0.1 })
  })

  it('não muta a lista original', () => {
    const list = [kf(2000, 0.9, 0.9), kf(0, 0.1, 0.1)]
    pipRectAt(list, 500)
    expect(list[0].tMs).toBe(2000)
  })
})

describe('pipPixelRect', () => {
  it('círculo: lado = min(w*W, h*H), centralizado no retângulo, radius = lado/2', () => {
    const r: PipRect = { x: 0.5, y: 0.5, w: 0.2, h: 0.4, shape: 'circle', visible: true }
    // W=1000, H=500 → rect px = (500, 250, 200, 200) → lado 200 (empate)
    expect(pipPixelRect(r, 1000, 500)).toEqual({ x: 500, y: 250, w: 200, h: 200, radius: 100 })
    // W=1000, H=1000 → rect px = (500, 500, 200, 400) → lado 200, centralizado verticalmente
    expect(pipPixelRect(r, 1000, 1000)).toEqual({ x: 500, y: 600, w: 200, h: 200, radius: 100 })
  })

  it('rounded: retângulo inteiro com radius = 6 % do menor lado', () => {
    const r: PipRect = { x: 0.1, y: 0.2, w: 0.5, h: 0.5, shape: 'rounded', visible: true }
    const px = pipPixelRect(r, 1000, 800)
    expect(px.x).toBe(100)
    expect(px.y).toBe(160)
    expect(px.w).toBe(500)
    expect(px.h).toBe(400)
    expect(px.radius).toBeCloseTo(24)
  })
})

describe('clampPip', () => {
  const base: PipRect = { x: 0, y: 0, w: 0.2, h: 0.2, shape: 'circle', visible: true }

  it('mantém valores já válidos', () => {
    const r = { ...base, x: 0.3, y: 0.4 }
    expect(clampPip(r)).toEqual(r)
  })

  it('empurra para dentro quando x+w > 1 ou y+h > 1', () => {
    const c = clampPip({ ...base, x: 0.95, y: 0.9 })
    expect(c.x).toBeCloseTo(0.8)
    expect(c.y).toBeCloseTo(0.8)
  })

  it('valores negativos viram 0', () => {
    const c = clampPip({ ...base, x: -0.5, y: -1 })
    expect(c.x).toBe(0)
    expect(c.y).toBe(0)
  })

  it('reduz w/h maiores que 1 e respeita mínimo 0.05', () => {
    const c = clampPip({ ...base, x: 0.5, w: 2, h: 0.001 })
    expect(c.w).toBe(1)
    expect(c.x).toBe(0)
    expect(c.h).toBe(0.05)
  })

  it('preserva shape e visible', () => {
    const c = clampPip({ ...base, shape: 'rounded', visible: false })
    expect(c.shape).toBe('rounded')
    expect(c.visible).toBe(false)
  })
})
