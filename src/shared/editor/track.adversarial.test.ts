import { describe, expect, it } from 'vitest'
import { evalAnim } from './anim'
import { createEffectItem } from './factory'
import type { EffectItem, Us } from './project'
import { trackFrames, trackFrameTimes, trackToKeys, type GrayImage, type TrackResult } from './track'

// Oráculo de privacidade ADVERSARIAL do "Seguir conteúdo" (revisão da Task 5, rulings R19/R20): conteúdo repetido e
// parecido (linhas de tabela rolando), cópia idêntica do valor em outro lugar, oclusão parcial de uma linha, região
// folgada sobre fundo estático de alto contraste e zoom lento de 2–4 % — normal e invertido. Denso (1/240 s):
// normal → a caixa do CONTEÚDO ⊆ região avaliada em todo instante (esteja ele visível ou escondido pela oclusão);
// invertido → o buraco ⊆ região do usuário levada pelo movimento real do conteúdo, ou buraco nulo.

const AW = 480
const AH = 270
const CW = 1920
const CH = 1080
const FPS = 30
const GEO = { analysisW: AW, analysisH: AH, canvasW: CW, canvasH: CH }
const usOf = (t: number): Us => Math.round(t * 1e6)

type Tex = (u: number, v: number) => number
function waves(seed: number, n: number, fmin: number, fmax: number, amp: number): Tex {
  let s = seed * 9301 + 49297
  const rnd = (): number => ((s = (s * 9301 + 49297) % 233280) / 233280)
  const ws = Array.from({ length: n }, () => ({ fx: (fmin + rnd() * (fmax - fmin)) * (rnd() < 0.5 ? -1 : 1), fy: (fmin + rnd() * (fmax - fmin)) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * 6.28, a: amp * (0.6 + 0.8 * rnd()) }))
  return (u, v) => ws.reduce((acc, w) => acc + w.a * Math.sin(w.fx * u + w.fy * v + w.ph), 0)
}
const SHARED = waves(11, 6, 0.3, 0.9, 14)
/** Linha "de tabela": parte comum a todas (o rótulo) + parte própria (os dígitos), parecidas mas distintas (ownAmp menor = mais parecidas). */
const row = (k: number, ownAmp = 9): Tex => {
  const own = waves(100 + k, 6, 0.3, 0.9, ownAmp)
  return (u, v) => 150 + SHARED(u, v) + own(u, v)
}
const TEXT = ((): Tex => { const w = waves(3, 6, 0.2, 0.7, 20); return (u, v) => 140 + w(u, v) })()

interface Box { x0: number; y0: number; x1: number; y1: number }
interface Obj { path: (t: number) => { x: number; y: number }; pw: number; ph: number; tex: Tex; zoom?: (t: number) => number; on?: (t: number) => boolean }
interface Adv {
  bg: Float32Array
  target: Obj
  others?: Obj[]
  /** Oclusores (opacos, cinza 90) no instante t. */
  occl?: (t: number) => Box[]
  /** Região do usuário maior que o conteúdo (px da análise), centrada nele; ausente = justa. */
  region?: { w: number; h: number }
}

const flatBg = (v: number): Float32Array => new Float32Array(AW * AH).fill(v)
const softBg = ((): Float32Array => {
  const f = waves(7, 6, 0.1, 0.5, 10)
  const d = new Float32Array(AW * AH)
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) d[y * AW + x] = 60 + f(x + 0.5, y + 0.5)
  return d
})()
/** Fundo estático de alto contraste (blocos 6×6 claro/escuro). */
const blocksBg = ((): Float32Array => {
  const d = new Float32Array(AW * AH)
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    const h = Math.sin(Math.floor(x / 6) * 12.9898 + Math.floor(y / 6) * 78.233) * 43758.5453
    d[y * AW + x] = h - Math.floor(h) < 0.5 ? 30 : 220
  }
  return d
})()

function draw(d: Float32Array, o: Obj, t: number): void {
  if (o.on && !o.on(t)) return
  const c = o.path(t), z = o.zoom?.(t) ?? 1
  const pw = o.pw * z, ph = o.ph * z, x0 = c.x - pw / 2, y0 = c.y - ph / 2
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(AH, Math.ceil(y0 + ph)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(AW, Math.ceil(x0 + pw)); x++) {
      const px = x + 0.5, py = y + 0.5
      if (px < x0 || px >= x0 + pw || py < y0 || py >= y0 + ph) continue
      d[y * AW + x] = o.tex((px - x0) / z, (py - y0) / z)
    }
  }
}

function render(sc: Adv, t: number): GrayImage {
  const data = new Float32Array(sc.bg)
  for (const o of sc.others ?? []) draw(data, o, t)
  draw(data, sc.target, t)
  for (const b of sc.occl?.(t) ?? []) {
    for (let y = Math.max(0, Math.floor(b.y0)); y < Math.min(AH, Math.ceil(b.y1)); y++) for (let x = Math.max(0, Math.floor(b.x0)); x < Math.min(AW, Math.ceil(b.x1)); x++) data[y * AW + x] = 90
  }
  return { width: AW, height: AH, data }
}

const userBox = (sc: Adv, t0: number): { x: number; y: number; w: number; h: number } => {
  const c = sc.target.path(t0), z = sc.target.zoom?.(t0) ?? 1
  return { ...c, w: sc.region?.w ?? sc.target.pw * z, h: sc.region?.h ?? sc.target.ph * z }
}

type V = { x: number; y: number; w: number; h: number }
const at = (fx: EffectItem, local: Us): V => ({ x: evalAnim(fx.region.x, local), y: evalAnim(fx.region.y, local), w: evalAnim(fx.region.w, local), h: evalAnim(fx.region.h, local) })
const insideRect = (r: V, px: number, py: number): boolean => Math.abs(px - r.x * CW) <= (Math.abs(r.w) * CW) / 2 + 1e-6 && Math.abs(py - r.y * CH) <= (Math.abs(r.h) * CH) / 2 + 1e-6
const corners = (r: V): [number, number][] => {
  const hx = (Math.abs(r.w) * CW) / 2, hy = (Math.abs(r.h) * CH) / 2
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [r.x * CW + a * hx, r.y * CH + b * hy])
}

function oracle(sc: Adv, fx0: EffectItem, fx1: EffectItem, t0: number, t1: number): { fails: number; worst: string } {
  let fails = 0, worst = '', worstPx = 0
  const z0 = sc.target.zoom?.(t0) ?? 1
  const R0 = at(fx0, usOf(t0))
  const p0 = sc.target.path(t0)
  for (let k = 0; ; k++) {
    const t = t0 + k / 240
    if (t >= t1) break
    const r = at(fx1, usOf(t) - fx1.startUs)
    const c = sc.target.path(t), z = sc.target.zoom?.(t) ?? 1
    if (!fx0.invert) {
      // a caixa do conteúdo (não a região do usuário) tem de estar coberta
      const box: V = { x: c.x / AW, y: c.y / AH, w: (sc.target.pw * z) / AW, h: (sc.target.ph * z) / AH }
      const out = corners(box).map(([x, y]) => Math.max(Math.abs(x - r.x * CW) - (Math.abs(r.w) * CW) / 2, Math.abs(y - r.y * CH) - (Math.abs(r.h) * CH) / 2))
      const ex = Math.max(...out)
      if (ex > 1e-6) {
        fails++
        if (ex > worstPx) { worstPx = ex; worst = `t=${t.toFixed(3)} conteúdo ${ex.toFixed(1)} px fora` }
      }
    } else if (Math.abs(r.w) > 0 && Math.abs(r.h) > 0) {
      const truth: V = { x: R0.x + (c.x - p0.x) / AW, y: R0.y + (c.y - p0.y) / AH, w: (R0.w * z) / z0, h: (R0.h * z) / z0 }
      const bad = corners(r).find(([x, y]) => !insideRect(truth, x, y))
      if (bad) {
        fails++
        if (!worst) worst = `t=${t.toFixed(3)} buraco fora da região levada pelo conteúdo`
      }
    }
  }
  return { fails, worst }
}

function run(sc: Adv, t0: number, t1: number, invert: boolean): { fails: number; worst: string; results: TrackResult[] } {
  const b = userBox(sc, t0)
  const fx0: EffectItem = { ...createEffectItem('blurText', 0, usOf(t1), { x: b.x / AW, y: b.y / AH, w: b.w / AW, h: b.h / AH }), id: 'fx', invert }
  const frames = trackFrameTimes(usOf(t0), usOf(t1), FPS).map((tUs) => ({ tUs, img: render(sc, tUs / 1e6) }))
  const results = trackFrames(frames, b)
  const fx1 = { ...fx0, region: trackToKeys(fx0, results, GEO).region }
  return { ...oracle(sc, fx0, fx1, t0, t1), results }
}

// ---------------------------------------------------------------- cenas (sementes: as da revisão)

const COPY: Adv = { bg: flatBg(40), target: { path: () => ({ x: 200, y: 100 }), pw: 60, ph: 20, tex: TEXT }, others: [{ path: () => ({ x: 200, y: 200 }), pw: 60, ph: 20, tex: TEXT }], occl: (t) => (t >= 0.4 && t < 0.8 ? [{ x0: 160, y0: 80, x1: 240, y1: 120 }] : []) }
const LOOSE: Adv = { bg: blocksBg, target: { path: (t) => ({ x: 150 + 40 * t, y: 130 }), pw: 60, ph: 20, tex: TEXT }, region: { w: 100, h: 50 } }
const ZOOM: Adv = { bg: softBg, target: { path: () => ({ x: 240, y: 135 }), pw: 120, ph: 30, tex: TEXT, zoom: (t) => 1 + 0.04 * Math.sin(t * Math.PI) } }

const ROW_W = 100
/** Linhas de altura h a cada `gap` px (as finas, 16/22, são as da revisão; as altas, 40/46, deixam o buraco do invertido aberto). */
const table = (y0: (t: number) => number, h = 16, gap = 22, n = 10, ownAmp = 9): Obj[] => Array.from({ length: n }, (_, k) => ({ path: (t: number) => ({ x: 240, y: y0(t) + gap * k }), pw: ROW_W, ph: h, tex: row(k, ownAmp) }))
const withTarget = (rows: Obj[], k: number): { target: Obj; others: Obj[] } => ({ target: rows[k], others: rows.filter((_, i) => i !== k) })

// [nome, cena normal, cena invertida (a mesma, com linhas altas quando a fina fecharia o buraco de qualquer jeito), t0, t1]
const SCENES: [string, Adv, Adv, number, number][] = [
  // tabela de linhas parecidas rolando para cima; a linha-alvo passa por baixo de um cabeçalho fixo e sai acima dele
  ['linhas parecidas rolando (cabeçalho fixo)', { bg: flatBg(40), ...withTarget(table((t) => 100 - 40 * t), 4), occl: () => [{ x0: 150, y0: 120, x1: 330, y1: 150 }] }, { bg: flatBg(40), ...withTarget(table((t) => 60 - 40 * t, 40, 46, 6), 3), occl: () => [{ x0: 150, y0: 110, x1: 330, y1: 160 }] }, 0, 2],
  // cópia idêntica do valor 100 px abaixo; o alvo fica coberto de 0,4 s a 0,8 s
  ['cópia idêntica em outro lugar', COPY, COPY, 0, 1.6],
  // tabela parada; a linha-alvo fica coberta menos os 4 px de baixo de 0,5 s a 1,2 s
  ['oclusão parcial de uma linha', { bg: flatBg(40), ...withTarget(table(() => 40), 4), occl: (t) => (t >= 0.5 && t < 1.2 ? [{ x0: 170, y0: 40 + 4 * 22 - 10, x1: 310, y1: 40 + 4 * 22 + 4 }] : []) }, { bg: flatBg(40), ...withTarget(table(() => 30, 40, 46, 5, 5), 2), occl: (t) => (t >= 0.5 && t < 1.2 ? [{ x0: 170, y0: 30 + 2 * 46 - 30, x1: 310, y1: 30 + 2 * 46 + 16 }] : []) }, 0, 1.6],
  // região folgada (100×50) sobre um conteúdo de 60×20 que anda, fundo parado de alto contraste
  ['região folgada sobre fundo de alto contraste', LOOSE, LOOSE, 0, 2],
  // zoom lento de 2–4 % para dentro e para fora (opções padrão)
  ['zoom lento de 2–4 % (entrando e saindo)', ZOOM, ZOOM, 0, 2]
]

describe('oráculo adversarial (R19/R20)', () => {
  for (const [name, normal, inverted, t0, t1] of SCENES) {
    for (const invert of [false, true]) {
      it(`${name}${invert ? ' — invertido' : ''}`, () => {
        const r = run(invert ? inverted : normal, t0, t1, invert)
        expect(r.fails, `${r.worst} | estados ${r.results.map((x) => x.state[0]).join('')}`).toBe(0)
      })
    }
  }
})

// ---------------------------------------------------------------- R21: cópia idêntica e recuperação (re-revisão)

// alvo 60×20 parado em (200, 100) coberto a partir de 0,4 s; uma cópia idêntica aparece a 30 px enquanto ele está
// escondido (sementes: /tmp/rerev5/probe.ts da re-revisão)
const TGT: Obj = { path: () => ({ x: 200, y: 100 }), pw: 60, ph: 20, tex: TEXT }
// B: a faixa sobe de 1,2 s a 1,6 s revelando o alvo aos poucos (de baixo para cima); a cópia fica
const REVEAL: Adv = {
  bg: flatBg(40), target: TGT,
  others: [{ path: () => ({ x: 200, y: 130 }), pw: 60, ph: 20, tex: TEXT, on: (t) => t >= 0.45 && t < 1.8 }],
  occl: (t) => (t >= 0.4 && t < 1.2 ? [{ x0: 160, y0: 70, x1: 240, y1: 115 }] : t >= 1.2 && t < 1.6 ? [{ x0: 160, y0: 70, x1: 240, y1: 110 - 50 * (t - 1.2) }] : [])
}
// C: a cópia ("fantasma de arrasto") se afasta depois de 1 s; o alvo reaparece longe dela em 1,6 s
const DRAG: Adv = {
  bg: flatBg(40), target: TGT,
  others: [{ path: (t) => ({ x: 200 + (t > 1 ? 150 * (t - 1) : 0), y: 130 + (t > 1 ? 60 * (t - 1) : 0) }), pw: 60, ph: 20, tex: TEXT, on: (t) => t >= 0.45 }],
  occl: (t) => (t >= 0.4 && t < 1.6 ? [{ x0: 160, y0: 80, x1: 240, y1: 120 }] : [])
}
// sem perda antes: uma cópia idêntica DENTRO do portão de movimento (5 px ao lado, por baixo do alvo) e o alvo coberto
// aos poucos de cima para baixo a partir de 0,5 s — a região nunca sai do alvo, ou o rastreamento se perde
const NEAR: Adv = {
  bg: flatBg(40), target: TGT,
  others: [{ path: () => ({ x: 205, y: 100 }), pw: 60, ph: 20, tex: TEXT, on: (t) => t >= 0.3 }],
  occl: (t) => (t >= 0.5 ? [{ x0: 150, y0: 85, x1: 250, y1: Math.min(115, 90 + 25 * (t - 0.5)) }] : [])
}

describe('oráculo adversarial (R21: sem recuperação automática)', () => {
  const cases: [string, Adv, number][] = [
    ['cópia idêntica parada, alvo revelado aos poucos', REVEAL, 1.9],
    ['cópia idêntica que se afasta (fantasma de arrasto)', DRAG, 2],
    ['sem perda antes: cópia dentro do portão, alvo coberto aos poucos', NEAR, 1.6]
  ]
  for (const [name, sc, t1] of cases) {
    for (const invert of [false, true]) {
      it(`${name}${invert ? ' — invertido' : ''}`, () => {
        const r = run(sc, 0, t1, invert)
        expect(r.fails, `${r.worst} | estados ${r.results.map((x) => x.state[0]).join('')}`).toBe(0)
      })
    }
  }
})
