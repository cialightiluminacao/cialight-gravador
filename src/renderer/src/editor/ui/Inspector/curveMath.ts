import { easeValue } from '@shared/editor/anim'
import type { Anim, Ease, Keyframe, Us } from '@shared/editor/project'

// Matemática pura do editor de curvas: presets, alças da bezier (x preso a [0,1], y livre em −1..2),
// vista e mapeamento do gráfico, desenho da curva e qual key o ◇ (botão direito) edita.

export type Bez = [number, number, number, number]
export type CurvePresetId = 'linear' | 'hold' | 'in' | 'out' | 'inOut' | 'overshoot'

export const OVERSHOOT: Bez = [0.34, 1.56, 0.64, 1]

export const CURVE_PRESETS: { id: CurvePresetId; label: string; ease: Ease }[] = [
  { id: 'linear', label: 'Linear', ease: 'linear' },
  { id: 'hold', label: 'Segurar', ease: 'hold' },
  { id: 'in', label: 'Suavizar entrada', ease: 'in' },
  { id: 'out', label: 'Suavizar saída', ease: 'out' },
  { id: 'inOut', label: 'Suavizar ambos', ease: 'inOut' },
  { id: 'overshoot', label: 'Overshoot', ease: { bezier: OVERSHOOT } }
]

export const HANDLE_Y_MIN = -1
export const HANDLE_Y_MAX = 2

export function presetOf(e: Ease): CurvePresetId | null {
  if (typeof e !== 'object') return e
  return e.bezier.every((v, i) => v === OVERSHOOT[i]) ? 'overshoot' : null
}

/**
 * Alças de partida para arrastar: a própria bezier, ou a do preset (linear/segurar = diagonal; entrada/saída, a
 * bezier exata; "ambos" não tem bezier exata — fica a equivalente usual). Arrastar uma alça transforma o ease em bezier personalizada.
 */
export function handlesOf(e: Ease): Bez {
  if (typeof e === 'object') return [...e.bezier]
  switch (e) {
    // cúbicas exatas: com x1 = 1/3 e x2 = 2/3, x(t) = t e y(t) = t³ (entrada) / 1 − (1 − t)³ (saída)
    case 'in': return [1 / 3, 0, 2 / 3, 0]
    case 'out': return [1 / 3, 1, 2 / 3, 1]
    case 'inOut': return [0.65, 0, 0.35, 1]
    default: return [0.25, 0.25, 0.75, 0.75]
  }
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** Alça 1 (x1,y1) ou 2 (x2,y2) em (x, y): x preso a [0,1] (a curva continua função do tempo), y a −1..2; 3 casas. */
export function withHandle(b: Bez, which: 1 | 2, x: number, y: number): Bez {
  const hx = r3(Math.max(0, Math.min(1, x)))
  const hy = r3(Math.max(HANDLE_Y_MIN, Math.min(HANDLE_Y_MAX, y)))
  return which === 1 ? [hx, hy, b[2], b[3]] : [b[0], b[1], hx, hy]
}

/** Faixa vertical do gráfico: 0..1 com folga e as alças (a curva fica dentro do casco delas). */
export function viewRange(b: Bez): { lo: number; hi: number } {
  return { lo: Math.min(-0.15, b[1] - 0.1, b[3] - 0.1), hi: Math.max(1.15, b[1] + 0.1, b[3] + 0.1) }
}

export interface CurveGraph {
  toPx(x: number, y: number): { x: number; y: number }
  fromPx(px: number, py: number): { x: number; y: number }
}

/** Mapeamento curva (x 0..1, y lo..hi) ↔ px de um gráfico w×h com margem pad (y para baixo). */
export function curveGraph(w: number, h: number, r: { lo: number; hi: number }, pad: number): CurveGraph {
  const iw = w - 2 * pad, ih = h - 2 * pad
  return {
    toPx: (x, y) => ({ x: pad + x * iw, y: pad + ((r.hi - y) / (r.hi - r.lo)) * ih }),
    fromPx: (px, py) => ({ x: (px - pad) / iw, y: r.hi - ((py - pad) / ih) * (r.hi - r.lo) })
  }
}

/** Caminho SVG da curva (n trechos); segurar = degrau no fim. */
export function curvePath(e: Ease, g: CurveGraph, n = 64): string {
  const pts: { x: number; y: number }[] = e === 'hold' ? [g.toPx(0, 0), g.toPx(1, 0), g.toPx(1, 1)] : Array.from({ length: n + 1 }, (_, i) => g.toPx(i / n, easeValue(e, i / n)))
  return `M${pts.map((p) => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`).join('L')}`
}

/**
 * Key cuja curva o ◇ (botão direito) edita, com o playhead no instante local: o key a ±tol; senão o que começa o
 * trecho em que o playhead está; antes do 1º key, o 1º. Sem keys → null.
 */
export function curveKeyFor(a: Anim<number>, localUs: Us, tolUs: Us): Keyframe<number> | null {
  const k = a.keys ?? []
  if (k.length === 0) return null
  let best: Keyframe<number> | null = null
  for (const x of k) if (Math.abs(x.tUs - localUs) <= tolUs && (!best || Math.abs(x.tUs - localUs) < Math.abs(best.tUs - localUs))) best = x
  if (best) return best
  return k.filter((x) => x.tUs < localUs).at(-1) ?? k[0]
}
