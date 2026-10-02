// Manutenção das âncoras dos efeitos (pura; roda dentro das operações, no rascunho do immer): depois de qualquer edição,
// cada efeito ancorado aponta para o pedaço certo do clipe e guarda a caixa de reserva (fallback) atualizada.
import { followCheckTimes, regionAabb, regionTouchesClip } from './contentPose'
import type { EffectItem, MediaItem, Project, Us } from './project'
import { attachedMedia, clipFrameAt, effectRegionAt } from './resolve'
import { itemEndUs } from './time'

/** Amostras uniformes da caixa de reserva ao longo do efeito (além das pontas e dos keys). */
const FALLBACK_SAMPLES = 30

const overlapUs = (a: { startUs: Us; durationUs: Us }, b: { startUs: Us; durationUs: Us }): Us => Math.max(0, Math.min(itemEndUs(a), itemEndUs(b)) - Math.max(a.startUs, b.startUs))

/**
 * Caixa do quadro (normalizada, sem rotação) que envolve a região do efeito ancorado ao longo dele: pontas, keys da
 * região e do clipe e FALLBACK_SAMPLES instantes uniformes.
 */
export function attachFallback(p: Project, fx: EffectItem, m: MediaItem): { x: number; y: number; w: number; h: number } {
  const a = fx.startUs, b = itemEndUs(fx)
  const times = new Set<Us>([a, b - 1])
  for (let i = 1; i < FALLBACK_SAMPLES; i++) times.add(a + Math.round(((b - a) * i) / FALLBACK_SAMPLES))
  const r = fx.region, v = m.visual!, t = v.transform, c = v.crop
  for (const an of [r.x, r.y, r.w, r.h, r.rotation]) for (const k of an.keys ?? []) times.add(fx.startUs + k.tUs)
  for (const an of [t.x, t.y, t.scale, t.rotation, c.l, c.t, c.r, c.b]) for (const k of an.keys ?? []) times.add(m.startUs + k.tUs)
  const W = p.canvas.width, H = p.canvas.height
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const at of times) {
    if (at < a || at >= b) continue
    const box = regionAabb(effectRegionAt(p, fx, at), W, H)
    x0 = Math.min(x0, box.x0); y0 = Math.min(y0, box.y0); x1 = Math.max(x1, box.x1); y1 = Math.max(y1, box.y1)
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

/**
 * Âncoras depois de uma edição (rascunho `d`, mutado):
 * 1. Efeito vinculado cujo clipe-âncora sumiu, saiu do grupo de vínculo dele ou não cruza mais o tempo dele (dividir,
 *    duplicar/colar, congelar, apagar trechos, mover) passa ao clipe de vídeo do grupo que mais o cruza (empate: o do
 *    mesmo asset). Sem candidato, fica como está (apagado → attachLost).
 * 2. Com o clipe válido, atualiza a caixa de reserva (attachFallback).
 * `attach` é sempre trocado, nunca mutado: pedaços copiados (dividir, duplicar) dividem o mesmo objeto, às vezes congelado.
 */
export function maintainAttachments(d: Project): void {
  if (!d.tracks.some((t) => t.items.some((i) => i.type === 'effect' && i.attach))) return
  const media: MediaItem[] = []
  for (const t of d.tracks) if (t.kind === 'video') for (const i of t.items) if (i.type === 'media' && i.visual) media.push(i)
  for (const t of d.tracks) {
    for (const fx of t.items) {
      if (fx.type !== 'effect' || !fx.attach) continue
      const cur = media.find((m) => m.id === fx.attach!.mediaItemId)
      if (fx.linkId && !(cur && cur.linkId === fx.linkId && overlapUs(cur, fx) > 0)) {
        let best: MediaItem | null = null
        for (const m of media) {
          if (m.linkId !== fx.linkId) continue
          const o = overlapUs(m, fx)
          if (o <= 0) continue
          const bo = best ? overlapUs(best, fx) : 0
          if (!best || o > bo || (o === bo && cur && m.assetId === cur.assetId && best.assetId !== cur.assetId)) best = m
        }
        if (best && best.id !== fx.attach.mediaItemId) fx.attach = { ...fx.attach, mediaItemId: best.id }
      }
      const target = attachedMedia(d, fx)
      if (!target) continue
      const f = attachFallback(d, fx, target)
      const old = fx.attach.fallback
      if (!old || Math.abs(old.x - f.x) > 1e-9 || Math.abs(old.y - f.y) > 1e-9 || Math.abs(old.w - f.w) > 1e-9 || Math.abs(old.h - f.h) > 1e-9) fx.attach = { ...fx.attach, fallback: f }
    }
  }
}

/** Amostras mínimas do teste "a região encosta no clipe" (além dos keys e pontos de followCheckTimes). */
const TOUCH_SAMPLES = 30

/**
 * A região do efeito (no quadro) encosta na camada do clipe em algum instante de [a, b)? Amostras: followCheckTimes
 * (keys do clipe e da região, pontas, entre-pontos) e TOUCH_SAMPLES instantes uniformes.
 */
export function regionTouchesOver(p: Project, fx: EffectItem, m: MediaItem, a: Us, b: Us): boolean {
  if (a >= b || !m.visual) return false
  const times = new Set(followCheckTimes(fx, m, a, b))
  for (let i = 0; i < TOUCH_SAMPLES; i++) times.add(a + Math.round(((b - a) * i) / TOUCH_SAMPLES))
  for (const at of times) {
    const cf = clipFrameAt(p, m, at)
    if (cf && regionTouchesClip(fx, effectRegionAt(p, fx, at), cf)) return true
  }
  return false
}
