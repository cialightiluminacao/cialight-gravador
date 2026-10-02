import { describe, expect, it } from 'vitest'
import type { CursorTrackV1 } from '../cursor'
import { evalAnim } from './anim'
import { itemAnimEntries } from './animPaths'
import {
  applyAutoZoom, AUTO_ZOOM_LIMITS, AUTO_ZOOM_TOL_PX, autoZoomSpeedBound, DEFAULT_AUTO_ZOOM, itemClicks, planAutoZoom, type AutoZoomOpts
} from './autoZoom'
import { contentPose, toScreen } from './contentPose'
import { cursorTimeMap, type CursorTimeMap } from './cursorTime'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachEffects } from './followTransform'
import { layerBase } from './layerGeometry'
import { EditError, findItem } from './ops'
import type { Asset, MediaItem, Project, Us, VisualProps } from './project'
import { clipFrameAt, effectRegionAt } from './resolve'
import { coversFrame, sourceOf } from './zoom'

const S = 1_000_000
const DT = Math.round(S / 240)

/** Gerador determinístico (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Trilha sintética: amostras a ~60 Hz (passeio aleatório com saltos e alguns pontos um pouco fora do quadro, como a
 * gravação guarda) e cliques nos instantes pedidos, na posição do cursor naquele instante.
 */
function synthTrack(durMs: number, clickMs: number[], r: () => number): CursorTrackV1 {
  const samples: CursorTrackV1['samples'] = []
  let x = 0.5, y = 0.5
  for (let t = 0; t <= durMs; t += 16) {
    if (r() < 0.004) {
      x = r() * 1.1 - 0.05
      y = r() * 1.1 - 0.05
    } else {
      x = Math.min(1.02, Math.max(-0.02, x + (r() - 0.5) * 0.012))
      y = Math.min(1.02, Math.max(-0.02, y + (r() - 0.5) * 0.012))
    }
    samples.push({ tMs: t, x, y })
  }
  const clicks = clickMs.map((tMs) => {
    const s = samples[Math.min(samples.length - 1, Math.floor(tMs / 16))]
    return { tMs, x: s.x, y: s.y, button: 'left' as const }
  })
  return { version: 1, width: 1920, height: 1080, samples, clicks }
}

/** Cliques aleatórios: intervalos entre 0,3 s e 12 s. */
function randomClicks(durMs: number, r: () => number): number[] {
  const out: number[] = []
  for (let t = 400 + r() * 2000; t < durMs - 100; t += 300 + r() * 11_700) out.push(Math.round(t))
  return out
}

const screen = (durUs: Us): Asset => ({
  id: 'scr', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' }, durationUs: durUs,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready', cursor: 'cursor.json'
})

type Aspect = '16:9' | '9:16 reenquadrado' | 'cortado' | 'girado 90°'
const ASPECTS: Aspect[] = ['16:9', '9:16 reenquadrado', 'cortado', 'girado 90°']

function proj(aspect: Aspect, durUs: Us, over: Partial<MediaItem> = {}, assetDurUs = durUs): Project {
  const vertical = aspect === '9:16 reenquadrado'
  const p = createEmptyProject('az', vertical ? { width: 1080, height: 1920, fps: 30 } : { width: 1920, height: 1080, fps: 30 })
  const a = screen(assetDurUs)
  p.assets = [a]
  const m: MediaItem = { ...createMediaItem(a, 0, 'video'), id: 'm', durationUs: durUs, ...over }
  const v = m.visual!
  if (aspect === '9:16 reenquadrado') v.fit = 'cover'
  if (aspect === 'cortado') {
    v.crop = { l: { value: 0.1 }, t: { value: 0.05 }, r: { value: 0.05 }, b: { value: 0.1 } }
    v.fit = 'cover'
  }
  if (aspect === 'girado 90°') {
    v.transform.rotation = { value: 90 }
    v.transform.scale = { value: 1920 / 1080 }
  }
  p.tracks[0].items = [m]
  return p
}

const itemOf = (p: Project, id = 'm'): MediaItem => findItem(p, id)!.item as MediaItem
const canvasOf = (p: Project): { w: number; h: number } => ({ w: p.canvas.width, h: p.canvas.height })
const idMap = (D: Us): CursorTimeMap => ({
  durationUs: D, reversed: false,
  toCursorMs: (u) => (u >= 0 && u < D ? u / 1000 : null),
  toLocalUs: (ms) => { const u = Math.round(ms * 1000); return u >= 0 && u < D ? u : null }
})
const randomOpts = (r: () => number): AutoZoomOpts => {
  const pick = (k: keyof AutoZoomOpts): number => AUTO_ZOOM_LIMITS[k].min + r() * (AUTO_ZOOM_LIMITS[k].max - AUTO_ZOOM_LIMITS[k].min)
  return { scale: pick('scale'), holdMs: pick('holdMs'), transitionMs: pick('transitionMs'), smoothing: pick('smoothing') }
}
const xys = (m: MediaItem): Anim3 => ({ x: m.visual!.transform.x, y: m.visual!.transform.y, scale: m.visual!.transform.scale })
type Anim3 = Record<'x' | 'y' | 'scale', VisualProps['transform']['x']>

describe('planAutoZoom: grupos, tempo e caminho', () => {
  const D = 30 * S
  const plan = (clicks: number[], o: Partial<AutoZoomOpts> = {}, d = D): ReturnType<typeof planAutoZoom> =>
    planAutoZoom(synthTrack(d / 1000, clicks, rng(1)), idMap(d), { ...DEFAULT_AUTO_ZOOM, ...o })
  it('cliques com intervalo < duração + transição viram um só zoom, que chega à escala cheia no 1º clique', () => {
    const s = plan([5000, 6000, 7400], { holdMs: 1800, transitionMs: 700 })
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ inUs: 4_300_000, fullUs: 5_000_000, outStartUs: 9_200_000, outUs: 9_900_000, clicks: 3 })
  })
  it('cliques distantes: dois zooms', () => {
    const s = plan([3000, 15_000])
    expect(s.map((x) => [x.inUs, x.fullUs, x.outUs])).toEqual([[2_300_000, 3_000_000, 5_500_000], [14_300_000, 15_000_000, 17_500_000]])
  })
  it('grupos cujos zooms se sobreporiam (volta de um × ida do outro) se fundem', () => {
    // 1º grupo volta em [4,8 s; 5,5 s]; o 2º iria de 6,3 s → sem sobreposição; com 2º clique em 5,9 s a ida começaria em 5,2 s
    expect(plan([3000, 7000])).toHaveLength(2)
    const s = plan([3000, 5900])
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ inUs: 2_300_000, fullUs: 3_000_000, outUs: 5_900_000 + 2_500_000, clicks: 2 })
  })
  it('clique logo no início: a ida começa no início do item e termina o mais cedo possível', () => {
    const s = plan([200])
    expect(s[0]).toMatchObject({ inUs: 0, fullUs: 700_000 })
  })
  it('clique perto do fim: a volta é antecipada para caber; sem tempo para a volta, fica no zoom até o fim', () => {
    const a = plan([28_000])
    expect(a[0]).toMatchObject({ fullUs: 28_000_000, outStartUs: D - 700_000, outUs: D })
    const b = plan([29_600])
    expect(b[0]).toMatchObject({ fullUs: 29_600_000, outStartUs: D, outUs: D })
  })
  it('sem cliques: nada; caminho começa no clique, amostrado, tempos crescentes, dentro do quadro gravado', () => {
    expect(plan([])).toEqual([])
    const s = plan([5000, 9000])[0]
    expect(s.path[0].tUs).toBe(s.fullUs)
    expect(s.path[s.path.length - 1].tUs).toBe(s.outStartUs)
    for (let i = 1; i < s.path.length; i++) expect(s.path[i].tUs).toBeGreaterThan(s.path[i - 1].tUs)
    for (const q of s.path) for (const c of [q.x, q.y]) expect(c >= 0 && c <= 1).toBe(true)
  })
  it('opções fora da faixa são presas (nunca NaN)', () => {
    const s = plan([5000], { scale: 99, holdMs: -1, transitionMs: Number.NaN, smoothing: 7 })
    expect(s[0].fullUs - s[0].inUs).toBe(DEFAULT_AUTO_ZOOM.transitionMs * 1000)
    expect(s[0].outStartUs - s[0].fullUs).toBe(AUTO_ZOOM_LIMITS.holdMs.min * 1000)
  })
})

describe('applyAutoZoom: sem bordas pretas, continuidade, keys (denso a 1/240 s)', () => {
  const seeds = [11, 22, 33]
  for (const aspect of ASPECTS) {
    for (const seed of seeds) {
      it(`${aspect}, semente ${seed}: cobre o quadro em todo instante; velocidade ≤ limite declarado; keys crescentes`, () => {
        const r = rng(seed)
        const D = 60 * S
        const p = proj(aspect, D)
        const v0 = itemOf(p).visual!
        const src = sourceOf(p, itemOf(p))
        const canvas = canvasOf(p)
        expect(coversFrame(v0, src, canvas, 0)).toBe(true)
        const opts = randomOpts(r)
        const track = synthTrack(D / 1000, randomClicks(D / 1000, r), r)
        const res = applyAutoZoom(p, 'm', track, opts)
        expect(res.segments).toBeGreaterThan(0)
        const m = itemOf(res.project)
        const v = m.visual!
        for (const [, a] of itemAnimEntries(m)) (a.keys ?? []).forEach((k, i, ks) => i > 0 && expect(k.tUs).toBeGreaterThan(ks[i - 1].tUs))
        const g = layerBase({ l: v0.crop.l.value, t: v0.crop.t.value, r: v0.crop.r.value, b: v0.crop.b.value }, v0.fit, src, canvas)
        const bound = autoZoomSpeedBound(opts, { s0: v0.transform.scale.value, bw: g.bw, bh: g.bh, rotation: v0.transform.rotation.value }, canvas)
        const a = xys(m)
        let prev = { x: evalAnim(a.x, 0), y: evalAnim(a.y, 0), s: evalAnim(a.scale, 0) }
        let uncovered = 0, fast = 0, maxPx = 0
        for (let t = 0; t < D; t += DT) {
          if (!coversFrame(v, src, canvas, t)) uncovered++
          const cur = { x: evalAnim(a.x, t), y: evalAnim(a.y, t), s: evalAnim(a.scale, t) }
          if (t > 0) {
            const px = Math.max(Math.abs(cur.x - prev.x) * canvas.w, Math.abs(cur.y - prev.y) * canvas.h) / (DT / S)
            maxPx = Math.max(maxPx, px)
            if (px > bound.pxPerS * 1.0001 + 1e-6 || Math.abs(cur.s - prev.s) / (DT / S) > bound.scalePerS * 1.0001 + 1e-9) fast++
          }
          prev = cur
        }
        expect(uncovered).toBe(0)
        expect(fast).toBe(0)
        expect(maxPx).toBeGreaterThan(0)
      })
    }
  }

  it('corte animado (a geometria base muda no trecho): o refino insere keys presos e o quadro continua coberto', () => {
    const D = 30 * S
    const p = proj('cortado', D)
    const v0 = itemOf(p).visual!
    v0.crop.l = { value: 0.1, keys: [{ tUs: 0, value: 0, ease: 'linear' }, { tUs: D, value: 0.3, ease: 'linear' }] }
    v0.crop.b = { value: 0.1, keys: [{ tUs: 0, value: 0.3, ease: 'inOut' }, { tUs: D, value: 0, ease: 'linear' }] }
    const r = rng(3)
    const track = synthTrack(30_000, randomClicks(30_000, r), r)
    const res = applyAutoZoom(p, 'm', track, { ...DEFAULT_AUTO_ZOOM, scale: 1.3, smoothing: 0 })
    const v = itemOf(res.project).visual!
    const src = sourceOf(p, itemOf(p))
    let uncovered = 0
    for (let t = 0; t < D; t += DT) if (coversFrame(v0, src, canvasOf(p), t) && !coversFrame(v, src, canvasOf(p), t)) uncovered++
    expect(uncovered).toBe(0)
  })

  /** Instantes (1/240 s) em que o original cobria o quadro e o resultado não. */
  const lostCover = (p0: Project, q: Project, D: Us): number => {
    const v0 = itemOf(p0).visual!, v = itemOf(q).visual!, src = sourceOf(p0, itemOf(p0)), c = canvasOf(p0)
    let n = 0
    for (let t = 0; t < D; t += DT) if (coversFrame(v0, src, c, t) && !coversFrame(v, src, c, t)) n++
    return n
  }
  it.each([1, 2, 3])('rotação com keys (0° → 90° → 180°, degraus) e corte animado rápido, semente %i: coberto a 1/240 s', (seed) => {
    const D = 30 * S
    const p = proj('girado 90°', D)
    const v0 = itemOf(p).visual!
    v0.transform.rotation = { value: 0, keys: [{ tUs: 0, value: 0, ease: 'hold' }, { tUs: 9 * S, value: 90, ease: 'hold' }, { tUs: 21 * S, value: 180, ease: 'linear' }] }
    v0.fit = 'cover'
    v0.crop.t = { value: 0, keys: [{ tUs: 0, value: 0, ease: 'inOut' }, { tUs: 4 * S, value: 0.25, ease: 'inOut' }, { tUs: 8 * S, value: 0, ease: 'linear' }, { tUs: 16 * S, value: 0.3, ease: 'linear' }] }
    const r = rng(seed)
    const clicks = [...randomClicks(30_000, r), 8_950, 9_000, 20_950]
    const track = synthTrack(30_000, clicks.sort((a, b) => a - b), r)
    const res = applyAutoZoom(p, 'm', track, { ...randomOpts(r), smoothing: 0 })
    expect(lostCover(p, res.project, D)).toBe(0)
    for (const [, a] of itemAnimEntries(itemOf(res.project))) (a.keys ?? []).forEach((k, i, ks) => i > 0 && expect(k.tUs).toBeGreaterThan(ks[i - 1].tUs))
  })

  it.each(ASPECTS)('%s: sem salto nas pontas de cada trecho (|Δpose| ≈ 0 entre inUs ± 1 µs e outUs ± 1 µs)', (aspect) => {
    const D = 60 * S
    const r = rng(99)
    const p = proj(aspect, D)
    // curva do usuário mexendo fora dos trechos também
    itemOf(p).visual!.transform.scale = { value: 1, keys: [{ tUs: 0, value: itemOf(p).visual!.transform.scale.value, ease: 'inOut' }, { tUs: 50 * S, value: itemOf(p).visual!.transform.scale.value * 1.1, ease: 'linear' }] }
    const opts = randomOpts(r)
    const track = synthTrack(60_000, randomClicks(60_000, r), r)
    const segs = planAutoZoom(track, cursorTimeMap(p, itemOf(p))!, opts)
    expect(segs.length).toBeGreaterThan(1)
    const t = itemOf(applyAutoZoom(p, 'm', track, opts).project).visual!.transform
    const W = p.canvas.width, H = p.canvas.height
    for (const sg of segs) {
      for (const at of [sg.inUs, sg.outUs]) {
        if (at <= 0 || at >= D) continue
        const a = at - 1, b = at + 1
        expect(Math.abs(evalAnim(t.x, b) - evalAnim(t.x, a)) * W).toBeLessThan(0.01)
        expect(Math.abs(evalAnim(t.y, b) - evalAnim(t.y, a)) * H).toBeLessThan(0.01)
        expect(Math.abs(evalAnim(t.scale, b) - evalAnim(t.scale, a))).toBeLessThan(1e-5)
      }
    }
  })

  it('no instante do clique (zoom cheio) o ponto clicado vai ao centro do quadro; perto do canto, fica preso à borda', () => {
    const D = 20 * S
    for (const [cx, cy] of [[0.5, 0.4], [0.62, 0.55], [0.02, 0.03]]) {
      const p = proj('16:9', D)
      const track: CursorTrackV1 = { version: 1, width: 1920, height: 1080, samples: [{ tMs: 0, x: cx, y: cy }, { tMs: 20_000, x: cx, y: cy }], clicks: [{ tMs: 4000, x: cx, y: cy, button: 'left' }] }
      const res = applyAutoZoom(p, 'm', track, { ...DEFAULT_AUTO_ZOOM, scale: 2 })
      const local = 4_080_000 // atraso R11: o clique aparece 80 ms depois
      const q = res.project
      const cf = clipFrameAt(q, itemOf(q), local)!
      const at = toScreen(cf, cx * cf.g.dw, cy * cf.g.dh)
      expect(evalAnim(itemOf(q).visual!.transform.scale, local)).toBeCloseTo(2, 9)
      if (cx > 0.1) {
        expect(at.x).toBeCloseTo(960, 6)
        expect(at.y).toBeCloseTo(540, 6)
      } else {
        // preso: o canto da camada no canto do quadro (camada 3840×2160 com o centro em (1920, 1080))
        expect(evalAnim(itemOf(q).visual!.transform.x, local) * 1920).toBeCloseTo(1920, 6)
        expect(evalAnim(itemOf(q).visual!.transform.y, local) * 1080).toBeCloseTo(1080, 6)
      }
      // antes e depois do zoom: escala 1
      expect(evalAnim(itemOf(q).visual!.transform.scale, 1 * S)).toBe(1)
      expect(evalAnim(itemOf(q).visual!.transform.scale, 15 * S)).toBe(1)
    }
  })

  it('keys do usuário fora dos trechos ficam intactos; os de dentro são contados em `replaced`; nunca tUs repetido', () => {
    const D = 30 * S
    const p = proj('16:9', D)
    const m0 = itemOf(p)
    m0.visual!.transform.scale = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'linear' }, { tUs: 5_000_000, value: 1, ease: 'linear' }, { tUs: 25_000_000, value: 1.2, ease: 'inOut' }] }
    m0.visual!.transform.x = { value: 0.5, keys: [{ tUs: 1_000_000, value: 0.5, ease: 'linear' }, { tUs: 11_000_000, value: 0.5, ease: 'linear' }, { tUs: 29_000_000, value: 0.55, ease: 'linear' }] }
    m0.visual!.transform.rotation = { value: 0, keys: [{ tUs: 10_500_000, value: 0, ease: 'linear' }] }
    const track = synthTrack(30_000, [10_000], rng(5))
    const res = applyAutoZoom(p, 'm', track, DEFAULT_AUTO_ZOOM)
    // trecho: [9,38 s; 12,58 s] (clique em 10 s + 80 ms de atraso)
    expect(res.segments).toBe(1)
    expect(res.replaced).toBe(1) // o key de x em 11 s
    const t = itemOf(res.project).visual!.transform
    expect(t.scale.keys!.filter((k) => k.tUs < 9_380_000 || k.tUs > 12_580_000)).toEqual(m0.visual!.transform.scale.keys)
    expect(t.x.keys!.filter((k) => k.tUs < 9_380_000 || k.tUs > 12_580_000)).toEqual([m0.visual!.transform.x.keys![0], m0.visual!.transform.x.keys![2]])
    expect(t.rotation).toEqual(m0.visual!.transform.rotation)
    for (const a of [t.x, t.y, t.scale]) a.keys!.forEach((k, i, ks) => i > 0 && expect(k.tUs).toBeGreaterThan(ks[i - 1].tUs))
    // a curva de antes e de depois do trecho não muda
    for (const at of [0, 3 * S, 9 * S, 13 * S, 20 * S, 29.9 * S]) {
      expect(evalAnim(t.scale, at)).toBeCloseTo(evalAnim(m0.visual!.transform.scale, at), 9)
      expect(evalAnim(t.x, at)).toBeCloseTo(evalAnim(m0.visual!.transform.x, at), 9)
    }
  })

  it('vários trechos sobre uma curva do usuário com ease inOut: fora dos trechos a curva é a mesma (denso)', () => {
    const D = 40 * S
    const p = proj('16:9', D)
    const m0 = itemOf(p)
    m0.visual!.transform.scale = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'inOut' }, { tUs: 20 * S, value: 1.1, ease: 'inOut' }, { tUs: 39 * S, value: 1, ease: 'linear' }] }
    m0.visual!.transform.x = { value: 0.5, keys: [{ tUs: 2 * S, value: 0.5, ease: 'inOut' }, { tUs: 30 * S, value: 0.52, ease: 'linear' }] }
    const track = synthTrack(40_000, [5_000, 14_000, 21_000, 33_000], rng(8))
    const segs = planAutoZoom(track, cursorTimeMap(p, m0)!, DEFAULT_AUTO_ZOOM)
    expect(segs.length).toBe(4)
    const res = applyAutoZoom(p, 'm', track, DEFAULT_AUTO_ZOOM)
    const t = itemOf(res.project).visual!.transform, t0 = m0.visual!.transform
    const inside = (u: number): boolean => segs.some((sg) => u >= sg.inUs && u <= sg.outUs)
    for (let u = 0; u < D; u += DT) {
      if (inside(u)) continue
      expect(evalAnim(t.scale, u)).toBeCloseTo(evalAnim(t0.scale, u), 6)
      expect(evalAnim(t.x, u)).toBeCloseTo(evalAnim(t0.x, u), 6)
    }
    for (const a of [t.x, t.y, t.scale]) a.keys!.forEach((k, i, ks) => i > 0 && expect(k.tUs).toBeGreaterThan(ks[i - 1].tUs))
  })

  it('velocidade 2× e corte: o clique é levado ao tempo local certo; clique fora do trecho usado é ignorado', () => {
    const p = proj('16:9', 20 * S, { inUs: 10 * S, speed: 2 }, 60 * S)
    const track = synthTrack(60_000, [5_000, 30_000], rng(9))
    const res = applyAutoZoom(p, 'm', track, { ...DEFAULT_AUTO_ZOOM, scale: 2.5 })
    expect(res.segments).toBe(1)
    const s = itemOf(res.project).visual!.transform.scale
    const full = (30_000_000 + 80_000 - 10 * S) / 2
    expect(evalAnim(s, full)).toBeCloseTo(2.5, 9)
    expect(s.keys![0].tUs).toBe(full - 700_000)
  })

  it('itemClicks: só os cliques do trecho usado, em tempo local e em ordem (corte, 2×, atraso R11)', () => {
    const p = proj('16:9', 5 * S, { inUs: 10 * S, speed: 2 }, 60 * S)
    const track = synthTrack(60_000, [9_000, 12_000, 19_000, 19_950, 25_000], rng(1))
    const map = cursorTimeMap(p, itemOf(p))!
    expect(itemClicks(track, map).map((c) => c.tUs)).toEqual([(12_080_000 - 10 * S) / 2, (19_080_000 - 10 * S) / 2])
    expect(itemClicks({ ...track, clicks: [] }, map)).toEqual([])
  })

  it('clipe mais curto que a transição: motivo certo, não "nenhum clique"', () => {
    const p = proj('16:9', 600_000)
    const track = synthTrack(10_000, [100, 300], rng(2))
    expect(() => applyAutoZoom(p, 'm', track, DEFAULT_AUTO_ZOOM)).toThrow(/mais curto que a transição/)
  })

  it('invertido, congelado, sem trilha, imagem ou sem cliques: EditError com mensagem em português', () => {
    const track = synthTrack(10_000, [3000], rng(2))
    const err = (p: Project): EditError => {
      try {
        applyAutoZoom(p, 'm', track, DEFAULT_AUTO_ZOOM)
      } catch (e) {
        return e as EditError
      }
      throw new Error('não lançou')
    }
    const rev = err(proj('16:9', 10 * S, { reverse: true }))
    expect(rev).toBeInstanceOf(EditError)
    expect(rev.code).toBe('invalid')
    expect(rev.message).toMatch(/invertidos ou congelados/)
    expect(err(proj('16:9', 10 * S, { freeze: { atUs: S } })).message).toMatch(/invertidos ou congelados/)
    const noCursor = proj('16:9', 10 * S)
    noCursor.assets = [{ ...noCursor.assets[0], cursor: undefined }]
    expect(err(noCursor).message).toMatch(/cursor/)
    const img = proj('16:9', 10 * S)
    img.assets = [{ ...img.assets[0], kind: 'image' }]
    expect(err(img).code).toBe('invalid')
    const none = proj('16:9', 10 * S)
    expect(() => applyAutoZoom(none, 'm', synthTrack(10_000, [], rng(2)), DEFAULT_AUTO_ZOOM)).toThrow(/Nenhum clique/)
  })
})

describe('1 h de gravação: quantidade de keys e desempenho', () => {
  const H1 = 3600 * S
  const r = rng(77)
  const track = synthTrack(3_600_000, randomClicks(3_600_000, r), r)
  it(`planejar 1 h < 200 ms; keys de x/y/escala limitados (caminho simplificado a ≤ ${'2'} px)`, () => {
    expect(AUTO_ZOOM_TOL_PX).toBeLessThanOrEqual(2)
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      planAutoZoom(track, idMap(H1), DEFAULT_AUTO_ZOOM)
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(200)
    const p = proj('16:9', H1)
    const res = applyAutoZoom(p, 'm', track, DEFAULT_AUTO_ZOOM)
    const t = itemOf(res.project).visual!.transform
    const n = Math.max(t.x.keys!.length, t.y.keys!.length, t.scale.keys!.length)
    // padrão: < 2 keys por segundo de gravação (medido ~1,3/s com o cursor sempre andando)
    expect(n).toBeLessThan(2 * 3600)
    expect(t.x.keys!.length).toBe(t.scale.keys!.length)
    // pior caso (suavidade 0, intensidade 3): < 20 keys por segundo DE ZOOM (teto teórico: 60/s das amostras + 3 por trecho)
    const segs = planAutoZoom(track, idMap(H1), { ...DEFAULT_AUTO_ZOOM, smoothing: 0, scale: 3 })
    const zoomedS = segs.reduce((acc, sg) => acc + (sg.outUs - sg.inUs), 0) / S
    const worst = itemOf(applyAutoZoom(p, 'm', track, { ...DEFAULT_AUTO_ZOOM, smoothing: 0, scale: 3 }).project).visual!.transform.x.keys!.length
    expect(worst).toBeLessThan(20 * zoomedS)
    expect(worst).toBeLessThanOrEqual(segs.reduce((acc, sg) => acc + sg.path.length + 2, 0))
  })
  it('aplicar em 1 h < 1 s (medido ~100 ms)', () => {
    let best = Infinity
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now()
      applyAutoZoom(proj('16:9', H1), 'm', track, DEFAULT_AUTO_ZOOM)
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(1000)
  })
})

describe('privacidade (invariante 2)', () => {
  const D = 20 * S
  const track = synthTrack(20_000, [4_000, 12_000], rng(4))
  /** Clipe + blur numa faixa acima, sobre o canto superior esquerdo do quadro. */
  function scene(): Project {
    const p = proj('16:9', D)
    const fx = { ...createEffectItem('blur', 0, D, { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }), id: 'fx' }
    p.tracks = [p.tracks[0], { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }]
    return p
  }
  it('blur sem âncora sobre este clipe e sobre um clipe que se move antes: o aviso é deste clipe também', () => {
    const p = scene()
    // clipe que se move desde o início numa faixa abaixo do efeito (privacyWarnings atribui o aviso a ele)
    const other: MediaItem = { ...createMediaItem(p.assets[0], 0, 'video'), id: 'o', durationUs: D }
    other.visual!.transform.scale = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'linear' }, { tUs: 2 * S, value: 1.5, ease: 'linear' }] }
    p.tracks = [{ ...p.tracks[0], id: 'tb', items: [other] }, { ...p.tracks[0], id: 'tv' }, p.tracks[1]]
    const res = applyAutoZoom(p, 'm', track, DEFAULT_AUTO_ZOOM)
    const w = res.privacyWarnings.find((x) => x.itemId === 'fx')
    expect(w).toMatchObject({ kind: 'unlinkedOverMoving', mediaItemId: 'm' })
    expect(w!.message.length).toBeGreaterThan(10)
  })
  it('blur sem âncora sobre o clipe: aviso (a região não acompanha o zoom)', () => {
    const res = applyAutoZoom(scene(), 'm', track, DEFAULT_AUTO_ZOOM)
    expect(res.privacyWarnings.some((w) => w.itemId === 'fx' && w.kind === 'unlinkedOverMoving')).toBe(true)
  })
  /**
   * Oráculo de cobertura: pontos do conteúdo que estavam sob a região antes (clipe parado: os mesmos em qualquer
   * instante) continuam dentro da região do quadro em cada instante (1/240 s) depois do zoom, enquanto estão no quadro.
   */
  function coverage(before: Project, after: Project): { fails: number; zoomed: number } {
    const fx0 = findItem(before, 'fx')!.item
    const fx1 = findItem(after, 'fx')!.item
    if (fx0.type !== 'effect' || fx1.type !== 'effect') throw new Error('efeito')
    const cf0 = clipFrameAt(before, itemOf(before), 0)!
    const r0 = effectRegionAt(before, fx0, 0, 0) // sem a folga: os pontos do conteúdo de fato sob a região
    const pts: { qx: number; qy: number }[] = []
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const X = (r0.x + (i / 8 - 0.5) * r0.w) * 1920, Y = (r0.y + (j / 8 - 0.5) * r0.h) * 1080
      pts.push(contentPose(cf0, { x: X / 1920, y: Y / 1080, w: 0, h: 0, rotation: 0 }))
    }
    let fails = 0, zoomed = 0
    for (let t = 0; t < D; t += DT) {
      const cf = clipFrameAt(after, itemOf(after), t)!
      if (cf.sx > 1920 * 1.01) zoomed++
      const r = effectRegionAt(after, fx1, t)
      for (const q of pts) {
        const s = toScreen(cf, q.qx, q.qy)
        const inside = Math.abs(s.x / 1920 - r.x) <= Math.abs(r.w) / 2 + 1e-9 && Math.abs(s.y / 1080 - r.y) <= Math.abs(r.h) / 2 + 1e-9
        if (!inside && s.x >= 0 && s.y >= 0 && s.x <= 1920 && s.y <= 1080) fails++
      }
    }
    return { fails, zoomed }
  }
  it('blur ancorado: acompanha o conteúdo em todo instante (oráculo de cobertura a 1/240 s), sem aviso', () => {
    const before = attachEffects(scene(), 'm', ['fx'])
    const res = applyAutoZoom(before, 'm', track, DEFAULT_AUTO_ZOOM)
    expect(res.privacyWarnings).toEqual([])
    const c = coverage(before, res.project)
    expect(c.zoomed).toBeGreaterThan(240)
    expect(c.fails).toBe(0)
  })
  it('controle: o mesmo oráculo acusa o blur sem âncora', () => {
    const before = scene()
    expect(coverage(before, applyAutoZoom(before, 'm', track, DEFAULT_AUTO_ZOOM).project).fails).toBeGreaterThan(0)
  })
})
