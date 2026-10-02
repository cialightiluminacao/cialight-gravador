// Formas (F5) rasterizadas em Canvas 2D, no mesmo cache LRU do texto. Escolha: Canvas 2D em vez de shader porque dá
// antisserrilhado, cantos arredondados, contorno centrado na borda e a seta (haste + cabeça) com o mesmo código, e a
// forma quase nunca muda de quadro em quadro (a caixa em px só depende de box·W×H; escala/rotação do transform vão no
// quad) — um upload por mudança, não por quadro. O holofote (escurecer fora) é um passe de shader (EffectPass).
// Unidades: caixa = box.w·W × box.h·H px (padrão DEFAULT_SHAPE_BOX); strokeWidth em px de um quadro de lado menor 1080.
import { DEFAULT_SHAPE_BOX, type ShapeItem } from '@shared/editor/project'
import type { Rect } from '@shared/editor/resolve'
import { TEXT_REFERENCE_SHORT, type FrameSize } from './textRaster'

export interface ShapeRaster {
  canvas: OffscreenCanvas
  w: number
  h: number
  /** Centro da caixa dentro do quad (px): fica em rect.cx/cy. */
  anchor: { x: number; y: number }
  box: { w: number; h: number }
}

type ShapeFields = Pick<ShapeItem, 'shape' | 'fill' | 'stroke' | 'strokeWidth' | 'box' | 'cornerRadius'>

/** Caixa da forma em px da saída (antes da escala do transform). */
export function shapeBoxPx(item: Pick<ShapeItem, 'box'>, frame: FrameSize): { w: number; h: number } {
  const b = item.box ?? DEFAULT_SHAPE_BOX
  return { w: Math.abs(b.w) * frame.W, h: Math.abs(b.h) * frame.H }
}

export const strokePx = (item: Pick<ShapeItem, 'strokeWidth'>, frame: FrameSize): number => (Math.max(0, item.strokeWidth) * Math.min(frame.W, frame.H)) / TEXT_REFERENCE_SHORT

const paint = (c: string): string | null => (c && c !== 'none' ? c : null)

export function shapeCacheKey(item: ShapeFields, frame: FrameSize): string {
  const b = shapeBoxPx(item, frame)
  return JSON.stringify(['s', item.shape, item.fill, item.stroke, item.strokeWidth, item.cornerRadius ?? 0, b.w, b.h, frame.W, frame.H])
}

/** A forma desenha alguma coisa (preenchimento ou contorno)? Holofote sem cor só escurece. */
export function shapeVisible(item: ShapeFields): boolean {
  return !!paint(item.fill) || (!!paint(item.stroke) && (item.strokeWidth > 0 || item.shape === 'arrow'))
}

/** Seta: haste com a largura do traço e cabeça proporcional a ele (comprimento 4×, meia-largura 2,5×; cabem na caixa). */
export function arrowGeometry(bw: number, bh: number, sw: number): { shaft: number; headLen: number; headHalf: number } {
  const shaft = Math.max(2, sw)
  const headLen = Math.min(0.5 * bw, 4 * shaft)
  const headHalf = Math.max(shaft, Math.min(bh / 2, 2.5 * shaft))
  return { shaft, headLen, headHalf }
}

/**
 * Rasteriza retângulo (cornerRadius = fração do lado menor da caixa), elipse ou seta (da borda esquerda-centro à
 * direita-centro) com preenchimento e contorno centrado na borda. Margem para metade do contorno + 2 px.
 */
export function rasterizeShape(item: ShapeFields, frame: FrameSize): ShapeRaster {
  const { w: bw, h: bh } = shapeBoxPx(item, frame)
  const sw = strokePx(item, frame)
  const fill = paint(item.fill)
  const stroke = paint(item.stroke)
  const arrow = item.shape === 'arrow' ? arrowGeometry(bw, bh, sw) : null
  const margin = Math.ceil((arrow ? Math.max(0, arrow.headHalf - bh / 2) : 0) + sw / 2 + 2)
  const w = bw + 2 * margin
  const h = bh + 2 * margin
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D indisponível para a forma')
  const x0 = margin
  const y0 = margin
  if (arrow) {
    const cy = y0 + bh / 2
    const shaftColor = stroke ?? fill
    const headColor = fill ?? stroke
    if (shaftColor) {
      ctx.strokeStyle = shaftColor
      ctx.lineWidth = arrow.shaft
      ctx.lineCap = 'butt'
      ctx.beginPath()
      ctx.moveTo(x0, cy)
      ctx.lineTo(x0 + bw - arrow.headLen * 0.9, cy)
      ctx.stroke()
    }
    if (headColor) {
      ctx.fillStyle = headColor
      ctx.beginPath()
      ctx.moveTo(x0 + bw - arrow.headLen, cy - arrow.headHalf)
      ctx.lineTo(x0 + bw, cy)
      ctx.lineTo(x0 + bw - arrow.headLen, cy + arrow.headHalf)
      ctx.closePath()
      ctx.fill()
    }
  } else {
    ctx.beginPath()
    if (item.shape === 'ellipse') ctx.ellipse(x0 + bw / 2, y0 + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2)
    else ctx.roundRect(x0, y0, bw, bh, Math.max(0, Math.min(0.5, item.cornerRadius ?? 0)) * Math.min(bw, bh))
    if (fill) {
      ctx.fillStyle = fill
      ctx.fill()
    }
    if (stroke && sw > 0) {
      ctx.strokeStyle = stroke
      ctx.lineWidth = sw
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
  }
  return { canvas, w: canvas.width, h: canvas.height, anchor: { x: margin + bw / 2, y: margin + bh / 2 }, box: { w: bw, h: bh } }
}

/**
 * Região do holofote (frações do quadro, como EffectLayer.region): a caixa × escala do transform, centrada e girada
 * como a forma. null = forma sem holofote (ou seta, que não tem "dentro").
 */
export function spotlightRegion(layer: { item: Pick<ShapeItem, 'shape' | 'box' | 'spotlight'>; rect: Rect }): { shape: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; rotation: number; dim: number } | null {
  const it = layer.item
  if (!it.spotlight || !(it.spotlight.dim > 0) || it.shape === 'arrow') return null
  const b = it.box ?? DEFAULT_SHAPE_BOX
  return { shape: it.shape, x: layer.rect.cx, y: layer.rect.cy, w: Math.abs(b.w) * layer.rect.scale, h: Math.abs(b.h) * layer.rect.scale, rotation: layer.rect.rotation, dim: Math.min(1, it.spotlight.dim) }
}
