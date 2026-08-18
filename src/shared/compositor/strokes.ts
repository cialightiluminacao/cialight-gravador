// Visibilidade de traços (anotações) em um instante: desenho progressivo,
// apagar individual (erasedAtMs), apagar tudo (clearEvents) e sumiço automático (autoFadeMs).
import type { Stroke, StrokePoint } from '../types'

/** Duração do fade final quando autoFadeMs está ativo (ms). */
export const STROKE_FADE_MS = 500

export interface VisibleStroke {
  stroke: Stroke
  /** Pontos a desenhar (já filtrados por tMs <= t; linha/seta reduzidas a [primeiro, último]). */
  points: StrokePoint[]
  /** 0–1 (fade linear nos últimos STROKE_FADE_MS quando autoFadeMs está ativo). */
  alpha: number
}

/** Alpha do traço no instante t: 1 até tMs+autoFade-500, depois fade linear a 0; null quando já sumiu. */
function strokeAlpha(strokeTMs: number, tMs: number, autoFadeMs: number | null): number | null {
  if (autoFadeMs == null || autoFadeMs <= 0) return 1
  const end = strokeTMs + autoFadeMs
  if (tMs >= end) return null
  const remaining = end - tMs
  if (remaining >= STROKE_FADE_MS) return 1
  return Math.min(1, Math.max(0, remaining / STROKE_FADE_MS))
}

/** Pontos visíveis conforme a ferramenta (progressivo p/ caneta; linha/seta = primeiro→último registrado). */
function pointsAt(stroke: Stroke, tMs: number): StrokePoint[] {
  const registered = stroke.points.filter((p) => p.tMs <= tMs)
  if (registered.length === 0) return registered
  if (stroke.tool === 'pen') return registered
  // Linha/seta: enquanto em andamento, do primeiro ponto até o último já registrado;
  // concluída (último ponto tMs <= t), primeiro e último ponto do traço.
  const first = registered[0]
  const last = registered[registered.length - 1]
  return registered.length === 1 ? [first] : [first, last]
}

/**
 * Traços visíveis no instante `tMs`.
 * Regras: stroke.tMs <= t; não erasedAtMs <= t; não existe clear com stroke.tMs < clear.tMs <= t;
 * pelo menos um ponto registrado (pt.tMs <= t); alpha por autoFadeMs (após o fade, some).
 * A ordem original dos traços é preservada.
 */
export function visibleStrokesAt(
  strokes: Stroke[],
  clears: { tMs: number }[],
  tMs: number,
  autoFadeMs: number | null
): VisibleStroke[] {
  const out: VisibleStroke[] = []
  for (const stroke of strokes) {
    if (stroke.tMs > tMs) continue
    if (stroke.erasedAtMs != null && stroke.erasedAtMs <= tMs) continue
    if (clears.some((c) => stroke.tMs < c.tMs && c.tMs <= tMs)) continue
    const anchorMs = stroke.points.length ? Math.max(stroke.tMs, stroke.points[stroke.points.length - 1].tMs) : stroke.tMs
    const alpha = strokeAlpha(anchorMs, tMs, autoFadeMs)
    if (alpha == null) continue
    const points = pointsAt(stroke, tMs)
    if (points.length === 0) continue
    out.push({ stroke, points, alpha })
  }
  return out
}
