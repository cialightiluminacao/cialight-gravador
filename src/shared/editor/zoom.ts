// Zoom/pan (F4): enquadramento-alvo → keyframes de escala e posição do item de mídia. Puro.
// O retângulo-alvo (centro e tamanho normalizados ao quadro) vai para o quadro inteiro por uma semelhança em torno do
// centro do quadro: escala × k e centro c' = ½ + k·(c − centro do retângulo). Escala uniforme comuta com a rotação e o
// espelho da camada, então o ponto do conteúdo sob o centro do retângulo vai para o centro do quadro qualquer que seja
// o corte/fit/rotação; o clamp de bordas usa o tamanho base da camada (layerBase, a mesma conta do compositor).
import { evalAnim, insertKeyExact } from './anim'
import { defaultVisual } from './factory'
import { layerBase, type SourceRotation } from './layerGeometry'
import { EditError, findItem, linkedIds, updateItem } from './ops'
import type { Anim, Ease, Keyframe, MediaItem, Project, Us } from './project'

/** Retângulo no quadro: centro (x, y) e tamanho (w, h), normalizados (0–1). */
export interface ZoomRect { x: number; y: number; w: number; h: number }
export interface ZoomPose { x: number; y: number; scale: number }
/** Tamanho base da camada (px do quadro, escala 1) e rotação (graus) — para o clamp de bordas. */
export interface ZoomClampBase { bw: number; bh: number; rotation: number }
export interface ZoomCanvas { w: number; h: number }

/** Duração da ida (e da volta) do zoom na ferramenta: 0,3–3 s. */
export const ZOOM_MIN_DUR_US = 300_000
export const ZOOM_MAX_DUR_US = 3_000_000
/** Menor lado do retângulo-alvo (5 % do quadro = 20×). */
export const ZOOM_MIN_RECT = 0.05
/** Ken Burns: aproximação lenta de 1 a 1,15 ao longo do item. */
export const KEN_BURNS_SCALE = 1.15

export type ZoomCorner = 'tl' | 'tr' | 'bl' | 'br'

/**
 * Pose que leva o retângulo ao quadro inteiro (cabe inteiro: k = 1/max(w, h)). clamp: a camada não descobre o fundo —
 * o centro fica onde as bordas da camada continuam fora do quadro (ou, se ela for menor que o quadro num eixo, dentro
 * dele). Só para rotação múltipla de 90° (outras rotações: sem clamp).
 */
export function zoomPose(cur: ZoomPose, rect: ZoomRect, canvas: ZoomCanvas, clamp?: ZoomClampBase | null): ZoomPose {
  const k = 1 / Math.max(rect.w, rect.h)
  const scale = cur.scale * k
  let x = 0.5 + k * (cur.x - rect.x)
  let y = 0.5 + k * (cur.y - rect.y)
  if (clamp) {
    const q = ((Math.round(clamp.rotation) % 360) + 360) % 360
    if (Math.abs(clamp.rotation - Math.round(clamp.rotation)) < 1e-9 && q % 90 === 0) {
      const turned = q === 90 || q === 270
      const lw = (turned ? clamp.bh : clamp.bw) * scale
      const lh = (turned ? clamp.bw : clamp.bh) * scale
      const range = (len: number, full: number): [number, number] => {
        const a = (full - len / 2) / full, b = len / 2 / full
        return [Math.min(a, b), Math.max(a, b)]
      }
      const [x0, x1] = range(lw, canvas.w)
      const [y0, y1] = range(lh, canvas.h)
      x = Math.min(x1, Math.max(x0, x))
      y = Math.min(y1, Math.max(y0, y))
    }
  }
  return { x, y, scale }
}

/**
 * Arraste da ferramenta (px do quadro) → retângulo na proporção do quadro (w = h normalizados): o lado maior (relativo
 * ao quadro) manda, o canto onde começou fica parado; lado mínimo ZOOM_MIN_RECT.
 */
export function aspectRect(from: { x: number; y: number }, to: { x: number; y: number }, canvas: ZoomCanvas): ZoomRect {
  const dx = (to.x - from.x) / canvas.w
  const dy = (to.y - from.y) / canvas.h
  const s = Math.min(1, Math.max(ZOOM_MIN_RECT, Math.abs(dx), Math.abs(dy)))
  const sx = dx < 0 ? -1 : 1
  const sy = dy < 0 ? -1 : 1
  return { x: from.x / canvas.w + (sx * s) / 2, y: from.y / canvas.h + (sy * s) / 2, w: s, h: s }
}

/** Retângulo do Ken Burns: o quadro reduzido a 1/1,15 encostado no canto para onde a câmera vai. */
export function kenBurnsRect(corner: ZoomCorner, amount = KEN_BURNS_SCALE): ZoomRect {
  const s = 1 / amount
  const x = corner === 'tl' || corner === 'bl' ? s / 2 : 1 - s / 2
  const y = corner === 'tl' || corner === 'tr' ? s / 2 : 1 - s / 2
  return { x, y, w: s, h: s }
}

/**
 * Substitui o trecho [from, to] da animação pelos keys dados, sem mudar a curva antes de `from` nem depois de `to`
 * (insertKeyExact nas pontas): o último key herda o ease do pedaço que segue.
 */
function spliceKeys(a: Anim<number>, keys: Keyframe<number>[]): Anim<number> {
  const from = keys[0].tUs
  const to = keys[keys.length - 1].tUs
  if (!a.keys || a.keys.length === 0) return { value: a.value, keys }
  const cut = insertKeyExact(insertKeyExact(a, from), to)
  const after = cut.keys!.find((k) => k.tUs === to)?.ease ?? 'linear'
  const kept = cut.keys!.filter((k) => k.tUs < from || k.tUs > to)
  const own = keys.map((k, i) => (i === keys.length - 1 ? { ...k, ease: after } : k))
  return { ...a, keys: [...kept, ...own].sort((p, q) => p.tUs - q.tUs) }
}

/**
 * Keys de x/y/escala do zoom no item (tempos locais): em atUs a pose atual (com `ease` até o enquadramento), em
 * atUs + durUs o enquadramento; holdUs ≠ null = "voltar ao normal depois de N s": segura N s e volta à pose atual em
 * durUs (mesmo ease). Tudo preso à duração do item: a ida termina no fim do item; a volta que não cabe é comprimida e,
 * começando depois do fim, não existe. opts.clampSrc (fonte exibida: largura/altura/rotação) liga o clamp de bordas.
 */
export function zoomKeys(
  item: MediaItem,
  targetRect: ZoomRect,
  atUs: Us,
  durUs: Us,
  holdUs: Us | null,
  ease: Ease,
  canvas: ZoomCanvas,
  opts?: { clampSrc?: { w: number; h: number; rotation: SourceRotation } }
): { x: Anim<number>; y: Anim<number>; scale: Anim<number> } {
  const v = item.visual ?? defaultVisual()
  const t = v.transform
  const D = item.durationUs
  const at = Math.min(Math.max(0, Math.round(atUs)), D)
  const end = Math.min(at + Math.max(0, Math.round(durUs)), D)
  if (end <= at) throw new EditError('bounds', 'Não há tempo para o zoom antes do fim do clipe')
  if (!(targetRect.w > 0 && targetRect.h > 0)) throw new EditError('invalid', 'Retângulo de zoom vazio')
  const start: ZoomPose = { x: evalAnim(t.x, at), y: evalAnim(t.y, at), scale: evalAnim(t.scale, at) }
  let clamp: ZoomClampBase | null = null
  if (opts?.clampSrc) {
    const c = v.crop
    const g = layerBase({ l: evalAnim(c.l, end), t: evalAnim(c.t, end), r: evalAnim(c.r, end), b: evalAnim(c.b, end) }, v.fit, opts.clampSrc, canvas)
    clamp = { bw: g.bw, bh: g.bh, rotation: evalAnim(t.rotation, end) }
  }
  const target = zoomPose(start, targetRect, canvas, clamp)
  const plan: { tUs: Us; pose: ZoomPose; ease: Ease }[] = [{ tUs: at, pose: start, ease }, { tUs: end, pose: target, ease: 'linear' }]
  if (holdUs !== null) {
    const hold = Math.min(end + Math.max(0, Math.round(holdUs)), D)
    if (hold < D) plan.push({ tUs: hold, pose: target, ease }, { tUs: Math.min(hold + Math.round(durUs), D), pose: start, ease: 'linear' })
  }
  const keysOf = (k: keyof ZoomPose): Keyframe<number>[] => plan.map((s) => ({ tUs: s.tUs, value: s.pose[k], ease: s.ease }))
  return { x: spliceKeys(t.x, keysOf('x')), y: spliceKeys(t.y, keysOf('y')), scale: spliceKeys(t.scale, keysOf('scale')) }
}

/** Fonte exibida do item (dimensões e rotação do vídeo; sem dados de vídeo, o próprio quadro). */
function sourceOf(p: Project, item: MediaItem): { w: number; h: number; rotation: SourceRotation } {
  const info = p.assets.find((a) => a.id === item.assetId)?.video
  return info && info.width > 0 && info.height > 0 ? { w: info.width, h: info.height, rotation: info.rotation } : { w: p.canvas.width, h: p.canvas.height, rotation: 0 }
}

function mustMedia(p: Project, itemId: string): MediaItem {
  const f = findItem(p, itemId)
  if (!f || f.item.type !== 'media' || f.track.kind !== 'video') throw new EditError('invalid', 'O zoom só vale para clipes de vídeo ou imagem')
  return f.item
}

/** Zoom no item em atUs (absoluto, playhead): grava os keys de x/y/escala (zoomKeys). Um passo de desfazer. */
export function applyZoom(p: Project, itemId: string, rect: ZoomRect, atUs: Us, durUs: Us, holdUs: Us | null, ease: Ease, opts: { clamp: boolean }): Project {
  const item = mustMedia(p, itemId)
  const k = zoomKeys(item, rect, atUs - item.startUs, durUs, holdUs, ease, { w: p.canvas.width, h: p.canvas.height }, opts.clamp ? { clampSrc: sourceOf(p, item) } : undefined)
  return updateItem<MediaItem>(p, itemId, (d) => {
    const vis = (d.visual ??= defaultVisual())
    vis.transform.x = k.x
    vis.transform.y = k.y
    vis.transform.scale = k.scale
  })
}

/**
 * Ken Burns: aproximação lenta 1 → 1,15 da pose do início ao longo do item inteiro, com o canto escolhido parado (o
 * conteúdo desliza na diagonal), sem bordas (clamp). Substitui a animação de x/y/escala do item.
 */
export function applyKenBurns(p: Project, itemId: string, corner: ZoomCorner, ease: Ease = 'linear'): Project {
  const item = mustMedia(p, itemId)
  return applyZoom(p, itemId, kenBurnsRect(corner), item.startUs, item.durationUs, null, ease, { clamp: true })
}

/** Efeitos de privacidade (região no quadro) vinculados ao clipe: o zoom/pan os deixa para trás. */
export function linkedRegionEffects(p: Project, itemId: string): string[] {
  return linkedIds(p, itemId).filter((id) => id !== itemId && findItem(p, id)?.item.type === 'effect')
}
