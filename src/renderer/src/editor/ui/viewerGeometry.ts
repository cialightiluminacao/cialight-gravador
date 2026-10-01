// Geometria do visualizador (pura): caixas das camadas de mídia em pixels do canvas do projeto,
// teste de clique e a matemática da manipulação direta (snap ao centro, escala por canto, rotação).
import { resolveFrame } from '@shared/editor/resolve'
import type { Project, Us } from '@shared/editor/project'
import { layerMatrix, type Rotation } from '../engine/compositor/matrix'

export interface ItemBox {
  itemId: string
  /** Centro e tamanho em pixels do canvas do projeto; rotação em graus (horária). */
  cx: number
  cy: number
  w: number
  h: number
  rotation: number
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br'
export interface Pt { x: number; y: number }

/** Camadas de mídia visíveis em tUs (fundo → topo), com o mesmo tamanho que o compositor desenha. */
export function itemBoxes(p: Project, tUs: Us): ItemBox[] {
  const W = p.canvas.width
  const H = p.canvas.height
  const out: ItemBox[] = []
  for (const l of resolveFrame(p, tUs)) {
    if (l.kind !== 'media') continue
    const a = p.assets.find((x) => x.id === l.assetId)
    const src = { w: a?.video?.width || W, h: a?.video?.height || H, rotation: (a?.video?.rotation ?? 0) as Rotation }
    const g = layerMatrix({ rect: l.rect, fit: l.fit, crop: l.crop }, src, { w: W, h: H })
    out.push({ itemId: l.itemId, cx: l.rect.cx * W, cy: l.rect.cy * H, w: g.size[0], h: g.size[1], rotation: l.rect.rotation })
  }
  return out
}

/** Ponto no referencial da caixa (sem rotação, origem no centro). */
function toLocal(b: ItemBox, x: number, y: number): Pt {
  const th = (-b.rotation * Math.PI) / 180
  const dx = x - b.cx
  const dy = y - b.cy
  return { x: dx * Math.cos(th) - dy * Math.sin(th), y: dx * Math.sin(th) + dy * Math.cos(th) }
}

/** Item mais ao topo sob (x, y) em pixels do canvas; null se nenhum. */
export function hitTest(boxes: ItemBox[], x: number, y: number): string | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i]
    const l = toLocal(b, x, y)
    if (Math.abs(l.x) <= b.w / 2 && Math.abs(l.y) <= b.h / 2) return b.itemId
  }
  return null
}

const SNAP = 0.01

/** Guia de centro: valor normalizado a ±1 % de 0,5 gruda em 0,5. */
export function snapCenter(v: number): { value: number; snapped: boolean } {
  return Math.abs(v - 0.5) <= SNAP ? { value: 0.5, snapped: true } : { value: v, snapped: false }
}

/** Canto da caixa (pixels do canvas), já rotacionado. */
export function cornerPoint(b: ItemBox, c: Corner): Pt {
  const sx = c === 'tl' || c === 'bl' ? -0.5 : 0.5
  const sy = c === 'tl' || c === 'tr' ? -0.5 : 0.5
  const th = (b.rotation * Math.PI) / 180
  const lx = sx * b.w
  const ly = sy * b.h
  return { x: b.cx + lx * Math.cos(th) - ly * Math.sin(th), y: b.cy + lx * Math.sin(th) + ly * Math.cos(th) }
}

const OPPOSITE: Record<Corner, Corner> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' }

/**
 * Escala arrastando um canto até `pointer`: fator sobre o tamanho inicial (projeção na diagonal) e o
 * novo centro. keepCenter (Shift): escala em torno do centro; senão o canto oposto fica parado.
 */
export function cornerScale(b: ItemBox, corner: Corner, pointer: Pt, keepCenter: boolean): { factor: number; cx: number; cy: number } {
  const h0 = cornerPoint(b, corner)
  const anchor = keepCenter ? { x: b.cx, y: b.cy } : cornerPoint(b, OPPOSITE[corner])
  const dx = h0.x - anchor.x
  const dy = h0.y - anchor.y
  const len2 = dx * dx + dy * dy || 1
  const factor = Math.max(0.01, ((pointer.x - anchor.x) * dx + (pointer.y - anchor.y) * dy) / len2)
  if (keepCenter) return { factor, cx: b.cx, cy: b.cy }
  return { factor, cx: anchor.x + (dx * factor) / 2, cy: anchor.y + (dy * factor) / 2 }
}

/** Rotação (graus) após girar de `from` até `to` em torno de `center`, partindo de `start`; Shift: passos de 15°. */
export function rotateAngle(center: Pt, from: Pt, to: Pt, start: number, step15: boolean): number {
  const a0 = Math.atan2(from.y - center.y, from.x - center.x)
  const a1 = Math.atan2(to.y - center.y, to.x - center.x)
  let deg = start + ((a1 - a0) * 180) / Math.PI
  deg = ((((deg + 180) % 360) + 360) % 360) - 180 // −180…180
  return step15 ? Math.round(deg / 15) * 15 : deg
}
