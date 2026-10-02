import { create } from 'zustand'
import type { SilenceCut } from '@shared/editor/silenceCut'

// Diálogo "Remover silêncios" (fora do histórico do projeto): aberto/fechado, a faixa sugerida ao abrir pelo menu e
// os cortes em pré-visualização (faixas vermelhas na régua e nas faixas da linha do tempo).

export interface SilencePreviewState {
  open: boolean
  /** Faixa de voz sugerida ao abrir (menu de um item); null = a primeira de voz. */
  trackId: string | null
  cuts: SilenceCut[]
  openDialog(trackId?: string | null): void
  close(): void
  setCuts(cuts: SilenceCut[]): void
}

const NONE: SilenceCut[] = []

export const useSilencePreview = create<SilencePreviewState>()((set) => ({
  open: false,
  trackId: null,
  cuts: NONE,
  openDialog: (trackId = null) => set({ open: true, trackId }),
  close: () => set({ open: false, trackId: null, cuts: NONE }),
  setCuts: (cuts) => set({ cuts: cuts.length ? cuts : NONE })
}))
