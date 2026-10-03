import { create } from 'zustand'
import { findItem } from '@shared/editor/ops'
import type { EffectRegion, Project, Us } from '@shared/editor/project'
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
   * Instante da perda NÃO recuperada do último rastreamento, LOCAL ao efeito (G4: "Continuar daqui" / "Continuar
   * rastreamento"; local: acompanha o efeito movido, como os keys); null/ausente = terminou confiante. Use liveLossUs.
   */
  lossLocalUs?: Us | null
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

/**
 * Instante absoluto da perda que "Continuar daqui" / "Continuar rastreamento" oferecem (G4), derivado do estado atual:
 * só enquanto o rastreamento que a gravou continua no histórico — a região do item é a gravada ou ela está num
 * projeto do passado (o usuário a ajustou depois, o fluxo normal). Desfeito o rastreamento (ou fora do histórico), o
 * efeito sumido ou a perda fora do trecho atual do efeito → null (nunca um instante errado).
 */
export function liveLossUs(strip: TrackStrip | undefined, project: Project | null, past: readonly Project[], itemId: string): Us | null {
  if (!strip || strip.lossLocalUs === null || strip.lossLocalUs === undefined || !project) return null
  const f = findItem(project, itemId)
  if (!f || f.item.type !== 'effect') return null
  if (strip.lossLocalUs < 0 || strip.lossLocalUs >= f.item.durationUs) return null
  let alive = f.item.region === strip.region
  for (let i = past.length - 1; !alive && i >= 0; i--) {
    const g = findItem(past[i], itemId)
    alive = g?.item.type === 'effect' && g.item.region === strip.region
  }
  return alive ? f.item.startUs + strip.lossLocalUs : null
}

/**
 * liveLossUs memoizado pelas REFERÊNCIAS de (faixa, projeto, histórico passado) — invariante 6: o seletor do painel
 * roda a cada atualização do store (o playhead anda a cada quadro), e a busca no histórico é O(passado × itens).
 * Playhead/seleção/zoom não trocam essas referências → custo O(1) por atualização; só uma edição recalcula.
 */
export function createLiveLossSelector(
  itemId: string,
  compute: typeof liveLossUs = liveLossUs
): (strip: TrackStrip | undefined, project: Project | null, past: readonly Project[]) => Us | null {
  let last: { strip: TrackStrip | undefined; project: Project | null; past: readonly Project[]; value: Us | null } | null = null
  return (strip, project, past) => {
    if (last && last.strip === strip && last.project === project && last.past === past) return last.value
    const value = compute(strip, project, past, itemId)
    last = { strip, project, past, value }
    return value
  }
}
