import { chaptersFromMarkers, type ChapterResult } from '@shared/editor/chapters'
import type { Marker } from '@shared/editor/project'
import { exportRange, hasInOut } from '../export/exportPlan'

/** Capítulos da ação "Copiar capítulos": o intervalo I–O se estiver marcado; senão, Tudo (0 até o fim do conteúdo). */
export function chaptersForEditor(markers: readonly Marker[], totalUs: number, inUs: number | null, outUs: number | null): ChapterResult {
  const range = exportRange(totalUs, inUs, outUs, hasInOut(totalUs, inUs, outUs) ? 'inout' : 'all')
  return chaptersFromMarkers(markers, range)
}
