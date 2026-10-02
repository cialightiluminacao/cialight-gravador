import { create } from 'zustand'
import { findItem, keyframeTimesUs } from '@shared/editor/ops'
import type { Us } from '@shared/editor/project'
import { useEditorStore } from './editorStore'

// Losango de keyframe selecionado na linha do tempo (fora do histórico): Delete remove os keys desse
// instante. Vale só enquanto o item dele é a seleção única e ainda há key naquele instante.

export interface KeyframeSel { itemId: string; /** Instante local (µs desde o início do item). */ tUs: Us }

export const useKeyframeSelection = create<{ sel: KeyframeSel | null; set(sel: KeyframeSel | null): void }>()((set) => ({
  sel: null,
  set: (sel) => set({ sel })
}))

useEditorStore.subscribe((s, prev) => {
  // no meio de um gesto (arrastar o losango) quem decide é o gesto, ao terminar
  if (s.txBase || (s.selection === prev.selection && s.project === prev.project)) return
  const sel = useKeyframeSelection.getState().sel
  if (!sel) return
  // outra seleção, ou nenhum key mais naquele instante (desfazer, edição no inspetor…): Delete volta a apagar o item
  const item = s.project ? findItem(s.project, sel.itemId)?.item : undefined
  const stillKeyed = !!item && keyframeTimesUs(item).some((t) => Math.abs(t - sel.tUs) <= 1)
  if (!stillKeyed || !(s.selection.length === 1 && s.selection[0] === sel.itemId)) useKeyframeSelection.getState().set(null)
})
