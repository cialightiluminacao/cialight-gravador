import { create } from 'zustand'
import type { OcrBox, SensitiveKind } from '@shared/editor/sensitive'
import type { ScanPhase } from '@shared/editor/sensitiveScan'
import { ALL_KINDS, type ReviewRow } from '../ui/sensitiveReview'

// Diálogo "Procurar dados sensíveis" (G3), fora do histórico do projeto. PRIVACIDADE: os termos personalizados, o
// resultado da busca e as miniaturas vivem só aqui, na memória; nada vai para o projeto, configurações, localStorage ou
// log. Fechar o diálogo (close) apaga tudo.

export type SensitiveStep = 'setup' | 'scanning' | 'review'

export interface SensitiveProgress {
  /** Arquivo de origem atual (1…files) e trecho dele (1…ranges). */
  file: number
  files: number
  range: number
  ranges: number
  phase: ScanPhase
  done: number
  total: number
}

/** Contorno da ocorrência em foco no visualizador (clipe, instante da timeline, caixa na fonte). */
export interface SensitiveHover { itemId: string; tUs: number; box: OcrBox }

export interface SensitiveScanState {
  open: boolean
  /** Busca pelo menu do clipe: só ele; null = todos os clipes visuais. */
  clipId: string | null
  step: SensitiveStep
  kinds: SensitiveKind[]
  wordsText: string
  style: 'blur' | 'solid'
  progress: SensitiveProgress | null
  /** Varredura em andamento no main (para cancelar). */
  scanId: string | null
  rows: ReviewRow[]
  /** Linhas desmarcadas (todas começam marcadas: privacidade primeiro). */
  unchecked: Set<string>
  ignored: Set<string>
  /** Filtro por tipo na revisão (vazio = todos). */
  filter: Set<SensitiveKind>
  thumbs: Record<string, string>
  hover: SensitiveHover | null
  /** Pedido para focar o diálogo já aberto (2ª entrada enquanto ele está aberto). */
  focusTick: number

  openDialog(clipId?: string | null): void
  close(): void
  patch(p: Partial<Omit<SensitiveScanState, 'openDialog' | 'close' | 'patch'>>): void
}

const fresh = (): Omit<SensitiveScanState, 'open' | 'clipId' | 'focusTick' | 'openDialog' | 'close' | 'patch'> => ({
  step: 'setup',
  kinds: [...ALL_KINDS],
  wordsText: '',
  style: 'blur',
  progress: null,
  scanId: null,
  rows: [],
  unchecked: new Set(),
  ignored: new Set(),
  filter: new Set(),
  thumbs: {},
  hover: null
})

export const useSensitiveScan = create<SensitiveScanState>()((set, get) => ({
  open: false,
  clipId: null,
  focusTick: 0,
  ...fresh(),
  openDialog: (clipId = null) => {
    // já aberto (ou buscando): só traz o diálogo para frente
    if (get().open) return set({ focusTick: get().focusTick + 1 })
    set({ ...fresh(), open: true, clipId })
  },
  close: () => set({ ...fresh(), open: false, clipId: null }),
  patch: (p) => set(p)
}))
