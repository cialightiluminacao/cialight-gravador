// Geometria base de uma camada de mídia (pura): corte → trecho da fonte exibido e tamanho no quadro pelo `fit`, antes
// de escala/rotação/posição. Usada pelo compositor (matrix.layerMatrix) e pela privacidade (mapear um ponto do quadro
// para o conteúdo do clipe), para as duas seguirem a mesma conta.

export type SourceRotation = 0 | 90 | 180 | 270

export interface LayerBase {
  /** Recorte em coordenadas da imagem exibida (já rotacionada), origem em cima à esquerda: [u0, v0, u1, v1]. */
  uv: [number, number, number, number]
  /** Tamanho da imagem exibida (fonte já rotacionada), px da fonte. */
  dw: number; dh: number
  /** Tamanho do trecho cortado, px da fonte. */
  cw: number; ch: number
  /** Tamanho da camada no quadro com escala 1, px do quadro. */
  bw: number; bh: number
}

const MIN_SPAN = 1e-4
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export function layerBase(
  crop: { l: number; t: number; r: number; b: number },
  fit: 'contain' | 'cover' | 'fill',
  src: { w: number; h: number; rotation: SourceRotation },
  canvas: { w: number; h: number }
): LayerBase {
  const u0 = clamp01(crop.l)
  const v0 = clamp01(crop.t)
  const u1 = Math.max(u0 + MIN_SPAN, clamp01(1 - crop.r))
  const v1 = Math.max(v0 + MIN_SPAN, clamp01(1 - crop.b))
  const turned = src.rotation === 90 || src.rotation === 270
  const dw = Math.max(1, turned ? src.h : src.w)
  const dh = Math.max(1, turned ? src.w : src.h)
  const cw = dw * (u1 - u0)
  const ch = dh * (v1 - v0)
  let bw: number
  let bh: number
  if (fit === 'fill') {
    bw = canvas.w
    bh = canvas.h
  } else {
    const k = fit === 'cover' ? Math.max(canvas.w / cw, canvas.h / ch) : Math.min(canvas.w / cw, canvas.h / ch)
    bw = cw * k
    bh = ch * k
  }
  return { uv: [u0, v0, u1, v1], dw, dh, cw, ch, bw, bh }
}
