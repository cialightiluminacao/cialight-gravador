import type { Item, Project } from '@shared/editor/project'

// Nome exibido de um item: o nome dele; senão o da mídia; senão o tipo em português.

export const ITEM_TYPE_LABEL: Record<Item['type'], string> = { media: 'Mídia', text: 'Texto', shape: 'Forma', effect: 'Efeito', annotations: 'Anotações' }

export function itemLabel(p: Project, item: Item): string {
  if (item.name) return item.name
  if (item.type === 'media') {
    const asset = p.assets.find((a) => a.id === item.assetId)
    if (asset) return asset.name
  }
  return ITEM_TYPE_LABEL[item.type]
}
