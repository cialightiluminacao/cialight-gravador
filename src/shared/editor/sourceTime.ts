// Tempo da timeline → tempo da fonte de um clipe de mídia (corte, velocidade, reverso, congelado). Pura. Módulo próprio
// para o resolve e o tempo do cursor (cursorTime) usarem a mesma conta sem import circular.
import type { Asset, MediaItem, Us } from './project'
import { frameDurUs } from './time'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Tempo na fonte (µs) para o instante tUs da timeline. Sempre dentro do trecho aparado [inUs, inUs + ⌈dur·speed⌉ − 1]
 * (congelado: o próprio freeze.atUs): o que foi cortado pode ser sigiloso. Até a v1.4 o reverso lia, no fim do clipe,
 * até um quadro ANTES de inUs (− 1 quadro da fórmula) — um quadro do trecho cortado aparecia; a trava corrige isso (F5).
 */
export function sourceTimeUs(item: MediaItem, asset: Asset, tUs: Us): Us {
  const local = tUs - item.startUs
  let src: number
  if (item.freeze) src = item.freeze.atUs
  else {
    src = item.reverse
      ? item.inUs + (item.durationUs - local) * item.speed - frameDurUs(asset.video?.fps || 30)
      : item.inUs + local * item.speed
    src = clamp(Math.round(src), item.inUs, item.inUs + Math.max(0, Math.ceil(item.durationUs * item.speed) - 1))
  }
  const max = asset.durationUs != null ? Math.max(0, asset.durationUs - 1) : Infinity
  return Math.round(clamp(src, 0, max))
}
