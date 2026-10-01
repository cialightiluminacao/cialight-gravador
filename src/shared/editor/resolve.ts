// Resolve o estado do quadro em um instante da timeline: lista de camadas (fundo → topo)
// consumida pelo compositor (preview e export). Pura, sem DOM/Electron.
import { easeValue, evalAnim } from './anim'
import { defaultVisual } from './factory'
import type { Anim, AnimPreset, Asset, EffectItem, Item, MediaItem, Project, ShapeItem, TextStyle, Track, TransitionKind, Us, VisualProps } from './project'
import { frameDurUs } from './time'

export interface Rect { cx: number; cy: number; scale: number; rotation: number }

export interface MediaLayer {
  kind: 'media'; itemId: string; trackId: string; assetId: string
  srcUs: Us | null // null = imagem
  rect: Rect // já com animações de entrada/saída aplicadas
  opacity: number // transform.opacity × fades × animIn/Out
  crop: VisualProps['crop']; fit: VisualProps['fit']
  shape: 'rect' | 'rounded' | 'circle'; radius: number
  border?: { width: number; color: string }; adjust?: VisualProps['adjust']; mirror: boolean
}
export interface AnnotationsLayer { kind: 'annotations'; itemId: string; sessionId: string; sessionMs: number; autoFadeMs: number | null }
export interface EffectLayer {
  kind: 'effect'; itemId: string; effect: EffectItem['effect']
  region: { shape: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; rotation: number }
  strength: number; feather: number; color: string; invert: boolean; scope: 'below' | 'track'
}
export interface TextLayer { kind: 'text'; itemId: string; text: string; style: TextStyle; rect: Rect; opacity: number }
export interface ShapeLayer { kind: 'shape'; itemId: string; item: ShapeItem; rect: Rect; opacity: number }
// Em F1 só o tipo existe; a geração de transições vem na F5.
export interface TransitionLayer { kind: 'transition'; transition: TransitionKind; progress: number; from: Layer[]; to: Layer[] }
export type Layer = MediaLayer | AnnotationsLayer | EffectLayer | TextLayer | ShapeLayer | TransitionLayer

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

/** Item ativo em [start, end) de cada faixa (inclui faixas ocultas; resolveFrame filtra). */
export function activeItemsAt(p: Project, tUs: Us): { track: Track; item: Item }[] {
  const out: { track: Track; item: Item }[] = []
  for (const track of p.tracks) {
    const item = track.items.find((it) => tUs >= it.startUs && tUs < it.startUs + it.durationUs)
    if (item) out.push({ track, item })
  }
  return out
}

// F1: 'fade' multiplica opacity; 'slideL/R/U/D' deslocam cx/cy em até ±1 (de fora do quadro até a
// posição final, com easeValue('out')). 'zoom' e 'pop' são tratados como fade por enquanto (F4 completa).
function presetEffect(preset: AnimPreset, p: number, isIn: boolean): { opacity: number; dx: number; dy: number } {
  const pp = clamp(p, 0, 1)
  const e = easeValue('out', pp)
  const k = isIn ? 1 - e : e // distância ainda a percorrer (entrada) ou já percorrida (saída)
  switch (preset) {
    case 'slideL': return { opacity: 1, dx: -k, dy: 0 }
    case 'slideR': return { opacity: 1, dx: k, dy: 0 }
    case 'slideU': return { opacity: 1, dx: 0, dy: -k }
    case 'slideD': return { opacity: 1, dx: 0, dy: k }
    default: return { opacity: isIn ? pp : 1 - pp, dx: 0, dy: 0 }
  }
}

function visualState(v: VisualProps, itemDur: Us, local: Us): { rect: Rect; opacity: number } {
  const t = v.transform
  let cx = evalAnim(t.x, local)
  let cy = evalAnim(t.y, local)
  let opacity = evalAnim(t.opacity, local)
  const remaining = itemDur - local
  if (v.fadeInUs > 0 && local < v.fadeInUs) opacity *= clamp(local / v.fadeInUs, 0, 1)
  if (v.fadeOutUs > 0 && remaining < v.fadeOutUs) opacity *= clamp(remaining / v.fadeOutUs, 0, 1)
  if (v.animIn && v.animIn.durationUs > 0 && local < v.animIn.durationUs) {
    const r = presetEffect(v.animIn.preset, local / v.animIn.durationUs, true)
    opacity *= r.opacity; cx += r.dx; cy += r.dy
  }
  if (v.animOut && v.animOut.durationUs > 0 && remaining < v.animOut.durationUs) {
    const r = presetEffect(v.animOut.preset, 1 - remaining / v.animOut.durationUs, false)
    opacity *= r.opacity; cx += r.dx; cy += r.dy
  }
  return { rect: { cx, cy, scale: evalAnim(t.scale, local), rotation: evalAnim(t.rotation, local) }, opacity: clamp(opacity, 0, 1) }
}

const ev = (a: Anim<number>, local: Us): number => evalAnim(a, local)

/** Camadas visíveis no instante tUs, da mais ao fundo (faixa 0) à mais ao topo. */
export function resolveFrame(p: Project, tUs: Us): Layer[] {
  const layers: Layer[] = []
  for (const { track, item } of activeItemsAt(p, tUs)) {
    if (track.hidden) continue
    const local = tUs - item.startUs
    switch (item.type) {
      case 'media': {
        if (track.kind !== 'video') break
        const asset = p.assets.find((a) => a.id === item.assetId)
        if (!asset) break
        const v = item.visual ?? defaultVisual()
        const s = visualState(v, item.durationUs, local)
        layers.push({
          kind: 'media', itemId: item.id, trackId: track.id, assetId: asset.id,
          srcUs: asset.kind === 'image' ? null : sourceTimeUs(item, asset, tUs),
          rect: s.rect, opacity: s.opacity, crop: v.crop, fit: v.fit,
          shape: v.shape ?? 'rect', radius: v.radius ?? 0,
          ...(v.border ? { border: v.border } : {}), ...(v.adjust ? { adjust: v.adjust } : {}),
          mirror: v.mirror ?? false
        })
        break
      }
      case 'annotations':
        layers.push({ kind: 'annotations', itemId: item.id, sessionId: item.sessionId, sessionMs: (item.inUs + local) / 1000, autoFadeMs: item.autoFadeMs ?? null })
        break
      case 'text': {
        const s = visualState(item.visual, item.durationUs, local)
        layers.push({ kind: 'text', itemId: item.id, text: item.text, style: item.style, rect: s.rect, opacity: s.opacity })
        break
      }
      case 'shape': {
        const s = visualState(item.visual, item.durationUs, local)
        layers.push({ kind: 'shape', itemId: item.id, item, rect: s.rect, opacity: s.opacity })
        break
      }
      case 'effect': {
        const r = item.region
        layers.push({
          kind: 'effect', itemId: item.id, effect: item.effect,
          region: { shape: r.shape, x: ev(r.x, local), y: ev(r.y, local), w: ev(r.w, local), h: ev(r.h, local), rotation: ev(r.rotation, local) },
          strength: ev(item.strength, local), feather: item.feather, color: item.color, invert: item.invert, scope: item.scope
        })
        break
      }
    }
  }
  return layers
}
