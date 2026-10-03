// Camadas que precisam de fonte (decoder/imagem/sessão) num quadro, e quando um item começa a ser desenhado.
// Usado pelo render worker (coleta de fontes, slots por asset e pré-carga). Puro.
import type { Asset, Item, Track, Us } from '@shared/editor/project'
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

/** Camada que lê um decoder de vídeo (um slot por camada do mesmo asset no quadro). */
export interface SlotLayer { itemId: string; assetId: string }
/** Slot de decoder de cada item no quadro (itemId → asset e slot). */
export type SlotMap = Map<string, { assetId: string; slot: number }>

/** Camadas de mídia de vídeo (srcUs ≠ null) com asset disponível, na ordem de desenho (flatLayers). */
export function decodedLayers(assets: readonly Asset[], flat: readonly Layer[]): SlotLayer[] {
  const out: SlotLayer[] = []
  for (const l of flat) {
    if (l.kind !== 'media' || l.srcUs === null) continue
    const asset = assets.find((a) => a.id === l.assetId)
    if (asset && asset.status !== 'missing') out.push({ itemId: l.itemId, assetId: l.assetId })
  }
  return out
}

/**
 * Slot de decoder por camada: o item que já tinha um slot do mesmo asset no quadro anterior (`prev`) fica com ele (o
 * iterador dele continua posicionado — no fim de uma transição entre dois trechos da MESMA gravação, B não troca de
 * iterador); os demais pegam o menor slot livre do asset, na ordem de desenho.
 */
export function assignSlots(layers: readonly SlotLayer[], prev: ReadonlyMap<string, { assetId: string; slot: number }>): SlotMap {
  const out: SlotMap = new Map()
  const taken = new Map<string, Set<number>>()
  const takenOf = (assetId: string): Set<number> => {
    let t = taken.get(assetId)
    if (!t) taken.set(assetId, (t = new Set()))
    return t
  }
  for (const l of layers) {
    const was = prev.get(l.itemId)
    if (!was || was.assetId !== l.assetId || takenOf(l.assetId).has(was.slot)) continue
    takenOf(l.assetId).add(was.slot)
    out.set(l.itemId, { assetId: l.assetId, slot: was.slot })
  }
  for (const l of layers) {
    if (out.has(l.itemId)) continue
    const t = takenOf(l.assetId)
    let slot = 0
    while (t.has(slot)) slot++
    t.add(slot)
    out.set(l.itemId, { assetId: l.assetId, slot })
  }
  // ordem de desenho (o Map lembra a inserção: refaz nessa ordem)
  return new Map(layers.map((l) => [l.itemId, out.get(l.itemId)!]))
}
