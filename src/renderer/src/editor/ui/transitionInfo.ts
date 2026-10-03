import type { TransitionKind, Us } from '@shared/editor/project'

// Nomes (pt-BR) e textos das transições para a biblioteca, o ícone na linha do tempo, o inspetor e os menus.

/** Ordem da biblioteca (as 11 de TransitionKind). */
export const TRANSITION_KINDS: TransitionKind[] = ['crossfade', 'dipBlack', 'dipWhite', 'slideL', 'slideR', 'slideU', 'slideD', 'wipeL', 'wipeR', 'zoomIn', 'blur']

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  crossfade: 'Dissolver',
  dipBlack: 'Mergulho no preto',
  dipWhite: 'Mergulho no branco',
  slideL: 'Deslizar ←',
  slideR: 'Deslizar →',
  slideU: 'Deslizar ↑',
  slideD: 'Deslizar ↓',
  wipeL: 'Cortina ←',
  wipeR: 'Cortina →',
  zoomIn: 'Zoom',
  blur: 'Desfoque'
}

export const TRANSITION_HINTS: Record<TransitionKind, string> = {
  crossfade: 'O clipe anterior some enquanto o seguinte aparece',
  dipBlack: 'Escurece até o preto e volta no clipe seguinte',
  dipWhite: 'Clareia até o branco e volta no clipe seguinte',
  slideL: 'O clipe seguinte empurra o anterior para a esquerda',
  slideR: 'O clipe seguinte empurra o anterior para a direita',
  slideU: 'O clipe seguinte empurra o anterior para cima',
  slideD: 'O clipe seguinte empurra o anterior para baixo',
  wipeL: 'Uma cortina revela o clipe seguinte da direita para a esquerda',
  wipeR: 'Uma cortina revela o clipe seguinte da esquerda para a direita',
  zoomIn: 'Aproxima o clipe anterior enquanto o seguinte aparece',
  blur: 'Desfoca o clipe anterior até o seguinte surgir nítido'
}

export const transitionLabel = (kind: TransitionKind): string => TRANSITION_LABELS[kind] ?? kind

/** "0,5 s", "1,25 s": segundos com vírgula, sem zeros à direita. */
export function formatTransitionDuration(us: Us): string {
  const s = Math.round(us / 10_000) / 100
  return `${String(s).replace('.', ',')} s`
}

/** Rótulo de acessibilidade do ícone na linha do tempo. */
export const transitionAria = (kind: TransitionKind, durationUs: Us): string => `Transição: ${transitionLabel(kind)}, ${formatTransitionDuration(durationUs)}`

/** Durações do menu de contexto ("duração padrão"): atalhos em µs. */
export const TRANSITION_DURATION_CHOICES: Us[] = [250_000, 500_000, 1_000_000, 1_500_000]
