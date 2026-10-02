import { create } from 'zustand'
import type { AnimPath } from '@shared/editor/animPaths'
import type { Us } from '@shared/editor/project'
import { useEditorStore } from './editorStore'

// Estado de interface (fora do histórico e do projeto) das linhas de keyframes e do editor de curvas:
// quais itens estão expandidos na linha do tempo (seta no item) e qual curva está aberta.

export const useExpandedItems = create<{ ids: ReadonlySet<string>; toggle(id: string): void; clear(): void }>()((set) => ({
  ids: new Set(),
  clear: () => set({ ids: new Set() }),
  toggle: (id) =>
    set((s) => {
      const ids = new Set(s.ids)
      if (!ids.delete(id)) ids.add(id)
      return { ids }
    })
}))

/** Curva aberta: o trecho que começa no key `tUs` (local) da propriedade; x/y = ponto da tela onde o popover abre. */
export interface CurveTarget { itemId: string; path: AnimPath; tUs: Us; x: number; y: number }

export const useCurveEditor = create<{ target: CurveTarget | null; open(t: CurveTarget): void; close(): void }>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null })
}))

// projeto carregado (outro, ou o mesmo reaberto): começa recolhido e sem curva aberta
useEditorStore.subscribe((s, prev) => {
  if (!s.project || (prev.project && s.project.id === prev.project.id)) return
  if (useExpandedItems.getState().ids.size) useExpandedItems.getState().clear()
  if (useCurveEditor.getState().target) useCurveEditor.getState().close()
})
