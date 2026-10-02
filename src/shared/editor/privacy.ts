// Avisos de privacidade: efeitos fracos demais, desativados ou com mídia por cima, num intervalo da timeline. Puro.
import { evalAnim } from './anim'
import type { Anim, EffectItem, Item, MediaItem, Project, Us } from './project'
import { itemEndUs } from './time'
import { layerBase } from './layerGeometry'
import { visualStateAt, visualTrackBelow } from './resolve'

export type PrivacyWarningKind = 'weakBlur' | 'weakPixelate' | 'disabled' | 'covered' | 'noTarget' | 'unlinkedOverEdited' | 'transformedUnderEffect'
/** `tUs`: instante (absoluto, dentro do intervalo) que "Revisar" mostra — o mais fraco, o início da sobreposição… */
export interface PrivacyWarning { itemId: string; kind: PrivacyWarningKind; message: string; tUs: Us }

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
  transformedUnderEffect: 'O clipe se move (zoom, pan ou animação) e a região deste efeito não acompanha: o conteúdo pode sair de baixo dele'
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
 * O clipe move o conteúdo no quadro: x/y/escala/rotação ou corte com keys, ou animação de entrada/saída que não é só
 * fade. zoom/pop ainda não têm geometria no resolve (F4 Task 5 a põe em visualStateAt) e por ora não movem nada.
 */
function clipMoves(m: MediaItem): boolean {
  const v = m.visual
  if (!v) return false
  const t = v.transform
  return animated(t.x, t.y, t.scale, t.rotation, v.crop.l, v.crop.t, v.crop.r, v.crop.b) || (!!v.animIn && v.animIn.preset !== 'fade') || (!!v.animOut && v.animOut.preset !== 'fade')
}

/**
 * Primeiro instante (absoluto) de [a, b) em que a região do efeito deixa de acompanhar o conteúdo do clipe; null =
 * acompanha. A região é levada ao espaço do conteúdo — desfaz centro, rotação, escala e espelho do clipe (geometria do
 * resolve, com animações de entrada/saída) e fit e corte (layerBase, a mesma conta do compositor). Acompanhar =
 * ponto da fonte sob o centro, tamanho e rotação constantes nesse espaço em relação ao início do trecho em comum
 * clipe ∩ efeito, com tolerância de FOLLOW_TOL do quadro medida na tela. Amostras: pontas, keys do clipe (inclusive
 * corte) e da região, janelas das animações de entrada/saída e 3 pontos entre cada par (curvas não lineares).
 */
function unfollowedAt(p: Project, fx: EffectItem, m: MediaItem, a: Us, b: Us, W: number, H: number): Us | null {
  const v = m.visual!
  const t = v.transform, r = fx.region, c = v.crop
  // fonte exibida (sem dados de vídeo: o próprio quadro)
  const info = p.assets.find((x) => x.id === m.assetId)?.video
  const src = info && info.width > 0 && info.height > 0 ? { w: info.width, h: info.height, rotation: info.rotation } : { w: W, h: H, rotation: 0 as const }
  const base = [a, b - 1]
  const add = (offset: Us, ...as: Anim<number>[]): void => { for (const x of as) for (const k of x.keys ?? []) base.push(offset + k.tUs) }
  add(m.startUs, t.x, t.y, t.scale, t.rotation, c.l, c.t, c.r, c.b)
  add(fx.startUs, r.x, r.y, r.w, r.h, r.rotation)
  if (v.animIn) base.push(m.startUs + v.animIn.durationUs)
  if (v.animOut) base.push(itemEndUs(m) - v.animOut.durationUs)
  const pts = [...new Set(base.filter((x) => x >= a && x < b))].sort((x, y) => x - y)
  const times: Us[] = []
  pts.forEach((x, i) => {
    times.push(x)
    const n = pts[i + 1]
    if (n !== undefined) for (let j = 1; j < 4; j++) times.push(x + Math.round(((n - x) * j) / 4))
  })
  const tol = FOLLOW_TOL * Math.max(W, H)
  // pose da região no espaço do conteúdo: ponto da fonte exibida (px) sob o centro, tamanho em px da fonte, rotação
  // relativa; f = px do quadro por px da fonte (para medir o desvio na tela)
  type Pose = { qx: number; qy: number; w: number; h: number; rot: number; fx: number; fy: number }
  const pose = (at: Us): Pose | null => {
    const local = at - m.startUs
    const rect = visualStateAt(v, m.durationUs, local).rect
    const g = layerBase({ l: evalAnim(c.l, local), t: evalAnim(c.t, local), r: evalAnim(c.r, local), b: evalAnim(c.b, local) }, v.fit, src, { w: W, h: H })
    const sx = g.bw * rect.scale, sy = g.bh * rect.scale
    if (sx < 1e-6 || sy < 1e-6) return null // conteúdo invisível neste instante
    const lf = at - fx.startUs
    const dx = (evalAnim(r.x, lf) - rect.cx) * W, dy = (evalAnim(r.y, lf) - rect.cy) * H
    const th = (rect.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th)
    // quad local da camada (−½..½), como matrix.layerMatrix: R(−θ)·(região − centro) / tamanho; espelhar inverte x
    let ax = (cos * dx + sin * dy) / sx
    const ay = (-sin * dx + cos * dy) / sy
    if (v.mirror) ax = -ax
    const [u0, v0, u1, v1] = g.uv
    const fxs = sx / g.cw, fys = sy / g.ch
    return {
      qx: (u0 + (ax + 0.5) * (u1 - u0)) * g.dw, qy: (v0 + (ay + 0.5) * (v1 - v0)) * g.dh,
      w: (Math.abs(evalAnim(r.w, lf)) * W) / fxs, h: (Math.abs(evalAnim(r.h, lf)) * H) / fys,
      rot: evalAnim(r.rotation, lf) - rect.rotation, fx: fxs, fy: fys
    }
  }
  const off = (ref: Pose, c: Pose | null): boolean => {
    if (!c) return false
    const dRot = Math.abs(((((c.rot - ref.rot) % 360) + 540) % 360) - 180)
    return Math.hypot((c.qx - ref.qx) * c.fx, (c.qy - ref.qy) * c.fy) > tol || Math.abs(c.w - ref.w) * c.fx > tol || Math.abs(c.h - ref.h) * c.fy > tol || dRot > FOLLOW_TOL_DEG
  }
  // referência: o início do trecho em comum (não o da consulta), para o resultado não depender da janela pedida
  let ref: Pose | null = pose(Math.max(m.startUs, fx.startUs))
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
      // coordenadas do quadro, então o conteúdo sensível sai de baixo dele
      if (it.linkId) {
        let moved: Us | null = null
        for (const t of p.tracks) {
          if (t.kind !== 'video' || t.hidden) continue
          for (const m of t.items) {
            if (m.type !== 'media' || m.linkId !== it.linkId || m.enabled === false || !clipMoves(m)) continue
            const a = Math.max(m.startUs, from), b = Math.min(itemEndUs(m), e, hi)
            const at = a < b ? unfollowedAt(p, it, m, a, b, W, H) : null
            if (at !== null) moved = moved === null ? at : Math.min(moved, at)
          }
        }
        if (moved !== null) out.push({ itemId: it.id, kind: 'transformedUnderEffect', message: MSG.transformedUnderEffect, tUs: moved })
      }
    }
  })
  return out
}
