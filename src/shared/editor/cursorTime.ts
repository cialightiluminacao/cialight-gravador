// Tempo da timeline ↔ tempo da trilha do cursor (F6). Pura.
import { CURSOR_VIDEO_LAG_MS } from '../cursor'
import type { Asset, MediaItem, Project, Us } from './project'
import { sourceTimeUs } from './resolve'
import { frameDurUs } from './time'

const videoAsset = (p: Project, item: MediaItem): Asset | null => {
  const asset = p.assets.find((a) => a.id === item.assetId)
  return asset && asset.kind === 'video' ? asset : null
}

/**
 * Instante (ms, fracionário) da trilha do cursor que corresponde ao quadro mostrado em `timelineUs` pelo clipe:
 * o mesmo tempo da fonte do resolve (sourceTimeUs: corte, velocidade, reverso, congelado) menos o atraso do vídeo
 * em relação à trilha (CURSOR_VIDEO_LAG_MS, ruling R11). Pode ser negativo (antes da 1ª amostra: cursorAt dá null).
 * null fora de [início, fim) do clipe, sem o asset ou asset que não é vídeo.
 */
export function cursorTimeMs(p: Project, item: MediaItem, timelineUs: Us): number | null {
  if (timelineUs < item.startUs || timelineUs >= item.startUs + item.durationUs) return null
  const asset = videoAsset(p, item)
  if (!asset) return null
  return sourceTimeUs(item, asset, timelineUs) / 1000 - CURSOR_VIDEO_LAG_MS
}

/**
 * Inverso de cursorTimeMs (ruling R15): instante da timeline (µs, inteiro) em que o clipe mostra o quadro do instante
 * `cursorMs` da trilha — a mesma conta do sourceTimeUs desfeita (corte, velocidade constante e reverso, que continua
 * monótono: decrescente), com o atraso R11 somado de volta. null fora de [início, fim) do clipe, clipe congelado (não
 * inversível: todo instante mostra o mesmo quadro), sem o asset ou asset que não é vídeo. Não prende ao fim do
 * asset (o resolve prende a fonte; o instante devolvido é o da conta, dentro do clipe).
 */
export function timelineUsAtCursorMs(p: Project, item: MediaItem, cursorMs: number): Us | null {
  if (item.freeze || !(item.speed > 0) || !Number.isFinite(cursorMs)) return null
  const asset = videoAsset(p, item)
  if (!asset) return null
  const src = (cursorMs + CURSOR_VIDEO_LAG_MS) * 1000
  const local = item.reverse
    ? item.durationUs - (src - item.inUs + frameDurUs(asset.video?.fps || 30)) / item.speed
    : (src - item.inUs) / item.speed
  const t = item.startUs + Math.round(local)
  return t >= item.startUs && t < item.startUs + item.durationUs ? t : null
}

/** Par tempo local do item (µs, 0..durationUs) ↔ tempo da trilha do cursor (ms), para o planejamento puro. */
export interface CursorTimeMap {
  durationUs: Us
  /** Clipe invertido: o tempo do cursor decresce ao longo do item. */
  reversed: boolean
  toCursorMs(localUs: Us): number | null
  toLocalUs(cursorMs: number): Us | null
}

/** Mapa do item (cursorTimeMs / timelineUsAtCursorMs em tempo local). null: congelado, sem asset ou não é vídeo. */
export function cursorTimeMap(p: Project, item: MediaItem): CursorTimeMap | null {
  if (item.freeze || !videoAsset(p, item)) return null
  return {
    durationUs: item.durationUs,
    reversed: !!item.reverse,
    toCursorMs: (localUs) => cursorTimeMs(p, item, item.startUs + localUs),
    toLocalUs: (cursorMs) => {
      const t = timelineUsAtCursorMs(p, item, cursorMs)
      return t === null ? null : t - item.startUs
    }
  }
}
