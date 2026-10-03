import { describe, expect, it } from 'vitest'
import { easeValue } from './anim'
import type { Item, MediaItem, Project, TransitionKind } from './project'
import { effectBound, resolveFrame, type Layer, type MediaLayer, type TextLayer, type TransitionLayer } from './resolve'
import { S, fx, img, project, textClip, tr, track, vclip, vid, withoutTransitions } from './__fixtures__/transitionScenes'

/** V1: A [0, 4 s) (fonte a desde 2 s) e B [4 s, 8 s) (fonte b desde 3 s) com transição de `d` em B; FX acima. */
function scene(d = S, kind: TransitionKind = 'crossfade', fxItems: Item[] = []): Project {
  return project([
    track('V1', 'video', [vclip('A', 'a', 0, 4 * S, { inUs: 2 * S }), vclip('B', 'b', 4 * S, 4 * S, { inUs: 3 * S, transitionIn: tr(kind, d) })]),
    track('FX', 'video', fxItems)
  ], [vid('a'), vid('b')])
}
const trLayer = (layers: Layer[]): TransitionLayer | undefined => layers.find((l): l is TransitionLayer => l.kind === 'transition')

describe('resolveFrame: TransitionLayer', () => {
  it('fora das janelas: idêntico ao projeto sem transição', () => {
    const p = scene()
    const q = withoutTransitions(p)
    for (const t of [0, S, 3.5 * S - 1, 4.5 * S, 6 * S, 8 * S - 1]) expect(resolveFrame(p, t)).toEqual(resolveFrame(q, t))
  })
  it('antes do corte: A toca normal, B congelado no 1º quadro; progresso suavizado', () => {
    const p = scene()
    const t = 3.75 * S
    const layers = resolveFrame(p, t)
    expect(layers).toHaveLength(1)
    const l = layers[0] as TransitionLayer
    expect(l).toMatchObject({ kind: 'transition', itemId: 'B', fromId: 'A', toId: 'B', trackId: 'V1', transition: 'crossfade', linear: 0.25 })
    expect(l.progress).toBeCloseTo(easeValue('inOut', 0.25), 12)
    expect(l.from).toEqual(resolveFrame(withoutTransitions(p), t))
    expect((l.from[0] as MediaLayer).srcUs).toBe(2 * S + t)
    expect((l.to[0] as MediaLayer).srcUs).toBe(3 * S)
    expect(l.to).toEqual(resolveFrame(withoutTransitions(p), 4 * S))
  })
  it('depois do corte: A congelado no último quadro (corte − 1), B toca normal', () => {
    const p = scene()
    const l = trLayer(resolveFrame(p, 4.25 * S))!
    expect(l.linear).toBe(0.75)
    expect((l.from[0] as MediaLayer).srcUs).toBe(2 * S + 4 * S - 1)
    expect((l.to[0] as MediaLayer).srcUs).toBe(3 * S + 0.25 * S)
  })
  it('janela [corte − floor(d/2), +d): bordas e d ímpar', () => {
    const p = scene(1_000_001)
    expect(trLayer(resolveFrame(p, 3.5 * S - 1))).toBeUndefined()
    expect(trLayer(resolveFrame(p, 3.5 * S))!.linear).toBe(0)
    expect(trLayer(resolveFrame(p, 4.5 * S))).toBeDefined() // o µs a mais fica depois do corte
    expect(trLayer(resolveFrame(p, 4.5 * S + 1))).toBeUndefined()
  })
  it('lado desativado ou faixa oculta: sem transição (corte seco / nada)', () => {
    const p = scene()
    const off = (id: string): Project => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === id ? { ...i, enabled: false } : i)) })) })
    expect(resolveFrame(off('A'), 3.75 * S)).toEqual([])
    expect(resolveFrame(off('B'), 3.75 * S)).toEqual(resolveFrame(withoutTransitions(p), 3.75 * S))
    expect(resolveFrame(off('A'), 4.25 * S)).toEqual(resolveFrame(withoutTransitions(p), 4.25 * S))
    const hidden: Project = { ...p, tracks: p.tracks.map((t) => (t.id === 'V1' ? { ...t, hidden: true } : t)) }
    expect(resolveFrame(hidden, 3.75 * S)).toEqual([])
  })
  it('mesma posição na pilha; efeitos da pilha principal continuam em t (below e track sobre a transição)', () => {
    const p = project([
      track('V0', 'video', [vclip('BG', 'a', 0, 8 * S)]),
      track('V1', 'video', [vclip('A', 'a', 0, 4 * S), vclip('B', 'b', 4 * S, 4 * S, { transitionIn: tr('slideL', S) })]),
      track('V2', 'video', [vclip('TOP', 'b', 0, 8 * S, { visual: { ...vclip('x', 'a', 0, 1).visual!, transform: { ...vclip('x', 'a', 0, 1).visual!.transform, scale: { value: 0.3 } } } })]),
      track('FX', 'video', [fx('fb', 'blur', 0, 8 * S)]),
      track('FX2', 'video', [fx('ft', 'solid', 0, 8 * S, { scope: 'track', targetTrackId: 'V1' })])
    ], [vid('a'), vid('b')])
    const layers = resolveFrame(p, 3.9 * S)
    expect(layers.map((l) => (l.kind === 'transition' ? 'tr' : l.itemId))).toEqual(['BG', 'tr', 'ft', 'TOP', 'fb'])
    expect(effectBound(layers, 2)).toBe(true)
    const l = layers[1] as TransitionLayer
    // from: A + o efeito de faixa (alvo V1) + o below acima; nunca o fundo nem o topo
    expect(l.from.map((x) => x.itemId)).toEqual(['A', 'ft', 'fb'])
    expect(l.to.map((x) => x.itemId)).toEqual(['B', 'ft', 'fb'])
  })
  it('texto ↔ imagem; o texto usa textContentAt (contagem)', () => {
    const p = project([
      track('V1', 'video', [vclip('A', 'im', 0, 4 * S), textClip('B', 4 * S, 4 * S, { counter: { from: 0, to: 100 }, transitionIn: tr('zoomIn', S) })])
    ], [img('im')])
    const before = trLayer(resolveFrame(p, 3.75 * S))!
    expect((before.from[0] as MediaLayer).srcUs).toBeNull()
    expect((before.to[0] as TextLayer).text).toBe('0')
    const after = trLayer(resolveFrame(p, 4.4 * S))!
    expect((after.to[0] as TextLayer).text).toBe('10')
    // fora da janela, texto com contagem
    expect((resolveFrame(p, 6 * S)[0] as TextLayer).text).toBe('50')
  })
  it('reverso: nunca lê a fonte antes de inUs (último quadro congelado)', () => {
    const p = project([
      track('V1', 'video', [vclip('A', 'a', 0, 4 * S, { inUs: 2 * S, reverse: true }), vclip('B', 'b', 4 * S, 4 * S, { transitionIn: tr('crossfade', S) })])
    ], [vid('a'), vid('b')])
    const l = trLayer(resolveFrame(p, 4.25 * S))!
    expect((l.from[0] as MediaLayer).srcUs).toBe(2 * S)
  })
  it('desempenho: 1 h, 4 faixas × 400 itens, 30 transições: < 1 ms por quadro em média', () => {
    const per = 400, dur = (3600 * S) / per
    const tracks = [0, 1, 2, 3].map((k) => track(`V${k}`, 'video', Array.from({ length: per }, (_, i): MediaItem =>
      vclip(`c${k}_${i}`, 'a', i * dur, dur, { inUs: S, ...(i % 50 === 1 && (i - 1) / 50 < (k < 2 ? 8 : 7) ? { transitionIn: tr('crossfade', S) } : {}) }))))
    const p = project([...tracks, track('FX', 'video', [fx('fx', 'blur', 0, 3600 * S)])], [vid('a', 3700 * S)])
    const n = p.tracks.flatMap((t) => t.items).filter((i) => i.type === 'media' && i.transitionIn).length
    expect(n).toBe(30) // i = 1, 51, 101, …: 8 nas faixas 0–1, 7 nas 2–3
    const N = 1000
    for (let i = 0; i < 200; i++) resolveFrame(p, (i * 7_919_993) % (3600 * S)) // aquecimento
    let inWin = 0
    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      const t = Math.round(((i + 0.5) * 3600 * S) / N)
      if (resolveFrame(p, t).some((l) => l.kind === 'transition')) inWin++
    }
    const ms = (performance.now() - t0) / N
    // dentro de janela: 1000 chamadas só em janelas
    const t1 = performance.now()
    for (let i = 0; i < N; i++) resolveFrame(p, 51 * dur - 0.4 * S + (i % 800) * 1000)
    const msIn = (performance.now() - t1) / N
    if (process.env.PERF_LOG) console.info(`resolveFrame: ${ms.toFixed(4)} ms/chamada espalhada (${inWin} em janela); ${msIn.toFixed(4)} ms/chamada em janela`)
    expect(ms).toBeLessThan(1)
    expect(msIn).toBeLessThan(1)
  })
})
