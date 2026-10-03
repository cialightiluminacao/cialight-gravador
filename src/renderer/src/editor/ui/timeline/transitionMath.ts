import { transitionWindowAt, canTransition, maxTransitionUs, MIN_TRANSITION_US, transitionPairOk, type TransitionWindow } from '@shared/editor/transitions'
import type { Item, Project, Track, Us } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'
import { isCaptionsTrack } from '@shared/editor/ops'
import { usToPx } from '../../state/zoom'

// Matemática pura das transições na linha do tempo: janelas visíveis de uma faixa, geometria do ícone, alvo do
// soltar (corte ou item), corte elegível mais próximo do playhead e a duração durante o arraste das bordas.

/** Tolerância (px) do soltar sobre um corte. */
export const CUT_HIT_PX = 12
/** Largura mínima (px) da faixa desenhada de uma transição: abaixo disso o ícone ainda precisa ser clicável. */
export const MIN_MARK_W = 22

/** Primeiro índice cujo item termina depois de `us` (itens ordenados, sem sobreposição). */
function firstEndingAfter(items: Item[], us: Us): number {
  let lo = 0, hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (itemEndUs(items[mid]) <= us) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Janelas de transição da faixa que tocam [fromUs, toUs] (O(log n + visíveis)). */
export function visibleTransitions(track: Track, fromUs: Us, toUs: Us): TransitionWindow[] {
  if (track.kind !== 'video') return []
  const items = track.items
  const out: TransitionWindow[] = []
  // um item antes (a janela de B começa dentro de A) e um depois (a janela de B pode começar antes da borda)
  for (let i = Math.max(1, firstEndingAfter(items, fromUs) - 1); i < items.length && items[i - 1].startUs < toUs; i++) {
    const w = transitionWindowAt(track, i)
    if (w && w.endUs > fromUs && w.startUs < toUs) out.push(w)
  }
  return out
}

/** Posição do ícone: faixa da janela em escala (largura mínima MIN_MARK_W, centrada no corte) e x do corte. */
export function markGeometry(w: Pick<TransitionWindow, 'startUs' | 'durationUs' | 'cutUs'>, pxPerSec: number, scrollUs: Us): { left: number; width: number; cutX: number } {
  const cutX = usToPx(w.cutUs, pxPerSec, scrollUs)
  const natural = (w.durationUs * pxPerSec) / 1e6
  const width = Math.max(MIN_MARK_W, natural)
  const left = natural >= MIN_MARK_W ? usToPx(w.startUs, pxPerSec, scrollUs) : cutX - width / 2
  return { left, width, cutX }
}

/** B do corte (entre dois itens encostados) mais perto de `atUs` dentro da tolerância; null se não há. */
export function cutNear(track: Track, atUs: Us, tolUs: Us): string | null {
  const items = track.items
  let best: { id: string; d: number } | null = null
  for (let i = Math.max(1, firstEndingAfter(items, atUs - tolUs) - 1); i < items.length && items[i - 1].startUs <= atUs + tolUs; i++) {
    const a = items[i - 1], b = items[i]
    if (itemEndUs(a) !== b.startUs) continue
    const d = Math.abs(b.startUs - atUs)
    if (d <= tolUs && (!best || d < best.d)) best = { id: b.id, d }
  }
  return best?.id ?? null
}

export type TransitionDrop = { toId: string; via: 'cut' | 'item' }

/**
 * Alvo do soltar de uma transição na faixa: o corte a até `tolUs` do ponteiro (entre dois itens encostados); senão o
 * item sob o ponteiro (a transição entra nele, vinda do anterior). null = nada sob o ponteiro.
 */
export function transitionDropTarget(track: Track, atUs: Us, tolUs: Us): TransitionDrop | null {
  const cut = cutNear(track, atUs, tolUs)
  if (cut) return { toId: cut, via: 'cut' }
  const under = track.items.find((i) => atUs >= i.startUs && atUs < itemEndUs(i))
  return under ? { toId: under.id, via: 'item' } : null
}

/** A transição pode entrar em `toId` (B)? Devolve o motivo (pt-BR) ou null. */
export function transitionDropReason(p: Project, trackId: string, toId: string): string | null {
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track) return 'Faixa não encontrada'
  const i = track.items.findIndex((x) => x.id === toId)
  return canTransition(p, trackId, i > 0 ? track.items[i - 1].id : undefined, toId)
}

export interface CutChoice { trackId: string; toId: string; cutUs: Us }

/**
 * Corte elegível (mesma regra de canTransition) mais perto do playhead nas faixas dadas (desbloqueadas); empate: o
 * primeiro. null = nenhum corte elegível.
 * Sem faixas dadas (`trackIds` null = nada selecionado), procura em todas as de vídeo MENOS a de legendas e só em pares
 * com pelo menos um lado de mídia: cortes entre legendas/títulos encostados são comuns (SRT importado) e o atalho
 * “Dissolver no corte mais próximo” não pode cair neles sem o usuário pedir (texto→texto pede seleção ou soltar).
 * O(itens das faixas): a regra do par é conferida em O(1) por par, sem buscas no projeto.
 */
export function nearestEligibleCut(p: Project, trackIds: string[] | null, playheadUs: Us): CutChoice | null {
  let best: (CutChoice & { d: number }) | null = null
  const only = trackIds ? new Set(trackIds) : null
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.locked) continue
    if (only ? !only.has(t.id) : isCaptionsTrack(t)) continue
    for (let i = 1; i < t.items.length; i++) {
      const a = t.items[i - 1], b = t.items[i]
      if (!transitionPairOk(t, a, b) || a.enabled === false || b.enabled === false || maxTransitionUs(a, b) < MIN_TRANSITION_US) continue
      if (!only && a.type !== 'media' && b.type !== 'media') continue
      const d = Math.abs(b.startUs - playheadUs)
      if (!best || d < best.d) best = { trackId: t.id, toId: b.id, cutUs: b.startUs, d }
    }
  }
  return best ? { trackId: best.trackId, toId: best.toId, cutUs: best.cutUs } : null
}

/**
 * Duração durante o arraste de uma borda da janela. A janela é centrada no corte: mover a borda de saída (end) `deltaUs`
 * para a direita, ou a de entrada (start) para a esquerda, muda a duração em 2×deltaUs. Limites do par: [mínimo, máximo].
 */
export function dragDuration(startDurationUs: Us, edge: 'start' | 'end', deltaUs: Us, a: Item, b: Item): Us {
  const raw = Math.round(startDurationUs + (edge === 'end' ? 2 : -2) * deltaUs)
  return Math.min(maxTransitionUs(a, b), Math.max(MIN_TRANSITION_US, raw))
}

// ---- zonas de ponteiro do ícone (para o ícone nunca cobrir as alças de aparar do corte)

/** Ícone da transição: círculo no TOPO da faixa; abaixo dele as alças de aparar (A.fim/B.início) ficam livres. */
export const ICON_SIZE = 18
export const ICON_TOP = 3
/** Largura das alças de aparar do ItemView (EDGE_W) de cada lado do corte. */
export const TRIM_ZONE_PX = 7
/** Largura das alças de duração nas bordas da janela. */
export const DURATION_EDGE_PX = 6

export interface Rect { x0: number; y0: number; x1: number; y1: number }
/** Retângulos (px, x relativo à esquerda da faixa da janela; y do topo da faixa) que capturam o ponteiro. */
export function markRects(g: { left: number; width: number; cutX: number }, rowH: number): { icon: Rect; start: Rect; end: Rect } {
  const cx = g.cutX - g.left
  const h = DURATION_EDGE_PX / 2
  return {
    icon: { x0: cx - ICON_SIZE / 2, y0: ICON_TOP, x1: cx + ICON_SIZE / 2, y1: ICON_TOP + ICON_SIZE },
    start: { x0: -h, y0: 3, x1: h, y1: rowH - 3 },
    end: { x0: g.width - h, y0: 3, x1: g.width + h, y1: rowH - 3 }
  }
}
/** Alças de aparar do corte (mesmas coordenadas de markRects): A.fim à esquerda e B.início à direita do corte. */
export function trimRects(g: { left: number; cutX: number }, rowH: number): { aEnd: Rect; bStart: Rect } {
  const cx = g.cutX - g.left
  return { aEnd: { x0: cx - TRIM_ZONE_PX, y0: 0, x1: cx, y1: rowH }, bStart: { x0: cx, y0: 0, x1: cx + TRIM_ZONE_PX, y1: rowH } }
}
export const rectsOverlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
