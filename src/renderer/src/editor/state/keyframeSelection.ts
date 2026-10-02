import { create } from 'zustand'
import type { Us } from '@shared/editor/project'
import { useEditorStore } from './editorStore'

// Losango de keyframe selecionado na linha do tempo (fora do histórico): Delete remove os keys desse
// instante. Vale só enquanto o item dele é a seleção única; qualquer outra seleção o descarta.

export interface KeyframeSel { itemId: string; /** Instante local (µs desde o início do item). */ tUs: Us }

export const useKeyframeSelection = create<{ sel: KeyframeSel | null; set(sel: KeyframeSel | null): void }>()((set) => ({
  sel: null,
  set: (sel) => set({ sel })
}))

useEditorStore.subscribe((s, prev) => {
  if (s.selection === prev.selection) return
  const sel = useKeyframeSelection.getState().sel
  if (sel && !(s.selection.length === 1 && s.selection[0] === sel.itemId)) useKeyframeSelection.getState().set(null)
})
