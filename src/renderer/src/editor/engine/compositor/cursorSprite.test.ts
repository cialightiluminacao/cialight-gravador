import { describe, expect, it } from 'vitest'
import { toScreen, type ClipFrame } from '@shared/editor/contentPose'
import { layerBase } from '@shared/editor/layerGeometry'
import { CURSOR_ARROW, CURSOR_ARROW_BOX, CURSOR_ARROW_HOTSPOT, contentToLocal, elementMatrix } from './cursorSprite'
import { applyMat3, layerMatrix } from './matrix'

// Geometria da sobreposição do cursor: o ponto do elemento (anel/seta) cai, na tela, exatamente onde
// contentPose.toScreen leva o mesmo ponto da fonte — com corte, fit, escala, rotação e espelho.

const W = 1080, H = 1920
const src = { w: 1920, h: 1080, rotation: 0 as const }
const toPx = (clip: [number, number]): { x: number; y: number } => ({ x: ((clip[0] + 1) / 2) * W, y: ((1 - clip[1]) / 2) * H })
const mul = (a: Float32Array, b: Float32Array): Float32Array => {
  const o = new Float32Array(9)
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]
  return o
}

describe('sobreposição do cursor: elemento → tela pela matriz da camada', () => {
  const cases = [
    { name: 'identidade (fit cobrir num 16:9)', rect: { cx: 0.5, cy: 0.5, scale: 1, rotation: 0 }, crop: { l: 0, t: 0, r: 0, b: 0 }, fit: 'cover' as const, mirror: false },
    { name: 'zoom 2× deslocado', rect: { cx: 0.62, cy: 0.41, scale: 2, rotation: 0 }, crop: { l: 0, t: 0, r: 0, b: 0 }, fit: 'cover' as const, mirror: false },
    { name: 'corte + rotação + espelho + conter', rect: { cx: 0.55, cy: 0.45, scale: 1.3, rotation: 17 }, crop: { l: 0.1, t: 0.05, r: 0.2, b: 0 }, fit: 'contain' as const, mirror: true },
    { name: 'esticar (não conforme)', rect: { cx: 0.5, cy: 0.5, scale: 0.8, rotation: -30 }, crop: { l: 0, t: 0.2, r: 0, b: 0 }, fit: 'fill' as const, mirror: false }
  ]
  it.each(cases)('$name: âncora do elemento = toScreen do ponto da fonte (±1e-3 px)', ({ rect, crop, fit, mirror }) => {
    const geom = layerMatrix({ rect, crop, fit }, src, { w: W, h: H })
    const g = layerBase(crop, fit, src, { w: W, h: H })
    const cf: ClipFrame = { cx: rect.cx, cy: rect.cy, rotation: rect.rotation, sx: g.bw * rect.scale, sy: g.bh * rect.scale, mirror, g, W, H }
    const space = { uv: geom.uv, mirror, refW: 1920, refH: 1080 }
    for (const [x, y] of [[0.47, 0.5], [0.3, 0.62], [0.71, 0.33]]) {
      const want = toScreen(cf, x * g.dw, y * g.dh)
      // anel: centro (0,5; 0,5) do elemento
      const ring = mul(geom.mat, elementMatrix(space, x, y, 40, 40, 0.5, 0.5))
      const a = toPx(applyMat3(ring, 0.5, 0.5))
      expect(Math.abs(a.x - want.x)).toBeLessThan(1e-3)
      expect(Math.abs(a.y - want.y)).toBeLessThan(1e-3)
      // seta: a ponta (hotspot) do sprite
      const arrow = mul(geom.mat, elementMatrix(space, x, y, CURSOR_ARROW_BOX.w * 2, CURSOR_ARROW_BOX.h * 2, CURSOR_ARROW_HOTSPOT.u, CURSOR_ARROW_HOTSPOT.v))
      const b = toPx(applyMat3(arrow, CURSOR_ARROW_HOTSPOT.u, CURSOR_ARROW_HOTSPOT.v))
      expect(Math.abs(b.x - want.x)).toBeLessThan(1e-3)
      expect(Math.abs(b.y - want.y)).toBeLessThan(1e-3)
    }
  })

  it('o tamanho do anel na tela escala com a camada (px da fonte × escala da camada)', () => {
    const rect = { cx: 0.5, cy: 0.5, scale: 2, rotation: 0 }
    const crop = { l: 0, t: 0, r: 0, b: 0 }
    const geom = layerMatrix({ rect, crop, fit: 'contain' }, src, { w: 1920, h: 1080 })
    const m = mul(geom.mat, elementMatrix({ uv: geom.uv, mirror: false, refW: 1920, refH: 1080 }, 0.5, 0.5, 40, 40, 0.5, 0.5))
    const l = applyMat3(m, 0, 0.5), r = applyMat3(m, 1, 0.5)
    expect(((r[0] - l[0]) / 2) * 1920).toBeCloseTo(80, 3)
  })

  it('espelho: o ponto vai para o lado espelhado do quad e a seta vira', () => {
    const s = { uv: [0, 0, 1, 1] as [number, number, number, number], mirror: true, refW: 100, refH: 100 }
    expect(contentToLocal(s, 0.2, 0.3)).toEqual([0.8, 0.3])
    expect(elementMatrix(s, 0.2, 0.3, 10, 10, 0, 0)[0]).toBeLessThan(0)
  })

  it('seta: ponta em (0, 0), dentro da caixa com margem', () => {
    expect(CURSOR_ARROW[0]).toEqual([0, 0])
    expect(CURSOR_ARROW_HOTSPOT.u).toBeGreaterThan(0)
    expect(CURSOR_ARROW_BOX.h).toBeGreaterThan(18)
  })
})
