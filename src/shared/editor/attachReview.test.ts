import { describe, expect, it } from 'vitest'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { withDeferredFallbacks } from './attachment'
import type { RegionValues } from './contentPose'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachCandidate, attachEffects, effectsOverClip } from './followTransform'
import { deleteItems, findItem, setItemEnabled } from './ops'
import { privacyWarnings } from './privacy'
import type { Anim, Asset, Ease, EffectItem, MediaItem, Project, Us } from './project'
import { effectRegionAt } from './resolve'
import { parseProject, toDiskProject } from './schema'
import { applyKenBurns } from './zoom'

// Revisão do modelo de âncora (F4 Task 4): formato do disco legível sem vazamento pela v1.3, clipe desativado, efeito
// sem caixa de reserva, efeito além do clipe e a oferta do zoom.

const S = 1_000_000
const W = 1920, H = 1080
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const anim = (a: number, b: number, ease: Ease = 'linear', from = 0, to = 10 * S): Anim<number> => ({ value: a, keys: [{ tUs: from, value: a, ease }, { tUs: to, value: b, ease: 'linear' }] })
const track = (id: string, items: (MediaItem | EffectItem)[], fx = false) => ({ id, kind: 'video' as const, name: id, ...(fx ? { role: 'effects' as const } : {}), muted: false, hidden: false, locked: false, volume: 1, items })

/** Clipe 10 s + blur vinculado (região 0,3/0,3 de 0,1×0,1) numa faixa de efeitos acima. */
function scene(edit?: (m: MediaItem, fx: EffectItem) => void): Project {
  const p = createEmptyProject('t')
  p.assets = [vid]
  const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', durationUs: 10 * S, linkId: 'l1' } as MediaItem
  const fx = { ...createEffectItem('blur', 0, 10 * S, { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }), id: 'fx', linkId: 'l1' } as EffectItem
  edit?.(m, fx)
  p.tracks = [track('tv', [m]), track('tf', [fx], true)]
  return p
}
const attached = (p: Project): Project => attachEffects(p, 'm', ['fx'])
const fxOf = (p: Project): EffectItem => findItem(p, 'fx')!.item as EffectItem
const screen = (p: Project, at: Us): RegionValues => effectRegionAt(p, fxOf(p), at)
const warn = (p: Project, kind: string) => privacyWarnings(p, 0, 20 * S).filter((w) => w.kind === kind)
/** Efeito com a âncora sem caixa de reserva (projeto feito à mão). */
const withoutFallback = (p: Project): Project => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.type === 'effect' && i.attach ? { ...i, attach: { mediaItemId: i.attach.mediaItemId } } : i)) })) })

/** Pontos da borda da região do quadro `r` (cantos do retângulo; 48 pontos da elipse), em px. */
function outline(r: RegionValues, shape: 'rect' | 'ellipse'): [number, number][] {
  const th = (r.rotation * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th)
  const hw = (Math.abs(r.w) * W) / 2, hh = (Math.abs(r.h) * H) / 2
  const local: [number, number][] = shape === 'rect'
    ? [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    : Array.from({ length: 48 }, (_, i): [number, number] => [hw * Math.cos((i / 48) * 2 * Math.PI), hh * Math.sin((i / 48) * 2 * Math.PI)])
  return local.map(([x, y]) => [r.x * W + c * x - sn * y, r.y * H + sn * x + c * y])
}
/** A região `inner` (do quadro) cabe dentro de `outer` (sem rotação, mesma forma)? */
function inside(outer: { x: number; y: number; w: number; h: number }, inner: RegionValues, shape: 'rect' | 'ellipse'): boolean {
  const ox = outer.x * W, oy = outer.y * H, a = (outer.w * W) / 2, b = (outer.h * H) / 2
  return outline(inner, shape).every(([x, y]) => (shape === 'rect' ? Math.abs(x - ox) <= a + 1e-6 && Math.abs(y - oy) <= b + 1e-6 : ((x - ox) / a) ** 2 + ((y - oy) / b) ** 2 <= 1 + 1e-9))
}
type DiskRegion = { x: { value: number; keys?: unknown[] }; y: { value: number }; w: { value: number }; h: { value: number }; rotation: { value: number } }
const valuesOf = (r: DiskRegion): RegionValues => ({ x: r.x.value, y: r.y.value, w: r.w.value, h: r.h.value, rotation: r.rotation.value })
/**
 * O que a v1.3 desenha para o efeito: a `region` gravada no disco, parada (o schema dela descarta `attach`). Projeto que
 * a v1.3 consegue abrir: conferido pelo parse dela; com recursos que ela recusa (keys de corte do Ken Burns em PiP),
 * ela nem abre — a região gravada é conferida assim mesmo.
 */
function v13Region(p: Project): RegionValues {
  const disk = JSON.parse(JSON.stringify(toDiskProject(p)))
  const r = parseProjectV13(disk)
  if (r.success) {
    const fx = r.data.tracks.flatMap((t) => t.items).find((i) => i.id === 'fx') as unknown as { region: DiskRegion; attach?: unknown }
    expect(fx.attach).toBeUndefined()
    expect(fx.region.x.keys).toBeUndefined()
    return valuesOf(fx.region)
  }
  const fx = disk.tracks.flatMap((t: { items: { id: string }[] }) => t.items).find((i: { id: string }) => i.id === 'fx') as { region: DiskRegion }
  expect(fx.region.x.keys).toBeUndefined()
  return valuesOf(fx.region)
}

const cases: [string, () => Project][] = [
  ['zoom 2× + pan com suavizar', () => attached(scene((m) => { m.visual!.transform.scale = anim(1, 2, 'inOut'); m.visual!.transform.x = anim(0.5, 0.65, 'inOut') }))],
  ['elipse girada, espelho, rotação e escala com overshoot', () => attached(scene((m, fx) => { m.visual!.mirror = true; m.visual!.transform.rotation = anim(0, 40, 'out'); m.visual!.transform.scale = anim(1, 2.2, { bezier: [0.5, -0.5, 0.4, 1.6] }); fx.region.shape = 'ellipse'; fx.region.rotation = { value: 30 } }))],
  ['segurar (salto)', () => attached(scene((m) => { m.visual!.transform.x = { value: 0.5, keys: [{ tUs: 0, value: 0.5, ease: 'hold' }, { tUs: 4 * S, value: 0.8, ease: 'linear' }] } }))],
  ['Ken Burns pelo corte (PiP)', () => attached(applyKenBurns(scene((m, fx) => { m.visual!.transform.scale = { value: 0.4 }; m.visual!.transform.x = { value: 0.75 }; m.visual!.transform.y = { value: 0.7 }; fx.region = { ...fx.region, x: { value: 0.7 }, y: { value: 0.65 }, w: { value: 0.08 }, h: { value: 0.06 } } }), 'm', 'br').project)],
  ['efeito mais longo que o clipe (deslizar na entrada)', () => attached(scene((m, fx) => { m.startUs = 2 * S; m.durationUs = 6 * S; m.visual!.animIn = { preset: 'slideL', durationUs: S }; fx.durationUs = 12 * S }))]
]

describe('disco: a v1.3 instalada não vaza o conteúdo de um efeito ancorado', () => {
  it('a v1.3 abre os projetos ancorados sem recursos novos (e recusa o Ken Burns por corte, que usa keys de corte)', () => {
    expect(cases.map(([n, make]) => [n, parseProjectV13(JSON.parse(JSON.stringify(toDiskProject(make())))).success])).toEqual(cases.map(([n]) => [n, n !== 'Ken Burns pelo corte (PiP)']))
  })
  it.each(cases)('%s: a região gravada para a v1.3 contém a do build novo em todo instante (1/240 s)', (_n, make) => {
    const q = make()
    const fx = fxOf(q)
    const box = v13Region(q)
    expect(box.rotation).toBe(0)
    for (let t = fx.startUs; t < fx.startUs + fx.durationUs; t += Math.round(S / 240)) {
      if (!inside(box, screen(q, t), fx.region.shape)) throw new Error(`fora em ${t}: ${JSON.stringify(screen(q, t))} ⊄ ${JSON.stringify(box)}`)
    }
  })
  it('âncora perdida (clipe apagado): a v1.3 recebe a caixa de reserva; sem caixa, o quadro inteiro', () => {
    const q = deleteItems(cases[0][1](), ['m'], { includeLinked: false })
    const f = fxOf(q).attach!.fallback!
    expect(v13Region(q)).toEqual({ x: f.x, y: f.y, w: f.w, h: f.h, rotation: 0 })
    expect(v13Region(withoutFallback(q))).toEqual({ x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 })
  })
  it.each(cases)('%s: ida e volta pelo parse novo sem perda (a região do conteúdo volta de attach.region)', (_n, make) => {
    const q = make()
    const disk = JSON.parse(JSON.stringify(toDiskProject(q)))
    const fxDisk = disk.tracks.flatMap((t: { items: { id: string }[] }) => t.items).find((i: { id: string }) => i.id === 'fx')
    expect(fxDisk.attach.region).toEqual(JSON.parse(JSON.stringify(fxOf(q).region)))
    expect(parseProject(disk)).toEqual(q)
  })
})

describe('revisão: clipe desativado, sem caixa, além do clipe, oferta do zoom', () => {
  it('não ancora em clipe desativado; o candidato do inspetor ignora clipe desativado', () => {
    const off = setItemEnabled(scene(), ['m'], false)
    expect(() => attachEffects(off, 'm', ['fx'])).toThrow(/desativado/)
    expect(attachCandidate(off, 'fx')).toBeNull()
  })
  it('a caixa de reserva nasce com a âncora (mesmo com o recálculo adiado); sem caixa, o quadro inteiro — nunca o conteúdo cru', () => {
    const q = withDeferredFallbacks(() => attachEffects(scene((m) => { m.visual!.transform.scale = anim(1, 2) }), 'm', ['fx']))
    expect(fxOf(q).attach!.fallback).toBeTruthy()
    const bare = withoutFallback(deleteItems(q, ['m'], { includeLinked: false }))
    expect(screen(bare, S)).toEqual({ x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 })
    const ell = { ...bare, tracks: bare.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.type === 'effect' ? { ...i, region: { ...i.region, shape: 'ellipse' as const } } : i)) })) }
    expect(screen(ell, S)).toMatchObject({ w: Math.SQRT2, h: Math.SQRT2 })
  })
  /** A caixa de reserva contém a região ancorada em todo instante de [a, b) (1/240 s). */
  function fallbackCovers(q: Project, a: Us, b: Us): void {
    const fx = fxOf(q), f = fx.attach!.fallback!
    for (let t = a; t < b; t += Math.round(S / 240)) expect(inside(f, screen(q, t), fx.region.shape)).toBe(true)
  }
  it('sonda "deslizar": efeito começa antes do clipe (slideL) → attachBeyondClip em 0 e, antes do clipe, a caixa que cobre tudo', () => {
    const q = attached(scene((m) => { m.startUs = 2 * S; m.durationUs = 8 * S; m.visual!.animIn = { preset: 'slideL', durationUs: S } }))
    expect(warn(q, 'attachBeyondClip')).toEqual([expect.objectContaining({ itemId: 'fx', tUs: 0 })])
    const f = fxOf(q).attach!.fallback!
    expect(screen(q, S)).toEqual({ x: f.x, y: f.y, w: f.w, h: f.h, rotation: 0 })
    fallbackCovers(q, 2 * S, 10 * S)
  })
  it('sonda "zoom": o clipe acaba no meio de um zoom 1 → 3 e o efeito continua → attachBeyondClip no fim do clipe; a caixa cobre o último quadro', () => {
    const q = attached(scene((m, fx) => { m.durationUs = 6 * S; m.visual!.transform.scale = anim(1, 3, 'in', 3 * S, 6 * S); fx.durationUs = 10 * S }))
    expect(warn(q, 'attachBeyondClip')).toEqual([expect.objectContaining({ tUs: 6 * S })])
    const f = fxOf(q).attach!.fallback!
    expect(inside(f, screen(q, 6 * S - 1), 'rect')).toBe(true)
    expect(screen(q, 8 * S)).toEqual({ x: f.x, y: f.y, w: f.w, h: f.h, rotation: 0 })
    fallbackCovers(q, 0, 6 * S)
    // efeito dentro do clipe: sem aviso
    expect(warn(attached(scene()), 'attachBeyondClip')).toEqual([])
  })
  it('oferta do zoom (effectsOverClip) nunca troca a âncora de um efeito ancorado a OUTRO clipe', () => {
    const p = scene((m) => { m.visual!.transform.scale = anim(1, 2) })
    const pip = { ...createMediaItem(vid, 0, 'video'), id: 'pip', durationUs: 10 * S, linkId: 'l1' } as MediaItem
    pip.visual!.transform.scale = { value: 0.5 }
    const q = attachEffects({ ...p, tracks: [p.tracks[0], track('tp', [pip]), p.tracks[1]] }, 'pip', ['fx'])
    expect(fxOf(q).attach!.mediaItemId).toBe('pip')
    expect(effectsOverClip(q, 'm')).toEqual({ linked: [], unlinked: [] })
  })
})
