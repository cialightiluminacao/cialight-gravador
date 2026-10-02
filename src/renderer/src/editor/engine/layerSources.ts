// Camadas que precisam de fonte (decoder/imagem/sessão) num quadro, e quando um item começa a ser desenhado.
// Usado pelo render worker (coleta de fontes, slots por asset e pré-carga). Puro.
import type { Item, Track, Us } from '@shared/editor/project'
import type { Layer } from '@shared/editor/resolve'
import { pairActive, transitionAt } from '@shared/editor/transitions'

/**
 * As camadas do quadro na ordem de desenho, com as de cada TransitionLayer (from, depois to) no lugar dela. O mesmo
 * asset pode aparecer em A e em B (trechos diferentes): duas camadas de mídia → dois slots de decoder.
 */
export function flatLayers(layers: readonly Layer[]): Layer[] {
  const out: Layer[] = []
  for (const l of layers) {
    if (l.kind === 'transition') out.push(...l.from, ...l.to)
    else out.push(l)
  }
  return out
}

/**
 * Primeiro instante em que o item é desenhado: o início da janela da transição que entra nele (B aparece congelado no
 * 1º quadro desde corte − d/2) quando ela está ativa na faixa visível; senão o início do item.
 */
export function firstDrawUs(track: Track, item: Item): Us {
  if (track.hidden) return item.startUs
  const w = transitionAt(track, item.startUs)
  return w && w.toId === item.id && pairActive(track, w) ? w.startUs : item.startUs
}
