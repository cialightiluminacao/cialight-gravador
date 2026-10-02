import { create } from 'zustand'
import { reframeProject, type FocusPoint, type ReframeAspect, type ReframeResult } from '@shared/editor/reframe'
import type { Project } from '@shared/editor/project'

// Painel "Reenquadrar" (fora do histórico do projeto): proporção, modo, destino (cópia ou este projeto) e os pontos de
// foco marcados no visualizador, por clipe principal. Fechar descarta os pontos.

export type ReframeDest = 'copy' | 'apply'

export interface ReframeState {
  open: boolean
  aspect: ReframeAspect
  mode: 'cover' | 'contain'
  dest: ReframeDest
  /** Pontos de foco por id do clipe principal, em ordem de tempo; um por instante. */
  points: Record<string, FocusPoint[]>
  openPanel(aspect: ReframeAspect): void
  close(): void
  set(patch: Partial<Pick<ReframeState, 'aspect' | 'mode' | 'dest'>>): void
  /** Marca (ou troca, no mesmo instante) o ponto de foco do clipe. */
  addPoint(itemId: string, pt: FocusPoint): void
  removePoint(itemId: string, tUs: number): void
  clearPoints(itemId: string): void
}

const NONE: Record<string, FocusPoint[]> = {}

export const useReframe = create<ReframeState>()((set) => ({
  open: false,
  aspect: '9:16',
  mode: 'cover',
  dest: 'copy',
  points: NONE,
  openPanel: (aspect) => set({ open: true, aspect, mode: 'cover', dest: 'copy', points: NONE }),
  close: () => set({ open: false, points: NONE }),
  set: (patch) => set(patch),
  addPoint: (itemId, pt) =>
    set((s) => ({ points: { ...s.points, [itemId]: [...(s.points[itemId] ?? []).filter((p) => p.tUs !== pt.tUs), pt].sort((a, b) => a.tUs - b.tUs) } })),
  removePoint: (itemId, tUs) => set((s) => ({ points: { ...s.points, [itemId]: (s.points[itemId] ?? []).filter((p) => p.tUs !== tUs) } })),
  clearPoints: (itemId) => set((s) => ({ points: { ...s.points, [itemId]: [] } }))
}))

// prévia compartilhada pelo painel e pelo visualizador: recalcula só quando o projeto ou as opções mudam
let memo: { p: Project; aspect: ReframeAspect; mode: 'cover' | 'contain'; points: Record<string, FocusPoint[]>; r: ReframeResult } | null = null

/** O projeto reenquadrado com as opções do painel (a mesma conta que "Criar cópia"/"Aplicar" usa). */
export function reframePreview(p: Project, s: Pick<ReframeState, 'aspect' | 'mode' | 'points'>): ReframeResult {
  if (memo && memo.p === p && memo.aspect === s.aspect && memo.mode === s.mode && memo.points === s.points) return memo.r
  const r = reframeProject(p, s.aspect, { mode: s.mode, focus: s.points })
  memo = { p, aspect: s.aspect, mode: s.mode, points: s.points, r }
  return r
}
