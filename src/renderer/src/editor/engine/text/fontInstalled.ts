// Sonda DOM: a família está instalada no sistema? FontFaceSet.check não serve para fontes do sistema (diz "pronta"),
// então mede-se uma sonda no canvas com a família sobre ≥2 reservas genéricas (a decisão pura é de @shared).
import { installedFromWidths, isAlwaysInstalled, normalizeFamily } from '@shared/editor/fontMissing'

const PROBE = 'mmmmmmmmmmlliWQ@#0123 áçãõ'
const BASELINES = ['monospace', 'serif', 'sans-serif'] as const
const cache = new Map<string, boolean>()
let ctx: CanvasRenderingContext2D | null | undefined

function measure(font: string): number {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(PROBE).width
}

/** Instalada (ou empacotada/genérica)? Resultado em cache por família na sessão. Sem canvas: assume instalada (sem falso alarme). */
export function isFontInstalled(family: string): boolean {
  const f = normalizeFamily(family)
  if (isAlwaysInstalled(f)) return true
  const hit = cache.get(f)
  if (hit !== undefined) return hit
  let ok = true
  try {
    const base = BASELINES.map((b) => measure(`72px ${b}`))
    const withFont = BASELINES.map((b) => measure(`72px "${f}", ${b}`))
    ok = base.every((w) => w > 0) ? installedFromWidths(withFont, base) : true
  } catch {
    ok = true
  }
  cache.set(f, ok)
  return ok
}
