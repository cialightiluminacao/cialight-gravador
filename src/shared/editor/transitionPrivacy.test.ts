// Invariante 2 (privacidade) nas transições: teste denso (1/240 s) com oráculo = o resolve SEM a transição.
import { describe, expect, it } from 'vitest'
import type { Anim, EffectItem, Item, MediaItem, Project, TransitionKind } from './project'
import { privacyWarnings } from './privacy'
import { resolveFrame, type EffectLayer, type Layer, type MediaLayer, type TransitionLayer } from './resolve'
import { pairActive, transitionWindows } from './transitions'
import { S, fx, img, project, textClip, tr, track, vclip, vid, withoutTransitions } from './__fixtures__/transitionScenes'

const KINDS: TransitionKind[] = ['crossfade', 'dipBlack', 'dipWhite', 'slideL', 'slideR', 'slideU', 'slideD', 'wipeL', 'wipeR', 'zoomIn', 'blur']
const ramp = (a: number, b: number, dur: number): Anim<number> => ({ value: a, keys: [{ tUs: 0, value: a, ease: 'linear' }, { tUs: dur, value: b, ease: 'linear' }] })

interface SceneOpts { kind?: TransitionKind; d?: number; a?: Partial<MediaItem>; b?: Partial<MediaItem>; fx?: Item[]; fx2?: Item[]; v1?: Item[] }
/** V1: A [0, 4 s) fonte a desde 2 s (linkId LA) → B [4 s, 8 s) fonte b desde 3 s (linkId LB); FX e FX2 acima. */
function scene(o: SceneOpts = {}): Project {
  const v1 = o.v1 ?? [
    vclip('A', 'a', 0, 4 * S, { inUs: 2 * S, linkId: 'LA', ...o.a }),
    vclip('B', 'b', 4 * S, 4 * S, { inUs: 3 * S, linkId: 'LB', ...o.b, transitionIn: tr(o.kind ?? 'crossfade', o.d ?? S) })
  ]
  return project([track('V1', 'video', v1), track('FX', 'video', o.fx ?? []), track('FX2', 'video', o.fx2 ?? [])], [vid('a'), vid('b'), img('im')])
}

const cases: [string, () => Project][] = [
  ['below vinculado a A (linkId)', () => scene({ fx: [fx('f', 'blur', S, 3 * S, { linkId: 'LA' })] })],
  ['ancorado (attach) em A com zoom', () => scene({ a: { visual: { ...vclip('x', 'a', 0, 1).visual!, transform: { ...vclip('x', 'a', 0, 1).visual!.transform, scale: ramp(1, 2, 4 * S) } } }, fx: [fx('f', 'solid', 0, 4 * S, { attach: { mediaItemId: 'A' }, region: { shape: 'rect', x: { value: 0.3 }, y: { value: 0.4 }, w: { value: 0.2 }, h: { value: 0.2 }, rotation: { value: 0 } } })] })],
  ['ancorado em B com pan', () => scene({ b: { visual: { ...vclip('x', 'a', 0, 1).visual!, transform: { ...vclip('x', 'a', 0, 1).visual!.transform, x: ramp(0.5, 0.7, 4 * S) } } }, fx: [fx('f', 'pixelate', 4 * S, 4 * S, { attach: { mediaItemId: 'B' } })] })],
  ['invertido vinculado a A', () => scene({ fx: [fx('f', 'blurAllExcept', 0, 4 * S, { linkId: 'LA' })] })],
  ["scope 'track' na faixa de A", () => scene({ fx: [fx('f', 'pixelate', 2 * S, 2 * S, { scope: 'track', targetTrackId: 'V1' })] })],
  ['efeito termina exatamente no corte', () => scene({ fx: [fx('f', 'solid', 3 * S, S)] })],
  ['tarja sólida em B começando no corte', () => scene({ fx: [fx('f', 'solid', 4 * S, 2 * S)] })],
  ['A com animOut e B com animIn (ancorados nos dois)', () => scene({
    a: { visual: { ...vclip('x', 'a', 0, 1).visual!, animOut: { preset: 'slideL', durationUs: S } } },
    b: { visual: { ...vclip('x', 'a', 0, 1).visual!, animIn: { preset: 'zoom', durationUs: S } } },
    fx: [fx('f', 'blur', 0, 4 * S, { attach: { mediaItemId: 'A' } })], fx2: [fx('g', 'solid', 4 * S, 4 * S, { attach: { mediaItemId: 'B' } })]
  })],
  ['A imagem e B texto', () => scene({ v1: [vclip('A', 'im', 0, 4 * S), textClip('B', 4 * S, 4 * S, { transitionIn: tr('slideU', S) })], fx: [fx('f', 'blur', 0, 8 * S)] })],
  ['A reverso a 2×, B congelado, d ímpar', () => scene({ d: 1_000_001, a: { reverse: true, speed: 2 }, b: { freeze: { atUs: 5 * S } }, fx: [fx('f', 'solid', 2 * S, 2 * S, { linkId: 'LA' })], fx2: [fx('g', 'blur', 4 * S, 2 * S, { linkId: 'LB' })] })],
  ['A em câmera lenta (0,5×) e B com corte', () => scene({ a: { speed: 0.5 }, fx: [fx('f', 'solid', 3 * S, 2 * S)] })],
  ['cadeia A → B → C com duas transições', () => scene({ v1: [
    vclip('A', 'a', 0, 4 * S, { inUs: 2 * S, linkId: 'LA' }),
    vclip('B', 'b', 4 * S, 4 * S, { inUs: 3 * S, linkId: 'LB', transitionIn: tr('wipeL', 2 * S) }),
    vclip('C', 'a', 8 * S, 4 * S, { inUs: 9 * S, linkId: 'LC', transitionIn: tr('dipBlack', S) })
  ], fx: [fx('f', 'blur', 0, 4 * S, { linkId: 'LA' }), fx('g', 'solid', 4 * S, 4 * S, { linkId: 'LB' }), fx('h', 'pixelate', 8 * S, 4 * S, { attach: { mediaItemId: 'C' } })] })],
  ...KINDS.map((k): [string, () => Project] => [`kind ${k}: vinculado a A + ancorado em B`, () => scene({ kind: k, fx: [fx('f', 'blur', 2 * S, 2 * S, { linkId: 'LA' })], fx2: [fx('g', 'solid', 4 * S, S, { attach: { mediaItemId: 'B' } })] })])
]

/** Trecho aparado da fonte: [lo, hi) (congelado: só o atUs). */
function trimmed(m: MediaItem): { lo: number; hi: number } {
  if (m.freeze) return { lo: m.freeze.atUs, hi: m.freeze.atUs + 1 }
  return { lo: m.inUs, hi: m.inUs + m.durationUs * m.speed }
}
const findItem = (p: Project, id: string): Item => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!

/** Oráculo (b): efeitos que, no resolve sem transição, agem sobre a faixa do item na posição k. */
function covering(ref: Layer[], k: number, trackId: string): EffectLayer[] {
  const out: EffectLayer[] = []
  let adjacent = true // efeitos `track` só valem colados à camada-alvo (seguidos de outros `track` do mesmo alvo)
  for (let j = k + 1; j < ref.length; j++) {
    const l = ref[j]
    if (l.kind === 'effect' && l.scope === 'track' && l.targetTrackId === trackId && adjacent) { out.push(l); continue }
    adjacent = false
    if (l.kind === 'effect' && l.scope === 'below') out.push(l)
  }
  return out
}

/** Confere um lado (A em tA ou B em tB) contra o resolve sem transição. */
function checkSide(p: Project, base: Project, side: Layer[], itemId: string, trackId: string, at: number): void {
  const ref = resolveFrame(base, at)
  const k = ref.findIndex((l) => l.kind !== 'effect' && l.itemId === itemId)
  if (k < 0) { expect(side).toEqual([]); return }
  const own = ref[k]
  const item = findItem(p, itemId)
  // (a) toda mídia do lado lê a fonte dentro do trecho aparado do próprio item
  for (const l of side) {
    if (l.kind !== 'media' || l.srcUs === null) continue
    const m = findItem(p, l.itemId) as MediaItem
    const r = trimmed(m)
    if (!(l.srcUs >= r.lo && l.srcUs < r.hi)) throw new Error(`(a) ${l.itemId} srcUs ${l.srcUs} fora de [${r.lo}, ${r.hi})`)
  }
  expect(side.filter((l) => l.kind !== 'effect').map((l) => l.itemId)).toEqual([itemId])
  // (c) a camada do item = a do resolve sem transição; a única diferença admitida é srcUs fora do trecho (reverso no
  // último quadro, arredondamento em câmera lenta) puxado para dentro dele
  if (own.kind === 'media' && own.srcUs !== null && item.type === 'media') {
    const r = trimmed(item)
    const inRange = own.srcUs >= r.lo && own.srcUs < r.hi
    expect({ ...side[0], srcUs: 0 }).toEqual({ ...own, srcUs: 0 })
    if (inRange) expect((side[0] as MediaLayer).srcUs).toBe(own.srcUs)
    else expect(Math.abs((side[0] as MediaLayer).srcUs! - own.srcUs)).toBeLessThanOrEqual(34_000)
  } else expect(side[0]).toEqual(own)
  // (b) cada efeito que cobre a faixa sem a transição está no lado, com a mesma geometria/força/feather/invert
  for (const e of covering(ref, k, trackId)) expect(side).toContainEqual(e)
}

describe('transições × privacidade (1/240 s, oráculo = resolve sem transição)', () => {
  it.each(cases)('%s', (_n, make) => {
    const p = make()
    const base = withoutTransitions(p)
    const wins = transitionWindows(p).filter((w) => pairActive(p.tracks.find((t) => t.id === w.trackId)!, w))
    expect(wins.length).toBeGreaterThan(0)
    let samples = 0
    for (const w of wins) {
      for (let t = w.startUs; t < w.endUs; t += Math.round(S / 240)) {
        try {
          const layers = resolveFrame(p, t)
          const trs = layers.filter((l): l is TransitionLayer => l.kind === 'transition' && l.trackId === w.trackId)
          expect(trs).toHaveLength(1)
          const L = trs[0]
          expect([L.fromId, L.toId]).toEqual([w.fromId, w.toId])
          checkSide(p, base, L.from, w.fromId, w.trackId, Math.min(t, w.cutUs - 1))
          checkSide(p, base, L.to, w.toId, w.trackId, Math.max(t, w.cutUs))
          samples++
        } catch (e) {
          throw new Error(`t = ${t} (janela ${w.fromId}→${w.toId}): ${(e as Error).message}`)
        }
      }
    }
    expect(samples).toBeGreaterThanOrEqual(wins.length * 239)
  })
  it.each(cases)('%s: privacyWarnings igual ao do projeto sem transição', (_n, make) => {
    const p = make()
    const end = Math.max(...p.tracks.flatMap((t) => t.items.map((i) => i.startUs + i.durationUs)))
    expect(privacyWarnings(p, 0, end)).toEqual(privacyWarnings(withoutTransitions(p), 0, end))
  })
  it('as cenas são estruturalmente válidas (efeitos e clipes onde o teste supõe)', () => {
    for (const [, make] of cases) {
      const p = make()
      expect(p.tracks[0].items.every((i) => i.type !== 'effect')).toBe(true)
      for (const t of p.tracks.slice(1)) expect(t.items.every((i): i is EffectItem => i.type === 'effect')).toBe(true)
    }
  })
})
