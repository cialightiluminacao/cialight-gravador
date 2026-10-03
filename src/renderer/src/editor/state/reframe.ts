import { useEffect, useReducer } from 'react'
import { create } from 'zustand'
import { reframeProject, type FocusPoint, type ReframeAspect, type ReframeResult } from '@shared/editor/reframe'
import type { Project } from '@shared/editor/project'

// Painel "Reenquadrar" (fora do histórico do projeto): proporção, modo, destino (cópia ou este projeto) e os pontos de
// foco marcados no visualizador, por clipe principal, no espaço do conteúdo do clipe (instante relativo ao início dele,
// fração da fonte): mover ou transformar o clipe com o painel aberto não os desloca. Fechar descarta os pontos.

export type ReframeDest = 'copy' | 'apply'

export interface ReframeState {
  open: boolean
  aspect: ReframeAspect
  mode: 'cover' | 'contain'
  dest: ReframeDest
  /** Pontos de foco por id do clipe principal, em ordem de tempo (localUs); um por instante. */
  points: Record<string, FocusPoint[]>
  openPanel(aspect: ReframeAspect): void
  close(): void
  set(patch: Partial<Pick<ReframeState, 'aspect' | 'mode' | 'dest'>>): void
  /** Marca (ou troca, no mesmo instante) o ponto de foco do clipe. */
  addPoint(itemId: string, pt: FocusPoint): void
  removePoint(itemId: string, localUs: number): void
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
    set((s) => ({ points: { ...s.points, [itemId]: [...(s.points[itemId] ?? []).filter((p) => p.localUs !== pt.localUs), pt].sort((a, b) => a.localUs - b.localUs) } })),
  removePoint: (itemId, localUs) => set((s) => ({ points: { ...s.points, [itemId]: (s.points[itemId] ?? []).filter((p) => p.localUs !== localUs) } })),
  clearPoints: (itemId) => set((s) => ({ points: { ...s.points, [itemId]: [] } }))
}))

// prévia compartilhada pelo painel e pelo visualizador: recalcula só quando o projeto ou as opções mudam
let memo: { p: Project; aspect: ReframeAspect; mode: 'cover' | 'contain'; points: Record<string, FocusPoint[]>; r: ReframeResult } | null = null

type PreviewOpts = Pick<ReframeState, 'aspect' | 'mode' | 'points'>
const memoHit = (p: Project, s: PreviewOpts): ReframeResult | null =>
  memo && memo.p === p && memo.aspect === s.aspect && memo.mode === s.mode && memo.points === s.points ? memo.r : null

/** O projeto reenquadrado com as opções do painel (a mesma conta que "Criar cópia"/"Aplicar" usa). Síncrono. */
export function reframePreview(p: Project, s: PreviewOpts): ReframeResult {
  const hit = memoHit(p, s)
  if (hit) return hit
  const r = reframeProject(p, s.aspect, { mode: s.mode, focus: s.points })
  memo = { p, aspect: s.aspect, mode: s.mode, points: s.points, r }
  return r
}

/** Espera depois da última mudança (clique de foco, opção) antes de recalcular: cliques seguidos fazem uma conta só. */
export const PREVIEW_DEBOUNCE_MS = 120

/**
 * Prévia fora do caminho do clique: num projeto de 1 h o reenquadrar leva ~1 s, e recalcular na renderização travava
 * a interface a cada ponto de foco. Com o resultado em dia na memória, devolve na hora; senão agenda a conta (depois
 * de PREVIEW_DEBOUNCE_MS e de o navegador ficar ocioso — o clique e o "calculando…" já foram pintados) e devolve a
 * última prévia do mesmo projeto (ou null) com `pending`.
 */
export function useReframePreview(p: Project | null, s: PreviewOpts): { result: ReframeResult | null; pending: boolean } {
  const hit = p ? memoHit(p, s) : null
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const { aspect, mode, points } = s
  useEffect(() => {
    if (!p || hit) return
    let idle = 0
    const timer = window.setTimeout(() => {
      idle = requestIdleCallback(() => {
        idle = 0
        reframePreview(p, { aspect, mode, points })
        bump()
      }, { timeout: 300 })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      if (idle) cancelIdleCallback(idle)
    }
  }, [p, aspect, mode, points, hit])
  if (!p) return { result: null, pending: false }
  return { result: hit ?? (memo && memo.p.id === p.id ? memo.r : null), pending: !hit }
}
