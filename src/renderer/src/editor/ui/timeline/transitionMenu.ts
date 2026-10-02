import { Repeat, Timer, Trash2 } from 'lucide-react'
import { removeTransition } from '@shared/editor/ops'
import type { MediaItem, Project, TextItem } from '@shared/editor/project'
import { DEFAULT_TRANSITION_US } from '@shared/editor/transitions'
import { SHORTCUT_LABELS } from '../../shortcuts'
import { useEditorStore } from '../../state/editorStore'
import { addTransitionTo, setTransitionDurationTo } from '../editorActions'
import { formatTransitionDuration, TRANSITION_DURATION_CHOICES, TRANSITION_KINDS, transitionLabel } from '../transitionInfo'
import type { MenuEntry } from './ContextMenu'

// Menu de contexto do ícone de transição: trocar o tipo, a duração e remover.

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

export function transitionMenuEntries(p: Project, toId: string): MenuEntry[] {
  const item = p.tracks.flatMap((t) => t.items).find((i) => i.id === toId) as MediaItem | TextItem | undefined
  const cur = item?.transitionIn
  if (!cur) return []
  const durations = [{ us: DEFAULT_TRANSITION_US, label: `Padrão (${formatTransitionDuration(DEFAULT_TRANSITION_US)})` }, ...TRANSITION_DURATION_CHOICES.filter((d) => d !== DEFAULT_TRANSITION_US).map((us) => ({ us, label: formatTransitionDuration(us) }))]
  return [
    {
      label: 'Trocar tipo',
      icon: Repeat,
      sub: TRANSITION_KINDS.map((k) => ({ label: k === cur.kind ? `${transitionLabel(k)}  ✓` : transitionLabel(k), onSelect: () => void addTransitionTo(toId, k) }))
    },
    {
      label: 'Duração',
      icon: Timer,
      sub: durations.map((d) => ({
        label: d.us === cur.durationUs ? `${d.label}  ✓` : d.label,
        // acima do máximo do par o op limita e setTransitionDurationTo avisa (nenhuma ação silenciosa)
        onSelect: () => {
          if (setTransitionDurationTo(toId, d.us)) st().selectTransition(toId)
        }
      }))
    },
    { separator: true },
    {
      label: 'Remover transição',
      icon: Trash2,
      shortcut: SHORTCUT_LABELS.delete,
      danger: true,
      onSelect: () => {
        if (st().apply((q) => removeTransition(q, toId))) st().selectTransition(null)
      }
    }
  ]
}
