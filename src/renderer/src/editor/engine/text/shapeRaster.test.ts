import { describe, expect, it } from 'vitest'
import { DEFAULT_SHAPE_BOX } from '@shared/editor/project'
import { arrowGeometry, shapeBoxPx, shapeCacheKey, shapeVisible, spotlightRegion, strokePx } from './shapeRaster'

const F = { W: 1920, H: 1080 }
const base = { shape: 'rect' as const, fill: '#ffffff', stroke: 'none', strokeWidth: 0 }

describe('shapeRaster (partes puras)', () => {
  it('caixa = box.w·W × box.h·H; sem box, a padrão 0,3×0,2', () => {
    expect(shapeBoxPx({ box: { w: 0.25, h: 0.1 } }, F)).toEqual({ w: 480, h: 108 })
    expect(shapeBoxPx({}, F)).toEqual({ w: DEFAULT_SHAPE_BOX.w * 1920, h: DEFAULT_SHAPE_BOX.h * 1080 })
  })
  it('traço em px de referência 1080 (lado menor)', () => {
    expect(strokePx({ strokeWidth: 12 }, F)).toBe(12)
    expect(strokePx({ strokeWidth: 12 }, { W: 1280, H: 720 })).toBe(8)
    expect(strokePx({ strokeWidth: 12 }, { W: 1080, H: 1920 })).toBe(12)
  })
  it('seta: cabeça proporcional ao traço, cabendo na caixa', () => {
    expect(arrowGeometry(480, 108, 12)).toEqual({ shaft: 12, headLen: 48, headHalf: 30 })
    expect(arrowGeometry(60, 20, 12)).toEqual({ shaft: 12, headLen: 30, headHalf: 12 })
  })
  it('chave do cache: muda com cor/traço/caixa em px/quadro; não com posição', () => {
    const k = shapeCacheKey({ ...base, box: { w: 0.3, h: 0.2 } }, F)
    expect(shapeCacheKey({ ...base, box: { w: 0.3, h: 0.2 } }, F)).toBe(k)
    expect(shapeCacheKey({ ...base, fill: '#000000', box: { w: 0.3, h: 0.2 } }, F)).not.toBe(k)
    expect(shapeCacheKey({ ...base, box: { w: 0.31, h: 0.2 } }, F)).not.toBe(k)
    expect(shapeCacheKey({ ...base, box: { w: 0.3, h: 0.2 } }, { W: 1280, H: 720 })).not.toBe(k)
  })
  it('visível só com preenchimento ou contorno', () => {
    expect(shapeVisible(base)).toBe(true)
    expect(shapeVisible({ ...base, fill: 'none' })).toBe(false)
    expect(shapeVisible({ ...base, fill: 'none', stroke: '#ff0000', strokeWidth: 4 })).toBe(true)
  })
  it('holofote: região = caixa × escala, centro e rotação do transform; seta ou dim 0 não têm', () => {
    const rect = { cx: 0.4, cy: 0.6, scale: 2, rotation: 30 }
    expect(spotlightRegion({ item: { shape: 'ellipse', box: { w: 0.3, h: 0.45 }, spotlight: { dim: 0.6 } }, rect })).toEqual({ shape: 'ellipse', x: 0.4, y: 0.6, w: 0.6, h: 0.9, rotation: 30, dim: 0.6 })
    expect(spotlightRegion({ item: { shape: 'arrow', spotlight: { dim: 0.6 } }, rect })).toBeNull()
    expect(spotlightRegion({ item: { shape: 'rect', spotlight: { dim: 0 } }, rect })).toBeNull()
    expect(spotlightRegion({ item: { shape: 'rect' }, rect })).toBeNull()
  })
})
