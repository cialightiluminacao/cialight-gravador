import type { Project, TextItem, Us } from '@shared/editor/project'
import { findItem } from '@shared/editor/ops'
import { itemEndUs } from '@shared/editor/time'

// Decisão pura de Enter/F2 ("editar o texto selecionado"): exatamente UM item de texto (inclui legenda) ativo, em
// faixa desbloqueada e visível. Fora do playhead, `seekUs` leva o cursor ao início do item para a caixa existir no quadro.

export type TextEditEntry =
  | { kind: 'edit'; itemId: string; seekUs?: Us }
  | { kind: 'locked'; trackName: string }
  | { kind: 'counter' }

export function planTextEditEntry(project: Project, selection: readonly string[], playheadUs: Us): TextEditEntry | null {
  if (selection.length !== 1) return null
  const found = findItem(project, selection[0])
  if (!found || found.item.type !== 'text') return null
  if (found.item.enabled === false || found.track.hidden) return null
  if (found.track.locked) return { kind: 'locked', trackName: found.track.name }
  if ((found.item as TextItem).counter) return { kind: 'counter' }
  const it = found.item
  const inside = playheadUs >= it.startUs && playheadUs < itemEndUs(it)
  return inside ? { kind: 'edit', itemId: it.id } : { kind: 'edit', itemId: it.id, seekUs: it.startUs }
}

/** Ferramenta do visualizador ativa (as três tomam o clique no quadro e escondem as alças). */
export type ViewerToolActive = 'drawing' | 'zooming' | 'reframing' | null

export const TEXT_EDIT_FAILED = 'Não foi possível editar o texto agora.'

const TOOL_WHY: Record<Exclude<ViewerToolActive, null>, string> = {
  drawing: 'Saia de “Desenhar região” (B) para editar o texto.',
  zooming: 'Saia da ferramenta Zoom (Z) para editar o texto.',
  reframing: 'Feche o reenquadramento para editar o texto.'
}

/**
 * Decisão pura do pedido de Enter/F2 (G4): é resolvido NA HORA — abre ou é descartado com o motivo. Nunca fica
 * pendente (um pedido velho abriria o editor de texto de surpresa quando o playhead passasse pelo item depois).
 * `hasBox`: a caixa do texto existe no quadro do playhead (itemBoxes).
 */
export function resolveTextEditRequest(s: {
  exists: boolean
  playing: boolean
  playheadInside: boolean
  hasBox: boolean
  tool: ViewerToolActive
}): { kind: 'open' } | { kind: 'drop'; why: string } {
  if (!s.exists) return { kind: 'drop', why: 'O texto não existe mais.' }
  if (s.tool) return { kind: 'drop', why: TOOL_WHY[s.tool] }
  if (s.playing) return { kind: 'drop', why: 'Pause a reprodução para editar o texto.' }
  if (!s.playheadInside) return { kind: 'drop', why: 'O cursor de reprodução não pôde ir até o texto agora (ex.: durante a gravação de narração).' }
  if (!s.hasBox) return { kind: 'drop', why: 'O texto não aparece no quadro do cursor de reprodução.' }
  return { kind: 'open' }
}
