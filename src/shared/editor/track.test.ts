import { describe, expect, it } from 'vitest'
import { evalAnim, setValue } from './anim'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { applyTrackedRegion, EditError, findItem, moveItems } from './ops'
import type { Anim, Asset, EffectItem, EffectRegion, Project, Us } from './project'
import { resolveFrame, type Layer } from './resolve'
import { parseProject, toDiskProject, validateProject } from './schema'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import {
  analysisSize,
  DEFAULT_TRACK_OPTS,
  ellipseInEllipse,
  formatTrackTime,
  grayFromRgba,
  layersBelowEffect,
  lossMessage,
  resolveRedetections,
  templateBox,
  trackFrames,
  trackFrameTimes,
  trackingBlocker,
  trackingProject,
  trackToKeys,
  TRACK_ATTACHED_MESSAGE,
  type GrayImage,
  type TrackBox,
  type TrackResult
} from './track'

// ---------------------------------------------------------------- cena sintética (px da análise, 480×270)

const AW = 480
const AH = 270
const CW = 1920 // quadro do projeto (4× a análise)
const CH = 1080
const FPS = 30

/** Textura suave determinística: soma de senos com fases do `seed` (amostrada no centro do pixel = translação exata). */
function texture(seed: number): (x: number, y: number) => number {
  let s = seed * 9301 + 49297
  const rnd = (): number => ((s = (s * 9301 + 49297) % 233280) / 233280)
  const waves = Array.from({ length: 6 }, () => ({ fx: (0.15 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1), fy: (0.15 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * 6.28, a: 12 + rnd() * 18 }))
  return (x, y) => 128 + waves.reduce((acc, w) => acc + w.a * Math.sin(w.fx * x + w.fy * y + w.ph), 0)
}

interface Scene {
  /** Centro do conteúdo (px da análise) no instante t (s). */
  path: (t: number) => { x: number; y: number }
  pw: number
  ph: number
  /** Oclusor (caixa fixa, px da análise) que esconde o conteúdo; corte de cena a partir de `cutAt` (s). */
  occluder?: { x0: number; y0: number; x1: number; y1: number }
  cutAt?: number
  /** Escala do conteúdo no instante t (zoom da gravação); ausente = 1. */
  zoom?: (t: number) => number
}

const BG = (() => {
  const f = texture(7)
  const d = new Float32Array(AW * AH)
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) d[y * AW + x] = 0.35 * f(x + 0.5, y + 0.5) + 60
  return d
})()
const BG_CUT = (() => {
  const f = texture(99)
  const d = new Float32Array(AW * AH)
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) d[y * AW + x] = f(x + 0.5, y + 0.5)
  return d
})()
const PATCH = texture(3)

function render(sc: Scene, t: number): GrayImage {
  const data = new Float32Array(sc.cutAt !== undefined && t >= sc.cutAt ? BG_CUT : BG)
  if (sc.cutAt !== undefined && t >= sc.cutAt) return { width: AW, height: AH, data }
  const c = sc.path(t)
  const z = sc.zoom?.(t) ?? 1
  const pw = sc.pw * z, ph = sc.ph * z
  const x0 = c.x - pw / 2, y0 = c.y - ph / 2
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(AH, Math.ceil(y0 + ph)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(AW, Math.ceil(x0 + pw)); x++) {
      const px = x + 0.5, py = y + 0.5
      if (px < x0 || px >= x0 + pw || py < y0 || py >= y0 + ph) continue
      data[y * AW + x] = PATCH((px - x0) / z, (py - y0) / z)
    }
  }
  const o = sc.occluder
  if (o) for (let y = o.y0; y < o.y1; y++) for (let x = o.x0; x < o.x1; x++) data[y * AW + x] = 90
  return { width: AW, height: AH, data }
}

const usOf = (t: number): Us => Math.round(t * 1e6)

/** Quadros nos instantes da grade do projeto em [t0, t1) (s). */
function frames(sc: Scene, t0: number, t1: number): { tUs: Us; img: GrayImage }[] {
  return trackFrameTimes(usOf(t0), usOf(t1), FPS).map((tUs) => ({ tUs, img: render(sc, tUs / 1e6) }))
}

const boxAt = (sc: Scene, t: number): TrackBox => ({ ...sc.path(t), w: sc.pw, h: sc.ph })

/** Efeito cuja região (no quadro 1920×1080) é exatamente a caixa do conteúdo em t0. */
function effectOn(sc: Scene, t0: number, t1: number, opts: { invert?: boolean; shape?: 'rect' | 'ellipse'; rotation?: number } = {}): EffectItem {
  const c = sc.path(t0)
  const fx = createEffectItem('blurText', 0, usOf(t1), { x: c.x / AW, y: c.y / AH, w: sc.pw / AW, h: sc.ph / AH, shape: opts.shape ?? 'rect', rotation: opts.rotation ?? 0 })
  return { ...fx, id: 'fx', invert: !!opts.invert }
}

const GEO = { analysisW: AW, analysisH: AH, canvasW: CW, canvasH: CH }

function region(fx: EffectItem, local: Us): { x: number; y: number; w: number; h: number; rotation: number } {
  const r = fx.region
  return { x: evalAnim(r.x, local), y: evalAnim(r.y, local), w: evalAnim(r.w, local), h: evalAnim(r.h, local), rotation: evalAnim(r.rotation, local) }
}

type V = { x: number; y: number; w: number; h: number; rotation: number }

/** Ponto (px do quadro) dentro da região (retângulo ou elipse, com rotação)? Tolerância de 1e-6 px. */
function inside(r: V, shape: 'rect' | 'ellipse', px: number, py: number): boolean {
  const th = (r.rotation * Math.PI) / 180
  const dx = px - r.x * CW, dy = py - r.y * CH
  const lx = Math.cos(th) * dx + Math.sin(th) * dy, ly = -Math.sin(th) * dx + Math.cos(th) * dy
  const hx = (Math.abs(r.w) * CW) / 2, hy = (Math.abs(r.h) * CH) / 2
  if (shape === 'rect') return Math.abs(lx) <= hx + 1e-6 && Math.abs(ly) <= hy + 1e-6
  if (hx <= 0 || hy <= 0) return false
  return (lx / hx) ** 2 + (ly / hy) ** 2 <= 1 + 1e-9
}

/** Pontos da borda de uma região (cantos e meio dos lados do retângulo; 64 pontos da elipse), px do quadro. */
function outline(r: V, shape: 'rect' | 'ellipse'): [number, number][] {
  const th = (r.rotation * Math.PI) / 180
  const hx = (Math.abs(r.w) * CW) / 2, hy = (Math.abs(r.h) * CH) / 2
  const local: [number, number][] = shape === 'rect'
    ? [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [0, -hy], [0, hy], [-hx, 0], [hx, 0]]
    : Array.from({ length: 64 }, (_, k) => [hx * Math.cos((k * Math.PI) / 32), hy * Math.sin((k * Math.PI) / 32)] as [number, number])
  return local.map(([lx, ly]) => [r.x * CW + Math.cos(th) * lx - Math.sin(th) * ly, r.y * CH + Math.sin(th) * lx + Math.cos(th) * ly])
}

/** Região verdadeira do conteúdo no instante t: a região inicial transportada pelo caminho real. */
function truth(sc: Scene, fx0: EffectItem, t0: number, t: number): V {
  const a = sc.path(t0), b = sc.path(t)
  const r = region(fx0, 0)
  const z = (sc.zoom?.(t) ?? 1) / (sc.zoom?.(t0) ?? 1)
  return { ...r, x: r.x + (b.x - a.x) / AW, y: r.y + (b.y - a.y) / AH, w: r.w * z, h: r.h * z }
}

const isNoHole = (r: V): boolean => !(Math.abs(r.w) > 0 && Math.abs(r.h) > 0)

/**
 * Oráculo de privacidade denso (1/240 s): normal → a região verdadeira do conteúdo ⊆ região avaliada do efeito em todo
 * instante; invertido → o buraco avaliado ⊆ região verdadeira, ou buraco nulo. Devolve as falhas.
 */
function oracle(sc: Scene, fx0: EffectItem, fx1: EffectItem, t0: number, t1: number): string[] {
  const fails: string[] = []
  const shape = fx0.region.shape
  for (let k = 0; ; k++) {
    const t = t0 + k / 240
    if (t >= t1) break
    const local = usOf(t) - fx1.startUs
    const r = region(fx1, local)
    const tr = truth(sc, fx0, t0, t)
    if (!fx0.invert) {
      const bad = outline(tr, shape).find(([x, y]) => !inside(r, shape, x, y))
      if (bad) fails.push(`t=${t.toFixed(4)} conteúdo fora da região em (${bad[0].toFixed(1)}, ${bad[1].toFixed(1)})`)
    } else if (!isNoHole(r)) {
      const bad = outline(r, shape).find(([x, y]) => !inside(tr, shape, x, y))
      if (bad) fails.push(`t=${t.toFixed(4)} buraco fora do conteúdo em (${bad[0].toFixed(1)}, ${bad[1].toFixed(1)})`)
    }
  }
  return fails
}

function run(sc: Scene, t0: number, t1: number, fxOpts: Parameters<typeof effectOn>[3] = {}, opts = {}): { fx0: EffectItem; fx1: EffectItem; results: TrackResult[]; lost: { tUs: Us }[] } {
  const fx0 = effectOn(sc, t0, t1, fxOpts)
  const results = trackFrames(frames(sc, t0, t1), boxAt(sc, t0), opts)
  const out = trackToKeys(fx0, results, GEO)
  return { fx0, fx1: { ...fx0, region: out.region }, results, lost: out.lost }
}

// caminhos (centro, px da análise)
const linear = (t: number): { x: number; y: number } => ({ x: 120 + 120 * t, y: 90 + 40 * t })
const accelerating = (t: number): { x: number; y: number } => ({ x: 60 + 100 * t * t, y: 135 })
const zigzag = (t: number): { x: number; y: number } => {
  const T = 0.5, A = 70
  const u = (t / T) % 1
  return { x: 200 + A * (u < 0.5 ? 2 * u : 2 - 2 * u), y: 120 + 10 * Math.sin(t * 5) }
}
// rolagem com parada: sobe 150 px/s, para 0,5 s, volta a subir
const scroll = (t: number): { x: number; y: number } => ({ x: 240, y: 220 - 150 * Math.min(t, 0.6) - (t > 1.1 ? 150 * (t - 1.1) : 0) })
// passa por trás de uma faixa opaca vertical em x ∈ [250, 330)
const occludedPath = (t: number): { x: number; y: number } => ({ x: 100 + 150 * t, y: 140 })
const OCCLUDER = { x0: 250, y0: 0, x1: 330, y1: AH }

// ---------------------------------------------------------------- testes

describe('NCC (track.ts)', () => {
  it('acha um pedaço com textura transladado (inteiro e subpixel ≤ 0,5 px)', () => {
    const offsets = [[0, 0], [7, -3], [-12.5, 4.25], [3.3, 9.7], [-20.4, -11.6]]
    for (const [dx, dy] of offsets) {
      const sc: Scene = { path: (t) => (t < 0.01 ? { x: 200, y: 120 } : { x: 200 + dx, y: 120 + dy }), pw: 60, ph: 40 }
      const res = trackFrames([{ tUs: 0, img: render(sc, 0) }, { tUs: 33_333, img: render(sc, 0.0333) }], boxAt(sc, 0))
      const r = res[1]
      expect(r.state).toBe('ok')
      expect(Math.abs(r.x - (200 + dx))).toBeLessThanOrEqual(0.5)
      expect(Math.abs(r.y - (120 + dy))).toBeLessThanOrEqual(0.5)
      expect(r.confidence).toBeGreaterThan(0.95)
    }
  })

  it('a confiança cai na oclusão e no corte de cena (e o tracking entra em perda)', () => {
    const occl = trackFrames(frames({ path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }, 0, 2), boxAt({ path: occludedPath, pw: 60, ph: 40 }, 0))
    // atrás do oclusor (centro em [250, 330) ± meia largura): confiança baixa e perda
    const hidden = occl.filter((r) => { const x = occludedPath(r.tUs / 1e6).x; return x > 260 && x < 320 })
    expect(hidden.length).toBeGreaterThan(3)
    for (const r of hidden) expect(r.state).toBe('lost')
    expect(Math.max(...hidden.map((r) => r.confidence))).toBeLessThan(DEFAULT_TRACK_OPTS.lostBelow)
    // antes da oclusão: confiante
    expect(occl.filter((r) => r.tUs < 0.5e6).every((r) => r.state === 'ok' && r.confidence > 0.95)).toBe(true)
    const cut: Scene = { path: linear, pw: 60, ph: 40, cutAt: 1 }
    const res = trackFrames(frames(cut, 0, 1.5), boxAt(cut, 0))
    for (const r of res) {
      if (r.tUs < 1e6) expect(r.confidence).toBeGreaterThan(0.95)
      else expect(r.state).toBe('lost')
    }
  })

  it('recusa região lisa e pequena demais', () => {
    const flat: GrayImage = { width: AW, height: AH, data: new Float32Array(AW * AH).fill(80) }
    expect(() => trackFrames([{ tUs: 0, img: flat }], { x: 200, y: 100, w: 60, h: 40 })).toThrow(EditError)
    expect(() => trackFrames([{ tUs: 0, img: render({ path: linear, pw: 60, ph: 40 }, 0) }], { x: 120, y: 90, w: 5, h: 4 })).toThrow(EditError)
  })

  it('perf: 300 quadros 480×270, molde 60×40, janela ±40 px < 1,5 s', () => {
    const sc: Scene = { path: (t) => ({ x: 120 + 30 * t, y: 100 + 10 * Math.sin(t) }), pw: 60, ph: 40 }
    const fr = Array.from({ length: 300 }, (_, n) => ({ tUs: usOf(n / 30), img: render(sc, n / 30) }))
    let best = Infinity
    for (let round = 0; round < 3; round++) {
      const t0 = performance.now()
      const res = trackFrames(fr, boxAt(sc, 0), { searchPx: 40 })
      best = Math.min(best, performance.now() - t0)
      expect(res.every((r) => r.state === 'ok')).toBe(true)
    }
    expect(best).toBeLessThan(1500)
  })
})

describe('trackToKeys: perda (R4), espaçamento (R4b) e mescla', () => {
  it('perda (normal): segura a última posição confiante e CRESCE até cobrir a janela de busca alcançada', () => {
    const sc: Scene = { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }
    const { fx1, results, lost } = run(sc, 0, 2)
    expect(lost.length).toBeGreaterThanOrEqual(1)
    const firstLost = results.findIndex((r) => r.state === 'lost')
    const held = results[firstLost - 1]
    let prevArea = 0
    for (let i = firstLost; i < results.length && results[i].state === 'lost'; i++) {
      const r = results[i]
      // posição segura: nunca inventada
      expect(r.x).toBe(held.x)
      expect(r.y).toBe(held.y)
      const v = region(fx1, r.tUs)
      // cobre a janela alcançada: o molde em qualquer ponto de held ± reach
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const px = (held.x + sx * r.reach + (cx * sc.pw) / 2) * (CW / AW)
          const py = (held.y + sy * r.reach + (cy * sc.ph) / 2) * (CH / AH)
          expect(inside(v, 'rect', px, py)).toBe(true)
        }
      }
      const area = v.w * v.h
      expect(area).toBeGreaterThanOrEqual(prevArea) // só cresce enquanto perdido
      prevArea = area
    }
    // R21: sem recuperação — perdido até o fim (mesmo depois que o conteúdo reaparece), a região nunca encolhe
    expect(results.slice(firstLost).every((r) => r.state !== 'ok')).toBe(true)
    expect(results.slice(firstLost + 1).every((r) => r.state === 'lost')).toBe(true)
    let prev = 0
    for (let t = results[firstLost].tUs; t < fx1.durationUs; t += 4_167) {
      const v = region(fx1, t)
      expect(v.w * v.h).toBeGreaterThanOrEqual(prev)
      prev = v.w * v.h
    }
  })

  it('perda (invertido): o buraco fecha (NO_HOLE), nunca cresce', () => {
    const sc: Scene = { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }
    const { fx0, fx1, results } = run(sc, 0, 2, { invert: true })
    const r0 = region(fx0, 0)
    for (const r of results) {
      const v = region(fx1, r.tUs)
      if (r.state === 'lost') expect(v).toEqual({ x: 0, y: 0, w: 0, h: 0, rotation: 0 })
      else {
        expect(v.w).toBeLessThanOrEqual(r0.w)
        expect(v.h).toBeLessThanOrEqual(r0.h)
      }
    }
  })

  it('R4b: com passo de análise > 1 quadro, cada key é alargado pelo maior deslocamento entre vizinhos (oráculo)', () => {
    // zigue-zague a meia velocidade: 24 px por quadro analisado (dentro da janela), virando entre as amostras
    const slowZig = (t: number): { x: number; y: number } => zigzag(t / 2)
    const sc: Scene = { path: slowZig, pw: 60, ph: 40 }
    const all = frames(sc, 0, 1.5)
    const strided = all.filter((_, n) => n % 3 === 0) // um quadro analisado a cada 3
    const fx0 = effectOn(sc, 0, 1.5)
    const results = trackFrames(strided, boxAt(sc, 0))
    expect(results.filter((r) => r.state === 'ok').length).toBeGreaterThan(results.length * 0.8)
    const out = trackToKeys(fx0, results, GEO)
    const fx1 = { ...fx0, region: out.region }
    for (let i = 1; i < results.length - 1; i++) {
      // R4b vale entre quadros confiantes seguidos (a perda tem a sua própria cobertura)
      if (results[i - 1].state !== 'ok' || results[i].state !== 'ok' || results[i + 1].state !== 'ok') continue
      const d = Math.max(Math.hypot(results[i].x - results[i - 1].x, results[i].y - results[i - 1].y), Math.hypot(results[i + 1].x - results[i].x, results[i + 1].y - results[i].y)) * (CW / AW)
      const v = region(fx1, results[i].tUs)
      expect((v.w * CW - (sc.pw * CW) / AW) / 2).toBeGreaterThanOrEqual(d - 1e-6)
    }
    expect(oracle(sc, fx0, fx1, 0, 1.5)).toEqual([])
  })

  it('keys estritamente crescentes, dentro do item e um por quadro analisado (+ degraus da perda)', () => {
    const sc: Scene = { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }
    const { fx1, results } = run(sc, 0, 2)
    for (const c of ['x', 'y', 'w', 'h'] as const) {
      const keys = fx1.region[c].keys!
      for (let i = 1; i < keys.length; i++) expect(keys[i].tUs).toBeGreaterThan(keys[i - 1].tUs)
      expect(keys[0].tUs).toBeGreaterThanOrEqual(0)
      expect(keys[keys.length - 1].tUs).toBeLessThanOrEqual(fx1.durationUs)
      for (const r of results) expect(keys.some((k) => k.tUs === r.tUs)).toBe(true)
    }
  })

  it('R21: depois de uma perda, reposicionar e rodar de novo a partir de um quadro posterior — os keys de antes ficam', () => {
    const sc: Scene = { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }
    // 1ª passada: perde atrás do oclusor e fica ampliada até o fim
    const first = run(sc, 0, 2)
    expect(first.lost).toHaveLength(1)
    // o conteúdo já saiu de trás do oclusor em 1,7 s: o usuário reposiciona a região sobre ele nesse quadro
    const t2 = 1.7, a = usOf(t2)
    const c = sc.path(t2)
    const box = { x: c.x / AW, y: c.y / AH, w: sc.pw / AW, h: sc.ph / AH }
    const r1 = first.fx1.region
    const user: EffectItem = { ...first.fx1, region: { ...r1, x: setValue(r1.x, a, box.x), y: setValue(r1.y, a, box.y), w: setValue(r1.w, a, box.w), h: setValue(r1.h, a, box.h) } }
    // 2ª passada a partir de 1,7 s
    const res2 = trackFrames(frames(sc, t2, 2), boxAt(sc, t2))
    expect(res2.every((r) => r.state === 'ok')).toBe(true)
    const out2 = trackToKeys(user, res2, GEO)
    expect(out2.lost).toEqual([])
    const fx2 = { ...user, region: out2.region }
    // os keys de antes ficam iguais e a curva não muda até o último deles; de lá até a − 1 vale o estado dele (a região
    // ampliada da perda: degrau conservador da fronteira), não a interpolação até a caixa reposicionada
    const kPrev = Math.max(...(['x', 'y', 'w', 'h'] as const).flatMap((ch) => user.region[ch].keys!.filter((k) => k.tUs < a - 1).map((k) => k.tUs)))
    for (const ch of ['x', 'y', 'w', 'h'] as const) {
      expect(fx2.region[ch].keys!.filter((k) => k.tUs < a - 1)).toEqual(user.region[ch].keys!.filter((k) => k.tUs < a - 1))
      for (let t = 0; t <= kPrev; t += 7_919) expect(evalAnim(fx2.region[ch], t)).toBeCloseTo(evalAnim(user.region[ch], t), 12)
      expect(evalAnim(fx2.region[ch], a - 1)).toBe(evalAnim(user.region[ch], kPrev))
      const ts = fx2.region[ch].keys!.map((k) => k.tUs)
      for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1])
    }
    // de 1,7 s ao fim, o conteúdo está coberto (oráculo denso)
    expect(oracle(sc, effectOn(sc, t2, 2), fx2, t2, 2)).toEqual([])
  })
  it('R21: na fronteira da nova passada, o estado anterior vale até a − 1 (invertido: buraco fechado; normal: ampliada) — oráculo denso', () => {
    const sc: Scene = { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }
    for (const invert of [true, false]) {
      for (const t2 of [1.7, 1.71, 1.75, 1.8]) {
        // 1ª passada sem a redetecção (G4): a oclusão passa de 1 s e o resultado é o mesmo (oclusão > 1 s em
        // track.adversarial), mas a busca da janela de 1 s em 8 passadas estoura o tempo do teste com a máquina carregada
        const first = run(sc, 0, 2, { invert }, { redetect: null })
        const firstLost = first.results.find((r) => r.state !== 'ok')!.tUs / 1e6
        const a = usOf(t2), c = sc.path(t2)
        const box = { x: c.x / AW, y: c.y / AH, w: sc.pw / AW, h: sc.ph / AH }
        const r1 = first.fx1.region
        // o usuário reposiciona a região no quadro da nova partida
        const user: EffectItem = { ...first.fx1, region: { ...r1, x: setValue(r1.x, a, box.x), y: setValue(r1.y, a, box.y), w: setValue(r1.w, a, box.w), h: setValue(r1.h, a, box.h) } }
        const fx2 = { ...user, region: trackToKeys(user, trackFrames(frames(sc, t2, 2), boxAt(sc, t2)), GEO).region }
        // denso, da perda ao fim: invertido → buraco ⊆ conteúdo ou nulo; normal → conteúdo ⊆ região (a referência do
        // conteúdo é a caixa dele no início de cada trecho: a perda, e a nova partida)
        const tag = `${invert ? 'invertido' : 'normal'} t2=${t2}`
        expect(oracle(sc, effectOn(sc, firstLost, 2, { invert }), fx2, firstLost, t2), `${tag} antes da nova partida`).toEqual([])
        expect(oracle(sc, effectOn(sc, t2, 2, { invert }), fx2, t2, 2), `${tag} depois`).toEqual([])
        if (invert) for (const t of [a - 1, a - 2, a - 1000]) expect(evalAnim(fx2.region.w, t)).toBe(0)
      }
    }
  })
  it('R21: na fronteira da nova passada, elipse de proporção diferente da anterior não é "contida" por engano — a cobertura não diminui (oráculo denso)', () => {
    // 1ª passada confiante; o usuário reposiciona em `a` com uma elipse estreita e alta, deslocada de lado: ela NÃO cabe
    // na elipse do último key antes de a, então a fronteira não pode segurar aquela região no lugar da interpolação
    const sc: Scene = { path: linear, pw: 60, ph: 40 }
    for (const shape of ['ellipse', 'rect'] as const) {
      for (const hr of [0.9, 0.97]) {
        const first = run(sc, 0, 2, { shape })
        expect(first.lost).toEqual([])
        const t2 = 1.0, a = usOf(t2)
        const r1 = first.fx1.region
        const kPrev = Math.max(...(['x', 'y', 'w', 'h'] as const).flatMap((ch) => r1[ch].keys!.filter((k) => k.tUs < a - 1).map((k) => k.tUs)))
        const p = region(first.fx1, kPrev)
        const w = p.w * 0.3, h = p.h * hr
        const lx = (((p.w - w) / 2) * CW / Math.SQRT2) * 0.97 // passa no teste antigo (deslocamento × √2 + meia-largura)
        const box = { x: p.x + lx / CW, y: p.y, w, h }
        const user: EffectItem = { ...first.fx1, region: { ...r1, x: setValue(r1.x, a, box.x), y: setValue(r1.y, a, box.y), w: setValue(r1.w, a, box.w), h: setValue(r1.h, a, box.h) } }
        const res2 = trackFrames(frames(sc, t2, 2), { x: box.x * AW, y: box.y * AH, w: box.w * AW, h: box.h * AH })
        const fx2 = { ...user, region: trackToKeys(user, res2, GEO).region }
        // denso (1/240 s, mais a − 1) entre o último key de antes e a nova partida: a região de antes da nova passada
        // (a do usuário) ⊆ a de depois
        const ts: Us[] = [a - 1]
        for (let t = kPrev; t < a; t += Math.round(1e6 / 240)) ts.push(t)
        const fails: string[] = []
        for (const t of ts) {
          const before = region(user, t), after = region(fx2, t)
          const bad = outline(before, shape).find(([x, y]) => !inside(after, shape, x, y))
          if (bad) fails.push(`t=${t} (${bad[0].toFixed(1)}, ${bad[1].toFixed(1)})`)
        }
        expect(fails, `${shape} h=${hr}·h anterior`).toEqual([])
      }
    }
  })
  it('ellipseInEllipse: só erra para "não cabe" (proporções diferentes, deslocada, degenerada)', () => {
    // contida de verdade (concêntrica, menor) e por pouco fora (a do achado da revisão: estreita, alta, deslocada)
    expect(ellipseInEllipse(0, 0, 50, 30, 100, 60)).toBe(true)
    expect(ellipseInEllipse(74.1, 0, 23, 99.9, 154.4, 103)).toBe(false)
    expect(ellipseInEllipse(0, 0, 10, 10, 0, 50)).toBe(false)
    // aleatória: sempre que diz "cabe", 4096 pontos da borda da interna estão dentro da externa
    let s = 12345
    const rnd = (): number => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
    let yes = 0
    for (let i = 0; i < 3000; i++) {
      const px = 20 + rnd() * 200, py = 20 + rnd() * 200
      const ex = rnd() * px, ey = rnd() * py, cx = (rnd() - 0.5) * px, cy = (rnd() - 0.5) * py
      if (!ellipseInEllipse(cx, cy, ex, ey, px, py)) continue
      yes++
      let m = 0
      for (let k = 0; k < 4096; k++) {
        const t = (k * 2 * Math.PI) / 4096
        m = Math.max(m, ((cx + ex * Math.cos(t)) / px) ** 2 + ((cy + ey * Math.sin(t)) / py) ** 2)
      }
      expect(m, JSON.stringify({ cx, cy, ex, ey, px, py })).toBeLessThanOrEqual(1 + 1e-12)
    }
    expect(yes).toBeGreaterThan(100)
  })
  it('mescla: keys fora do trecho rastreado ficam; antes do início a curva não muda', () => {
    const sc: Scene = { path: linear, pw: 60, ph: 40 }
    const base = effectOn(sc, 0.5, 1.5)
    const fx0: EffectItem = { ...base, region: { ...base.region, x: { value: 0.3, keys: [{ tUs: 0, value: 0.2, ease: 'inOut' }, { tUs: 300_000, value: 0.25, ease: 'linear' }, { tUs: 810_000, value: 0.5, ease: 'linear' }] }, w: { value: 0.2 } } }
    const t0 = 0.5
    const res = trackFrames(frames(sc, t0, 1.5), boxAt(sc, t0))
    const out = trackToKeys(fx0, res, GEO)
    const x = out.region.x
    // keys antes do trecho preservados
    expect(x.keys!.slice(0, 2)).toEqual(fx0.region.x.keys!.slice(0, 2))
    // nenhum key velho dentro do trecho
    expect(x.keys!.some((k) => k.tUs === 810_000)).toBe(false)
    // curva idêntica antes do início
    for (let t = 0; t < 500_000; t += 7_919) expect(evalAnim(x, t)).toBeCloseTo(evalAnim(fx0.region.x, t), 12)
    expect(evalAnim(out.region.w, 100_000)).toBe(0.2)
    // sem tempos repetidos
    const ts = x.keys!.map((k) => k.tUs)
    expect(new Set(ts).size).toBe(ts.length)
  })

  it('degrau conservador mesmo com só 2 µs entre os quadros (M1); depois da perda nada volta (R21, mesmo se a entrada disser ok)', () => {
    const sc: Scene = { path: linear, pw: 60, ph: 40 }
    const r = (tUs: number, state: 'ok' | 'lost'): TrackResult => ({ tUs, x: 120, y: 90, w: 60, h: 40, scale: 1, scaleLo: 1, scaleHi: 1, confidence: state === 'ok' ? 1 : 0.1, state, reach: state === 'ok' ? 0 : 40 })
    const input = [r(0, 'ok'), r(2, 'lost'), r(4, 'ok'), r(6, 'ok')]
    // invertido: perde em 2 µs → 1 µs já é o buraco nulo, e ele fica fechado até o fim
    const inv = { ...effectOn(sc, 0, 1, { invert: true }) }
    const ri = trackToKeys(inv, input, GEO).region
    for (const t of [1, 2, 3, 4, 5, 6, 500_000]) expect([evalAnim(ri.w, t), evalAnim(ri.h, t), evalAnim(ri.x, t)]).toEqual([0, 0, 0])
    // normal: 1 µs já é a região ampliada, e ela não encolhe depois
    const nor = effectOn(sc, 0, 1)
    const out = trackToKeys(nor, input, GEO)
    const rn = out.region
    expect(evalAnim(rn.w, 1)).toBe(evalAnim(rn.w, 2))
    for (const t of [3, 4, 5, 6]) expect(evalAnim(rn.w, t)).toBeGreaterThanOrEqual(evalAnim(rn.w, 2))
    expect(out.lost).toEqual([{ tUs: 2 }])
    expect(out.samples.map((x) => x.state)).toEqual(['ok', 'lost', 'lost', 'lost'])
  })
  it('redetecção (G4): resolveRedetections promove os candidatos confirmados; sem eles, nada volta (R21)', () => {
    const base = (tUs: number, state: 'ok' | 'lost', extra: Partial<TrackResult> = {}): TrackResult => ({ tUs, x: 120, y: 90, w: 60, h: 40, scale: 1, scaleLo: 1, scaleHi: 1, confidence: state === 'ok' ? 1 : 0, state, reach: state === 'ok' ? 0 : 40, ...extra })
    const cand = (x: number): TrackResult['cand'] => ({ x, y: 90, w: 60, h: 40, scale: 1, scaleLo: 1, scaleHi: 1, confidence: 0.97 })
    const raw = [base(0, 'ok'), base(10, 'lost'), base(20, 'lost', { cand: cand(150) }), base(30, 'lost', { cand: cand(151) }), base(40, 'ok', { x: 152, confirms: 2 }), base(50, 'ok', { x: 153 })]
    const out = resolveRedetections(raw)
    expect(out.map((r) => [r.state, r.x, !!r.reacquired])).toEqual([['ok', 120, false], ['lost', 120, false], ['ok', 150, true], ['ok', 151, false], ['ok', 152, false], ['ok', 153, false]])
    expect(out.some((r) => r.cand !== undefined || r.confirms !== undefined)).toBe(false)
    expect(resolveRedetections(out)).toEqual(out) // idempotente
    // candidato faltando (entrada truncada/alterada): o 'ok' não vira reencontro e trackToKeys o trata como perda
    const broken = resolveRedetections([raw[0], raw[1], raw[2], base(30, 'lost'), raw[4], raw[5]])
    expect(broken.some((r) => r.reacquired)).toBe(false)
    const fx = effectOn({ path: linear, pw: 60, ph: 40 }, 0, 1)
    const k = trackToKeys(fx, [raw[0], raw[1], raw[2], base(30, 'lost'), raw[4], raw[5]], GEO)
    expect(k.samples.map((x) => x.state)).toEqual(['ok', 'lost', 'lost', 'lost', 'lost', 'lost'])
    expect(k.recovered).toEqual([])
    expect(k.lost).toEqual([{ tUs: 10 }])
  })
  it('redetecção (G4): a região segurada do trecho perdido contém o conteúdo onde ele foi reencontrado, até t − 1 (oráculo denso)', () => {
    // perda curta com cobertura pequena (reach 2 px) e reencontro 30 px adiante — a folga do trecho tem de ir até lá
    const sc: Scene = { path: (t) => ({ x: 120 + 900 * t, y: 90 }), pw: 60, ph: 40 }
    const fx = effectOn(sc, 0, 1)
    const fr = (n: number, state: 'ok' | 'lost', reacquired = false): TrackResult => {
      const tUs = Math.round((n * 1e6) / FPS), c = sc.path(tUs / 1e6)
      return state === 'ok'
        ? { tUs, x: c.x, y: c.y, w: 60, h: 40, scale: 1, scaleLo: 1, scaleHi: 1, confidence: 0.99, state, reach: 0, ...(reacquired ? { reacquired: true } : {}) }
        : { tUs, x: sc.path(1 / FPS).x, y: 90, w: 60, h: 40, scale: 1, scaleLo: 1, scaleHi: 1, confidence: 0, state, reach: 2 }
    }
    const input = [fr(0, 'ok'), fr(1, 'ok'), fr(2, 'lost'), fr(3, 'ok', true), fr(4, 'ok'), fr(5, 'ok')]
    const out = trackToKeys(fx, input, GEO)
    expect(out.recovered).toEqual([{ fromUs: input[2].tUs, toUs: input[3].tUs }])
    expect(out.lost).toEqual([])
    const fx1 = { ...fx, region: out.region }
    // de 2/30 s a 3/30 s (inclusive t − 1): a região ⊇ o conteúdo reencontrado em 3/30 s e a do 1º perdido
    const t2 = input[2].tUs, t3 = input[3].tUs
    for (const t of [t2, t2 + 1, Math.round((t2 + t3) / 2), t3 - 2, t3 - 1]) {
      const v = region(fx1, t)
      for (const ref of [input[3], input[2]]) {
        for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) expect(inside(v, 'rect', (ref.x + (cx * 60) / 2) * (CW / AW), (ref.y + (cy * 40) / 2) * (CH / AH)), `t=${t}`).toBe(true)
      }
    }
    // a partir do reencontro, a região do quadro confiante (justa: encolhe só aí)
    expect(region(fx1, t3).w).toBeLessThan(region(fx1, t3 - 1).w)
  })
  it('"Continuar rastreamento" (G4, mescla pura, redetecção ligada): keys antes do playhead idênticos, depois só os da nova passada, sem tUs repetido', () => {
    const sc: Scene = { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }
    for (const invert of [false, true]) {
      // 1ª passada com as opções padrão (redetecção ligada): a oclusão passa de 1 s → perda até o fim
      const first = run(sc, 0, 2, { invert })
      expect(first.lost).toHaveLength(1)
      // o usuário reposiciona a região no playhead (edição normal) e continua dali, também com as opções padrão
      const t2 = 1.75, a = usOf(t2), c = sc.path(t2)
      const r1 = first.fx1.region
      const user: EffectItem = { ...first.fx1, region: { ...r1, x: setValue(r1.x, a, c.x / AW), y: setValue(r1.y, a, c.y / AH), w: setValue(r1.w, a, sc.pw / AW), h: setValue(r1.h, a, sc.ph / AH) } }
      const res2 = trackFrames(frames(sc, t2, 2), boxAt(sc, t2))
      // a mesma passada num efeito sem keys com a região ajustada (só os keys novos)
      const fresh = trackToKeys({ ...user, region: { ...user.region, x: { value: c.x / AW }, y: { value: c.y / AH }, w: { value: sc.pw / AW }, h: { value: sc.ph / AH } } }, res2, GEO).region
      const out = trackToKeys(user, res2, GEO).region
      for (const ch of ['x', 'y', 'w', 'h'] as const) {
        const keys = out[ch].keys!
        // antes do playhead (até a − 2): exatamente os keys de antes (objetos iguais, mesma ordem)
        expect(JSON.stringify(keys.filter((k) => k.tUs < a - 1)), ch).toBe(JSON.stringify(user.region[ch].keys!.filter((k) => k.tUs < a - 1)))
        // do playhead em diante: só os da nova passada
        expect(keys.filter((k) => k.tUs >= a), ch).toEqual(fresh[ch].keys!.filter((k) => k.tUs >= a))
        expect(keys.filter((k) => k.tUs >= a)[0].tUs, ch).toBe(a)
        // entre a − 1 e a nada além do key de fronteira; tUs estritamente crescente
        expect(keys.filter((k) => k.tUs > a - 1 && k.tUs < a), ch).toEqual([])
        for (let i = 1; i < keys.length; i++) expect(keys[i].tUs, ch).toBeGreaterThan(keys[i - 1].tUs)
      }
    }
  })
  it('formato do toast da perda', () => {
    expect(formatTrackTime(2_216_667)).toBe('00:02,2')
    expect(formatTrackTime(83_950_000)).toBe('01:23,9')
    expect(lossMessage({ tUs: 2_216_667 }, false)).toBe('Rastreamento perdido em 00:02,2 — a região foi ampliada até o fim; reposicione e use “Seguir conteúdo” de novo a partir daí')
    expect(lossMessage({ tUs: 2_216_667 }, true)).toBe('Rastreamento perdido em 00:02,2 — o buraco foi fechado até o fim; reposicione e use “Seguir conteúdo” de novo a partir daí')
  })
})

describe('oráculo de privacidade (denso, 1/240 s)', () => {
  const scenes: [string, Scene, number, number][] = [
    ['linear', { path: linear, pw: 60, ph: 40 }, 0, 2],
    ['acelerando', { path: accelerating, pw: 60, ph: 40 }, 0, 2],
    ['zigue-zague', { path: zigzag, pw: 60, ph: 40 }, 0, 2],
    ['rolagem com parada', { path: scroll, pw: 70, ph: 30 }, 0, 1.6],
    ['oclusão → perda', { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }, 0, 2],
    ['corte de cena → perda', { path: linear, pw: 60, ph: 40, cutAt: 1 }, 0, 1.6]
  ]
  for (const [name, sc, t0, t1] of scenes) {
    it(`${name}: conteúdo ⊆ região (normal)`, () => {
      const { fx0, fx1 } = run(sc, t0, t1)
      expect(oracle(sc, fx0, fx1, t0, t1)).toEqual([])
    })
    it(`${name}: buraco ⊆ conteúdo ou NO_HOLE (invertido)`, () => {
      const { fx0, fx1 } = run(sc, t0, t1, { invert: true })
      expect(oracle(sc, fx0, fx1, t0, t1)).toEqual([])
    })
  }
  it('controle: sem a folga (só o centro transportado nos quadros) o oráculo acusa (ele tem dentes)', () => {
    const sc: Scene = { path: zigzag, pw: 60, ph: 40 }
    const fx0 = effectOn(sc, 0, 1.5)
    const res = trackFrames(frames(sc, 0, 1.5), boxAt(sc, 0))
    const key = (c: 'x' | 'y'): Anim<number> => ({ value: 0, keys: res.map((r) => ({ tUs: r.tUs, value: (c === 'x' ? r.x / AW : r.y / AH), ease: 'linear' as const })) })
    const bare = { ...fx0, region: { ...fx0.region, x: key('x'), y: key('y') } }
    expect(oracle(sc, fx0, bare, 0, 1.5).length).toBeGreaterThan(0)
    const hole = { ...bare, invert: true }
    expect(oracle(sc, { ...fx0, invert: true }, hole, 0, 1.5).length).toBeGreaterThan(0)
  })
  it('escala sempre estimada (R20): conteúdo que cresce e encolhe 10 % fica coberto (opções padrão)', () => {
    const sc: Scene = { path: (t) => ({ x: 220 + 40 * t, y: 130 }), pw: 60, ph: 40, zoom: (t) => 1 + 0.1 * Math.sin(t * 3) }
    for (const invert of [false, true]) {
      const fx0 = effectOn(sc, 0, 2, { invert })
      const results = trackFrames(frames(sc, 0, 2), boxAt(sc, 0))
      // a escala acompanha o zoom
      expect(Math.max(...results.map((r) => r.scale))).toBeGreaterThan(1.05)
      expect(Math.min(...results.map((r) => r.scale))).toBeLessThan(0.95)
      const fx1 = { ...fx0, region: trackToKeys(fx0, results, GEO).region }
      expect(oracle(sc, fx0, fx1, 0, 2)).toEqual([])
    }
  })
  it('elipse e retângulo girado', () => {
    const sc: Scene = { path: zigzag, pw: 60, ph: 40 }
    for (const opts of [{ shape: 'ellipse' as const }, { rotation: 25 }, { shape: 'ellipse' as const, rotation: -40 }]) {
      for (const invert of [false, true]) {
        const { fx0, fx1 } = run(sc, 0, 1.5, { ...opts, invert })
        expect(oracle(sc, fx0, fx1, 0, 1.5)).toEqual([])
      }
    }
  })
  it('começando no meio do efeito (playhead): conteúdo coberto do playhead ao fim', () => {
    const sc: Scene = { path: linear, pw: 60, ph: 40 }
    const fx0 = { ...effectOn(sc, 0.4, 2), startUs: 0 }
    // região do usuário no playhead 0,4 s (sem keys) = caixa do conteúdo em 0,4 s
    const res = trackFrames(frames(sc, 0.4, 2), boxAt(sc, 0.4))
    const fx1 = { ...fx0, region: trackToKeys(fx0, res, GEO).region }
    expect(oracle(sc, fx0, fx1, 0.4, 2)).toEqual([])
  })
})

// ---------------------------------------------------------------- integração com o projeto

const asset: Asset = { id: 'a1', name: 'tela.mp4', kind: 'video', source: { type: 'file', path: 'x.mp4', size: 1, mtimeMs: 0 }, durationUs: 10_000_000, video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 0, decodable: true, gopUs: 1e6 }, status: 'ready' }

function project(fx: EffectItem, opts: { link?: boolean; locked?: boolean; above?: boolean } = {}): Project {
  const clip = { ...createMediaItem(asset, 0, 'video'), id: 'clip', durationUs: 4_000_000, ...(opts.link ? { linkId: 'L' } : {}) }
  const text = { id: 'txt', type: 'text' as const, startUs: 0, durationUs: 4_000_000, text: 'oi', style: { font: 'Manrope', size: { value: 40 }, weight: 600, color: '#fff', align: 'center' as const, lineHeight: 1.2 }, visual: clip.visual! }
  return {
    ...createEmptyProject('T', { width: CW, height: CH, fps: FPS, background: '#000' }),
    assets: [asset],
    tracks: [
      { id: 'tv', kind: 'video', name: 'Vídeo', muted: false, hidden: false, locked: false, volume: 1, items: [clip] },
      { id: 'tfx', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: !!opts.locked, volume: 1, items: [{ ...fx, ...(opts.link ? { linkId: 'L' } : {}) }] },
      ...(opts.above ? [{ id: 'tt', kind: 'video' as const, name: 'Texto', muted: false, hidden: false, locked: false, volume: 1, items: [text] }] : [])
    ]
  }
}

describe('aplicar o rastreamento no projeto', () => {
  const sc: Scene = { path: linear, pw: 60, ph: 40 }
  const fx0 = { ...effectOn(sc, 0, 2), durationUs: 2_000_000 }
  const tracked = (): EffectRegion => trackToKeys(fx0, trackFrames(frames(sc, 0, 2), boxAt(sc, 0)), GEO).region

  it('um passo puro: só a região muda; vínculo, escopo, alvo e tempo ficam; disco v1.3 e ida e volta', () => {
    for (const scope of ['below', 'track'] as const) {
      const p = project({ ...fx0, scope, ...(scope === 'track' ? { targetTrackId: 'tv' } : {}) }, { link: true })
      const r = tracked()
      const q = applyTrackedRegion(p, 'fx', r)
      const before = findItem(p, 'fx')!.item as EffectItem
      const after = findItem(q, 'fx')!.item as EffectItem
      expect(after.region).toEqual(r)
      expect({ ...after, region: null }).toEqual({ ...before, region: null })
      expect(validateProject(q)).toEqual([])
      expect(parseProjectV13(JSON.parse(JSON.stringify(toDiskProject(q)))).success).toBe(true)
      expect(parseProject(JSON.parse(JSON.stringify(toDiskProject(q))))).toEqual(q)
      // seguidor: mover o clipe leva o efeito junto e a região continua sobre o mesmo conteúdo (keys locais)
      const moved = moveItems(q, ['clip'], 500_000)
      const m = findItem(moved, 'fx')!.item as EffectItem
      expect(m.startUs).toBe(500_000)
      expect(m.region).toEqual(after.region)
      // escopo `track`: o efeito continua agindo sobre a faixa do clipe
      const layers = resolveFrame(moved, 1_000_000)
      const fxl = layers.find((l) => l.kind === 'effect')!
      if (scope === 'track') expect(fxl.kind === 'effect' && fxl.targetTrackId).toBe('tv')
    }
  })

  it('ancorado → EditError pt-BR; faixa bloqueada → EditError; o motivo aparece para a interface', () => {
    const attached = project({ ...fx0, attach: { mediaItemId: 'clip' } }, { link: true })
    expect(trackingBlocker(attached, 'fx')).toBe(TRACK_ATTACHED_MESSAGE)
    expect(TRACK_ATTACHED_MESSAGE).toBe('O efeito já está ancorado ao clipe; desancore para seguir o conteúdo')
    expect(() => applyTrackedRegion(attached, 'fx', tracked())).toThrow(TRACK_ATTACHED_MESSAGE)
    const locked = project(fx0, { locked: true })
    expect(trackingBlocker(locked, 'fx')).toMatch(/bloqueada/)
    expect(() => applyTrackedRegion(locked, 'fx', tracked())).toThrow(EditError)
    expect(trackingBlocker(project(fx0), 'fx')).toBeNull()
    // desativado continua permitido (só keys); o projeto de análise o liga
    const off = project({ ...fx0, enabled: false })
    expect(trackingBlocker(off, 'fx')).toBeNull()
    const ana = trackingProject(off, 'fx')
    expect((findItem(ana, 'fx')!.item as EffectItem).enabled).not.toBe(false)
  })

  it('faixa oculta: a análise mostra só o efeito, não os outros itens dela (M2)', () => {
    const p = project(fx0)
    const other = { ...createEffectItem('blur', 2_100_000, 500_000), id: 'outro' }
    const hidden: Project = { ...p, tracks: p.tracks.map((t) => (t.id === 'tfx' ? { ...t, hidden: true, items: [...t.items, other] } : t)) }
    const ana = trackingProject(hidden, 'fx')
    const t = ana.tracks.find((x) => x.id === 'tfx')!
    expect(t.hidden).toBe(false)
    expect(t.items.map((i) => i.id)).toEqual(['fx'])
    // as outras faixas ficam como estavam
    expect(ana.tracks.find((x) => x.id === 'tv')).toBe(hidden.tracks.find((x) => x.id === 'tv'))
  })

  it('v1.3 e ida e volta com perda: invertido (keys de NO_HOLE, zeros) e normal (região ampliada, w > 1) (M6)', () => {
    const occ: Scene = { path: occludedPath, pw: 60, ph: 40, occluder: OCCLUDER }
    for (const invert of [true, false]) {
      const fx = { ...effectOn(occ, 0, 2, { invert }), durationUs: 2_000_000 }
      const res = trackFrames(frames(occ, 0, 2), boxAt(occ, 0))
      const out = trackToKeys(fx, res, GEO)
      expect(out.lost.length).toBeGreaterThan(0)
      if (invert) expect(out.region.w.keys!.some((k) => k.value === 0)).toBe(true)
      else expect(out.region.w.keys!.some((k) => k.value > 1)).toBe(true)
      const q = applyTrackedRegion(project(fx), 'fx', out.region)
      expect(validateProject(q)).toEqual([])
      const disk = JSON.parse(JSON.stringify(toDiskProject(q)))
      expect(parseProjectV13(disk).success).toBe(true)
      expect(parseProject(disk)).toEqual(q)
    }
  })

  it('quadros de análise: só as camadas ABAIXO do efeito (ele e o que está acima ficam de fora; escopo track)', () => {
    const below = project(fx0, { above: true })
    const ids = (ls: Layer[]): string[] => ls.map((l) => ('itemId' in l ? l.itemId : '?'))
    expect(ids(layersBelowEffect(resolveFrame(below, 1_000_000), 'fx'))).toEqual(['clip'])
    const tr = project({ ...fx0, scope: 'track', targetTrackId: 'tv' }, { above: true })
    expect(ids(layersBelowEffect(resolveFrame(tr, 1_000_000), 'fx'))).toEqual(['clip'])
  })

  it('tamanho da análise e molde: lado maior ≤ 480 (sobe até 960 se o molde ficaria < 16 px)', () => {
    expect(analysisSize(1920, 1080, { w: 400, h: 200 })).toEqual({ width: 480, height: 270 })
    expect(analysisSize(1920, 1080, { w: 120, h: 40 })).toEqual({ width: 960, height: 540 })
    const fx = { ...fx0, region: { ...fx0.region, x: { value: 0.5 }, y: { value: 0.5 }, w: { value: 0.25 }, h: { value: 0.1 }, rotation: { value: 0 } } }
    expect(templateBox(fx, 0, GEO)).toEqual({ x: 240, y: 135, w: 120, h: 27 })
  })

  it('instantes: o playhead e depois a grade do projeto até o fim (exclusivo)', () => {
    expect(trackFrameTimes(50_000, 200_000, 30)).toEqual([50_000, 66_667, 100_000, 133_333, 166_667])
  })

  it('cinza de RGBA (BT.601)', () => {
    const g = grayFromRgba(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 10, 10, 255]), 2, 2)
    const want = [0.299 * 255, 0.587 * 255, 0.114 * 255, 10]
    want.forEach((v, i) => expect(g.data[i]).toBeCloseTo(v, 3))
  })
})

