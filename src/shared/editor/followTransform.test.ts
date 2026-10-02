import { describe, expect, it } from 'vitest'
import { evalAnim } from './anim'
import { clipFrameAt, contentPose, poseError, regionValuesAt } from './contentPose'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { FIT_TOL, FIT_TOL_DEG, fitEffectsToMotion, followRegion, linkAndFitEffect } from './followTransform'
import { EditError, findItem } from './ops'
import { privacyWarnings } from './privacy'
import type { Anim, Asset, Ease, EffectItem, MediaItem, Project, Us } from './project'
import { applyKenBurns, applyZoom } from './zoom'

const S = 1_000_000
const W = 1920, H = 1080
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const anim = (a: number, b: number, ease: Ease = 'linear', from = 0, to = 10 * S): Anim<number> => ({ value: a, keys: [{ tUs: from, value: a, ease }, { tUs: to, value: b, ease: 'linear' }] })

type Edit = (m: MediaItem, fx: EffectItem) => void
/** Clipe 10 s na faixa 0 + blur vinculado (região 0,3/0,3 de 0,1×0,1) numa faixa de efeitos acima. */
function scene(edit?: Edit, opts: { link?: boolean; fxStart?: Us; fxDur?: Us } = {}): Project {
  const link = opts.link ?? true
  const p = createEmptyProject('t')
  p.assets = [vid]
  const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', ...(link ? { linkId: 'l1' } : {}) } as MediaItem
  const base = createEffectItem('blur', opts.fxStart ?? 0, opts.fxDur ?? 10 * S)
  const fx: EffectItem = { ...base, id: 'fx', ...(link ? { linkId: 'l1' } : {}), region: { ...base.region, x: { value: 0.3 }, y: { value: 0.3 }, w: { value: 0.1 }, h: { value: 0.1 }, rotation: { value: 0 } } }
  edit?.(m, fx)
  p.tracks = [
    { id: 'tv', kind: 'video', name: 'Vídeo 1', muted: false, hidden: false, locked: false, volume: 1, items: [m] },
    { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
  ]
  return p
}
const fxOf = (p: Project, id = 'fx'): EffectItem => findItem(p, id)!.item as EffectItem
const mOf = (p: Project, id = 'm'): MediaItem => findItem(p, id)!.item as MediaItem
const warn = (p: Project, kind: string) => privacyWarnings(p, 0, 10 * S).filter((w) => w.kind === kind)
const reg = (p: Project, at: Us) => regionValuesAt(fxOf(p), at)

/**
 * Verificação densa: a cada 1/240 s do trecho em comum (bem mais fino que qualquer quadro exportado), a região ajustada
 * fica sobre o mesmo ponto do conteúdo que a original cobria no início, a ≤ FIT_TOL do quadro (e ≤ FIT_TOL_DEG).
 */
function denseMaxError(before: Project, after: Project, a: Us, b: Us): { px: number; deg: number } {
  const m = mOf(after)
  const cf0 = clipFrameAt(before, mOf(before), a)!
  const ref = contentPose(cf0, regionValuesAt(fxOf(before), a), W, H)
  let px = 0, deg = 0
  for (let t = a; t < b; t += Math.round(S / 240)) {
    const cf = clipFrameAt(after, m, t)
    if (!cf) continue
    const e = poseError(ref, contentPose(cf, reg(after, t), W, H))
    px = Math.max(px, e.px)
    deg = Math.max(deg, e.deg)
  }
  return { px, deg }
}
const TOL_PX = FIT_TOL * Math.max(W, H)
const keyCount = (fx: EffectItem): number => Math.max(...(['x', 'y', 'w', 'h', 'rotation'] as const).map((k) => fx.region[k].keys?.length ?? 0))

describe('followRegion / fitEffectsToMotion: a região acompanha o conteúdo', () => {
  it('zoom 2× central: a região no centro dobra e fica centrada; só 2 keys (w/h lineares na escala)', () => {
    const p = scene((m, fx) => { m.visual!.transform.scale = anim(1, 2); fx.region.x = { value: 0.5 }; fx.region.y = { value: 0.5 } })
    expect(warn(p, 'transformedUnderEffect')).toHaveLength(1)
    const q = fitEffectsToMotion(p, 'm')
    const r = fxOf(q).region
    expect(evalAnim(r.w, 10 * S - 1)).toBeCloseTo(0.2, 4)
    expect(evalAnim(r.h, 10 * S - 1)).toBeCloseTo(0.2, 4)
    expect(evalAnim(r.w, 5 * S)).toBeCloseTo(0.15, 4)
    for (const t of [0, 3 * S, 7 * S, 10 * S - 1]) {
      expect(evalAnim(r.x, t)).toBeCloseTo(0.5, 9)
      expect(evalAnim(r.y, t)).toBeCloseTo(0.5, 9)
    }
    // x/y/rotação constantes ficam sem keys; w/h: uma reta
    expect(r.x.keys).toBeUndefined()
    expect(r.rotation.keys).toBeUndefined()
    expect(r.w.keys).toHaveLength(2)
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    expect(denseMaxError(p, q, 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
  })
  it('zoom 2× fora do centro: a região vai de 0,3 a 0,1 (= ½ + 2·(0,3 − ½)) e dobra', () => {
    const p = scene((m) => { m.visual!.transform.scale = anim(1, 2) })
    const q = fitEffectsToMotion(p, 'm')
    const end = reg(q, 10 * S - 1)
    expect(end.x).toBeCloseTo(0.1, 4)
    expect(end.y).toBeCloseTo(0.1, 4)
    expect(end.w).toBeCloseTo(0.2, 4)
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
  })
  it('pan: a região translada junto (tamanho igual)', () => {
    const p = scene((m) => { m.visual!.transform.x = anim(0.5, 0.7); m.visual!.transform.y = anim(0.5, 0.4) })
    const q = fitEffectsToMotion(p, 'm')
    for (const t of [0, 2.5 * S, 5 * S, 10 * S - 1]) {
      const r = reg(q, t)
      expect(r.x).toBeCloseTo(0.3 + 0.2 * (t / (10 * S)), 4)
      expect(r.y).toBeCloseTo(0.3 - 0.1 * (t / (10 * S)), 4)
      expect(r.w).toBeCloseTo(0.1, 9)
      expect(r.h).toBeCloseTo(0.1, 9)
    }
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
  })
  it('rotação: a região gira em torno do centro do clipe e gira junto (90° no fim)', () => {
    const p = scene((m, fx) => { m.visual!.transform.rotation = anim(0, 90); fx.region.x = { value: 0.3 }; fx.region.y = { value: 0.5 } })
    const q = fitEffectsToMotion(p, 'm')
    const end = reg(q, 10 * S - 1)
    // −384 px em x viram −384 px em y (giro horário na tela, y para baixo)
    expect(end.x).toBeCloseTo(0.5, 3)
    expect(end.y).toBeCloseTo(0.5 - 384 / 1080, 3)
    expect(end.rotation).toBeCloseTo(90, 1)
    expect(end.w).toBeCloseTo(0.1, 6)
    const mid = reg(q, 5 * S)
    expect(mid.rotation).toBeCloseTo(45, 1)
    const e = denseMaxError(p, q, 0, 10 * S)
    expect(e.px).toBeLessThanOrEqual(TOL_PX)
    expect(e.deg).toBeLessThanOrEqual(FIT_TOL_DEG)
    // trajetória curva: mais que 2 keys, menos que um por quadro
    expect(keyCount(fxOf(q))).toBeGreaterThan(2)
    expect(keyCount(fxOf(q))).toBeLessThan(60)
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
  })
  it('curvas não lineares (pan + zoom com suavizar ambos, rotação, espelho e elipse): densa ≤ 0,5 % em qualquer instante', () => {
    const p = scene((m, fx) => {
      const v = m.visual!
      v.transform.scale = anim(1, 2.5, 'inOut', 2 * S, 6 * S)
      v.transform.x = anim(0.5, 0.8, { bezier: [0.6, -0.4, 0.3, 1.5] }, S, 8 * S)
      v.transform.rotation = anim(-10, 25, 'out', 0, 9 * S)
      v.mirror = true
      fx.region.shape = 'ellipse'
      fx.region.rotation = { value: 15 }
      fx.region.w = { value: 0.15 }
    })
    const q = fitEffectsToMotion(p, 'm')
    const e = denseMaxError(p, q, 0, 10 * S)
    expect(e.px).toBeLessThanOrEqual(TOL_PX)
    expect(e.deg).toBeLessThanOrEqual(FIT_TOL_DEG)
    expect(fxOf(q).region.shape).toBe('ellipse')
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    // simplificado: bem menos keys que quadros (300 a 30 fps)
    expect(keyCount(fxOf(q))).toBeLessThan(150)
  })
  it('key "segurar" no clipe: a região salta no mesmo instante, sem rampa entre quadros', () => {
    const p = scene((m) => { m.visual!.transform.x = { value: 0.5, keys: [{ tUs: 0, value: 0.5, ease: 'hold' }, { tUs: 4 * S, value: 0.7, ease: 'linear' }] } })
    const q = fitEffectsToMotion(p, 'm')
    expect(reg(q, 4 * S - 1).x).toBeCloseTo(0.3, 6)
    expect(reg(q, 4 * S).x).toBeCloseTo(0.5, 6)
    expect(denseMaxError(p, q, 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
  })
  it('animação de entrada com movimento (deslizar) também é acompanhada', () => {
    const p = scene((m) => { m.visual!.animIn = { preset: 'slideL', durationUs: S } })
    expect(warn(p, 'transformedUnderEffect')).toHaveLength(1)
    const q = fitEffectsToMotion(p, 'm')
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    expect(denseMaxError(p, q, 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
  })
  it('corte animado com fit esticar (fill): acompanha e o aviso some', () => {
    const p = scene((m) => { m.visual!.fit = 'fill'; m.visual!.crop.l = anim(0, 0.5) })
    const q = fitEffectsToMotion(p, 'm')
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    expect(denseMaxError(p, q, 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
  })
  it('Ken Burns pelo corte (PiP) + efeito vinculado: transformedUnderEffect; ajustar faz sumir', () => {
    // PiP a 40 %, no canto: Ken Burns vira keys de corte
    const p0 = scene((m, fx) => { m.visual!.transform.scale = { value: 0.4 }; m.visual!.transform.x = { value: 0.75 }; m.visual!.transform.y = { value: 0.7 }; fx.region.x = { value: 0.7 }; fx.region.y = { value: 0.65 }; fx.region.w = { value: 0.08 }; fx.region.h = { value: 0.06 } })
    const p = applyKenBurns(p0, 'm', 'br').project
    expect(mOf(p).visual!.crop.l.keys).toHaveLength(2)
    expect(warn(p, 'transformedUnderEffect')).toHaveLength(1)
    const q = fitEffectsToMotion(p, 'm')
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    expect(denseMaxError(p, q, 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
  })
  it('Ken Burns em tela cheia e zoom da ferramenta (ida e volta): ajustar faz o aviso sumir', () => {
    const kb = applyKenBurns(scene(), 'm', 'tl').project
    expect(warn(kb, 'transformedUnderEffect')).toHaveLength(1)
    expect(warn(fitEffectsToMotion(kb, 'm'), 'transformedUnderEffect')).toEqual([])
    const z = applyZoom(scene(), 'm', { x: 0.3, y: 0.3, w: 0.5, h: 0.5 }, 2 * S, S, 2 * S, 'inOut', { clamp: true }).project
    expect(warn(z, 'transformedUnderEffect')).toHaveLength(1)
    const q = fitEffectsToMotion(z, 'm')
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    expect(denseMaxError(z, q, 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
    // antes do zoom (2 s) e depois da volta (5 s) a região é a original
    expect(reg(q, S)).toEqual(expect.objectContaining({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }))
    expect(reg(q, 6 * S).x).toBeCloseTo(0.3, 6)
  })
  it('efeito mais longo que o clipe: fora do trecho em comum a região original continua (keys preservados)', () => {
    const p = scene((m, fx) => {
      m.startUs = 2 * S
      m.durationUs = 4 * S
      m.visual!.transform.scale = anim(1, 2, 'linear', 0, 4 * S)
      fx.region.x = { value: 0.2, keys: [{ tUs: 0, value: 0.2, ease: 'linear' }, { tUs: 10 * S, value: 0.4, ease: 'linear' }] }
    })
    const q = fitEffectsToMotion(p, 'm')
    // antes (0–2 s) e depois (6–10 s): a animação original
    for (const t of [0, S, 2 * S - 1, 6 * S, 8 * S, 10 * S]) expect(reg(q, t).x).toBeCloseTo(0.2 + 0.02 * (t / S), 6)
    // no trecho: segue o zoom a partir da pose de 2 s (x = 0,24)
    expect(reg(q, 6 * S - 1).x).toBeCloseTo(0.5 + 2 * (0.24 - 0.5), 3)
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
  })
  it('imutável; clipe parado não muda nada; efeito sem vínculo não é tocado; faixa bloqueada → EditError', () => {
    const p = scene((m) => { m.visual!.transform.scale = anim(1, 2) })
    const q = fitEffectsToMotion(p, 'm')
    expect(fxOf(p).region.x).toEqual({ value: 0.3 })
    expect(q).not.toBe(p)
    const still = scene()
    expect(fitEffectsToMotion(still, 'm')).toBe(still)
    const free = scene((m) => { m.visual!.transform.scale = anim(1, 2) }, { link: false })
    expect(fitEffectsToMotion(free, 'm')).toBe(free)
    const locked = scene((m) => { m.visual!.transform.scale = anim(1, 2) })
    locked.tracks[1].locked = true
    expect(() => fitEffectsToMotion(locked, 'm')).toThrow(EditError)
    expect(() => fitEffectsToMotion(p, 'fx')).toThrow(EditError)
  })
  it('followRegion: invisível o tempo todo (escala 0) → null', () => {
    const p = scene((m) => { m.visual!.transform.scale = { value: 0 } })
    expect(followRegion(p, fxOf(p), mOf(p))).toBeNull()
  })
  it('invertido ("Borrar tudo menos") também acompanha, mantendo invert', () => {
    const p = scene((m, fx) => { m.visual!.transform.scale = anim(1, 2); fx.invert = true })
    const q = fitEffectsToMotion(p, 'm')
    expect(fxOf(q).invert).toBe(true)
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
  })
})

describe('unlinkedOverMoving e "Vincular e ajustar"', () => {
  const moving: Edit = (m) => { m.visual!.transform.scale = anim(1, 2) }
  it('efeito sem vínculo sobre clipe que se move (e encosta nele): avisa com o clipe; não ajusta sozinho', () => {
    const p = scene(moving, { link: false })
    const w = warn(p, 'unlinkedOverMoving')
    expect(w).toHaveLength(1)
    expect(w[0]).toEqual(expect.objectContaining({ itemId: 'fx', mediaItemId: 'm' }))
    expect(w[0].message).toMatch(/não vinculado/)
    expect(warn(p, 'transformedUnderEffect')).toEqual([])
  })
  it('não avisa: clipe parado, região que acompanha, longe do clipe (PiP), clipe acima do efeito, vinculado', () => {
    expect(warn(scene(undefined, { link: false }), 'unlinkedOverMoving')).toEqual([])
    const follows = scene((m, fx) => { moving(m, fx); fx.region.x = anim(0.3, 0.1); fx.region.y = anim(0.3, 0.1); fx.region.w = anim(0.1, 0.2); fx.region.h = anim(0.1, 0.2) }, { link: false })
    expect(warn(follows, 'unlinkedOverMoving')).toEqual([])
    // PiP pequeno no canto inferior direito, região no superior esquerdo
    const far = scene((m) => { m.visual!.transform.scale = anim(0.2, 0.3); m.visual!.transform.x = { value: 0.85 }; m.visual!.transform.y = { value: 0.85 } }, { link: false })
    expect(warn(far, 'unlinkedOverMoving')).toEqual([])
    const above = scene(moving, { link: false })
    above.tracks.reverse()
    expect(warn(above, 'unlinkedOverMoving')).toEqual([])
    expect(warn(scene(moving), 'unlinkedOverMoving')).toEqual([])
  })
  it('vínculo só entre efeitos (grupo sem mídia) conta como sem vínculo', () => {
    const p = scene(moving, { link: false })
    const fx2 = { ...fxOf(p), id: 'fx2', linkId: 'lx', startUs: 0 }
    p.tracks[1].items = [{ ...fxOf(p), linkId: 'lx' }]
    p.tracks.push({ id: 'tf2', kind: 'video', name: 'Efeitos 2', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx2] })
    expect(warn(p, 'unlinkedOverMoving').map((w) => w.itemId).sort()).toEqual(['fx', 'fx2'])
  })
  it('linkAndFitEffect: entra no grupo do clipe (sem quebrar o vínculo dele) e ajusta — os dois avisos somem', () => {
    const p = scene(moving, { link: false })
    p.tracks[0].items[0] = { ...mOf(p), linkId: 'grupo' }
    const q = linkAndFitEffect(p, 'fx', 'm')
    expect(fxOf(q).linkId).toBe('grupo')
    expect(mOf(q).linkId).toBe('grupo')
    expect(warn(q, 'unlinkedOverMoving')).toEqual([])
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    // clipe sem vínculo nenhum: grupo novo com os dois
    const r = linkAndFitEffect(scene(moving, { link: false }), 'fx', 'm')
    expect(fxOf(r).linkId).toBeTruthy()
    expect(mOf(r).linkId).toBe(fxOf(r).linkId)
    expect(warn(r, 'unlinkedOverMoving')).toEqual([])
    expect(warn(r, 'transformedUnderEffect')).toEqual([])
  })
})
