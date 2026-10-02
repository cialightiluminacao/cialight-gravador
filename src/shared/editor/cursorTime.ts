// Tempo da timeline → tempo da trilha do cursor (F6). Pura.
import { CURSOR_VIDEO_LAG_MS } from '../cursor'
import type { MediaItem, Project, Us } from './project'
import { sourceTimeUs } from './resolve'

/**
 * Instante (ms, fracionário) da trilha do cursor que corresponde ao quadro mostrado em `timelineUs` pelo clipe:
 * o mesmo tempo da fonte do resolve (sourceTimeUs: corte, velocidade, reverso, congelado) menos o atraso do vídeo
 * em relação à trilha (CURSOR_VIDEO_LAG_MS, ruling R11). Pode ser negativo (antes da 1ª amostra: cursorAt dá null).
 * null fora de [início, fim) do clipe, sem o asset ou asset que não é vídeo.
 */
export function cursorTimeMs(p: Project, item: MediaItem, timelineUs: Us): number | null {
  if (timelineUs < item.startUs || timelineUs >= item.startUs + item.durationUs) return null
  const asset = p.assets.find((a) => a.id === item.assetId)
  if (!asset || asset.kind !== 'video') return null
  return sourceTimeUs(item, asset, timelineUs) / 1000 - CURSOR_VIDEO_LAG_MS
}
