// Resolve o estado do quadro em um instante da timeline: lista de camadas (fundo → topo)
// consumida pelo compositor (preview e export). Pura, sem DOM/Electron.
import { easeValue, evalAnim } from './anim'
import { ATTACH_PAD_PX, contentToScreen, type ClipFrame, type RegionValues } from './contentPose'
import { defaultVisual } from './factory'
import { layerBase } from './layerGeometry'
import type { Anim, AnimPreset, Asset, EffectItem, Item, MediaItem, Project, ShapeItem, TextStyle, Track, TransitionKind, Us, VisualProps } from './project'
import { frameDurUs } from './time'

export interface Rect { cx: number; cy: number; scale: number; rotation: number }
/** Corte e ajuste já avaliados no instante (o modelo guarda Anim). */
export interface CropValues { l: number; t: number; r: number; b: number }
export interface AdjustValues { brightness: number; contrast: number; saturation: number }
/** Estilo do texto com o tamanho avaliado no instante. */
export type ResolvedTextStyle = Omit<TextStyle, 'size'> & { size: number }

export interface MediaLayer {
  kind: 'media'; itemId: string; trackId: string; assetId: string
  srcUs: Us | null // null = imagem
  rect: Rect // já com animações de entrada/saída aplicadas
  opacity: number // transform.opacity × fades × animIn/Out
  crop: CropValues; fit: VisualProps['fit']
  shape: 'rect' | 'rounded' | 'circle'; radius: number
  border?: { width: number; color: string }; adjust?: AdjustValues; mirror: boolean
}
export interface AnnotationsLayer { kind: 'annotations'; itemId: string; trackId: string; sessionId: string; sessionMs: number; autoFadeMs: number | null }
export interface EffectLayer {
  kind: 'effect'; itemId: string; trackId: string; effect: EffectItem['effect']
  /**
   * Faixa cuja camada o escopo `track` afeta: o targetTrackId do efeito (projeto antigo sem ele: a faixa de vídeo
   * visível logo abaixo); null = nenhuma. resolveFrame põe o efeito `track` logo depois da camada dessa faixa.
   */
  targetTrackId: string | null
  region: { shape: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; rotation: number }
  strength: number; feather: number; color: string; invert: boolean; scope: 'below' | 'track'
}
export interface TextLayer { kind: 'text'; itemId: string; text: string; style: ResolvedTextStyle; rect: Rect; opacity: number }
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

/**
 * Retângulo e opacidade do item no instante local: transform avaliado + fades + animações de entrada/saída. Escala
 * presa a ≥ 0 e opacidade a [0,1] (curvas com overshoot). Também é a geometria que a privacidade confere.
 */
export function visualStateAt(v: VisualProps, itemDur: Us, local: Us): { rect: Rect; opacity: number } {
  const t = v.transform
  let cx = evalAnim(t.x, local)
  let cy = evalAnim(t.y, local)
  // presa antes de fades/presets: overshoot (> 1) não pode encurtar o fade nem passar de opaco
  let opacity = clamp(evalAnim(t.opacity, local), 0, 1)
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
  return { rect: { cx, cy, scale: Math.max(0, evalAnim(t.scale, local)), rotation: evalAnim(t.rotation, local) }, opacity: clamp(opacity, 0, 1) }
}

/**
 * Geometria do clipe no instante absoluto `at` (geometria de visualStateAt, com animações de entrada/saída, e fit/corte
 * por layerBase — a mesma conta do compositor). null = conteúdo invisível (escala ~0; `allowEmpty` devolve assim mesmo)
 * ou clipe sem propriedades visuais.
 */
export function clipFrameAt(p: Project, m: MediaItem, at: Us, allowEmpty = false): ClipFrame | null {
  const v = m.visual
  if (!v) return null
  const W = p.canvas.width, H = p.canvas.height
  // fonte exibida (sem dados de vídeo: o próprio quadro)
  const info = p.assets.find((x) => x.id === m.assetId)?.video
  const src = info && info.width > 0 && info.height > 0 ? { w: info.width, h: info.height, rotation: info.rotation } : { w: W, h: H, rotation: 0 as const }
  const local = at - m.startUs
  const rect = visualStateAt(v, m.durationUs, local).rect
  const c = v.crop
  const g = layerBase({ l: evalAnim(c.l, local), t: evalAnim(c.t, local), r: evalAnim(c.r, local), b: evalAnim(c.b, local) }, v.fit, src, { w: W, h: H })
  const sx = g.bw * rect.scale, sy = g.bh * rect.scale
  if (!allowEmpty && (sx < 1e-6 || sy < 1e-6)) return null
  return { cx: rect.cx, cy: rect.cy, rotation: rect.rotation, sx, sy, mirror: !!v.mirror, g, W, H }
}

/** Clipe ao qual o efeito está ancorado, se ainda existe como mídia visual numa faixa de vídeo e está ativo; senão null. */
export function attachedMedia(p: Project, fx: EffectItem): MediaItem | null {
  const id = fx.attach?.mediaItemId
  if (!id) return null
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    const m = t.items.find((i) => i.id === id)
    if (m) return m.type === 'media' && m.visual && m.enabled !== false ? m : null
  }
  return null
}

/** Quadro inteiro: a região de um efeito ancorado sem clipe nem caixa de reserva (nunca os valores do conteúdo crus). */
const FULL_FRAME_REGION: RegionValues = { x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 }

/**
 * Região do efeito NO QUADRO no instante absoluto tUs. Sem âncora: as anims da região. Ancorado: as anims estão no
 * espaço do conteúdo do clipe e, enquanto o clipe dura ([início, fim) dele), vão à tela pela geometria dele neste
 * instante (conservadora, contentToScreen, com `pad` px de folga — desancorar assa sem ela). Fora do clipe (efeito mais
 * longo que ele: aviso attachBeyondClip) ou com o clipe apagado/desativado (attachLost): a caixa de reserva — a que
 * envolve a região ao longo de todo o clipe (anchoredUnion); elipse: a que contém a caixa (×√2); sem caixa, o quadro
 * inteiro.
 */
export function effectRegionAt(p: Project, fx: EffectItem, tUs: Us, pad = ATTACH_PAD_PX): RegionValues {
  const r = fx.region, local = tUs - fx.startUs
  const v = { x: evalAnim(r.x, local), y: evalAnim(r.y, local), w: evalAnim(r.w, local), h: evalAnim(r.h, local), rotation: evalAnim(r.rotation, local) }
  if (!fx.attach) return v
  const m = attachedMedia(p, fx)
  if (!m || tUs < m.startUs || tUs >= m.startUs + m.durationUs) {
    const f = fx.attach.fallback ?? FULL_FRAME_REGION
    const k = r.shape === 'ellipse' ? Math.SQRT2 : 1
    return { x: f.x, y: f.y, w: f.w * k, h: f.h * k, rotation: 0 }
  }
  return contentToScreen(clipFrameAt(p, m, tUs, true)!, v, r.shape, pad)
}

const ev = (a: Anim<number>, local: Us): number => evalAnim(a, local)
const cropAt = (c: VisualProps['crop'], local: Us): CropValues => ({ l: ev(c.l, local), t: ev(c.t, local), r: ev(c.r, local), b: ev(c.b, local) })
/**
 * Ajuste preso a [−1, 1] (ADJUST_RANGE): faixa útil do shader (brilho somado; contraste e saturação × (1 + v) — abaixo
 * de −1 inverteriam). Overshoot de curva não sai dela.
 */
export const ADJUST_RANGE = { min: -1, max: 1 } as const
const adj = (a: Anim<number>, local: Us): number => clamp(ev(a, local), ADJUST_RANGE.min, ADJUST_RANGE.max)
const adjustAt = (a: NonNullable<VisualProps['adjust']>, local: Us): AdjustValues => ({ brightness: adj(a.brightness, local), contrast: adj(a.contrast, local), saturation: adj(a.saturation, local) })

/**
 * O efeito layers[i] age no quadro? Escopo `below`: sempre. Escopo `track`: só se, pulando os outros efeitos `track`
 * do mesmo alvo logo antes dele, a camada anterior for a mídia/anotações da faixa `targetTrackId` (a mesma condição do
 * compositor; sem ela o efeito não esconde nada).
 */
export function effectBound(layers: Layer[], i: number): boolean {
  const fx = layers[i]
  if (fx?.kind !== 'effect') return false
  if (fx.scope === 'below') return true
  let j = i - 1
  while (j >= 0) {
    const l = layers[j]
    if (l.kind !== 'effect' || l.scope !== 'track' || l.targetTrackId !== fx.targetTrackId) break
    j--
  }
  const prev = layers[j]
  return !!prev && (prev.kind === 'media' || prev.kind === 'annotations') && prev.trackId === fx.targetTrackId
}

/** Faixa de vídeo não oculta imediatamente abaixo de trackId (faixas de áudio e ocultas são puladas). */
export function visualTrackBelow(p: Project, trackId: string): string | null {
  const i = p.tracks.findIndex((t) => t.id === trackId)
  for (let j = i - 1; j >= 0; j--) {
    const t = p.tracks[j]
    if (t.kind === 'video' && !t.hidden) return t.id
  }
  return null
}

/** Camadas visíveis no instante tUs, da mais ao fundo (faixa 0) à mais ao topo. */
export function resolveFrame(p: Project, tUs: Us): Layer[] {
  const layers: Layer[] = []
  for (const { track, item } of activeItemsAt(p, tUs)) {
    if (track.hidden || item.enabled === false) continue
    const local = tUs - item.startUs
    switch (item.type) {
      case 'media': {
        if (track.kind !== 'video') break
        const asset = p.assets.find((a) => a.id === item.assetId)
        if (!asset) break
        const v = item.visual ?? defaultVisual()
        const s = visualStateAt(v, item.durationUs, local)
        layers.push({
          kind: 'media', itemId: item.id, trackId: track.id, assetId: asset.id,
          srcUs: asset.kind === 'image' ? null : sourceTimeUs(item, asset, tUs),
          rect: s.rect, opacity: s.opacity, crop: cropAt(v.crop, local), fit: v.fit,
          shape: v.shape ?? 'rect', radius: v.radius ? Math.max(0, ev(v.radius, local)) : 0,
          ...(v.border ? { border: v.border } : {}), ...(v.adjust ? { adjust: adjustAt(v.adjust, local) } : {}),
          mirror: v.mirror ?? false
        })
        break
      }
      case 'annotations':
        layers.push({ kind: 'annotations', itemId: item.id, trackId: track.id, sessionId: item.sessionId, sessionMs: (item.inUs + local) / 1000, autoFadeMs: item.autoFadeMs ?? null })
        break
      case 'text': {
        const s = visualStateAt(item.visual, item.durationUs, local)
        layers.push({ kind: 'text', itemId: item.id, text: item.text, style: { ...item.style, size: Math.max(0, ev(item.style.size, local)) }, rect: s.rect, opacity: s.opacity })
        break
      }
      case 'shape': {
        const s = visualStateAt(item.visual, item.durationUs, local)
        layers.push({ kind: 'shape', itemId: item.id, item, rect: s.rect, opacity: s.opacity })
        break
      }
      case 'effect': {
        layers.push({
          kind: 'effect', itemId: item.id, trackId: track.id, effect: item.effect, targetTrackId: item.targetTrackId ?? visualTrackBelow(p, track.id),
          region: { shape: item.region.shape, ...effectRegionAt(p, item, tUs) },
          strength: ev(item.strength, local), feather: item.feather, color: item.color, invert: item.invert, scope: item.scope
        })
        break
      }
    }
  }
  // escopo `track`: o efeito vai para logo depois da camada da faixa-alvo (e dos outros efeitos dela), seja qual for a
  // posição da faixa do próprio efeito; sem camada da faixa-alvo neste instante ele fica no fim, sem efeito
  const trackFx = layers.filter((l): l is EffectLayer => l.kind === 'effect' && l.scope === 'track')
  if (trackFx.length === 0) return layers
  const out = layers.filter((l) => !(l.kind === 'effect' && l.scope === 'track'))
  for (const fx of trackFx) {
    let at = out.findIndex((l) => (l.kind === 'media' || l.kind === 'annotations') && l.trackId === fx.targetTrackId)
    if (at < 0) { out.push(fx); continue }
    while (out[at + 1]?.kind === 'effect' && (out[at + 1] as EffectLayer).scope === 'track' && (out[at + 1] as EffectLayer).targetTrackId === fx.targetTrackId) at++
    out.splice(at + 1, 0, fx)
  }
  return out
}
