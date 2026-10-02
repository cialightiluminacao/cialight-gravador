import type { Item, Project, Track, TransitionKind, Us } from './project'

/*
 * Transições entre clipes adjacentes — modelo "centrado no corte, SEM handles".
 *
 * `B.transitionIn = { kind, durationUs: d }` liga B ao item ANTERIOR A da mesma faixa de vídeo, encostado
 * (A.startUs + A.durationUs === B.startUs = cut). Os itens continuam adjacentes no modelo (nada se sobrepõe, a
 * duração do projeto não muda; a v1.3 ignora o campo e mostra corte seco). A janela da transição é
 * [cut − half, cut − half + d) com half = floor(d/2) (µs inteiros: d ímpar põe o µs a mais depois do corte).
 * Durante a janela:
 *  - A mostra o conteúdo normal até o corte e depois fica CONGELADO no último quadro visível (tempo de timeline
 *    cut − 1);
 *  - B fica CONGELADO no primeiro quadro (tempo de timeline cut) antes do corte e toca normal depois.
 * Nunca se mostra conteúdo da fonte fora do trecho aparado (o que foi cortado pode ser sigiloso).
 *
 * Elegíveis: A e B na mesma faixa de vídeo, encostados, cada um mídia com visual (inclui imagem) ou texto. Formas,
 * efeitos e anotações não participam. `enabled` NÃO conta na regra estrutural: desativar A ou B é reversível e a
 * transição continua gravada (normalização e validateProject a mantêm); quem desenha/mixa pula o par com um lado
 * desativado (pairActive). Só criar uma transição nova (canTransition/addTransition) exige os dois ativos.
 * Limites: MIN_TRANSITION_US ≤ d ≤ floor(min(A, B) / 2).
 */

/** Menor duração de uma transição. */
export const MIN_TRANSITION_US = 100_000
/** Duração de uma transição nova (limitada ao máximo do par). */
export const DEFAULT_TRANSITION_US = 500_000

/** Janela de uma transição na timeline; endUs exclusivo. */
export interface TransitionWindow {
  trackId: string
  fromId: string
  toId: string
  kind: TransitionKind
  durationUs: Us
  cutUs: Us
  startUs: Us
  endUs: Us
}

/** Tipo de item que pode participar de uma transição (dos dois lados). Ignora `enabled` (ver o modelo acima). */
export function transitionEligible(it: Item): boolean {
  return (it.type === 'media' && !!it.visual) || it.type === 'text'
}

/** Maior duração de transição entre A e B (floor(min/2)). */
export function maxTransitionUs(a: Item, b: Item): Us {
  return Math.floor(Math.min(a.durationUs, b.durationUs) / 2)
}

/** Par (A, B) estruturalmente válido numa faixa: faixa de vídeo, encostados e elegíveis. Não olha a duração nem `enabled`. */
export function transitionPairOk(track: Track, a: Item | undefined, b: Item): a is Item {
  return !!a && track.kind === 'video' && a.startUs + a.durationUs === b.startUs && transitionEligible(a) && transitionEligible(b)
}

/**
 * Motivo (pt-BR, para EditError) de não poder haver transição de A para B na faixa; null = pode.
 * Não confere bloqueio da faixa (a operação lança 'locked' antes).
 */
export function canTransition(p: Project, trackId: string, aId: string | undefined, bId: string): string | null {
  const NOT_ADJ = 'Transição só entre dois clipes encostados na mesma faixa'
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track) return NOT_ADJ
  const a = aId ? track.items.find((i) => i.id === aId) : undefined
  const b = track.items.find((i) => i.id === bId)
  if (!a || !b || a.startUs + a.durationUs !== b.startUs) return NOT_ADJ
  if (track.kind !== 'video') return 'Transição só entre clipes de faixas de vídeo'
  if (a.enabled === false || b.enabled === false) return 'Transição só entre clipes ativos'
  if (!transitionEligible(a) || !transitionEligible(b)) return 'Transição só entre clipes de vídeo, imagem ou texto'
  if (maxTransitionUs(a, b) < MIN_TRANSITION_US) return 'Clipes curtos demais para a transição'
  return null
}

/**
 * Janela da transição que entra no item `items[i]` (B) da faixa, ou null se não houver uma válida. Duração acima do
 * máximo (projeto antigo/editado fora) é limitada ao máximo para desenhar; abaixo do mínimo, nenhuma.
 */
function windowAt(track: Track, i: number): TransitionWindow | null {
  if (i <= 0 || i >= track.items.length) return null
  const b = track.items[i]
  if ((b.type !== 'media' && b.type !== 'text') || !b.transitionIn) return null
  const a = track.items[i - 1]
  if (!transitionPairOk(track, a, b)) return null
  const d = Math.min(b.transitionIn.durationUs, maxTransitionUs(a, b))
  if (d < MIN_TRANSITION_US) return null
  const cutUs = b.startUs
  const startUs = cutUs - Math.floor(d / 2)
  return { trackId: track.id, fromId: a.id, toId: b.id, kind: b.transitionIn.kind, durationUs: d, cutUs, startUs, endUs: startUs + d }
}

/**
 * Todas as janelas estruturalmente válidas do projeto. NÃO filtra faixas ocultas nem itens desativados: quem desenha
 * ou mixa pula a janela se a faixa estiver oculta ou se algum lado estiver desativado (pairActive). O(itens).
 */
export function transitionWindows(p: Project): TransitionWindow[] {
  const out: TransitionWindow[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    for (let i = 1; i < t.items.length; i++) {
      const w = windowAt(t, i)
      if (w) out.push(w)
    }
  }
  return out
}

/**
 * Janela que contém tUs na faixa (itens ordenados por startUs, sem sobreposição), ou null. Busca binária: O(log n)
 * por quadro. As janelas nunca se sobrepõem (cada uma ocupa no máximo metade de cada clipe, dividida no corte).
 * Como transitionWindows, NÃO filtra itens desativados nem faixa oculta: o chamador confere (pairActive).
 */
export function transitionAt(track: Track, tUs: Us): TransitionWindow | null {
  if (track.kind !== 'video') return null
  const items = track.items
  // último item com startUs ≤ tUs
  let lo = 0, hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].startUs <= tUs) lo = mid + 1
    else hi = mid
  }
  const i = lo - 1
  // tUs antes do corte (dentro de A = items[i]) → transição para items[i+1]; depois do corte → transição para items[i]
  const next = windowAt(track, i + 1)
  if (next && tUs >= next.startUs && tUs < next.endUs) return next
  const cur = windowAt(track, i)
  return cur && tUs >= cur.startUs && tUs < cur.endUs ? cur : null
}

/**
 * Os dois lados da janela estão ativos (enabled !== false)? Para quem desenha/mixa: par com um lado desativado = corte
 * seco. O(log n): B é o item que começa no corte e A o anterior.
 */
export function pairActive(track: Track, w: TransitionWindow): boolean {
  const items = track.items
  let lo = 0, hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].startUs < w.cutUs) lo = mid + 1
    else hi = mid
  }
  const a = items[lo - 1], b = items[lo]
  return !!a && !!b && a.id === w.fromId && b.id === w.toId && a.enabled !== false && b.enabled !== false
}

/** Progresso linear 0–1 da transição em tUs (limitado). */
export function windowProgress(w: TransitionWindow, tUs: Us): number {
  if (w.durationUs <= 0) return 1
  return Math.min(1, Math.max(0, (tUs - w.startUs) / w.durationUs))
}

/** Tempos de timeline em que A (último quadro visível) e B (primeiro quadro) são avaliados quando congelados. */
export function frozenTimes(w: TransitionWindow): { fromUs: Us; toUs: Us } {
  return { fromUs: w.cutUs - 1, toUs: w.cutUs }
}
