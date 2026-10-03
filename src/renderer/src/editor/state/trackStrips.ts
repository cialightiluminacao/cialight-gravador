import { create } from 'zustand'
import type { EffectRegion, Us } from '@shared/editor/project'
import type { TrackSample, TrackState } from '@shared/editor/track'
import { useEditorStore } from './editorStore'

// Faixa de confiança do "Seguir conteúdo" (F6) nos itens de efeito da timeline. NÃO vai ao project.json (nada novo
// no disco — invariante 1): fica em memória enquanto o editor está aberto, presa à região que o rastreamento gravou.
// O item mostra a faixa só se a região dele ainda é ESSE objeto (imutável): editar a região, desfazer o rastreamento
// ou rastrear de novo a esconde; refazer a traz de volta (o histórico guarda o mesmo objeto).

export interface TrackStrip {
  region: EffectRegion
  samples: TrackSample[]
  /**
   * Instante (absoluto) da perda NÃO recuperada do último rastreamento (G4: "Continuar daqui" / "Continuar
   * rastreamento"); null/ausente = terminou confiante. Vale mesmo depois que o usuário reposiciona a região.
   */
  lossUs?: Us | null
}

interface State {
  strips: Record<string, TrackStrip>
  set(itemId: string, strip: TrackStrip): void
  clear(): void
}

export const useTrackStrips = create<State>()((set) => ({
  strips: {},
  set: (itemId, strip) => set((s) => ({ strips: { ...s.strips, [itemId]: strip } })),
  clear: () => set({ strips: {} })
}))

// outro projeto aberto (ou o editor fechado): as faixas eram do anterior
useEditorStore.subscribe((s, prev) => {
  if (s.project?.id !== prev.project?.id && Object.keys(useTrackStrips.getState().strips).length) useTrackStrips.getState().clear()
})

/** Trechos contíguos de mesmo estado: [início, fim) em tempo local ao item (o último vai até `durationUs`). */
export function stripRuns(samples: readonly TrackSample[], durationUs: Us): { fromUs: Us; toUs: Us; state: TrackState }[] {
  const out: { fromUs: Us; toUs: Us; state: TrackState }[] = []
  samples.forEach((s, i) => {
    const toUs = Math.min(durationUs, i + 1 < samples.length ? samples[i + 1].tUs : durationUs)
    const last = out[out.length - 1]
    if (last && last.state === s.state && last.toUs === s.tUs) last.toUs = toUs
    else if (toUs > s.tUs) out.push({ fromUs: s.tUs, toUs, state: s.state })
  })
  return out
}

/**
 * Faixa de "Continuar rastreamento" (G4): as amostras de antes do ponto de partida (tempo local) ficam; dali em diante,
 * as da nova passada — como os keys da região (trackToKeys).
 */
export function mergeStripSamples(prev: readonly TrackSample[], fresh: readonly TrackSample[], fromLocalUs: Us): TrackSample[] {
  return [...prev.filter((s) => s.tUs < fromLocalUs), ...fresh]
}
