// Avisos de privacidade: efeitos fracos demais, desativados ou com mídia por cima, num intervalo da timeline. Puro.
import { evalAnim } from './anim'
import { clipFrameAt, clipMoves, contentPose, followCheckTimes, poseError, regionTouchesClip, regionValuesAt, type ContentPose } from './contentPose'
import type { Anim, EffectItem, Item, MediaItem, Project, Track, Us } from './project'
import { itemEndUs } from './time'
import { visualTrackBelow } from './resolve'

export type PrivacyWarningKind = 'weakBlur' | 'weakPixelate' | 'disabled' | 'covered' | 'noTarget' | 'unlinkedOverEdited' | 'transformedUnderEffect' | 'unlinkedOverMoving'
/**
 * `tUs`: instante (absoluto, dentro do intervalo) que "Revisar" mostra — o mais fraco, o início da sobreposição…
 * `mediaItemId` (transformedUnderEffect, unlinkedOverMoving): o clipe que se move — o alvo de "Ajustar efeitos ao
 * movimento" / "Vincular e ajustar".
 */
export interface PrivacyWarning { itemId: string; kind: PrivacyWarningKind; message: string; tUs: Us; mediaItemId?: string }

/**
 * Pisos de intensidade. Blur 50: com o raio pela região (effectsMath: 1,25 × menor lado × intensidade), um texto de
 * 47 px numa região justa fica com contraste local 0,12 da fonte (limite de leitura 0,15). Invertido: o raio usa o
 * menor lado do QUADRO (a área escondida é o quadro fora da região), então a 50 ele é ≥ ao de qualquer região justa
 * a 50 — o mesmo piso vale, medido no teste de render com texto fora da região. Pixelizar 30: bloco ≈ 28 px num
 * texto de 47 px (~1,7 bloco por altura de letra).
 */
export const WEAK_BLUR = 50
export const WEAK_PIXELATE = 30

const MSG = {
  weakBlur: `Blur fraco pode ser revertido; use intensidade ≥ ${WEAK_BLUR} ou Tarja`,
  weakBlurInvert: `Blur fraco fora da região pode ser revertido; use intensidade ≥ ${WEAK_BLUR}`,
  weakPixelate: `Pixelado fraco pode ser revertido; use intensidade ≥ ${WEAK_PIXELATE} ou Tarja`,
  disabled: 'Efeito de privacidade desativado neste trecho: o conteúdo aparece sem proteção',
  covered: 'Há mídia acima deste efeito; ela não será borrada',
  noTarget: "Efeito 'só a faixa abaixo' sem mídia embaixo neste trecho",
  unlinkedOverEdited: 'Efeito não vinculado sobre um trecho invertido — confira se ainda cobre o conteúdo',
  transformedUnderEffect: 'O clipe se move (zoom, pan ou animação) e a região deste efeito não acompanha: o conteúdo pode sair de baixo dele',
  unlinkedOverMoving: 'Efeito não vinculado sobre um clipe que se move (zoom, pan ou animação): a região não acompanha o conteúdo'
} as const

/**
 * Escopo `track`: primeiro instante de [a, b) em que a faixa-alvo (targetTrackId; projeto antigo: visualTrackBelow)
 * não tem camada que resolveFrame desenharia — faixa apagada ou oculta, ou sem mídia (com asset) / anotações ativas.
 * Ali o efeito não acha camada e não esconde nada. null = coberto o trecho todo.
 */
function noTargetAt(p: Project, fx: EffectItem, trackId: string, a: Us, b: Us): Us | null {
  const target = fx.targetTrackId ?? visualTrackBelow(p, trackId)
  const t = target ? p.tracks.find((x) => x.id === target) : undefined
  if (!t || t.hidden || t.kind !== 'video') return a
  const drawn = (i: Item): boolean => i.enabled !== false && (i.type === 'annotations' || (i.type === 'media' && p.assets.some((x) => x.id === i.assetId)))
  const items = t.items.filter((i) => drawn(i) && i.startUs < b && itemEndUs(i) > a).sort((x, y) => x.startUs - y.startUs)
  let cursor = a
  for (const i of items) {
    if (i.startUs > cursor) return cursor
    cursor = Math.max(cursor, itemEndUs(i))
    if (cursor >= b) return null
  }
  return cursor < b ? cursor : null
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const animated = (...as: Anim<number>[]): boolean => as.some((a) => (a.keys?.length ?? 0) > 0)

/** Caixa (px do quadro) que contém a região + borda suave; null = quadro inteiro ou animada (sem teste de espaço). */
function regionBox(fx: EffectItem, W: number, H: number): Box | null {
  const r = fx.region
  if (fx.invert || animated(r.x, r.y, r.w, r.h, r.rotation)) return null
  const w = Math.abs(r.w.value) * W
  const h = Math.abs(r.h.value) * H
  const th = (r.rotation.value * Math.PI) / 180
  const pad = Math.max(0, fx.feather) * Math.min(w, h) / 2
  const ex = (Math.abs(Math.cos(th)) * w + Math.abs(Math.sin(th)) * h) / 2 + pad
  const ey = (Math.abs(Math.sin(th)) * w + Math.abs(Math.cos(th)) * h) / 2 + pad
  const cx = r.x.value * W
  const cy = r.y.value * H
  return { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey }
}

/** Caixa (px do quadro) da mídia com transformação parada; null = desconhecida/animada (conta como sobreposta). */
function mediaBox(p: Project, it: MediaItem, W: number, H: number): Box | null {
  const v = it.visual
  const a = p.assets.find((x) => x.id === it.assetId)
  if (!v || !a?.video || v.animIn || v.animOut) return null
  // recorte muda a proporção do conteúdo (matrix.layerMatrix): sem teste de espaço
  const c = v.crop
  if (animated(c.l, c.t, c.r, c.b) || c.l.value || c.t.value || c.r.value || c.b.value) return null
  const t = v.transform
  if (animated(t.x, t.y, t.scale, t.rotation)) return null
  const turned = a.video.rotation === 90 || a.video.rotation === 270
  const aw = turned ? a.video.height : a.video.width
  const ah = turned ? a.video.width : a.video.height
  if (!(aw > 0 && ah > 0)) return null
  const k = v.fit === 'cover' ? Math.max(W / aw, H / ah) : Math.min(W / aw, H / ah)
  const w = (v.fit === 'fill' ? W : aw * k) * t.scale.value
  const h = (v.fit === 'fill' ? H : ah * k) * t.scale.value
  const th = (t.rotation.value * Math.PI) / 180
  const ex = (Math.abs(Math.cos(th)) * w + Math.abs(Math.sin(th)) * h) / 2
  const ey = (Math.abs(Math.sin(th)) * w + Math.abs(Math.cos(th)) * h) / 2
  const cx = t.x.value * W
  const cy = t.y.value * H
  return { x0: Math.max(0, cx - ex), y0: Math.max(0, cy - ey), x1: Math.min(W, cx + ex), y1: Math.min(H, cy + ey) }
}

/** Desvio tolerado da região em relação ao conteúdo: 1 % do maior lado do quadro (px) e 1° de rotação. */
const FOLLOW_TOL = 0.01
const FOLLOW_TOL_DEG = 1

/**
 * Primeiro instante (absoluto) de [a, b) em que a região do efeito deixa de acompanhar o conteúdo do clipe; null =
 * acompanha. A região é levada ao espaço do conteúdo (contentPose: desfaz centro, rotação, escala e espelho do clipe —
 * geometria do resolve, com animações de entrada/saída — e fit e corte por layerBase, a mesma conta do compositor).
 * Acompanhar = ponto da fonte sob o centro, tamanho e rotação constantes nesse espaço em relação ao início do trecho
 * em comum clipe ∩ efeito, com tolerância de FOLLOW_TOL do quadro medida na tela (poseError). Amostras:
 * followCheckTimes. `touch`: só conta desvio enquanto a região encosta na camada em algum instante amostrado (efeito
 * não vinculado: o que fica longe do clipe não esconde nada dele).
 */
function unfollowedAt(p: Project, fx: EffectItem, m: MediaItem, a: Us, b: Us, touch = false): Us | null {
  const W = p.canvas.width, H = p.canvas.height
  const tol = FOLLOW_TOL * Math.max(W, H)
  const times = followCheckTimes(fx, m, a, b)
  if (touch && !times.some((at) => {
    const cf = clipFrameAt(p, m, at)
    return !!cf && regionTouchesClip(fx, regionValuesAt(fx, at), cf, W, H)
  })) return null
  const pose = (at: Us): ContentPose | null => {
    const cf = clipFrameAt(p, m, at)
    return cf ? contentPose(cf, regionValuesAt(fx, at), W, H) : null // null = conteúdo invisível neste instante
  }
  const off = (ref: ContentPose, c: ContentPose | null): boolean => {
    if (!c) return false
    const e = poseError(ref, c)
    return e.px > tol || e.deg > FOLLOW_TOL_DEG
  }
  // referência: o início do trecho em comum (não o da consulta), para o resultado não depender da janela pedida
  let ref: ContentPose | null = pose(Math.max(m.startUs, fx.startUs))
  let ok = a
  for (const at of times) {
    const cur = pose(at)
    if (!ref) {
      ref = cur
      ok = at
      continue
    }
    if (!off(ref, cur)) {
      ok = at
      continue
    }
    // bisseção até ~1 ms: o instante em que a região começa a sair (o que "Revisar" mostra)
    let lo = ok, hi = at
    while (hi - lo > 1000) {
      const mid = Math.round((lo + hi) / 2)
      if (off(ref, pose(mid))) hi = mid
      else lo = mid
    }
    return hi
  }
  return null
}

/**
 * Primeiro instante de [from, to) em que a região do efeito não acompanha um clipe que se move (das faixas `trackOk`,
 * filtrado por `mediaOk`), com o clipe; null = acompanha todos.
 */
function firstUnfollowed(p: Project, fx: EffectItem, trackOk: (t: Track) => boolean, mediaOk: (m: MediaItem) => boolean, from: Us, to: Us, touch: boolean): { tUs: Us; mediaItemId: string } | null {
  let best: { tUs: Us; mediaItemId: string } | null = null
  for (const t of p.tracks) {
    if (!trackOk(t)) continue
    for (const m of t.items) {
      if (m.type !== 'media' || m.enabled === false || !mediaOk(m) || !clipMoves(m)) continue
      const a = Math.max(m.startUs, from), b = Math.min(itemEndUs(m), to)
      const at = a < b ? unfollowedAt(p, fx, m, a, b, touch) : null
      if (at !== null && (!best || at < best.tUs)) best = { tUs: at, mediaItemId: m.id }
    }
  }
  return best
}

const disjoint = (a: Box | null, b: Box | null): boolean => !!a && !!b && (a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0)

/** Avisos dos efeitos que tocam [fromUs,toUs]; no máximo um por tipo e por efeito. */
export function privacyWarnings(p: Project, fromUs: Us, toUs: Us): PrivacyWarning[] {
  const out: PrivacyWarning[] = []
  const hi = Math.max(toUs, fromUs + 1)
  const { width: W, height: H } = p.canvas
  p.tracks.forEach((track, ti) => {
    for (const it of track.items) {
      if (it.type !== 'effect') continue
      const s = it.startUs, e = itemEndUs(it)
      if (s >= hi || e <= fromUs) continue
      const from = Math.max(s, fromUs)
      // faixa oculta não renderiza, então também deixa o conteúdo sem proteção
      if (it.enabled === false || track.hidden) {
        out.push({ itemId: it.id, kind: 'disabled', message: MSG.disabled, tUs: from })
        continue
      }
      // pontos de avaliação (locais ao item): bordas do trecho visível e cada keyframe dentro dele; o mais fraco
      const lo = from - s, up = Math.max(lo, Math.min(e, toUs) - s)
      const times = [lo, up, ...(it.strength.keys ?? []).map((k) => k.tUs).filter((t) => t >= lo && t <= up)]
      let tMin = lo
      for (const t of times) if (evalAnim(it.strength, t) < evalAnim(it.strength, tMin)) tMin = t
      const min = evalAnim(it.strength, tMin)
      if (it.effect === 'blur' && min < WEAK_BLUR) out.push({ itemId: it.id, kind: 'weakBlur', message: it.invert ? MSG.weakBlurInvert : MSG.weakBlur, tUs: s + tMin })
      if (it.effect === 'pixelate' && min < WEAK_PIXELATE) out.push({ itemId: it.id, kind: 'weakPixelate', message: MSG.weakPixelate, tUs: s + tMin })
      // mídia visível numa faixa de vídeo mais alta no mesmo trecho (e no mesmo lugar, quando dá para saber): fica por cima
      const region = regionBox(it, W, H)
      // escopo `track`: a faixa-alvo é o que o efeito esconde, mesmo estando acima dele (ligação explícita)
      const target = it.scope === 'track' ? (it.targetTrackId ?? visualTrackBelow(p, track.id)) : null
      let cover: Us | null = null
      for (const upper of p.tracks.slice(ti + 1)) {
        if (upper.kind !== 'video' || upper.hidden || upper.id === target) continue
        for (const m of upper.items) {
          if (m.type !== 'media' || m.enabled === false) continue
          const a = Math.max(m.startUs, from), b = Math.min(itemEndUs(m), e, hi)
          if (a >= b || disjoint(region, mediaBox(p, m, W, H))) continue
          cover = cover === null ? a : Math.min(cover, a)
        }
      }
      if (cover !== null) out.push({ itemId: it.id, kind: 'covered', message: MSG.covered, tUs: cover })
      if (it.scope === 'track') {
        const gap = noTargetAt(p, it, track.id, from, Math.min(e, hi))
        if (gap !== null) out.push({ itemId: it.id, kind: 'noTarget', message: MSG.noTarget, tUs: gap })
      }
      // clipe invertido sob um efeito que não é dele: o efeito não acompanha o conteúdo espelhado
      let rev: Us | null = null
      for (const t of p.tracks) {
        if (t.kind !== 'video' || t.hidden) continue
        for (const m of t.items) {
          if (m.type !== 'media' || !m.reverse || m.freeze || m.enabled === false || (it.linkId && m.linkId === it.linkId)) continue
          const a = Math.max(m.startUs, from), b = Math.min(itemEndUs(m), e, hi)
          if (a < b) rev = rev === null ? a : Math.min(rev, a)
        }
      }
      if (rev !== null) out.push({ itemId: it.id, kind: 'unlinkedOverEdited', message: MSG.unlinkedOverEdited, tUs: rev })
      // clipe vinculado com zoom/pan/animação de movimento sob uma região que não acompanha (F4): o efeito é em
      // coordenadas do quadro, então o conteúdo sensível sai de baixo dele ("Ajustar efeitos ao movimento")
      const linked = !!it.linkId && p.tracks.some((t) => t.items.some((m) => m.type !== 'effect' && m.linkId === it.linkId))
      if (linked) {
        const moved = firstUnfollowed(p, it, (t) => t.kind === 'video' && !t.hidden, (m) => m.linkId === it.linkId, from, Math.min(e, hi), false)
        if (moved) out.push({ itemId: it.id, kind: 'transformedUnderEffect', message: MSG.transformedUnderEffect, tUs: moved.tUs, mediaItemId: moved.mediaItemId })
      } else {
        // sem vínculo, sobre um clipe que se move e que ele esconde (faixas abaixo; escopo `track`: só a faixa-alvo),
        // encostando nele: não se ajusta sozinho — "Vincular e ajustar"
        const below = (t: Track): boolean => t.kind === 'video' && !t.hidden && (target ? t.id === target : p.tracks.indexOf(t) < ti)
        const moved = firstUnfollowed(p, it, below, () => true, from, Math.min(e, hi), true)
        if (moved) out.push({ itemId: it.id, kind: 'unlinkedOverMoving', message: MSG.unlinkedOverMoving, tUs: moved.tUs, mediaItemId: moved.mediaItemId })
      }
    }
  })
  return out
}
