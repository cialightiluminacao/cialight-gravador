// Geometria da PiP (webcam picture-in-picture). Coordenadas normalizadas 0–1
// em relação ao frame da tela; conversão para pixels só em pipPixelRect.
import type { PipKeyframe, PipShape } from '../types'

/** Retângulo normalizado da PiP em um instante (resultado de pipRectAt). */
export interface PipRect {
  x: number
  y: number
  w: number
  h: number
  shape: PipShape
  visible: boolean
}

/** Retângulo em pixels + raio de canto (círculo: raio = lado/2; rounded: 6 % do menor lado). */
export interface PipPixelRect {
  x: number
  y: number
  w: number
  h: number
  radius: number
}

/** Duração padrão da suavização de movimento entre keyframes (ms). */
export const PIP_EASE_MS = 150
/** Menor tamanho normalizado permitido para largura/altura da PiP. */
export const PIP_MIN_SIZE = 0.05

const toRect = (k: PipKeyframe): PipRect => ({ x: k.x, y: k.y, w: k.w, h: k.h, shape: k.shape, visible: k.visible })

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p

/**
 * Retângulo da PiP no instante `tMs`.
 * - Sem keyframes → null.
 * - Antes do primeiro keyframe → primeiro.
 * - Vigente = último keyframe com tMs <= t. Se t estiver em [vigente.tMs, vigente.tMs + easeMs)
 *   e houver keyframe anterior, x/y/w/h interpolam linearmente do anterior para o vigente
 *   (o movimento acontece logo após o keyframe ser registrado, suavizado por easeMs).
 * - shape e visible nunca interpolam: vêm sempre do keyframe vigente.
 */
export function pipRectAt(keyframes: PipKeyframe[], tMs: number, easeMs = PIP_EASE_MS): PipRect | null {
  if (keyframes.length === 0) return null
  const kfs = keyframes.slice().sort((a, b) => a.tMs - b.tMs)
  if (tMs < kfs[0].tMs) return toRect(kfs[0])

  // Índice do último keyframe com tMs <= t.
  let i = 0
  for (let j = 1; j < kfs.length; j++) {
    if (kfs[j].tMs <= tMs) i = j
    else break
  }
  const cur = kfs[i]
  if (i === 0 || easeMs <= 0) return toRect(cur)

  const elapsed = tMs - cur.tMs
  if (elapsed >= easeMs) return toRect(cur)

  const prev = kfs[i - 1]
  const p = elapsed / easeMs
  return {
    x: lerp(prev.x, cur.x, p),
    y: lerp(prev.y, cur.y, p),
    w: lerp(prev.w, cur.w, p),
    h: lerp(prev.h, cur.h, p),
    shape: cur.shape,
    visible: cur.visible
  }
}

/**
 * Converte o retângulo normalizado para pixels no frame W×H.
 * Círculo: lado = min(w·W, h·H), centralizado no retângulo, radius = lado/2.
 * Rounded: retângulo inteiro, radius = 6 % do menor lado.
 */
export function pipPixelRect(r: PipRect, W: number, H: number): PipPixelRect {
  const rx = r.x * W
  const ry = r.y * H
  const rw = r.w * W
  const rh = r.h * H
  if (r.shape === 'circle') {
    const side = Math.min(rw, rh)
    return { x: rx + (rw - side) / 2, y: ry + (rh - side) / 2, w: side, h: side, radius: side / 2 }
  }
  return { x: rx, y: ry, w: rw, h: rh, radius: 0.06 * Math.min(rw, rh) }
}

const clamp01 = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** Mantém x,y,w,h em [0,1] com x+w <= 1 e y+h <= 1 (w/h entre PIP_MIN_SIZE e 1). */
export function clampPip(r: PipRect): PipRect {
  const w = clamp01(r.w, PIP_MIN_SIZE, 1)
  const h = clamp01(r.h, PIP_MIN_SIZE, 1)
  return {
    x: clamp01(r.x, 0, 1 - w),
    y: clamp01(r.y, 0, 1 - h),
    w,
    h,
    shape: r.shape,
    visible: r.visible
  }
}
