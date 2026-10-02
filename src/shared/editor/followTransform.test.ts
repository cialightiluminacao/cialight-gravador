import { describe, expect, it } from 'vitest'
import { evalAnim } from './anim'
import { contentPose, poseError, type RegionValues } from './contentPose'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachCandidate, attachEffects, bakeScreenRegion, detachEffect, effectsOverClip, FIT_TOL, FIT_TOL_DEG } from './followTransform'
import { deleteItems, deleteRanges, duplicateItems, EditError, findItem, freezeFrameAt, moveItems, setItemEnabled, splitAt, updateItem } from './ops'
import { privacyWarnings } from './privacy'
import type { Anim, Asset, Ease, EffectItem, MediaItem, Project, Us } from './project'
import { clipFrameAt, effectRegionAt, resolveFrame } from './resolve'
import { parseProject, toDiskProject } from './schema'
import { applyKenBurns, applyZoom } from './zoom'

const S = 1_000_000
const W = 1920, H = 1080
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const anim = (a: number, b: number, ease: Ease = 'linear', from = 0, to = 10 * S): Anim<number> => ({ value: a, keys: [{ tUs: from, value: a, ease }, { tUs: to, value: b, ease: 'linear' }] })
const track = (id: string, items: (MediaItem | EffectItem)[], fx = false) => ({ id, kind: 'video' as const, name: id, ...(fx ? { role: 'effects' as const } : {}), muted: false, hidden: false, locked: false, volume: 1, items })

type Edit = (m: MediaItem, fx: EffectItem) => void
/** Clipe 10 s na faixa 0 + blur vinculado (região 0,3/0,3 de 0,1×0,1) numa faixa de efeitos acima. */
function scene(edit?: Edit, opts: { link?: boolean } = {}): Project {
  const link = opts.link ?? true
  const p = createEmptyProject('t')
  p.assets = [vid]
  const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', durationUs: 10 * S, ...(link ? { linkId: 'l1' } : {}) } as MediaItem
  const base = createEffectItem('blur', 0, 10 * S)
  const fx: EffectItem = { ...base, id: 'fx', ...(link ? { linkId: 'l1' } : {}), region: { ...base.region, x: { value: 0.3 }, y: { value: 0.3 }, w: { value: 0.1 }, h: { value: 0.1 }, rotation: { value: 0 } } }
  edit?.(m, fx)
  p.tracks = [track('tv', [m]), track('tf', [fx], true)]
  return p
}
const fxOf = (p: Project, id = 'fx'): EffectItem => findItem(p, id)!.item as EffectItem
const mOf = (p: Project, id = 'm'): MediaItem => findItem(p, id)!.item as MediaItem
const warn = (p: Project, kind: string, to = 10 * S) => privacyWarnings(p, 0, to).filter((w) => w.kind === kind)
const screen = (p: Project, at: Us, id = 'fx'): RegionValues => effectRegionAt(p, fxOf(p, id), at)
const TOL_PX = FIT_TOL * Math.max(W, H)
const PAD = 2 / W // folga de 1 px de cada lado

/**
 * Verificação densa: a cada 1/240 s de [a, b), a região do quadro (como o resolve a desenha) cobre o mesmo ponto do
 * conteúdo do clipe que a região original cobria em `a` no projeto `before`, a ≤ FIT_TOL do quadro (≤ FIT_TOL_DEG). A
 * folga de 1 px (ATTACH_PAD_PX) entra no erro.
 */
function denseMaxError(before: Project, after: Project, a: Us, b: Us, mid = 'm'): { px: number; deg: number } {
  const ref = contentPose(clipFrameAt(before, mOf(before, mid), a)!, screen(before, a))
  let px = 0, deg = 0
  for (let t = a; t < b; t += Math.round(S / 240)) {
    const cf = clipFrameAt(after, mOf(after, mid), t)
    if (!cf) continue
    const e = poseError(ref, contentPose(cf, screen(after, t)))
    px = Math.max(px, e.px)
    deg = Math.max(deg, e.deg)
  }
  return { px, deg }
}
const attached = (p: Project): Project => attachEffects(p, 'm', ['fx'])

describe('attachEffects: a região ancorada acompanha o conteúdo no resolve', () => {
  it('zoom 2× central: a região dobra e fica centrada; a região guardada fica constante no espaço do conteúdo', () => {
    const p = scene((m, fx) => { m.visual!.transform.scale = anim(1, 2); fx.region.x = { value: 0.5 }; fx.region.y = { value: 0.5 } })
    expect(warn(p, 'transformedUnderEffect')).toHaveLength(1)
    const q = attached(p)
    const fx = fxOf(q)
    expect(fx.attach?.mediaItemId).toBe('m')
    expect(fx.region.x).toEqual({ value: 0.5 })
    expect(fx.region.w.value).toBeCloseTo(0.1, 9)
    const end = screen(q, 10 * S - 1)
    expect(end.w).toBeCloseTo(0.2 + PAD, 4)
    expect(end.x).toBeCloseTo(0.5, 9)
    // a camada do compositor recebe a mesma região
    const layer = resolveFrame(q, 10 * S - 1).find((l) => l.kind === 'effect')
    expect(layer).toMatchObject({ region: { x: end.x, y: end.y, w: end.w, h: end.h } })
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
    expect(denseMaxError(p, q, 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
  })
  it('zoom fora do centro, pan e rotação (a região gira em torno do centro do clipe e gira junto)', () => {
    const z = attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) }))
    expect(screen(z, 10 * S).x).toBeCloseTo(0.1, 6)
    expect(screen(z, 10 * S).w).toBeCloseTo(0.2 + PAD, 6)
    const pan = attached(scene((m) => { m.visual!.transform.x = anim(0.5, 0.7) }))
    expect(screen(pan, 5 * S).x).toBeCloseTo(0.4, 6)
    const p = scene((m, fx) => { m.visual!.transform.rotation = anim(0, 90); fx.region.y = { value: 0.5 } })
    const rot = attached(p)
    const end = screen(rot, 10 * S)
    expect(end.x).toBeCloseTo(0.5, 6)
    expect(end.y).toBeCloseTo(0.5 - 384 / 1080, 6)
    expect(end.rotation).toBeCloseTo(90, 6)
    const e = denseMaxError(p, rot, 0, 10 * S)
    expect(e.px).toBeLessThanOrEqual(TOL_PX)
    expect(e.deg).toBeLessThanOrEqual(FIT_TOL_DEG)
  })
  it('curvas não lineares, espelho, elipse, segurar, deslizar, corte esticado, Ken Burns: densa ≤ 0,5 % e sem aviso', () => {
    const cases: Edit[] = [
      (m, fx) => {
        const v = m.visual!
        v.transform.scale = anim(1, 2.5, 'inOut', 2 * S, 6 * S)
        v.transform.x = anim(0.5, 0.8, { bezier: [0.6, -0.4, 0.3, 1.5] }, S, 8 * S)
        v.transform.rotation = anim(-10, 25, 'out', 0, 9 * S)
        v.mirror = true
        fx.region.shape = 'ellipse'
        fx.region.rotation = { value: 15 }
      },
      (m) => { m.visual!.transform.x = { value: 0.5, keys: [{ tUs: 0, value: 0.5, ease: 'hold' }, { tUs: 4 * S, value: 0.7, ease: 'linear' }] } },
      (m) => { m.visual!.animIn = { preset: 'slideL', durationUs: S } },
      (m) => { m.visual!.fit = 'fill'; m.visual!.crop.l = anim(0, 0.5) }
    ]
    for (const c of cases) {
      const p = scene(c)
      expect(warn(p, 'transformedUnderEffect')).toHaveLength(1)
      const q = attached(p)
      expect(warn(q, 'transformedUnderEffect')).toEqual([])
      const e = denseMaxError(p, q, 0, 10 * S)
      expect(e.px).toBeLessThanOrEqual(TOL_PX)
      expect(e.deg).toBeLessThanOrEqual(FIT_TOL_DEG)
    }
    // 'segurar': salta no mesmo instante
    const hold = attached(scene(cases[1]))
    expect(screen(hold, 4 * S - 1).x).toBeCloseTo(0.3, 9)
    expect(screen(hold, 4 * S).x).toBeCloseTo(0.5, 9)
  })
  it('Ken Burns pelo corte (PiP) e em tela cheia, e zoom da ferramenta: ancorar faz o aviso sumir', () => {
    const pip = applyKenBurns(scene((m, fx) => { m.visual!.transform.scale = { value: 0.4 }; m.visual!.transform.x = { value: 0.75 }; m.visual!.transform.y = { value: 0.7 }; fx.region.x = { value: 0.7 }; fx.region.y = { value: 0.65 }; fx.region.w = { value: 0.08 }; fx.region.h = { value: 0.06 } }), 'm', 'br').project
    expect(warn(pip, 'transformedUnderEffect')).toHaveLength(1)
    expect(warn(attached(pip), 'transformedUnderEffect')).toEqual([])
    expect(denseMaxError(pip, attached(pip), 0, 10 * S).px).toBeLessThanOrEqual(TOL_PX)
    const kb = applyKenBurns(scene(), 'm', 'tl').project
    expect(warn(attached(kb), 'transformedUnderEffect')).toEqual([])
    const z = applyZoom(scene(), 'm', { x: 0.3, y: 0.3, w: 0.5, h: 0.5 }, 2 * S, S, 2 * S, 'inOut', { clamp: true }).project
    expect(warn(attached(z), 'transformedUnderEffect')).toEqual([])
  })
  it('edições posteriores do clipe (novo zoom, outro corte, girar, tirar o zoom, velocidade) continuam acompanhadas', () => {
    const p = scene()
    const q = attached(p)
    const edits: ((x: Project) => Project)[] = [
      (x) => applyZoom(x, 'm', { x: 0.3, y: 0.3, w: 0.5, h: 0.5 }, 2 * S, S, null, 'inOut', { clamp: false }).project,
      (x) => applyZoom(applyZoom(x, 'm', { x: 0.3, y: 0.3, w: 0.5, h: 0.5 }, 2 * S, S, null, 'inOut', { clamp: false }).project, 'm', { x: 0.6, y: 0.4, w: 0.25, h: 0.25 }, 5 * S, 2 * S, S, 'out', { clamp: false }).project,
      (x) => updateItem<MediaItem>(x, 'm', (d) => { d.visual!.crop.l = anim(0, 0.2); d.visual!.crop.t = { value: 0.1 } }),
      (x) => updateItem<MediaItem>(x, 'm', (d) => { d.visual!.transform.rotation = anim(0, -30, 'inOut'); d.visual!.transform.scale = { value: 0.8 } }),
      (x) => updateItem<MediaItem>(applyZoom(x, 'm', { x: 0.3, y: 0.3, w: 0.5, h: 0.5 }, 2 * S, S, null, 'inOut', { clamp: false }).project, 'm', (d) => { d.visual!.transform.scale = { value: 1 }; d.visual!.transform.x = { value: 0.5 }; d.visual!.transform.y = { value: 0.5 } })
    ]
    for (const ed of edits) {
      const r = ed(q)
      expect(warn(r, 'transformedUnderEffect')).toEqual([])
      const e = denseMaxError(p, r, 0, 10 * S)
      expect(e.px).toBeLessThanOrEqual(TOL_PX)
      expect(e.deg).toBeLessThanOrEqual(FIT_TOL_DEG)
    }
  })
  it('keys da região + zoom do clipe se compõem: centro na tela = ponto do conteúdo (keys) levado pelo zoom', () => {
    // região que anda no conteúdo (0,3 → 0,6) com o clipe parado; ancora; depois zoom 1 → 2 em torno do centro
    const p = scene((_m, fx) => { fx.region.x = anim(0.3, 0.6) })
    const q = applyZoom(attached(p), 'm', { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0, 10 * S, null, 'linear', { clamp: false }).project
    expect(fxOf(q).region.x.keys!.map((k) => k.value)).toEqual([0.3, 0.6].map((v) => expect.closeTo(v, 9)))
    for (const t of [0, 2.5 * S, 5 * S, 7.5 * S, 10 * S]) {
      const m = mOf(q).visual!.transform
      const s = evalAnim(m.scale, t), cx = evalAnim(m.x, t)
      const u = 0.3 + 0.3 * (t / (10 * S))
      expect(screen(q, t).x).toBeCloseTo(cx + s * (u - 0.5), 9)
      expect(screen(q, t).w).toBeCloseTo(0.1 * s + PAD, 9)
    }
    // keys da região que já acompanhavam um alvo no quadro com o clipe parado: a ancoragem não os muda na tela
    for (const t of [0, 3 * S, 10 * S]) expect(screen(attached(p), t).x).toBeCloseTo(screen(p, t).x, 9)
  })
  it('fit esticar com corte desproporcional e região girada: a região da tela contém os 4 cantos exatos (conservadora)', () => {
    const p = scene((m, fx) => { m.visual!.fit = 'fill'; m.visual!.crop.l = { value: 0.4 }; fx.region.rotation = { value: 30 }; fx.region.shape = 'ellipse' })
    const q = attached(p)
    const z = applyZoom(q, 'm', { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0, 10 * S, null, 'linear', { clamp: false }).project
    for (const t of [0, 5 * S, 10 * S - 1]) {
      const r = screen(z, t)
      const cf = clipFrameAt(z, mOf(z), t)!
      // cantos da região de conteúdo levados à tela (afim do clipe), no sistema da região da tela
      const c = fxOf(z).region, g = cf.g
      const th = (r.rotation * Math.PI) / 180
      const [u0, , u1] = g.uv
      for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const ph = (evalAnim(c.rotation, t) * Math.PI) / 180
        const hw = (evalAnim(c.w, t) * g.dw) / 2, hh = (evalAnim(c.h, t) * g.dh) / 2
        const qx = evalAnim(c.x, t) * g.dw + Math.cos(ph) * i * hw - Math.sin(ph) * j * hh
        const qy = evalAnim(c.y, t) * g.dh + Math.sin(ph) * i * hw + Math.cos(ph) * j * hh
        const lx = ((qx / g.dw - u0) / (u1 - u0) - 0.5) * cf.sx, ly = (qy / g.dh - 0.5) * cf.sy
        const X = cf.cx * W + lx, Y = cf.cy * H + ly // clipe sem rotação
        const dx = X - r.x * W, dy = Y - r.y * H
        expect(Math.abs(Math.cos(th) * dx + Math.sin(th) * dy)).toBeLessThanOrEqual((r.w * W) / 2 + 1e-6)
        expect(Math.abs(-Math.sin(th) * dx + Math.cos(th) * dy)).toBeLessThanOrEqual((r.h * H) / 2 + 1e-6)
      }
    }
  })
  it('imutável, idempotente; clipe inválido, efeito inválido e faixa bloqueada → EditError; elipse e invertido mantidos', () => {
    const p = scene((m, fx) => { m.visual!.transform.scale = anim(1, 2); fx.invert = true; fx.region.shape = 'ellipse' })
    const q = attached(p)
    expect(fxOf(p).attach).toBeUndefined()
    expect(attachEffects(q, 'm', ['fx'])).toBe(q)
    expect(fxOf(q)).toMatchObject({ invert: true, region: { shape: 'ellipse' } })
    expect(() => attachEffects(p, 'fx', ['fx'])).toThrow(EditError)
    expect(() => attachEffects(p, 'm', ['m'])).toThrow(EditError)
    const locked = scene()
    locked.tracks[1].locked = true
    expect(() => attached(locked)).toThrow(EditError)
    expect(() => attached(scene((m) => { m.visual!.transform.scale = { value: 0 } }))).toThrow(EditError)
  })
  it('schema: attach (com a caixa de reserva) sobrevive a gravar e abrir', () => {
    const q = attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) }))
    expect(fxOf(q).attach!.fallback).toBeTruthy()
    expect(fxOf(parseProject(JSON.parse(JSON.stringify(toDiskProject(q))))).attach).toEqual(fxOf(q).attach)
  })
})

describe('desancorar e o buraco do "ajuste assado"', () => {
  it('detachEffect assa o comportamento atual em keys do quadro (≤ 0,5 %) e tira a âncora', () => {
    const p = scene((m) => { m.visual!.transform.scale = anim(1, 2, 'inOut'); m.visual!.transform.rotation = anim(0, 20) })
    const q = attached(p)
    const d = detachEffect(q, 'fx')
    expect(fxOf(d).attach).toBeUndefined()
    expect(fxOf(d).region.x.keys!.length).toBeGreaterThan(2)
    for (let t = 0; t < 10 * S; t += Math.round(S / 240)) {
      const a = screen(q, t), b = screen(d, t)
      expect(Math.max(Math.hypot((a.x - b.x) * W, (a.y - b.y) * H), Math.abs(a.w - b.w) * W, Math.abs(a.h - b.h) * H)).toBeLessThanOrEqual(TOL_PX)
      expect(Math.abs(a.rotation - b.rotation)).toBeLessThanOrEqual(FIT_TOL_DEG)
    }
    expect(warn(d, 'transformedUnderEffect')).toEqual([])
    expect(detachEffect(p, 'fx')).toBe(p)
    expect(bakeScreenRegion(p, fxOf(p)).x).toEqual({ value: 0.3 })
  })
  it('desancorar depois de zoom forte (≈19×): assa sem a folga de 1 px (que encolheria no conteúdo) e não avisa', () => {
    let q = attached(applyZoom(scene(), 'm', { x: 0.25, y: 0.25, w: 0.25, h: 0.25 }, 2 * S, S, null, 'inOut', { clamp: true }).project)
    q = applyZoom(q, 'm', { x: 0.26, y: 0.33, w: 0.21, h: 0.21 }, 5 * S, S, null, 'inOut', { clamp: true }).project
    expect(evalAnim(mOf(q).visual!.transform.scale, 6 * S)).toBeGreaterThan(18)
    expect(warn(detachEffect(q, 'fx'), 'transformedUnderEffect')).toEqual([])
  })
  it('região com keys sem âncora sobre clipe vinculado PARADO não avisa (seguir texto que anda na gravação — fluxo do F2)', () => {
    // região animada à mão (x 0,2 → 0,7, y e tamanho mudando) sobre o clipe vinculado sem nenhum movimento
    const hand = scene((_m, fx) => { fx.region.x = anim(0.2, 0.7); fx.region.y = anim(0.3, 0.6, 'inOut'); fx.region.w = anim(0.1, 0.2) })
    expect(privacyWarnings(hand, 0, 10 * S).filter((w) => w.kind !== 'weakBlur')).toEqual([])
    // idem depois de desancorar e o zoom sumir (os keys assados ficam; o clipe parado não é conferido)
    const baked = detachEffect(attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) })), 'fx')
    expect(warn(updateItem<MediaItem>(baked, 'm', (d) => { d.visual!.transform.scale = { value: 1 } }), 'transformedUnderEffect')).toEqual([])
    // clipe que se move continua conferido
    expect(warn(scene((m, fx) => { m.visual!.transform.scale = anim(1, 2); fx.region.x = anim(0.2, 0.7) }), 'transformedUnderEffect')).toHaveLength(1)
  })
})

describe('operações mantêm a âncora no pedaço certo', () => {
  /** Cada efeito ancorado aponta para um clipe do mesmo grupo que o cruza no tempo; sem avisos de movimento/âncora. */
  function checkAnchors(p: Project): void {
    for (const t of p.tracks) {
      for (const fx of t.items) {
        if (fx.type !== 'effect') continue
        expect(fx.attach).toBeTruthy()
        const m = findItem(p, fx.attach!.mediaItemId)?.item as MediaItem
        expect(m?.type).toBe('media')
        expect(m.linkId).toBe(fx.linkId)
        expect(Math.min(m.startUs + m.durationUs, fx.startUs + fx.durationUs)).toBeGreaterThan(Math.max(m.startUs, fx.startUs))
      }
    }
    expect(privacyWarnings(p, 0, 40 * S).filter((w) => ['transformedUnderEffect', 'attachLost'].includes(w.kind))).toEqual([])
  }
  const zoomed = (): Project => attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) }))
  it('dividir: os pedaços do efeito ancoram no pedaço do clipe que cruzam e a região na tela não muda', () => {
    const p = zoomed()
    const q = splitAt(p, ['m'], 4 * S)
    const pieces = q.tracks[1].items as EffectItem[]
    const media = q.tracks[0].items as MediaItem[]
    expect(pieces).toHaveLength(2)
    expect(pieces[0].attach!.mediaItemId).toBe(media[0].id)
    expect(pieces[1].attach!.mediaItemId).toBe(media[1].id)
    checkAnchors(q)
    for (const t of [S, 4 * S, 7 * S]) {
      const fx = pieces.find((f) => t >= f.startUs && t < f.startUs + f.durationUs)!
      const r = effectRegionAt(q, fx, t), r0 = screen(p, t)
      expect(r.x).toBeCloseTo(r0.x, 6)
      expect(r.w).toBeCloseTo(r0.w, 6)
    }
  })
  it('duplicar e colar: a cópia do efeito ancora na cópia do clipe', () => {
    for (const at of [undefined, 15 * S]) {
      const r = duplicateItems(zoomed(), ['m'], at)
      const copyFx = r.itemIds.map((id) => findItem(r.project, id)!.item).find((i) => i.type === 'effect') as EffectItem
      const copyM = r.itemIds.find((id) => findItem(r.project, id)!.item.type === 'media')!
      expect(copyFx.attach!.mediaItemId).toBe(copyM)
      checkAnchors(r.project)
    }
  })
  it('colar o efeito junto com o clipe: ancora na cópia do clipe (nunca no original)', () => {
    const r = duplicateItems(zoomed(), ['m', 'fx'], 15 * S)
    const copyFx = r.itemIds.map((id) => findItem(r.project, id)!.item).find((i) => i.type === 'effect') as EffectItem
    const copyM = r.itemIds.find((id) => findItem(r.project, id)!.item.type === 'media')!
    expect(copyFx.attach!.mediaItemId).toBe(copyM)
    expect(r.detached).toEqual([])
    expect(fxOf(r.project).attach!.mediaItemId).toBe('m')
  })
  it('colar o efeito ancorado SEM o clipe: a cópia fica solta na caixa de reserva (detached → toast); o original segue ancorado', () => {
    for (const shape of ['rect', 'ellipse'] as const) {
      const p = attachEffects(scene((m, fx) => { m.visual!.transform.scale = anim(1, 2); fx.region.shape = shape }), 'm', ['fx'])
      const f = fxOf(p).attach!.fallback!
      const r = duplicateItems(p, ['fx'], 12 * S)
      expect(r.itemIds).toHaveLength(1)
      expect(r.detached).toEqual(r.itemIds)
      const copy = findItem(r.project, r.itemIds[0])!.item as EffectItem
      expect(copy.attach).toBeUndefined()
      const k = shape === 'ellipse' ? Math.SQRT2 : 1
      expect(copy.region).toEqual({ shape, x: { value: f.x }, y: { value: f.y }, w: { value: f.w * k }, h: { value: f.h * k }, rotation: { value: 0 } })
      // a mesma região que o resolve usaria com a âncora perdida
      expect(effectRegionAt(r.project, copy, 13 * S)).toEqual(effectRegionAt(deleteItems(p, ['m'], { includeLinked: false }), fxOf(p), 5 * S))
      expect(fxOf(r.project).attach!.mediaItemId).toBe('m')
    }
    // efeito sem âncora colado sozinho: nada a soltar
    expect(duplicateItems(scene(), ['fx'], 12 * S).detached).toEqual([])
  })
  it('congelar quadro: o efeito continua no clipe e cobre o congelado na pose do instante', () => {
    const q = freezeFrameAt(zoomed(), 'm', 4 * S, 2 * S)
    checkAnchors(q)
    const fx = (q.tracks.find((t) => t.id === 'tf')!.items as EffectItem[]).find((f) => f.startUs <= 5 * S && f.startUs + f.durationUs > 5 * S)!
    const at4 = screen(zoomed(), 4 * S)
    expect(effectRegionAt(q, fx, 5 * S).x).toBeCloseTo(at4.x, 4)
  })
  it('apagar trechos: o pedaço da direita ancora no pedaço da direita do clipe', () => {
    const q = deleteRanges(zoomed(), [{ fromUs: 3 * S, toUs: 5 * S }])
    expect(q.tracks[1].items).toHaveLength(2)
    checkAnchors(q)
    const right = q.tracks[1].items[1] as EffectItem
    expect(right.attach!.mediaItemId).toBe(q.tracks[0].items[1].id)
    // o conteúdo de 6 s no original está em 4 s agora
    expect(effectRegionAt(q, right, 4 * S).x).toBeCloseTo(screen(zoomed(), 6 * S).x, 6)
  })
  it('mover o clipe (o efeito vai junto): continua ancorado', () => {
    const q = moveItems(zoomed(), ['m'], 3 * S)
    checkAnchors(q)
    expect(fxOf(q).attach!.mediaItemId).toBe('m')
    expect(screen(q, 8 * S).x).toBeCloseTo(screen(zoomed(), 5 * S).x, 9)
  })
})

describe('attachLost', () => {
  it('clipe apagado ou desativado: aviso attachLost e a região fica na caixa de reserva (que contém a região de antes)', () => {
    const p = attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) }))
    const f = fxOf(p).attach!.fallback!
    for (const q of [deleteItems(p, ['m'], { includeLinked: false }), setItemEnabled(p, ['m'], false)]) {
      expect(warn(q, 'attachLost')).toEqual([expect.objectContaining({ itemId: 'fx', tUs: 0 })])
      const r = screen(q, 5 * S)
      expect(r).toEqual({ x: f.x, y: f.y, w: f.w, h: f.h, rotation: 0 })
      for (const t of [0, 5 * S, 10 * S - 1]) {
        const a = screen(p, t)
        expect(a.x - a.w / 2).toBeGreaterThanOrEqual(r.x - r.w / 2 - 1e-9)
        expect(a.x + a.w / 2).toBeLessThanOrEqual(r.x + r.w / 2 + 1e-9)
      }
    }
    expect(warn(p, 'attachLost')).toEqual([])
  })
})

describe('privacidade com vários clipes', () => {
  /** Tela (m, ancorada) + PiP (pip) numa faixa entre a tela e o efeito, com a região sobre os dois. */
  function multi(pipEdit: (pip: MediaItem) => void, pipLink?: string): Project {
    const p = attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) }))
    const pip = { ...createMediaItem(vid, 0, 'video'), id: 'pip', durationUs: 10 * S, ...(pipLink ? { linkId: pipLink } : {}) } as MediaItem
    pip.visual!.transform.scale = { value: 0.3 }
    pip.visual!.transform.x = { value: 0.3 }
    pip.visual!.transform.y = { value: 0.3 }
    pipEdit(pip)
    return { ...p, tracks: [p.tracks[0], track('tp', [pip]), p.tracks[1]] }
  }
  it('o próprio clipe ancorado não avisa; outro clipe que se move sob a região avisa conforme o vínculo', () => {
    const still = multi(() => undefined)
    expect(privacyWarnings(still, 0, 10 * S).filter((w) => w.kind === 'transformedUnderEffect' || w.kind === 'unlinkedOverMoving')).toEqual([])
    const loose = multi((pip) => { pip.visual!.transform.x = anim(0.3, 0.6) })
    expect(warn(loose, 'unlinkedOverMoving')).toEqual([expect.objectContaining({ itemId: 'fx', mediaItemId: 'pip' })])
    expect(warn(loose, 'transformedUnderEffect')).toEqual([])
    const sameGroup = multi((pip) => { pip.visual!.transform.x = anim(0.3, 0.6) }, 'l1')
    expect(warn(sameGroup, 'transformedUnderEffect')).toEqual([expect.objectContaining({ mediaItemId: 'pip' })])
    // longe da região o tempo todo: nada
    const far = multi((pip) => { pip.visual!.transform.x = anim(0.85, 0.9); pip.visual!.transform.y = { value: 0.85 }; pip.visual!.transform.scale = { value: 0.2 } })
    expect(warn(far, 'unlinkedOverMoving')).toEqual([])
  })
  it('efeito solto: unlinkedOverMoving; attachEffects ("Vincular e ancorar") entra no grupo do clipe (que mantém o dele) e ancora', () => {
    const p = scene((m) => { m.visual!.transform.scale = anim(1, 2) }, { link: false })
    expect(warn(p, 'unlinkedOverMoving')).toEqual([expect.objectContaining({ itemId: 'fx', mediaItemId: 'm' })])
    p.tracks[0].items[0] = { ...mOf(p), linkId: 'grupo' }
    const q = attachEffects(p, 'm', ['fx'])
    expect(fxOf(q)).toMatchObject({ linkId: 'grupo', attach: { mediaItemId: 'm' } })
    expect(mOf(q).linkId).toBe('grupo')
    expect(privacyWarnings(q, 0, 10 * S).filter((w) => w.kind !== 'weakBlur')).toEqual([])
    const r = attachEffects(scene((m) => { m.visual!.transform.scale = anim(1, 2) }, { link: false }), 'm', ['fx'])
    expect(mOf(r).linkId).toBeTruthy()
    expect(fxOf(r).linkId).toBe(mOf(r).linkId)
  })
  it('effectsOverClip: vinculados que encostam (não os já ancorados) e soltos sobre o clipe; longe do PiP: nenhum', () => {
    const p = scene((m) => { m.visual!.transform.scale = anim(1, 2) })
    const loose = { ...fxOf(p), id: 'loose', linkId: undefined } as EffectItem
    p.tracks.push(track('tf2', [loose], true))
    expect(effectsOverClip(p, 'm')).toEqual({ linked: ['fx'], unlinked: ['loose'] })
    expect(effectsOverClip(attached(p), 'm')).toEqual({ linked: [], unlinked: ['loose'] })
    // PiP pequeno no canto: a região não encosta
    const pip = scene((m) => { m.visual!.transform.scale = anim(0.1, 0.15); m.visual!.transform.x = { value: 0.9 }; m.visual!.transform.y = { value: 0.9 } })
    expect(effectsOverClip(pip, 'm')).toEqual({ linked: [], unlinked: [] })
    expect(attachCandidate(p, 'fx')?.id).toBe('m')
    expect(attachCandidate(p, 'loose')).toBeNull()
  })
})
