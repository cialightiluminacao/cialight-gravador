// Zoom/pan (F4): enquadramento-alvo → keyframes de escala e posição do item de mídia. Puro.
// O retângulo-alvo (centro e tamanho normalizados ao quadro) vai para o quadro inteiro por uma semelhança em torno do
// centro do quadro: escala × k e centro c' = ½ + k·(c − centro do retângulo). Escala uniforme comuta com a rotação e o
// espelho da camada, então o ponto do conteúdo sob o centro do retângulo vai para o centro do quadro qualquer que seja
// o corte/fit/rotação; o clamp de bordas usa o tamanho base da camada (layerBase, a mesma conta do compositor).
import { evalAnim, insertKeyExact } from './anim'
import { defaultVisual } from './factory'
import { layerBase, type SourceRotation } from './layerGeometry'
import { EditError, findItem, linkedIds, updateItem } from './ops'
import type { Anim, Ease, Keyframe, MediaItem, Project, Us, VisualProps } from './project'

/** Retângulo no quadro: centro (x, y) e tamanho (w, h), normalizados (0–1). */
export interface ZoomRect { x: number; y: number; w: number; h: number }
export interface ZoomPose { x: number; y: number; scale: number }
/** Tamanho base da camada (px do quadro, escala 1) e rotação (graus) — para o clamp de bordas. */
export interface ZoomClampBase { bw: number; bh: number; rotation: number }
export interface ZoomCanvas { w: number; h: number }
type Src = { w: number; h: number; rotation: SourceRotation }

/** Duração da ida (e da volta) do zoom na ferramenta: 0,3–3 s. */
export const ZOOM_MIN_DUR_US = 300_000
export const ZOOM_MAX_DUR_US = 3_000_000
/** Menor lado do retângulo-alvo (5 % do quadro = 20×). */
export const ZOOM_MIN_RECT = 0.05
/** Ken Burns: aproximação lenta de 1 a 1,15 ao longo do item. */
export const KEN_BURNS_SCALE = 1.15

export type ZoomCorner = 'tl' | 'tr' | 'bl' | 'br'

/**
 * Retângulo alinhado aos eixos (centrado na camada) em que o centro do quadro pode andar sem descobrir o fundo,
 * como largura × altura "efetivas" da camada (px). Rotação múltipla de 90°: a própria caixa (90/270 trocam os lados).
 * Outra rotação: o maior retângulo na proporção do quadro inscrito na caixa girada (conservador: pode prender mais que
 * o necessário, nunca menos).
 */
export function coverBox(lw: number, lh: number, rotation: number, canvas: ZoomCanvas): [number, number] {
  const q = ((rotation % 360) + 360) % 360
  if (Math.abs(q - Math.round(q / 90) * 90) < 1e-9) {
    const turned = Math.round(q / 90) % 2 === 1
    return turned ? [lh, lw] : [lw, lh]
  }
  const th = (rotation * Math.PI) / 180
  const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th))
  // retângulo t·(W × H) com os cantos dentro da caixa girada: t·(W/2·c + H/2·s) ≤ lw/2 e t·(W/2·s + H/2·c) ≤ lh/2
  const t = Math.min(lw / (canvas.w * c + canvas.h * s), lh / (canvas.w * s + canvas.h * c))
  return [t * canvas.w, t * canvas.h]
}

/**
 * Pose que leva o retângulo ao quadro inteiro (cabe inteiro: k = 1/max(w, h)). clamp: a camada não descobre o fundo —
 * o centro fica onde as bordas da camada continuam fora do quadro (ou, se ela for menor que o quadro num eixo, dentro
 * dele). Rotação qualquer: clamp conservador pelo retângulo inscrito (coverBox).
 */
export function zoomPose(cur: ZoomPose, rect: ZoomRect, canvas: ZoomCanvas, clamp?: ZoomClampBase | null): ZoomPose {
  const k = 1 / Math.max(rect.w, rect.h)
  const scale = cur.scale * k
  let x = 0.5 + k * (cur.x - rect.x)
  let y = 0.5 + k * (cur.y - rect.y)
  if (clamp) {
    const r = coverRange(clamp.bw * scale, clamp.bh * scale, clamp.rotation, canvas)
    x = Math.min(r.x1, Math.max(r.x0, x))
    y = Math.min(r.y1, Math.max(r.y0, y))
  }
  return { x, y, scale }
}

/**
 * Faixa do centro (normalizada) em que a camada de lw × lh px (já com a escala) girada `rotation` graus não descobre
 * o fundo: as bordas continuam fora do quadro (ou, se a camada for menor que o quadro num eixo, dentro dele).
 * Rotação qualquer: conservadora pelo retângulo inscrito (coverBox).
 */
export function coverRange(lw: number, lh: number, rotation: number, canvas: ZoomCanvas): { x0: number; x1: number; y0: number; y1: number } {
  const [ew, eh] = coverBox(lw, lh, rotation, canvas)
  const range = (len: number, full: number): [number, number] => {
    const a = (full - len / 2) / full, b = len / 2 / full
    return [Math.min(a, b), Math.max(a, b)]
  }
  const [x0, x1] = range(ew, canvas.w)
  const [y0, y1] = range(eh, canvas.h)
  return { x0, x1, y0, y1 }
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

/** Keys da animação em [from, to] (os que o trecho substitui). */
export const keysIn = (a: Anim<number>, from: Us, to: Us): number => (a.keys ?? []).filter((k) => k.tUs >= from && k.tUs <= to).length

/**
 * Substitui o trecho [from, to] da animação pelos keys dados, sem mudar a curva antes de `from` nem depois de `to`
 * (insertKeyExact nas pontas): o último key herda o ease do pedaço que segue.
 */
export function spliceKeys(a: Anim<number>, keys: Keyframe<number>[]): Anim<number> {
  const from = keys[0].tUs
  const to = keys[keys.length - 1].tUs
  if (!a.keys || a.keys.length === 0) return { value: a.value, keys }
  const cut = insertKeyExact(insertKeyExact(a, from), to)
  const after = cut.keys!.find((k) => k.tUs === to)?.ease ?? 'linear'
  const kept = cut.keys!.filter((k) => k.tUs < from || k.tUs > to)
  const own = keys.map((k, i) => (i === keys.length - 1 ? { ...k, ease: after } : k))
  return { ...a, keys: [...kept, ...own].sort((p, q) => p.tUs - q.tUs) }
}

export interface ZoomKeys {
  x: Anim<number>; y: Anim<number>; scale: Anim<number>
  /** Keys que já existiam no trecho do zoom (x, y e escala somados) e foram substituídos. */
  replaced: number
}

/**
 * Keys de x/y/escala do zoom no item (tempos locais): em atUs a pose atual (com `ease` até o enquadramento), em
 * atUs + durUs o enquadramento. holdUs ≠ null = "voltar ao normal depois de N s" (N ≥ 0; 0 = volta logo, sem key de
 * espera): segura N s e volta em durUs (mesmo ease) ao valor que a animação original tem no fim da volta — a curva
 * de antes continua dali em diante. Tudo preso à duração do item: a ida termina no fim do item; a volta que não cabe é
 * comprimida e, começando no fim ou depois, não existe. opts.clampSrc (fonte exibida) liga o clamp de bordas.
 * Nunca grava dois keys no mesmo instante.
 */
export function zoomKeys(
  item: MediaItem,
  targetRect: ZoomRect,
  atUs: Us,
  durUs: Us,
  holdUs: Us | null,
  ease: Ease,
  canvas: ZoomCanvas,
  opts?: { clampSrc?: Src }
): ZoomKeys {
  const v = item.visual ?? defaultVisual()
  const t = v.transform
  const D = item.durationUs
  const dur = Math.max(0, Math.round(durUs))
  const at = Math.min(Math.max(0, Math.round(atUs)), D)
  const end = Math.min(at + dur, D)
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
  // passos: pose fixa ou 'orig' (o valor da animação original naquele instante)
  const plan: { tUs: Us; pose: ZoomPose | 'orig'; ease: Ease }[] = [{ tUs: at, pose: start, ease }]
  const hold = holdUs === null ? null : Math.min(end + Math.max(0, Math.round(holdUs)), D)
  if (hold === null || hold >= D) plan.push({ tUs: end, pose: target, ease: 'linear' })
  else {
    // espera zero: a volta começa no próprio key do enquadramento (sem key repetido)
    if (hold > end) plan.push({ tUs: end, pose: target, ease: 'linear' }, { tUs: hold, pose: target, ease })
    else plan.push({ tUs: end, pose: target, ease })
    plan.push({ tUs: Math.min(hold + dur, D), pose: 'orig', ease: 'linear' })
  }
  const last = plan[plan.length - 1].tUs
  const keysOf = (k: keyof ZoomPose): Keyframe<number>[] => plan.map((s) => ({ tUs: s.tUs, value: s.pose === 'orig' ? evalAnim(t[k], s.tUs) : s.pose[k], ease: s.ease }))
  return {
    x: spliceKeys(t.x, keysOf('x')), y: spliceKeys(t.y, keysOf('y')), scale: spliceKeys(t.scale, keysOf('scale')),
    replaced: keysIn(t.x, at, last) + keysIn(t.y, at, last) + keysIn(t.scale, at, last)
  }
}

/** Fonte exibida do item (dimensões e rotação do vídeo; sem dados de vídeo, o próprio quadro). */
export function sourceOf(p: Project, item: MediaItem): Src {
  const info = p.assets.find((a) => a.id === item.assetId)?.video
  return info && info.width > 0 && info.height > 0 ? { w: info.width, h: info.height, rotation: info.rotation } : { w: p.canvas.width, h: p.canvas.height, rotation: 0 }
}

function mustMedia(p: Project, itemId: string): MediaItem {
  const f = findItem(p, itemId)
  if (!f || f.item.type !== 'media' || f.track.kind !== 'video') throw new EditError('invalid', 'O zoom só vale para clipes de vídeo ou imagem')
  return f.item
}

/** Resultado das operações de zoom: o projeto e quantos keys existentes foram substituídos (aviso na interface). */
export interface ZoomEdit { project: Project; replaced: number }

/** Zoom no item em atUs (absoluto, playhead): grava os keys de x/y/escala (zoomKeys). Um passo de desfazer. */
export function applyZoom(p: Project, itemId: string, rect: ZoomRect, atUs: Us, durUs: Us, holdUs: Us | null, ease: Ease, opts: { clamp: boolean }): ZoomEdit {
  const item = mustMedia(p, itemId)
  const k = zoomKeys(item, rect, atUs - item.startUs, durUs, holdUs, ease, { w: p.canvas.width, h: p.canvas.height }, opts.clamp ? { clampSrc: sourceOf(p, item) } : undefined)
  const project = updateItem<MediaItem>(p, itemId, (d) => {
    const vis = (d.visual ??= defaultVisual())
    vis.transform.x = k.x
    vis.transform.y = k.y
    vis.transform.scale = k.scale
  })
  return { project, replaced: k.replaced }
}

/**
 * A camada cobre o quadro inteiro no instante local (bordas fora do quadro, ±½ px; rotação múltipla de 90° — outra
 * rotação nunca cobre exatamente e cai no Ken Burns por corte).
 */
export function coversFrame(v: VisualProps, src: Src, canvas: ZoomCanvas, local: Us): boolean {
  const t = v.transform, c = v.crop
  const rot = evalAnim(t.rotation, local)
  const q = ((rot % 360) + 360) % 360
  if (Math.abs(q - Math.round(q / 90) * 90) > 1e-9) return false
  const g = layerBase({ l: evalAnim(c.l, local), t: evalAnim(c.t, local), r: evalAnim(c.r, local), b: evalAnim(c.b, local) }, v.fit, src, canvas)
  const s = evalAnim(t.scale, local)
  const [lw, lh] = coverBox(g.bw * s, g.bh * s, rot, canvas)
  const dx = Math.abs(evalAnim(t.x, local) * canvas.w - canvas.w / 2), dy = Math.abs(evalAnim(t.y, local) * canvas.h - canvas.h / 2)
  return dx <= (lw - canvas.w) / 2 + 0.5 && dy <= (lh - canvas.h) / 2 + 0.5
}

/**
 * Ken Burns: aproximação lenta 1 → 1,15 ao longo do item inteiro com o canto escolhido parado (o conteúdo desliza na
 * diagonal). Clipe que cobre o quadro: keys de x/y/escala (zoom do quadro com clamp, sem bordas). Clipe menor que o
 * quadro (PiP, contain com barras, girado): a caixa da camada fica onde está e o conteúdo se aproxima DENTRO dela —
 * keys de corte, o trecho visível encolhe 1/1,15 na proporção (o tamanho da caixa não muda com o fit) encostado no
 * canto (na tela: com espelho, esquerda/direita da fonte trocam). Substitui a animação de x/y/escala ou do corte.
 */
export function applyKenBurns(p: Project, itemId: string, corner: ZoomCorner, ease: Ease = 'linear'): ZoomEdit {
  const item = mustMedia(p, itemId)
  const v = item.visual ?? defaultVisual()
  const canvas = { w: p.canvas.width, h: p.canvas.height }
  if (coversFrame(v, sourceOf(p, item), canvas, 0)) return applyZoom(p, itemId, kenBurnsRect(corner), item.startUs, item.durationUs, null, ease, { clamp: true })
  const D = item.durationUs
  const c = v.crop
  const c0 = { l: evalAnim(c.l, 0), t: evalAnim(c.t, 0), r: evalAnim(c.r, 0), b: evalAnim(c.b, 0) }
  const w = (1 - c0.l - c0.r) / KEN_BURNS_SCALE
  const h = (1 - c0.t - c0.b) / KEN_BURNS_SCALE
  const right = (corner === 'tr' || corner === 'br') !== !!v.mirror
  const bottom = corner === 'bl' || corner === 'br'
  const c1 = {
    l: right ? 1 - c0.r - w : c0.l, r: right ? c0.r : 1 - c0.l - w,
    t: bottom ? 1 - c0.b - h : c0.t, b: bottom ? c0.b : 1 - c0.t - h
  }
  const sides = ['l', 't', 'r', 'b'] as const
  const next = Object.fromEntries(sides.map((sd) => [sd, spliceKeys(c[sd], [{ tUs: 0, value: c0[sd], ease }, { tUs: D, value: c1[sd], ease: 'linear' }])])) as VisualProps['crop']
  const replaced = sides.reduce((n, sd) => n + keysIn(c[sd], 0, D), 0)
  const project = updateItem<MediaItem>(p, itemId, (d) => {
    const vis = (d.visual ??= defaultVisual())
    vis.crop = next
  })
  return { project, replaced }
}

/** Efeitos de privacidade vinculados ao clipe (o grupo de vínculo dele): o zoom/pan os deixa para trás. */
export function linkedEffectIds(p: Project, itemId: string): string[] {
  return linkedIds(p, itemId).filter((id) => id !== itemId && findItem(p, id)?.item.type === 'effect')
}
