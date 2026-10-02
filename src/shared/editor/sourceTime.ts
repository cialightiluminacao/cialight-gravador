// Tempo da timeline → tempo da fonte de um clipe de mídia (corte, velocidade, reverso, congelado). Pura. Módulo próprio
// para o resolve e o tempo do cursor (cursorTime) usarem a mesma conta sem import circular.
import type { Asset, MediaItem, Us } from './project'
import { frameDurUs } from './time'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Tempo na fonte (µs) para o instante tUs da timeline. */
export function sourceTimeUs(item: MediaItem, asset: Asset, tUs: Us): Us {
  const local = tUs - item.startUs
  let src: number
  if (item.freeze) src = item.freeze.atUs
  else if (item.reverse) src = item.inUs + (item.durationUs - local) * item.speed - frameDurUs(asset.video?.fps || 30)
  else src = item.inUs + local * item.speed
  const max = asset.durationUs != null ? Math.max(0, asset.durationUs - 1) : Infinity
  return Math.round(clamp(src, 0, max))
}
