// Áudio das transições (sem handles): A some em [corte − d/2, corte), B entra em [corte, corte + (d − d/2)).
import { describe, expect, it } from 'vitest'
import { gainAt, planAudio, type AudioSegment } from './audioPlan'
import type { Item, MediaItem, Project, Track, TransitionKind } from './project'
import { S, aclip, project, tr, track, vclip, vid, withoutTransitions } from './__fixtures__/transitionScenes'

interface Opts { kind?: TransitionKind; d?: number; aa?: Partial<MediaItem>; ab?: Partial<MediaItem>; a?: Partial<MediaItem>; abOnA2?: boolean; v1?: Partial<Track>; a1?: Partial<Track> }
/**
 * V1: A [0, 4 s) (LA) → B [4 s, 8 s) (LB) com transição; A1 (volume 0,5): aa [0, 4 s) (LA, volume 0,8) e ab [4 s, 8 s)
 * (LB); A2: música m [0, 8 s) sem vínculo (e ab, se abOnA2, numa faixa própria A3).
 */
function scene(o: Opts = {}): Project {
  const ab = aclip('ab', 'b', 4 * S, 4 * S, { inUs: 3 * S, linkId: 'LB', ...o.ab })
  const tracks: Track[] = [
    track('V1', 'video', [vclip('A', 'a', 0, 4 * S, { inUs: 2 * S, linkId: 'LA', ...o.a }), vclip('B', 'b', 4 * S, 4 * S, { inUs: 3 * S, linkId: 'LB', transitionIn: tr(o.kind ?? 'crossfade', o.d ?? S) })], o.v1),
    track('A1', 'audio', [aclip('aa', 'a', 0, 4 * S, { inUs: 2 * S, linkId: 'LA', audio: { ...aclip('x', 'a', 0, 1).audio, volume: { value: 0.8 } }, ...o.aa }), ...(o.abOnA2 ? [] : [ab])], { volume: 0.5, ...o.a1 }),
    track('A2', 'audio', [aclip('m', 'm', 0, 8 * S)]),
    ...(o.abOnA2 ? [track('A3', 'audio', [ab])] : [])
  ]
  return project(tracks, [vid('a'), vid('b'), vid('m')])
}
const seg = (p: Project, id: string): AudioSegment | undefined => planAudio(p).find((s) => s.itemId === id)
const g = (p: Project, id: string, t: number): number => gainAt(seg(p, id)!, Math.round(t))
const BASE = 0.5 * 0.8
const C45 = Math.cos(Math.PI / 4)
const mapItems = (p: Project, fn: (i: Item) => Item): Project => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map(fn) })) })

describe('planAudio: transições', () => {
  it('crossfade: potência constante em pontos-chave (lado A cos, lado B sin)', () => {
    const p = scene()
    expect(g(p, 'aa', 3 * S)).toBeCloseTo(BASE, 9)
    expect(g(p, 'aa', 3.5 * S)).toBeCloseTo(BASE, 9) // início da janela = 1·base
    expect(g(p, 'aa', 3.75 * S)).toBeCloseTo(C45 * BASE, 9) // meio do lado A
    expect(g(p, 'aa', 4 * S - 1)).toBeLessThan(1e-4) // corte − 1 µs ≈ 0
    expect(g(p, 'ab', 4 * S)).toBe(0) // B começa mudo no corte
    expect(g(p, 'ab', 4.25 * S)).toBeCloseTo(Math.sin(Math.PI / 4) * 0.5, 9)
    expect(g(p, 'ab', 4.5 * S)).toBeCloseTo(0.5, 9) // fim da janela = 1·base
    expect(g(p, 'ab', 6 * S)).toBeCloseTo(0.5, 9)
    // potência constante: no meio de cada lado cos² + sin² = 1 entre os pontos da curva também
    for (let t = 3.5 * S; t < 4 * S; t += 1_234) {
      const x = (t - 3.5 * S) / (0.5 * S)
      expect(Math.abs(g(p, 'aa', t) / BASE - Math.cos((x * Math.PI) / 2))).toBeLessThan(2e-4)
    }
    // música sem vínculo: intacta
    expect(seg(p, 'm')).toEqual(seg(withoutTransitions(p), 'm'))
  })
  it('curva densificada: pontos a ≤ 10 ms dentro da janela; segmentos não mudam de trecho (sem handles)', () => {
    const p = scene({ d: 1_000_001 })
    const q = withoutTransitions(p)
    for (const id of ['aa', 'ab']) {
      const s = seg(p, id)!
      const r = seg(q, id)!
      expect({ ...s, gain: [] }).toEqual({ ...r, gain: [] })
      const pts = s.gain.filter((x) => x.tUs >= 3.5 * S && x.tUs <= 4.5 * S + 1)
      for (let i = 1; i < pts.length; i++) expect(pts[i].tUs - pts[i - 1].tUs).toBeLessThanOrEqual(10_000)
      expect(pts.every((x) => Number.isInteger(x.tUs))).toBe(true)
      expect(s.gain[0].tUs).toBe(s.startUs)
      expect(s.gain[s.gain.length - 1].tUs).toBe(s.startUs + s.durationUs)
    }
    // d ímpar: o µs a mais vai para depois do corte (lado B: 500 001 µs)
    expect(g(p, 'ab', 4.5 * S + 1)).toBeCloseTo(0.5, 9)
    expect(g(p, 'ab', 4.5 * S)).toBeLessThan(0.5)
  })
  it('dipBlack/dipWhite: rampa linear até 0 nos mesmos intervalos', () => {
    for (const kind of ['dipBlack', 'dipWhite'] as const) {
      const p = scene({ kind })
      expect(g(p, 'aa', 3.75 * S)).toBeCloseTo(0.5 * BASE, 9)
      expect(g(p, 'aa', 3.6 * S)).toBeCloseTo(0.8 * BASE, 9)
      expect(g(p, 'ab', 4.1 * S)).toBeCloseTo(0.2 * 0.5, 9)
    }
    // os outros kinds visuais usam a potência constante
    for (const kind of ['slideL', 'wipeR', 'zoomIn', 'blur'] as const) expect(g(scene({ kind }), 'aa', 3.75 * S)).toBeCloseTo(C45 * BASE, 9)
  })
  it('item vinculado em outra faixa e áudio do próprio clipe de vídeo', () => {
    const p = scene({ abOnA2: true })
    expect(g(p, 'ab', 4.25 * S)).toBeCloseTo(Math.sin(Math.PI / 4), 9)
    const own = scene({ a: { audio: { ...aclip('x', 'a', 0, 1).audio, enabled: true } } })
    expect(g(own, 'A', 3.75 * S)).toBeCloseTo(C45, 9)
    expect(g(own, 'aa', 3.75 * S)).toBeCloseTo(C45 * BASE, 9)
  })
  it('vinculado que não termina/começa no corte não é afetado', () => {
    const p = scene({ aa: { durationUs: 3.8 * S }, ab: { startUs: 4.1 * S, durationUs: 3.9 * S } })
    const q = withoutTransitions(p)
    expect(seg(p, 'aa')).toEqual(seg(q, 'aa'))
    expect(seg(p, 'ab')).toEqual(seg(q, 'ab'))
  })
  it('multiplica fades próprios e volume animado', () => {
    const p = scene({ aa: { audio: { ...aclip('x', 'a', 0, 1).audio, volume: { value: 1, keys: [{ tUs: 0, value: 1, ease: 'linear' }, { tUs: 4 * S, value: 0.5, ease: 'linear' }] }, fadeOutUs: S } } })
    const q = withoutTransitions(p)
    // o envelope do item (linear entre os pontos dele) × a curva da transição
    expect(g(q, 'aa', 3.4 * S)).toBeLessThan(0.5 * (1 - 0.5 * (3.4 / 4))) // o fade próprio está lá
    expect(g(p, 'aa', 3.4 * S)).toBeCloseTo(g(q, 'aa', 3.4 * S), 9)
    expect(g(p, 'aa', 3.75 * S)).toBeCloseTo(g(q, 'aa', 3.75 * S) * C45, 9)
    for (let t = 3.5 * S; t < 4 * S; t += 7_777) {
      const x = (t - 3.5 * S) / (0.5 * S)
      expect(Math.abs(g(p, 'aa', t) - g(q, 'aa', t) * Math.cos((x * Math.PI) / 2))).toBeLessThan(1e-4)
    }
  })
  it('faixa de áudio muda: sem segmento; faixa de vídeo muda/oculta: o áudio vinculado faz a transição', () => {
    const muted = scene({ a1: { muted: true } })
    expect(planAudio(muted)).toEqual(planAudio(withoutTransitions(muted)))
    expect(seg(muted, 'aa')).toBeUndefined()
    const vMuted = scene({ v1: { muted: true }, a: { audio: { ...aclip('x', 'a', 0, 1).audio, enabled: true } } })
    expect(seg(vMuted, 'A')).toBeUndefined()
    expect(g(vMuted, 'aa', 3.75 * S)).toBeCloseTo(C45 * BASE, 9)
    const hidden = scene({ v1: { hidden: true } })
    expect(g(hidden, 'aa', 3.75 * S)).toBeCloseTo(C45 * BASE, 9)
  })
  it('lado desativado: corte seco (plano igual ao sem transição)', () => {
    for (const id of ['A', 'B']) {
      const p = mapItems(scene(), (i) => (i.id === id ? { ...i, enabled: false } : i))
      expect(planAudio(p)).toEqual(planAudio(withoutTransitions(p)))
    }
  })
  it('transição removida → plano idêntico ao anterior', () => {
    const before = withoutTransitions(scene())
    const plan = planAudio(before)
    expect(planAudio(scene())).not.toEqual(plan)
    expect(planAudio(withoutTransitions(scene()))).toEqual(plan)
  })
})
