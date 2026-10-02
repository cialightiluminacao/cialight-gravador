import { describe, expect, it } from 'vitest'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { anchoredUnion, refreshAttachments, withDeferredFallbacks } from './attachment'
import { NO_HOLE, toScreen, type RegionValues } from './contentPose'
import { evalAnim } from './anim'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachCandidate, attachEffects, detachEffect, effectsOverClip } from './followTransform'
import { deleteItems, duplicateItems, findItem, setItemEnabled, updateAsset } from './ops'
import { privacyWarnings } from './privacy'
import type { Anim, Asset, Ease, EffectItem, MediaItem, Project, Us } from './project'
import { clipFrameAt, effectRegionAt } from './resolve'
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
  ['efeito mais longo que o clipe (deslizar na entrada)', () => attached(scene((m, fx) => { m.startUs = 2 * S; m.durationUs = 6 * S; m.visual!.animIn = { preset: 'slideL', durationUs: S }; fx.durationUs = 12 * S }))],
  ['zoom na entrada e pop na saída', () => attached(scene((m) => { m.visual!.animIn = { preset: 'zoom', durationUs: S }; m.visual!.animOut = { preset: 'pop', durationUs: S / 2, ease: 'linear' } }))],
  ['girar na entrada e bater na saída', () => attached(scene((m) => { m.visual!.animIn = { preset: 'rotate', durationUs: S }; m.visual!.animOut = { preset: 'bounce', durationUs: S } }))]
]
/** Casos que a v1.3 recusa: keys de corte (Ken Burns em PiP) e presets novos da F4 (girar, bater, desfoque). */
const v13Refuses = (n: string): boolean => n === 'Ken Burns pelo corte (PiP)' || n === 'girar na entrada e bater na saída'

describe('disco: a v1.3 instalada não vaza o conteúdo de um efeito ancorado', () => {
  it('a v1.3 abre os projetos ancorados sem recursos novos (e recusa o Ken Burns por corte e girar/bater)', () => {
    expect(cases.map(([n, make]) => [n, parseProjectV13(JSON.parse(JSON.stringify(toDiskProject(make())))).success])).toEqual(cases.map(([n]) => [n, !v13Refuses(n)]))
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

// ---------------------------------------------------------------- efeito invertido (região = buraco nítido)

/** O mesmo projeto com o efeito `fx` invertido ("borrar tudo menos a região"). */
const inverted = (p: Project): Project => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === 'fx' && i.type === 'effect' ? { ...i, invert: true } : i)) })) })

/**
 * O pixel de centro (px, py) fica no buraco nítido da região `r` do quadro? Mesma conta da máscara invertida de
 * FS_APPLY (shaders.ts) com feather 0 — o feather do invertido só cresce para DENTRO: meia-largura presa a ≥ 1e-3 px,
 * dentro ⇔ distância ≤ 0.
 */
function inHole(r: RegionValues, shape: 'rect' | 'ellipse', px: number, py: number): boolean {
  const th = (r.rotation * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th)
  const dx = px - r.x * W, dy = py - r.y * H
  const lx = c * dx + sn * dy, ly = -sn * dx + c * dy
  const hx = Math.max((Math.abs(r.w) * W) / 2, 1e-3), hy = Math.max((Math.abs(r.h) * H) / 2, 1e-3)
  if (shape === 'ellipse') return Math.hypot(lx / hx, ly / hy) <= 1
  const qx = Math.abs(lx) - hx, qy = Math.abs(ly) - hy
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= 0
}
/** Centros de pixel do quadro no buraco de `r` (varre a caixa dela, +1 px). */
function holePixels(r: RegionValues, shape: 'rect' | 'ellipse'): [number, number][] {
  const th = (r.rotation * Math.PI) / 180, c = Math.abs(Math.cos(th)), sn = Math.abs(Math.sin(th))
  const hw = (Math.abs(r.w) * W) / 2, hh = (Math.abs(r.h) * H) / 2
  const ex = shape === 'rect' ? c * hw + sn * hh : Math.hypot(hw * c, hh * sn)
  const ey = shape === 'rect' ? sn * hw + c * hh : Math.hypot(hw * sn, hh * c)
  const out: [number, number][] = []
  for (let y = Math.max(0, Math.floor(r.y * H - ey - 1)); y < Math.min(H, Math.ceil(r.y * H + ey + 1)); y++) {
    for (let x = Math.max(0, Math.floor(r.x * W - ex - 1)); x < Math.min(W, Math.ceil(r.x * W + ex + 1)); x++) {
      if (inHole(r, shape, x + 0.5, y + 0.5)) out.push([x + 0.5, y + 0.5])
    }
  }
  return out
}
/** Conferência invertida: todo pixel nítido no buraco conservador `cons` também é nítido no buraco `hole` do build novo. */
function holeOutside(cons: RegionValues, hole: RegionValues, shape: 'rect' | 'ellipse'): [number, number] | null {
  for (const [x, y] of holePixels(cons, shape)) if (!inHole(hole, shape, x, y)) return [x, y]
  return null
}

describe('efeito invertido: o caminho conservador nunca abre um buraco maior que o do build novo', () => {
  it.each(cases)('%s (invertido): o buraco gravado para a v1.3 cabe no buraco do build novo em todo instante (1/240 s)', (n, make) => {
    const q = inverted(make())
    const fx = fxOf(q)
    const hole = v13Region(q)
    expect(hole).toEqual(NO_HOLE)
    for (let t = fx.startUs; t < fx.startUs + fx.durationUs; t += Math.round(S / 240)) {
      const bad = holeOutside(hole, screen(q, t), fx.region.shape)
      if (bad) throw new Error(`pixel ${bad} nítido na v1.3 e escondido no build novo em ${t}`)
    }
    // ida e volta pela v1.3 (abre e grava sem attach): o build novo desenha o mesmo buraco nulo; pelo parse novo, sem perda
    const disk = JSON.parse(JSON.stringify(toDiskProject(q)))
    const v13 = parseProjectV13(disk)
    // a v1.3 abre todos menos o Ken Burns por corte e os presets novos (que ela recusa — nada a vazar)
    expect(v13.success).toBe(!v13Refuses(n))
    if (v13.success) {
      const back = parseProject(JSON.parse(JSON.stringify(v13.data)))
      const fb = back.tracks.flatMap((t) => t.items).find((i) => i.id === 'fx') as EffectItem
      expect(fb.attach).toBeUndefined()
      expect(holePixels(effectRegionAt(back, fb, fx.startUs), fb.region.shape)).toEqual([])
    }
    expect(parseProject(disk)).toEqual(q)
  })
  it('âncora perdida (com e sem caixa de reserva): nenhum pixel nítido — no build novo e na v1.3', () => {
    const q = inverted(deleteItems(cases[0][1](), ['m'], { includeLinked: false }))
    for (const r of [q, withoutFallback(q)]) {
      expect(screen(r, S)).toEqual(NO_HOLE)
      expect(holePixels(screen(r, S), 'rect')).toEqual([])
      expect(v13Region(r)).toEqual(NO_HOLE)
    }
  })
  it('sem caixa de reserva (o normal usa o quadro inteiro): invertido esconde tudo, retângulo e elipse', () => {
    const bare = inverted(withoutFallback(deleteItems(attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) })), ['m'], { includeLinked: false })))
    expect(screen(bare, S)).toEqual(NO_HOLE)
    expect(holePixels(screen(bare, S), 'rect')).toEqual([])
    expect(holePixels(screen(bare, S), 'ellipse')).toEqual([])
    // o normal continua com o quadro inteiro
    expect(screen(withoutFallback(deleteItems(attached(scene()), ['m'], { includeLinked: false })), S)).toEqual({ x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 })
  })
  it('além do clipe (antes do deslizar; depois do fim, no meio do zoom): nenhum pixel nítido; dentro do clipe, o buraco ancorado', () => {
    const slide = inverted(attached(scene((m) => { m.startUs = 2 * S; m.durationUs = 8 * S; m.visual!.animIn = { preset: 'slideL', durationUs: S } })))
    expect(warn(slide, 'attachBeyondClip')).toEqual([expect.objectContaining({ tUs: 0 })])
    expect(screen(slide, S)).toEqual(NO_HOLE)
    expect(holePixels(screen(slide, S), 'rect')).toEqual([])
    const zoom = inverted(attached(scene((m, fx) => { m.durationUs = 6 * S; m.visual!.transform.scale = anim(1, 3, 'in', 3 * S, 6 * S); fx.durationUs = 10 * S })))
    expect(screen(zoom, 8 * S)).toEqual(NO_HOLE)
    expect(holePixels(screen(zoom, 8 * S), 'rect')).toEqual([])
    expect(holePixels(screen(zoom, S), 'rect').length).toBeGreaterThan(100 * 100)
  })
  it('colado sem o clipe: a cópia solta invertida fica com o buraco nulo', () => {
    const q = inverted(cases[0][1]())
    const { project, itemIds } = duplicateItems(q, ['fx'], 12 * S)
    const copy = findItem(project, itemIds[0])!.item as EffectItem
    expect(copy.attach).toBeUndefined()
    expect(effectRegionAt(project, copy, copy.startUs)).toEqual(NO_HOLE)
  })
})

describe('caixa de reserva: mudanças de geometria fora do clipe e do efeito', () => {
  const fbOf = (p: Project) => fxOf(p).attach!.fallback
  const fresh = (p: Project) => anchoredUnion(p, fxOf(p), findItem(p, 'm')!.item as MediaItem)
  it('religar o asset a outro tamanho/rotação recalcula a caixa (pela operação, incremental)', () => {
    const q = attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) }))
    for (const video of [{ ...vid.video!, width: 1080, height: 1920 }, { ...vid.video!, rotation: 90 as const }]) {
      const r = updateAsset(q, 'v', { video })
      expect(fbOf(r)).not.toEqual(fbOf(q))
      expect(fbOf(r)).toEqual(fresh(r))
    }
    // patch que não mexe na geometria (nome, análise de fala, áudio processado): a caixa fica
    expect(fxOf(updateAsset(q, 'v', { name: 'outro' }))).toBe(fxOf(q))
  })
  it('mudar o tamanho do quadro (função crua do editor) recalcula a caixa no refresh', () => {
    const q = attached(scene((m) => { m.visual!.transform.scale = anim(1, 2) }))
    const r = refreshAttachments({ ...q, canvas: { ...q.canvas, width: 1080, height: 1920 } }, q)
    expect(fbOf(r)).not.toEqual(fbOf(q))
    expect(fbOf(r)).toEqual(fresh(r))
    // só a cor de fundo: nada muda
    const bg = { ...q, canvas: { ...q.canvas, background: '#ffffff' } }
    expect(refreshAttachments(bg, q)).toBe(bg)
  })
})

describe('efeito invertido dentro do clipe: o buraco desenhado cabe no buraco exato (fit esticar, mapeamento não conforme)', { timeout: 60_000 }, () => {
  /** Pontos da borda da região do quadro `r` (px): retângulo pelos 4 cantos (o buraco exato é convexo); elipse, n pontos. */
  const border = (r: RegionValues, shape: 'rect' | 'ellipse', n: number): [number, number][] => {
    const th = (r.rotation * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th)
    const hw = (r.w * W) / 2, hh = (r.h * H) / 2
    const loc: [number, number][] = shape === 'rect' ? [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] : Array.from({ length: n }, (_, i): [number, number] => [hw * Math.cos((2 * Math.PI * i) / n), hh * Math.sin((2 * Math.PI * i) / n)])
    return loc.map(([x, y]) => [r.x * W + c * x - sn * y, r.y * H + sn * x + c * y])
  }
  /**
   * O buraco EXATO no instante t: a borda da região do conteúdo (keys de `fx` no instante, sistema da fonte exibida),
   * amostrada densamente e levada à tela ponto a ponto pela pose do clipe (toScreen) — um polígono convexo inscrito.
   */
  function trueHole(p: Project, fx: EffectItem, t: Us): [number, number][] {
    const m = findItem(p, 'm')!.item as MediaItem
    const cf = clipFrameAt(p, m, t, true)!, g = cf.g, l = t - fx.startUs, r = fx.region
    const cx = evalAnim(r.x, l) * g.dw, cy = evalAnim(r.y, l) * g.dh, hw = (evalAnim(r.w, l) * g.dw) / 2, hh = (evalAnim(r.h, l) * g.dh) / 2
    const ph = (evalAnim(r.rotation, l) * Math.PI) / 180, c = Math.cos(ph), sn = Math.sin(ph)
    const loc: [number, number][] = r.shape === 'rect'
      ? [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
      : Array.from({ length: 512 }, (_, i): [number, number] => [hw * Math.cos((2 * Math.PI * i) / 512), hh * Math.sin((2 * Math.PI * i) / 512)])
    return loc.map(([x, y]) => { const s = toScreen(cf, cx + c * x - sn * y, cy + sn * x + c * y); return [s.x, s.y] })
  }
  /** Teste "ponto dentro" do polígono convexo `poly` (qualquer orientação), com folga `eps` px: semiplanos pré-calculados. */
  const convexTest = (poly: [number, number][], eps: number): ((pt: [number, number]) => boolean) => {
    const o = Math.sign(poly.reduce((s, [x, y], i) => { const [u, v] = poly[(i + 1) % poly.length]; return s + x * v - u * y }, 0))
    const hs: [number, number, number][] = []
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
      const len = Math.hypot(bx - ax, by - ay)
      if (len < 1e-12) continue
      const nx = (-(by - ay) * o) / len, ny = ((bx - ax) * o) / len
      hs.push([nx, ny, nx * ax + ny * ay])
    }
    return ([x, y]) => hs.every(([nx, ny, c]) => nx * x + ny * y - c >= -eps)
  }
  const area = (poly: [number, number][]): number => Math.abs(poly.reduce((s, [x, y], i) => { const [u, v] = poly[(i + 1) % poly.length]; return s + x * v - u * y }, 0)) / 2
  const fill = (shape: 'rect' | 'ellipse', mirror = false): Project => inverted(attached(scene((m, fx) => {
    m.visual!.fit = 'fill'; m.visual!.crop.l = { value: 0.4 }; m.visual!.mirror = mirror
    m.visual!.transform.scale = anim(1, 2, 'inOut'); m.visual!.transform.rotation = anim(0, 40, 'out')
    fx.region = { ...fx.region, shape, x: { value: 0.45 }, y: { value: 0.4 }, w: { value: 0.2 }, h: { value: 0.12 }, rotation: { value: 30 } }
  })))
  /** O buraco desenhado por `draw` cabe no exato em todo instante (1/240 s) e não é trivial (≥ `minFrac` da área exata). */
  function holeContained(q: Project, draw: (t: Us) => RegionValues, minFrac: number): void {
    const fx = fxOf(q)
    let worst = Infinity
    for (let t = fx.startUs; t < fx.startUs + fx.durationUs; t += Math.round(S / 240)) {
      const tru = trueHole(q, fx, t), r = draw(t)
      const inside = convexTest(tru, 1e-3)
      const bad = border(r, fx.region.shape, 64).find((pt) => !inside(pt))
      if (bad) throw new Error(`buraco desenhado sai do exato em ${t}: ${bad} (${JSON.stringify(r)})`)
      const drawn = fx.region.shape === 'rect' ? (r.w * W) * (r.h * H) : (Math.PI * r.w * W * r.h * H) / 4
      worst = Math.min(worst, drawn / area(tru))
    }
    expect(worst).toBeGreaterThan(minFrac)
  }
  it.each([['retângulo girado', 'rect', false], ['elipse girada', 'ellipse', false], ['elipse girada com espelho', 'ellipse', true]] as const)('%s + fit esticar: o resolve desenha um buraco contido no exato', (_n, shape, mirror) => {
    const q = fill(shape, mirror)
    holeContained(q, (t) => screen(q, t), 0.3)
  })
  it.each([['retângulo girado', 'rect'], ['elipse girada', 'ellipse']] as const)('%s + fit esticar: desancorar assa um buraco contido no exato em todo instante', (_n, shape) => {
    const q = fill(shape)
    const d = detachEffect(q, 'fx')
    expect(fxOf(d).attach).toBeUndefined()
    holeContained(q, (t) => effectRegionAt(d, fxOf(d), t), 0.25)
  })
  it('mapeamento conforme (fit conter): o buraco é o exato menos a folga de 1 px', () => {
    const q = inverted(attached(scene((m, fx) => { m.visual!.transform.scale = anim(1, 2); fx.region.rotation = { value: 30 } })))
    const n = effectRegionAt(inverted(q), fxOf(q), 5 * S, 0), r = screen(q, 5 * S)
    expect((n.w - r.w) * W).toBeCloseTo(2, 6)
    expect((n.h - r.h) * H).toBeCloseTo(2, 6)
    holeContained(q, (t) => screen(q, t), 0.9)
  })
})

describe('animações de entrada/saída: a região ancorada acompanha o conteúdo (conferência densa, 1/240 s)', () => {
  /** Cantos (px do quadro) da região do conteúdo do efeito levados à tela pela pose exata do clipe no instante t. */
  function exactCorners(p: Project, t: Us): [number, number][] {
    const fx = fxOf(p), m = findItem(p, 'm')!.item as MediaItem
    const cf = clipFrameAt(p, m, t, true)!, g = cf.g, l = t - fx.startUs, r = fx.region
    const cx = evalAnim(r.x, l) * g.dw, cy = evalAnim(r.y, l) * g.dh, hw = (evalAnim(r.w, l) * g.dw) / 2, hh = (evalAnim(r.h, l) * g.dh) / 2
    const ph = (evalAnim(r.rotation, l) * Math.PI) / 180, c = Math.cos(ph), sn = Math.sin(ph)
    return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as [number, number][]).map(([x, y]) => { const s = toScreen(cf, cx + c * x - sn * y, cy + sn * x + c * y); return [s.x, s.y] })
  }
  /** O ponto (px) está dentro da região do quadro `r` (retângulo girado), com folga eps? */
  const within = (r: RegionValues, [x, y]: [number, number], eps = 1e-6): boolean => {
    const th = (r.rotation * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th)
    const dx = x - r.x * W, dy = y - r.y * H
    return Math.abs(c * dx + sn * dy) <= (r.w * W) / 2 + eps && Math.abs(-sn * dx + c * dy) <= (r.h * H) / 2 + eps
  }
  it.each([
    ['zoom de entrada (0,8 → 1)', { animIn: { preset: 'zoom' as const, durationUs: S } }],
    ['pop de entrada (0,6 → 1,05 → 1, overshoot)', { animIn: { preset: 'pop' as const, durationUs: S } }],
    ['girar na entrada (−15° → 0)', { animIn: { preset: 'rotate' as const, durationUs: S } }],
    ['bater na saída (recuo)', { animOut: { preset: 'bounce' as const, durationUs: S } }]
  ])('%s: a região desenhada contém o conteúdo exato em todo instante e a caixa de reserva a contém', (_n, anims) => {
    const q = attached(scene((m) => { Object.assign(m.visual!, anims) }))
    const f = fxOf(q).attach!.fallback!
    const win: [Us, Us] = 'animIn' in anims ? [0, S] : [9 * S, 10 * S]
    let moved = 0
    const ref = screen(q, 5 * S)
    for (let t = win[0]; t < win[1]; t += Math.round(S / 240)) {
      const r = screen(q, t)
      const bad = exactCorners(q, t).find((pt) => !within(r, pt))
      if (bad) throw new Error(`conteúdo fora da região em ${t}: ${bad} ⊄ ${JSON.stringify(r)}`)
      if (!inside(f, r, 'rect')) throw new Error(`região fora da caixa de reserva em ${t}: ${JSON.stringify(r)} ⊄ ${JSON.stringify(f)}`)
      moved = Math.max(moved, Math.hypot((r.x - ref.x) * W, (r.y - ref.y) * H), Math.abs(r.w - ref.w) * W, Math.abs(r.rotation - ref.rotation))
    }
    // a animação mexe de fato na região (a âncora segue a geometria do preset)
    expect(moved).toBeGreaterThan(10)
    // sem âncora (região parada no quadro, vinculada) o mesmo clipe dá o aviso transformedUnderEffect
    expect(warn(scene((m) => { Object.assign(m.visual!, anims) }), 'transformedUnderEffect')).toHaveLength(1)
    expect(warn(q, 'transformedUnderEffect')).toEqual([])
  })
})
