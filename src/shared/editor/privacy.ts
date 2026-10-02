// Avisos de privacidade: efeitos fracos demais, desativados ou com mídia por cima, num intervalo da timeline. Puro.
import { evalAnim } from './anim'
import type { Anim, EffectItem, MediaItem, Project, Us } from './project'
import { itemEndUs } from './time'
import { visualTrackBelow } from './resolve'

export type PrivacyWarningKind = 'weakBlur' | 'weakPixelate' | 'disabled' | 'covered' | 'noTarget'
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
  noTarget: "Efeito 'só a faixa abaixo' sem mídia embaixo neste trecho"
} as const

/**
 * Escopo `track`: primeiro instante de [a, b) em que a faixa logo abaixo (visualTrackBelow) não tem mídia/anotações
 * visíveis e ativas — ali o efeito não acha camada e não esconde nada. null = coberto o trecho todo.
 */
function noTargetAt(p: Project, trackId: string, a: Us, b: Us): Us | null {
  const below = visualTrackBelow(p, trackId)
  const t = below ? p.tracks.find((x) => x.id === below) : undefined
  if (!t) return a
  const items = t.items.filter((i) => (i.type === 'media' || i.type === 'annotations') && i.enabled !== false && i.startUs < b && itemEndUs(i) > a).sort((x, y) => x.startUs - y.startUs)
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
  if (v.crop.l || v.crop.t || v.crop.r || v.crop.b) return null
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
      let cover: Us | null = null
      for (const upper of p.tracks.slice(ti + 1)) {
        if (upper.kind !== 'video' || upper.hidden) continue
        for (const m of upper.items) {
          if (m.type !== 'media' || m.enabled === false) continue
          const a = Math.max(m.startUs, from), b = Math.min(itemEndUs(m), e, hi)
          if (a >= b || disjoint(region, mediaBox(p, m, W, H))) continue
          cover = cover === null ? a : Math.min(cover, a)
        }
      }
      if (cover !== null) out.push({ itemId: it.id, kind: 'covered', message: MSG.covered, tUs: cover })
      if (it.scope === 'track') {
        const gap = noTargetAt(p, track.id, from, Math.min(e, hi))
        if (gap !== null) out.push({ itemId: it.id, kind: 'noTarget', message: MSG.noTarget, tUs: gap })
      }
    }
  })
  return out
}
