import { useState } from 'react'
import type { Us } from '@shared/editor/project'
import { useEditorStore } from './editorStore'

// Playhead "parado": durante a reprodução devolve o último valor de quando estava parado. Para painéis e
// sobreposições que não mudam tocando (inspetor, alças do visualizador) e não precisam re-renderizar a cada quadro.

export function pausedPlayheadSelector(initial: Us): (s: { playing: boolean; playheadUs: Us }) => Us {
  let last = initial
  return (s) => {
    if (!s.playing) last = s.playheadUs
    return last
  }
}

export function usePausedPlayhead(): Us {
  const [selector] = useState(() => pausedPlayheadSelector(useEditorStore.getState().playheadUs))
  return useEditorStore(selector)
}
