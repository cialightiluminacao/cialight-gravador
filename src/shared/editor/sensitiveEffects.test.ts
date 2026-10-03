import { describe, expect, it } from 'vitest'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { contentToScreen, type RegionValues } from './contentPose'
import { createEmptyProject, createMediaItem } from './factory'
import { deleteItems, findItem, moveItems, setItemEnabled, setReverse, setSpeed, splitAt, trimItem, updateItem } from './ops'
import { privacyWarnings, WEAK_BLUR } from './privacy'
import type { Anim, Asset, EffectItem, MediaItem, Project, Track, Us } from './project'
import { clipFrameAt, resolveFrame, type EffectLayer } from './resolve'
import { parseProject, toDiskProject } from './schema'
import { hideOccurrences, occurrenceSpans } from './sensitiveEffects'
import { occurrenceRegionAt, type Occurrence, type OccurrenceSample } from './sensitiveScan'
import type { OcrBox } from './sensitive'
import { frameDurUs, itemEndUs } from './time'

const S = 1_000_000
const W = 1920, H = 1080
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const anim = (a: number, b: number, from: Us, to: Us): Anim<number> => ({ value: a, keys: [{ tUs: from, value: a, ease: 'inOut' }, { tUs: to, value: b, ease: 'linear' }] })
const vtrack = (id: string, items: MediaItem[], extra: Partial<Track> = {}): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items, ...extra })

/** Clipe do asset `vid`: começa em startUs, mostra [inUs, inUs + dur·speed). */
function clip(id: string, startUs: Us, durationUs: Us, extra: Partial<MediaItem> = {}): MediaItem {
  return { ...createMediaItem(vid, startUs, 'video'), id, durationUs, ...extra }
}
function project(clips: MediaItem[], fps = 30): Project {
  const p = createEmptyProject('t', { fps })
  p.assets = [vid]
  p.tracks = [vtrack('tv', clips)]
  return p
}

/**
 * Ocorrência como a varredura a entrega: amostras a cada 0,5 s em [fromUs, toUs] com a caixa de `boxAt`, mais as do
 * refinamento (0,1 s) onde `refine`; intervalo conservador de uma amostra antes/depois.
 */
function occurrence(id: string, fromUs: Us, toUs: Us, boxAt: (t: Us) => OcrBox, refine = false): Occurrence {
  const samples: OccurrenceSample[] = []
  const step = refine ? 100_000 : 500_000
  for (let t = fromUs; t <= toUs; t += step) samples.push({ tUs: t, box: boxAt(t), src: (t - fromUs) % 500_000 === 0 ? 'ocr' : 'track' })
  return {
    id, kind: 'cpf', masked: '***.456.***-**', confidence: 'validated', samples,
    firstSeenUs: fromUs, lastSeenUs: toUs, startUs: Math.max(0, fromUs - 500_000), endUs: Math.min(vid.durationUs! - 1, toUs + 500_000),
    sourceW: W, sourceH: H
  }
}
/** CPF parado 2–9 s. */
const still = (): Occurrence => occurrence('o1', 2 * S, 9 * S, () => ({ x: 0.3, y: 0.4, w: 0.12, h: 0.03 }))
/** CPF que rola de baixo para cima entre 3 e 7 s (parado antes e depois), com refinamento. */
const scrolling = (): Occurrence => occurrence('o2', 2 * S, 9 * S, (t) => {
  const k = Math.min(1, Math.max(0, (t - 3 * S) / (4 * S)))
  return { x: 0.55, y: 0.85 - 0.7 * k, w: 0.15, h: 0.03 }
}, true)

// ---------------------------------------------------------------- oráculo

const contentRegion = (b: OcrBox): RegionValues => ({ x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h, rotation: 0 })
/** Cantos (px) da região do quadro `r`. */
function corners(r: RegionValues): [number, number][] {
  const th = (r.rotation * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th)
  const hw = (Math.abs(r.w) * W) / 2, hh = (Math.abs(r.h) * H) / 2
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [r.x * W + c * x - s * y, r.y * H + s * x + c * y])
}
/** O retângulo `inner` (do quadro) cabe no retângulo `outer` (girado)? */
function rectInside(outer: RegionValues, inner: RegionValues): boolean {
  const th = (-outer.rotation * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th)
  const ox = outer.x * W, oy = outer.y * H, a = (Math.abs(outer.w) * W) / 2, b = (Math.abs(outer.h) * H) / 2
  return corners(inner).every(([x, y]) => {
    const dx = x - ox, dy = y - oy
    return Math.abs(c * dx - s * dy) <= a + 1e-6 && Math.abs(s * dx + c * dy) <= b + 1e-6
  })
}

/** Instantes amostrados em [a, b): a cada 1/240 s, cada quadro do projeto e ±1 µs das bordas dos quadros. */
function denseTimes(p: Project, a: Us, b: Us): Us[] {
  const set = new Set<Us>()
  for (let t = a; t < b; t += Math.round(S / 240)) set.add(t)
  const fd = frameDurUs(p.canvas.fps)
  for (let f = Math.ceil(a / fd); f * fd < b; f++) for (const d of [-1, 0, 1]) if (f * fd + d >= a && f * fd + d < b) set.add(f * fd + d)
  set.add(b - 1)
  return [...set].sort((x, y) => x - y)
}

interface Miss { t: Us; clipId: string; occId: string }
/**
 * Oráculo de cobertura, como o renderizador desenha: em cada instante amostrado de cada clipe do asset, o instante da
 * fonte que o resolve mostra (camada de mídia: srcUs) → caixa da ocorrência ali → imagem EXATA dela no quadro
 * (contentToScreen sem folga, na geometria do clipe naquele instante) ⊆ região de alguma camada de efeito ativa
 * (resolveFrame: effectRegionAt), blur forte ou tarja. `regionOf` troca a região do efeito (visão da v1.3).
 */
function misses(p: Project, occs: Occurrence[], regionOf?: (l: EffectLayer) => RegionValues): { misses: Miss[]; checked: number } {
  const out: Miss[] = []
  let checked = 0
  for (const t of p.tracks) {
    for (const m of t.items) {
      if (m.type !== 'media' || m.assetId !== vid.id || m.enabled === false || t.hidden) continue
      for (const at of denseTimes(p, m.startUs, itemEndUs(m))) {
        const layers = resolveFrame(p, at)
        const media = layers.find((l) => l.kind === 'media' && l.itemId === m.id)
        if (!media || media.kind !== 'media' || media.srcUs === null) continue
        const cf = clipFrameAt(p, m, at)
        if (!cf) continue
        const fx = layers.filter((l): l is EffectLayer => l.kind === 'effect' && (l.effect === 'solid' || l.strength >= WEAK_BLUR) && !l.invert)
        for (const occ of occs) {
          const box = occurrenceRegionAt(occ, media.srcUs)
          if (!box) continue
          checked++
          const data = contentToScreen(cf, contentRegion(box), 'rect', 0)
          if (!fx.some((l) => rectInside(regionOf ? regionOf(l) : l.region, data))) out.push({ t: at, clipId: m.id, occId: occ.id })
        }
      }
    }
  }
  return { misses: out, checked }
}
const effects = (p: Project): EffectItem[] => p.tracks.flatMap((t) => t.items.filter((i): i is EffectItem => i.type === 'effect'))

// ---------------------------------------------------------------- casos

const clipCases: [string, () => MediaItem][] = [
  ['simples', () => clip('c', 1 * S, 12 * S)],
  ['velocidade 2×', () => clip('c', 1 * S, 6 * S, { speed: 2 })],
  ['velocidade 0,5×', () => clip('c', 0, 20 * S, { speed: 0.5 })],
  ['velocidade 1,5× com início aparado fora do quadro', () => clip('c', 333_333, 8 * S + 7, { speed: 1.5, inUs: 1_234_567 })],
  ['reverso', () => clip('c', 2 * S, 12 * S, { reverse: true })],
  ['reverso 1,5×', () => clip('c', 500_000, 9 * S, { reverse: true, speed: 1.5, inUs: 700_001 })],
  ['aparado (inUs 3 s)', () => clip('c', 4 * S, 5 * S, { inUs: 3 * S })],
  ['zoom + pan em keyframes, corte e rotação', () => {
    const m = clip('c', 1 * S, 12 * S)
    const v = m.visual!
    v.transform.scale = anim(1, 2.4, 1 * S, 6 * S)
    v.transform.x = anim(0.5, 0.3, 2 * S, 8 * S)
    v.transform.y = anim(0.5, 0.65, 0, 5 * S)
    v.transform.rotation = { value: 7 }
    v.crop = { l: { value: 0.1 }, t: anim(0, 0.2, 0, 10 * S), r: { value: 0.05 }, b: { value: 0 } }
    return m
  }]
]

describe('hideOccurrences — cobertura densa (oráculo: resolveFrame + sourceTimeUs)', () => {
  for (const [name, make] of clipCases) {
    for (const fps of [30, 60]) {
      it(`${name} @${fps} fps: o dado nunca fica fora do efeito`, () => {
        const occs = [still(), scrolling()]
        const p0 = project([make()], fps)
        const r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
        expect(r.skipped).toEqual([])
        expect(r.itemIds.length).toBe(2)
        const o = misses(r.project, occs)
        expect(o.checked).toBeGreaterThan(200)
        expect(o.misses.slice(0, 3)).toEqual([])
        expect(privacyWarnings(r.project, 0, 30 * S)).toEqual([])
      })
    }
  }

  it('congelado sobre a ocorrência: região parada o clipe inteiro; fora dela: nenhum efeito (notInClip)', () => {
    const on = project([clip('c', 1 * S, 3 * S, { freeze: { atUs: 5 * S } })])
    const r = hideOccurrences(on, 'v', [scrolling()], { style: 'solid' })
    expect(r.itemIds.length).toBe(1)
    const fx = findItem(r.project, r.itemIds[0])!.item as EffectItem
    expect([fx.startUs, fx.durationUs]).toEqual([1 * S, 3 * S])
    expect(fx.region.x.keys).toBeUndefined()
    expect(fx.effect).toBe('solid')
    expect(misses(r.project, [scrolling()]).misses).toEqual([])
    const off = project([clip('c', 1 * S, 3 * S, { freeze: { atUs: 15 * S } })])
    const r2 = hideOccurrences(off, 'v', [scrolling()], { style: 'blur' })
    expect(r2.itemIds).toEqual([])
    expect(r2.skipped).toEqual([{ occurrenceId: 'o2', reason: 'notInClip' }])
    expect(r2.project).toBe(off)
  })

  it('trechos: reverso tem a sequência espelhada, cada trecho com a caixa da fonte que mostra', () => {
    const m = clip('c', 0, 10 * S, { reverse: true })
    const occ = scrolling()
    const spans = occurrenceSpans(project([m]), m, vid, occ)
    // início da timeline = fim da fonte: caixa de cima (y pequeno) primeiro
    expect(spans[0].box.y).toBeLessThan(spans[spans.length - 1].box.y)
    for (let i = 1; i < spans.length; i++) expect(spans[i].a).toBe(spans[i - 1].b)
  })

  it('várias faixas: o número de faixas novas é o máximo de efeitos simultâneos; faixa de efeitos livre é reaproveitada', () => {
    const p0 = project([clip('c', 0, 20 * S)])
    const occs = [
      occurrence('a', 2 * S, 4 * S, () => ({ x: 0.1, y: 0.1, w: 0.1, h: 0.03 })),
      occurrence('b', 3 * S, 5 * S, () => ({ x: 0.1, y: 0.2, w: 0.1, h: 0.03 })),
      occurrence('c', 10 * S, 12 * S, () => ({ x: 0.1, y: 0.3, w: 0.1, h: 0.03 })),
      occurrence('d', 11 * S, 13 * S, () => ({ x: 0.1, y: 0.4, w: 0.1, h: 0.03 }))
    ]
    const r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
    const fxTracks = r.project.tracks.filter((t) => t.role === 'effects')
    expect(fxTracks.length).toBe(2)
    expect(fxTracks.map((t) => t.name).sort()).toEqual(['Efeitos', 'Efeitos 2'])
    // acima da mídia
    const vi = r.project.tracks.findIndex((t) => t.id === 'tv')
    for (const t of fxTracks) expect(r.project.tracks.indexOf(t)).toBeGreaterThan(vi)
    // de novo, sobre trechos livres: reaproveita as faixas existentes
    const r2 = hideOccurrences(r.project, 'v', [occurrence('e', 15 * S, 16 * S, () => ({ x: 0.5, y: 0.5, w: 0.1, h: 0.03 }))], { style: 'blur' })
    expect(r2.project.tracks.filter((t) => t.role === 'effects').length).toBe(2)
  })

  it('um passo: um projeto novo; keys sem tUs repetido, em ordem, de segurar; nome mascarado; preset Esconder texto', () => {
    const p0 = project([clip('c', 0, 6 * S, { speed: 3 }), clip('d', 6 * S, 9 * S, { reverse: true, speed: 0.7 })])
    const occs = [still(), scrolling()]
    const r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
    expect(r.project).not.toBe(p0)
    expect(p0.tracks.length).toBe(1) // entrada intacta
    expect(r.itemIds.length).toBe(4)
    for (const fx of effects(r.project)) {
      for (const a of [fx.region.x, fx.region.y, fx.region.w, fx.region.h]) {
        const k = a.keys ?? []
        for (let i = 1; i < k.length; i++) expect(k[i].tUs).toBeGreaterThan(k[i - 1].tUs)
        for (const x of k) {
          expect(x.ease).toBe('hold')
          expect(Number.isInteger(x.tUs)).toBe(true)
          expect(x.tUs).toBeGreaterThanOrEqual(0)
          expect(x.tUs).toBeLessThan(fx.durationUs)
        }
      }
      expect(Number.isInteger(fx.startUs) && Number.isInteger(fx.durationUs)).toBe(true)
      expect(fx.name).toBe('CPF ***.456.***-**')
      expect([fx.effect, fx.strength.value, fx.feather, fx.scope, fx.invert, fx.region.shape]).toEqual(['blur', 80, 0, 'below', false, 'rect'])
      expect(fx.attach?.fallback).toBeDefined()
      expect(fx.linkId).toBeDefined()
    }
    expect(misses(r.project, occs).misses).toEqual([])
  })

  it('clipe desativado → disabled; faixa do clipe bloqueada sem vínculo → locked; com vínculo, entra no grupo', () => {
    const p0 = project([clip('c', 0, 10 * S, { enabled: false })])
    expect(hideOccurrences(p0, 'v', [still()], { style: 'blur' }).skipped).toEqual([{ occurrenceId: 'o1', reason: 'disabled' }])
    const p1 = project([clip('c', 0, 10 * S)])
    p1.tracks[0].locked = true
    const r1 = hideOccurrences(p1, 'v', [still()], { style: 'blur' })
    expect(r1.skipped).toEqual([{ occurrenceId: 'o1', reason: 'locked' }])
    expect(r1.itemIds).toEqual([])
    const p2 = project([clip('c', 0, 10 * S, { linkId: 'L' })])
    p2.tracks[0].locked = true
    p2.tracks.push({ ...vtrack('ta', []), kind: 'audio', items: [{ ...createMediaItem(vid, 0, 'audio'), id: 'au', durationUs: 10 * S, linkId: 'L' }] })
    const r2 = hideOccurrences(p2, 'v', [still()], { style: 'blur' })
    expect(r2.skipped).toEqual([])
    expect((findItem(r2.project, r2.itemIds[0])!.item as EffectItem).linkId).toBe('L')
    expect(r2.project.tracks[0]).toBe(p2.tracks[0]) // faixa bloqueada intacta
  })

  it('faixa de efeitos bloqueada não recebe (vai para uma nova, como o addEffect); clipIds restringe', () => {
    const p0 = project([clip('c', 0, 10 * S), clip('d', 10 * S, 10 * S, { inUs: 0 })])
    p0.tracks.push({ ...vtrack('fxl', []), name: 'Efeitos', role: 'effects', locked: true })
    const r = hideOccurrences(p0, 'v', [still()], { style: 'blur', clipIds: ['d'] })
    expect(r.itemIds.length).toBe(1)
    expect(findItem(r.project, r.itemIds[0])!.track.id).not.toBe('fxl')
    expect((findItem(r.project, r.itemIds[0])!.item as EffectItem).attach?.mediaItemId).toBe('d')
    expect(r.project.tracks.find((t) => t.id === 'fxl')!.items).toEqual([])
  })
})

describe('hideOccurrences — invariante 2 depois de outras edições', () => {
  const base = (): { p: Project; occs: Occurrence[] } => {
    const occs = [still(), scrolling()]
    const p0 = project([clip('c', 1 * S, 12 * S, { linkId: 'L' })])
    p0.tracks.push({ ...vtrack('ta', []), kind: 'audio', items: [{ ...createMediaItem(vid, 1 * S, 'audio'), id: 'au', durationUs: 12 * S, linkId: 'L' }] })
    return { p: hideOccurrences(p0, 'v', occs, { style: 'blur' }).project, occs }
  }
  /** Cobertura total, ou a privacidade avisa sobre algum efeito — nunca silêncio. */
  const coveredOrWarned = (p: Project, occs: Occurrence[]): void => {
    const m = misses(p, occs).misses
    if (m.length > 0) expect(privacyWarnings(p, 0, 40 * S).length).toBeGreaterThan(0)
  }
  const edits: [string, (p: Project) => Project, boolean][] = [
    ['mover o clipe', (p) => moveItems(p, ['c'], 2_345_678), true],
    ['zoom + pan no clipe', (p) => updateItem<MediaItem>(p, 'c', (d) => { d.visual!.transform.scale = anim(1, 3, 0, 8 * S); d.visual!.transform.x = anim(0.5, 0.2, 0, 8 * S) }), true],
    ['corte animado', (p) => updateItem<MediaItem>(p, 'c', (d) => { d.visual!.crop.l = anim(0, 0.25, 0, 6 * S) }), true],
    ['aparar o início', (p) => trimItem(p, 'c', 'start', 3_500_000), true],
    ['aparar o fim', (p) => trimItem(p, 'c', 'end', 7 * S), true],
    ['dividir', (p) => splitAt(p, ['c'], 5_432_100), true],
    ['dividir e mover o 2º pedaço', (p) => { const q = splitAt(p, ['c'], 5_432_100); const second = q.tracks[0].items[1].id; return moveItems(q, [second], 3 * S) }, true],
    ['velocidade 2× (keys do efeito vinculado reescaladas)', (p) => setSpeed(p, 'c', 2), true],
    ['reverso (keys do efeito vinculado espelhadas)', (p) => setReverse(p, ['c'], true), true],
    ['apagar o clipe (efeitos vinculados saem juntos)', (p) => deleteItems(p, ['c']), false],
    ['desativar o clipe', (p) => setItemEnabled(p, ['c'], false), false]
  ]
  for (const [name, op, strict] of edits) {
    it(`${name}: ${strict ? 'cobertura mantida' : 'cobertura mantida ou aviso'}`, () => {
      const { p, occs } = base()
      expect(misses(p, occs).misses).toEqual([])
      const q = op(p)
      expect(q).not.toBe(p)
      if (strict) expect(misses(q, occs).misses.slice(0, 3)).toEqual([])
      else coveredOrWarned(q, occs)
    })
  }
})

describe('hideOccurrences — v1.3', () => {
  it('disco legível pela v1.3, ida e volta igual, e a caixa estática do disco cobre o dado em todo instante', () => {
    const occs = [still(), scrolling()]
    const zoomed = clip('a', 0, 6 * S)
    zoomed.visual!.transform.scale = anim(1, 2, 0, 5 * S)
    const p0 = project([zoomed, clip('b', 6 * S, 6 * S, { reverse: true, inUs: 1 * S }), clip('f', 12 * S, 2 * S, { freeze: { atUs: 4 * S } })])
    const p = hideOccurrences(p0, 'v', occs, { style: 'blur' }).project
    const disk = JSON.parse(JSON.stringify(toDiskProject(p)))
    const v13 = parseProjectV13(disk)
    expect(v13.success).toBe(true)
    expect(parseProject(disk)).toEqual(JSON.parse(JSON.stringify(p)))
    // a v1.3 desenha a `region` do disco (parada, sem attach)
    const diskRegion = new Map<string, RegionValues>()
    for (const t of disk.tracks) for (const i of t.items) {
      if (i.type !== 'effect') continue
      expect(i.region.x.keys).toBeUndefined()
      diskRegion.set(i.id, { x: i.region.x.value, y: i.region.y.value, w: i.region.w.value, h: i.region.h.value, rotation: i.region.rotation.value })
    }
    expect(misses(p, occs, (l) => diskRegion.get(l.itemId)!).misses).toEqual([])
  })
})

describe('hideOccurrences — desempenho', () => {
  it('200 ocorrências × 3 clipes < 50 ms', () => {
    const occs = Array.from({ length: 200 }, (_, i) => occurrence(`o${i}`, ((i * 97) % 18) * S, ((i * 97) % 18) * S + 1_500_000, (t) => ({ x: (i % 10) / 11, y: ((i * 7) % 30) / 31 + (t % 1000) / 1e7, w: 0.08, h: 0.03 })))
    const p0 = project([clip('a', 0, 20 * S), clip('b', 20 * S, 10 * S, { speed: 2 }), clip('c', 30 * S, 20 * S, { reverse: true })])
    // melhor medida (padrão do attachPerf), repetindo por até 6 s enquanto passar do alvo: a suíte inteira em paralelo
    // (16 workers) deixa uma medida isolada ~6× mais lenta; a 1ª chamada aquece o JIT. Sozinho (esta máquina): ~20 ms
    // (node) / ~40 ms (vitest).
    let r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
    let ms = Infinity
    const until = performance.now() + 6000
    while (ms >= 50 && performance.now() < until) {
      const t0 = performance.now()
      r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
      ms = Math.min(ms, performance.now() - t0)
    }
    console.log(`hideOccurrences 200×3: ${ms.toFixed(1)} ms, ${r.itemIds.length} efeitos, ${r.project.tracks.filter((t) => t.role === 'effects').length} faixas`)
    expect(r.itemIds.length).toBe(600)
    expect(ms).toBeLessThan(50)
  }, 30_000)
})
