import { findItem, pastablePaths, type KeyframeClipboard } from '@shared/editor/ops'
import type { Project, Us } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'

// Ctrl+V de keyframes (puro): em quais itens selecionados colar e o aviso para o usuário. Alvo = item
// selecionado sob o playhead; faixa bloqueada e item sem nenhuma das propriedades copiadas ficam de fora.

export interface KeyframePastePlan {
  /** Itens que recebem os keyframes. */
  targets: string[]
  /** Aviso (null = colou em todos os itens sob o playhead). */
  message: string | null
}

export function planKeyframePaste(p: Project, selection: readonly string[], playheadUs: Us, clip: KeyframeClipboard): KeyframePastePlan {
  const under = selection.flatMap((id) => {
    const f = findItem(p, id)
    return f && playheadUs >= f.item.startUs && playheadUs < itemEndUs(f.item) ? [f] : []
  })
  if (under.length === 0) return { targets: [], message: 'Selecione um item sob o playhead para colar os keyframes.' }
  const locked = under.filter((f) => f.track.locked).length
  const free = under.filter((f) => !f.track.locked)
  const targets = free.filter((f) => pastablePaths(f.item, clip).length > 0).map((f) => f.item.id)
  const missing = free.length - targets.length
  const why = [locked ? `${locked} em faixa bloqueada` : '', missing ? `${missing} sem essas propriedades` : ''].filter(Boolean).join(', ')
  if (targets.length === 0) {
    return { targets, message: locked && !missing ? 'Faixa bloqueada: os keyframes não foram colados.' : under.length === 1 ? 'Este item não tem as propriedades dos keyframes copiados.' : `Nada colado (${why}).` }
  }
  if (targets.length < under.length) return { targets, message: `Colado em ${targets.length} de ${under.length} itens (${why}).` }
  return { targets, message: null }
}
