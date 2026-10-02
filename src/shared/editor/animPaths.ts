// Propriedades animáveis dos itens: caminhos (AnimPath), leitura/escrita por caminho e o mapa de todas as animações
// de um item. Fonte única para as operações (split, velocidade, reverso, congelar, keyframes), a validação do schema
// e a privacidade. Puro.
import type { Anim, Item, VisualProps } from './project'

export type AnimPath =
  | 'transform.x' | 'transform.y' | 'transform.scale' | 'transform.rotation' | 'transform.opacity'
  | 'crop.l' | 'crop.t' | 'crop.r' | 'crop.b'
  | 'adjust.brightness' | 'adjust.contrast' | 'adjust.saturation'
  | 'visual.radius' | 'text.size'
  | 'region.x' | 'region.y' | 'region.w' | 'region.h' | 'region.rotation'
  | 'strength' | 'audio.volume'

export const ANIM_PATHS: readonly AnimPath[] = [
  'transform.x', 'transform.y', 'transform.scale', 'transform.rotation', 'transform.opacity',
  'crop.l', 'crop.t', 'crop.r', 'crop.b',
  'adjust.brightness', 'adjust.contrast', 'adjust.saturation',
  'visual.radius', 'text.size',
  'region.x', 'region.y', 'region.w', 'region.h', 'region.rotation',
  'strength', 'audio.volume'
]

type RegionKey = 'x' | 'y' | 'w' | 'h' | 'rotation'
type TransformKey = keyof VisualProps['transform']
type CropKey = keyof VisualProps['crop']
type AdjustKey = keyof NonNullable<VisualProps['adjust']>

/** Ajuste neutro (adjust ausente = 0, 0, 0 no compositor). */
const neutralAdjust = (): NonNullable<VisualProps['adjust']> => ({ brightness: { value: 0 }, contrast: { value: 0 }, saturation: { value: 0 } })

const visualOf = (item: Item): VisualProps | undefined =>
  item.type === 'media' || item.type === 'text' || item.type === 'shape' ? item.visual : undefined

/**
 * Animação do item no caminho dado; null se o tipo de item não tem essa propriedade. Opcionais ausentes valem o
 * neutro (adjust → 0; radius → 0 = arredondamento automático), como no resolve.
 */
export function getAnim(item: Item, path: AnimPath): Anim<number> | null {
  const [group, key] = path.split('.') as [string, string | undefined]
  switch (group) {
    case 'strength': return item.type === 'effect' ? item.strength : null
    case 'audio': return item.type === 'media' ? item.audio.volume : null
    case 'region': return item.type === 'effect' ? item.region[key as RegionKey] : null
    case 'text': return item.type === 'text' ? item.style.size : null
  }
  const v = visualOf(item)
  if (!v) return null
  switch (group) {
    case 'transform': return v.transform[key as TransformKey]
    case 'crop': return v.crop[key as CropKey]
    case 'adjust': return v.adjust?.[key as AdjustKey] ?? { value: 0 }
    default: return v.radius ?? { value: 0 }
  }
}

/** Grava a animação no item (draft do immer); o caminho já foi validado por getAnim. */
export function assignAnim(item: Item, path: AnimPath, a: Anim<number>): void {
  const [group, key] = path.split('.') as [string, string | undefined]
  if (item.type === 'effect') {
    if (group === 'strength') item.strength = a
    else if (group === 'region') item.region[key as RegionKey] = a
    return
  }
  if (group === 'audio') {
    if (item.type === 'media') item.audio.volume = a
    return
  }
  if (group === 'text') {
    if (item.type === 'text') item.style.size = a
    return
  }
  const v = visualOf(item)
  if (!v) return
  if (group === 'transform') v.transform[key as TransformKey] = a
  else if (group === 'crop') v.crop[key as CropKey] = a
  else if (group === 'adjust') (v.adjust ??= neutralAdjust())[key as AdjustKey] = a
  else v.radius = a
}

/** Aplica f a todas as animações das propriedades visuais (transformação, corte, ajuste e raio presentes). */
export function mapVisualAnims(v: VisualProps, f: (a: Anim<number>) => Anim<number>): VisualProps {
  const t = v.transform, c = v.crop, ad = v.adjust
  return {
    ...v,
    transform: { x: f(t.x), y: f(t.y), scale: f(t.scale), rotation: f(t.rotation), opacity: f(t.opacity) },
    crop: { l: f(c.l), t: f(c.t), r: f(c.r), b: f(c.b) },
    ...(ad ? { adjust: { brightness: f(ad.brightness), contrast: f(ad.contrast), saturation: f(ad.saturation) } } : {}),
    ...(v.radius ? { radius: f(v.radius) } : {})
  }
}

/** Aplica f a todas as animações do item (visuais, tamanho do texto, volume, região e força do efeito). */
export function mapItemAnims<T extends Item>(it: T, f: (a: Anim<number>) => Anim<number>): T {
  const i = it as Item
  switch (i.type) {
    case 'media':
      return { ...i, audio: { ...i.audio, volume: f(i.audio.volume) }, ...(i.visual ? { visual: mapVisualAnims(i.visual, f) } : {}) } as T
    case 'text':
      return { ...i, style: { ...i.style, size: f(i.style.size) }, visual: mapVisualAnims(i.visual, f) } as T
    case 'shape':
      return { ...i, visual: mapVisualAnims(i.visual, f) } as T
    case 'effect': {
      const r = i.region
      return { ...i, region: { ...r, x: f(r.x), y: f(r.y), w: f(r.w), h: f(r.h), rotation: f(r.rotation) }, strength: f(i.strength) } as T
    }
    default:
      return it
  }
}

/** [caminho, animação] de cada propriedade animável presente no item (opcionais ausentes ficam de fora). */
export function itemAnimEntries(it: Item): [AnimPath, Anim<number>][] {
  const out: [AnimPath, Anim<number>][] = []
  const v = visualOf(it)
  for (const pt of ANIM_PATHS) {
    if (pt.startsWith('adjust.') && !v?.adjust) continue
    if (pt === 'visual.radius' && !v?.radius) continue
    const a = getAnim(it, pt)
    if (a) out.push([pt, a])
  }
  return out
}
