import { itemEndUs } from './time'
import type { Project, Us } from './project'

export interface SnapPoint { us: Us; kind: 'playhead' | 'itemStart' | 'itemEnd' | 'marker' | 'zero' }

/** Pontos magnéticos: 0, playhead, bordas de itens (exceto os excluídos, ex.: os que estão sendo arrastados) e marcadores. */
export function snapPoints(p: Project, playheadUs: Us, excludeItemIds: string[]): SnapPoint[] {
  const exclude = new Set(excludeItemIds)
  const out: SnapPoint[] = [{ us: 0, kind: 'zero' }, { us: playheadUs, kind: 'playhead' }]
  for (const t of p.tracks) {
    for (const it of t.items) {
      if (exclude.has(it.id)) continue
      out.push({ us: it.startUs, kind: 'itemStart' }, { us: itemEndUs(it), kind: 'itemEnd' })
    }
  }
  for (const m of p.markers) out.push({ us: m.tUs, kind: 'marker' })
  return out
}

/** Menor ajuste que encaixa qualquer candidato (início/fim do bloco movido) num ponto dentro da tolerância. */
export function snapDelta(candidatesUs: Us[], points: SnapPoint[], toleranceUs: Us): { deltaUs: Us; point: SnapPoint | null } {
  let best: { deltaUs: Us; point: SnapPoint | null } = { deltaUs: 0, point: null }
  for (const c of candidatesUs) {
    for (const pt of points) {
      const delta = pt.us - c
      if (Math.abs(delta) > toleranceUs) continue
      if (!best.point || Math.abs(delta) < Math.abs(best.deltaUs)) best = { deltaUs: delta, point: pt }
    }
  }
  return best
}
