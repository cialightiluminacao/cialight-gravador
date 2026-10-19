import type { Asset } from '@shared/editor/project'
export type MediaSort = 'name' | 'duration' | 'size' | 'type'
const fold = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
export function libraryAssets(assets: readonly Asset[], query: string, sort: MediaSort, descending: boolean): Asset[] {
  const terms = fold(query).trim().split(/\s+/).filter(Boolean)
  const size = (a: Asset): number => a.source.type === 'file' ? a.source.size : 0
  return assets.filter(a => terms.every(t => fold(a.name).includes(t))).sort((a, b) => {
    const comparison = sort === 'duration' ? (a.durationUs ?? -1) - (b.durationUs ?? -1) : sort === 'size' ? size(a) - size(b) : sort === 'type' ? a.kind.localeCompare(b.kind) : 0
    const order = comparison || a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' })
    return descending ? -order : order
  })
}
