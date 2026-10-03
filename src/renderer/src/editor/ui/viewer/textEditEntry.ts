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
