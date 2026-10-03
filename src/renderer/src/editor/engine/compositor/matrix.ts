// Geometria das camadas (pura, sem WebGL): quad local [0,1]² (x para a direita, y para baixo, como a
// imagem exibida) → clip space (−1..1, y para cima).
// Regra de tamanho do editor: o tamanho base é a fonte (já cortada e rotacionada) ajustada por `fit`
// ao canvas; `scale` multiplica esse tamanho; (cx, cy) é o centro em coordenadas normalizadas do
// canvas (y para baixo); `rotation` em graus, horária na tela, em torno do centro (em pixels, sem
// distorcer pelo aspecto do canvas).

import { layerBase } from '@shared/editor/layerGeometry'

export type Mat3 = Float32Array
export type Rotation = 0 | 90 | 180 | 270

export interface LayerGeometryInput {
  rect: { cx: number; cy: number; scale: number; rotation: number }
  fit: 'contain' | 'cover' | 'fill'
  crop: { l: number; t: number; r: number; b: number }
}

export interface LayerGeometry {
  /** Coluna-maior (convenção GL), aplica-se a vec3(a, 1) com a ∈ [0,1]². */
  mat: Mat3
  /** Recorte em coordenadas da imagem exibida (já rotacionada), origem em cima à esquerda: [u0, v0, u1, v1]. */
  uv: [number, number, number, number]
  /** Tamanho da camada em pixels do canvas (para máscaras e bordas). */
  size: [number, number]
}

export function layerMatrix(layer: LayerGeometryInput, src: { w: number; h: number; rotation: Rotation }, canvas: { w: number; h: number }): LayerGeometry {
  // corte e fit: a mesma conta da privacidade (shared/editor/layerGeometry)
  const { uv, bw, bh } = layerBase(layer.crop, layer.fit, src, canvas)
  const W = canvas.w
  const H = canvas.h
  const sx = bw * layer.rect.scale
  const sy = bh * layer.rect.scale
  const cx = layer.rect.cx * W
  const cy = layer.rect.cy * H
  const th = (layer.rect.rotation * Math.PI) / 180
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  // pixel p = c + R·((a − ½)·s); clip = (2p.x/W − 1, 1 − 2p.y/H)
  const m00 = (2 / W) * cos * sx
  const m01 = (-2 / W) * sin * sy
  const m02 = (2 / W) * (cx - (cos * sx) / 2 + (sin * sy) / 2) - 1
  const m10 = (-2 / H) * sin * sx
  const m11 = (-2 / H) * cos * sy
  const m12 = 1 - (2 / H) * (cy - (sin * sx) / 2 - (cos * sy) / 2)
  return { mat: new Float32Array([m00, m10, 0, m01, m11, 0, m02, m12, 1]), uv, size: [sx, sy] }
}

/**
 * Quad de w×h px do canvas cujo ponto `anchor` (px dentro do quad, y para baixo) fica no centro (cx, cy) do rect;
 * `scale` e `rotation` (graus, horária) em torno dele. Texto e formas (F5): a rasterização tem margem em volta da
 * caixa, e é o centro da caixa que fica no centro do transform.
 */
export function anchoredMatrix(rect: LayerGeometryInput['rect'], w: number, h: number, anchor: { x: number; y: number }, canvas: { w: number; h: number }): Mat3 {
  const W = canvas.w
  const H = canvas.h
  const s = rect.scale
  const th = (rect.rotation * Math.PI) / 180
  const cos = Math.cos(th) * s
  const sin = Math.sin(th) * s
  const cx = rect.cx * W
  const cy = rect.cy * H
  // pixel p = c + s·R·(a·(w,h) − anchor); clip = (2p.x/W − 1, 1 − 2p.y/H)
  const m00 = (2 / W) * cos * w
  const m01 = (-2 / W) * sin * h
  const m02 = (2 / W) * (cx - cos * anchor.x + sin * anchor.y) - 1
  const m10 = (-2 / H) * sin * w
  const m11 = (-2 / H) * cos * h
  const m12 = 1 - (2 / H) * (cy - sin * anchor.x - cos * anchor.y)
  return new Float32Array([m00, m10, 0, m01, m11, 0, m02, m12, 1])
}

/** Aplica a matriz (coluna-maior) a um ponto do quad local. */
export function applyMat3(m: Mat3, x: number, y: number): [number, number] {
  return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]
}
