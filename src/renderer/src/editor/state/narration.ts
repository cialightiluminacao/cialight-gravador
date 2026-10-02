import { create } from 'zustand'
import type { Us } from '@shared/editor/project'

// Gravação de narração (fora do histórico do projeto): fase, contagem regressiva, nível do microfone (VU) e tempo
// gravado. Quem conduz é ui/narrationFlow.ts.

export type NarrationPhase = 'idle' | 'countdown' | 'recording' | 'saving'

export interface NarrationState {
  phase: NarrationPhase
  /** Contagem regressiva (3, 2, 1). */
  count: number
  /** Nível do microfone 0–1 (RMS × 3,2, a mesma escala do VU da tela Preparar). */
  level: number
  recordedUs: Us
  /** Playhead no início da gravação (a faixa vermelha da timeline começa aqui). */
  fromUs: Us
  set(patch: Partial<Omit<NarrationState, 'set' | 'reset'>>): void
  reset(): void
}

export const useNarration = create<NarrationState>()((set) => ({
  phase: 'idle',
  count: 0,
  level: 0,
  recordedUs: 0,
  fromUs: 0,
  set: (patch) => set(patch),
  reset: () => set({ phase: 'idle', count: 0, level: 0, recordedUs: 0, fromUs: 0 })
}))
