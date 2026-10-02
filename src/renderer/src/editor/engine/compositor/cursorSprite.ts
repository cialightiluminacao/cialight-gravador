// Sobreposição do cursor (F6) no compositor: geometria pura (sem WebGL) e o desenho da seta.
// Os elementos (anel, seta) são quads próprios cujo quad local e ∈ [0,1]² vai ao quad local da camada (a ∈ [0,1]²,
// o mesmo de matrix.layerMatrix) por uma matriz afim; a matriz da camada leva daí à tela. Assim o anel e a seta
// seguem transform/corte/fit/rotação/espelho pela MESMA conta da imagem (e de contentPose.toScreen).
import type { Mat3 } from './matrix'

/**
 * Seta do cursor ampliado: desenho próprio (ruling R9 — nada do bitmap do Windows), ponta (hotspot) em (0, 0),
 * unidades ~ px do cursor do Windows a 100 % (shared/editor/cursorOverlay: CURSOR_REFERENCE_HEIGHT). Branca com
 * contorno preto de 1,5 unidade por fora.
 */
export const CURSOR_ARROW: readonly (readonly [number, number])[] = [
  [0, 0], [0, 16], [3.8, 12.4], [6.3, 18], [8.7, 17], [6.3, 11.5], [11.2, 11.5]
]
export const CURSOR_ARROW_OUTLINE = 1.5
/** Margem (unidades) em volta da seta no sprite: contorno + antialias. */
const PAD = 2
const maxOf = (i: 0 | 1): number => Math.max(...CURSOR_ARROW.map((p) => p[i]))
/** Caixa do sprite (unidades) e a ponta em coordenadas de textura (0–1, y para baixo). */
export const CURSOR_ARROW_BOX = { w: maxOf(0) + 2 * PAD, h: maxOf(1) + 2 * PAD }
export const CURSOR_ARROW_HOTSPOT = { u: PAD / CURSOR_ARROW_BOX.w, v: PAD / CURSOR_ARROW_BOX.h }

/** Desenha a seta num canvas (px por unidade = `res`); fundo transparente. */
export function drawArrowSprite(res: number): OffscreenCanvas {
  const cv = new OffscreenCanvas(Math.ceil(CURSOR_ARROW_BOX.w * res), Math.ceil(CURSOR_ARROW_BOX.h * res))
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('canvas 2D indisponível para o sprite do cursor')
  ctx.setTransform(res, 0, 0, res, PAD * res, PAD * res)
  ctx.beginPath()
  CURSOR_ARROW.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
  // traço com o dobro da largura e o preenchimento por cima: sobra 1,5 unidade de contorno por fora
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2 * CURSOR_ARROW_OUTLINE
  ctx.strokeStyle = '#000000'
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  return cv
}

/** Como a fonte exibida vai ao quad local da camada: recorte (uv), espelho e o tamanho (px) da fonte de referência. */
export interface OverlaySpace { uv: [number, number, number, number]; mirror: boolean; refW: number; refH: number }

/** Ponto da fonte exibida (fração 0–1, sem corte) → quad local da camada (como o FS_MEDIA amostra: espelho em x). */
export function contentToLocal(s: OverlaySpace, x: number, y: number): [number, number] {
  const [u0, v0, u1, v1] = s.uv
  const ax = (x - u0) / (u1 - u0)
  return [s.mirror ? 1 - ax : ax, (y - v0) / (v1 - v0)]
}

/**
 * Matriz (coluna-maior) do quad de um elemento → quad local da camada: caixa de wPx × hPx px da fonte de referência
 * com o ponto (anchorU, anchorV) do elemento sobre o ponto (x, y) da fonte. Espelho: o elemento também espelha
 * (a seta aponta como o cursor gravado espelhado).
 */
export function elementMatrix(s: OverlaySpace, x: number, y: number, wPx: number, hPx: number, anchorU: number, anchorV: number): Mat3 {
  const [u0, v0, u1, v1] = s.uv
  const [ax, ay] = contentToLocal(s, x, y)
  const sx = ((s.mirror ? -1 : 1) * wPx) / (s.refW * (u1 - u0))
  const sy = hPx / (s.refH * (v1 - v0))
  return new Float32Array([sx, 0, 0, 0, sy, 0, ax - sx * anchorU, ay - sy * anchorV, 1])
}
