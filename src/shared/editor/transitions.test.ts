import { describe, expect, it } from 'vitest'
import { createEmptyProject, defaultVisual } from './factory'
import type { Item, MediaItem, Project, TextItem, Track, Transition } from './project'
import { canTransition, frozenTimes, pairActive, maxTransitionUs, MIN_TRANSITION_US, transitionAt, transitionWindows, windowProgress } from './transitions'

const S = 1_000_000
const clip = (id: string, startUs: number, durationUs: number, transitionIn?: Transition, extra?: Partial<MediaItem>): MediaItem => ({
  id, type: 'media', assetId: 'a', startUs, durationUs, inUs: 0, speed: 1, reverse: false,
  audio: { enabled: false, volume: { value: 1 }, fadeInUs: 0, fadeOutUs: 0, preservePitch: true, denoise: false, normalize: false },
  visual: defaultVisual(), ...(transitionIn ? { transitionIn } : {}), ...extra
})
const text = (id: string, startUs: number, durationUs: number, transitionIn?: Transition): TextItem => ({
  id, type: 'text', startUs, durationUs, text: 'Olá', visual: defaultVisual(),
  style: { font: 'Inter', size: { value: 48 }, weight: 400, color: '#ffffff', align: 'center', lineHeight: 1.2 },
  ...(transitionIn ? { transitionIn } : {})
})
const track = (items: Item[], kind: Track['kind'] = 'video', id = 'v1'): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, volume: 1, items })
const proj = (...tracks: Track[]): Project => ({ ...createEmptyProject('t'), tracks })
const cf = (durationUs: number): Transition => ({ kind: 'crossfade', durationUs })

describe('transitionWindows / transitionAt', () => {
  it('janela centrada no corte: [cut − floor(d/2), cut − floor(d/2) + d); d ímpar põe o µs a mais depois do corte', () => {
    const t = track([clip('a', 0, 4 * S), clip('b', 4 * S, 4 * S, cf(1_000_001))])
    const [w] = transitionWindows(proj(t))
    expect(w).toEqual({ trackId: 'v1', fromId: 'a', toId: 'b', kind: 'crossfade', durationUs: 1_000_001, cutUs: 4 * S, startUs: 3_500_000, endUs: 4_500_001 })
    expect(Number.isInteger(w.startUs) && Number.isInteger(w.endUs)).toBe(true)
    expect(transitionAt(t, 3_499_999)).toBeNull()
    expect(transitionAt(t, 3_500_000)).toEqual(w)
    expect(transitionAt(t, 4 * S)).toEqual(w)
    expect(transitionAt(t, 4_500_000)).toEqual(w)
    expect(transitionAt(t, 4_500_001)).toBeNull()
    expect(windowProgress(w, w.startUs)).toBe(0)
    expect(windowProgress(w, w.endUs)).toBe(1)
    expect(windowProgress(w, 0)).toBe(0)
    expect(windowProgress(w, 3_500_000 + 500_000)).toBeCloseTo(0.5, 5)
    expect(frozenTimes(w)).toEqual({ fromUs: 4 * S - 1, toUs: 4 * S })
  })
  it('só pares válidos: vão, faixa de áudio, desativado, forma/efeito, primeiro item, abaixo do mínimo', () => {
    const p = proj(
      track([clip('a', 0, 2 * S, cf(S)), clip('b', 2 * S + 1, 2 * S, cf(S))], 'video', 'gap'),
      track([clip('c', 0, 2 * S), clip('d', 2 * S, 2 * S, cf(S))], 'audio', 'aud'),
      track([clip('e', 0, 2 * S, undefined, { enabled: false }), clip('f', 2 * S, 2 * S, cf(S))], 'video', 'off'),
      track([clip('g', 0, 2 * S, undefined, { visual: undefined }), clip('h', 2 * S, 2 * S, cf(S))], 'video', 'novis'),
      track([clip('i', 0, 150_000), clip('j', 150_000, 2 * S, cf(S))], 'video', 'short'),
      track([text('k', 0, 2 * S), clip('l', 2 * S, 2 * S, cf(S)), text('m', 4 * S, 2 * S, cf(300_000))], 'video', 'ok')
    )
    // item desativado não invalida a janela (regra estrutural); quem desenha pula o par com pairActive
    expect(transitionWindows(p).map((w) => [w.trackId, w.fromId, w.toId, w.durationUs])).toEqual([['off', 'e', 'f', S], ['ok', 'k', 'l', S], ['ok', 'l', 'm', 300_000]])
    const byId = new Map(p.tracks.map((t) => [t.id, t]))
    expect(transitionWindows(p).map((w) => pairActive(byId.get(w.trackId)!, w))).toEqual([false, true, true])
    expect(transitionAt(byId.get('off')!, 2 * S)).toMatchObject({ fromId: 'e', toId: 'f' })
    expect(canTransition(p, 'gap', 'a', 'b')).toMatch(/encostados/)
    expect(canTransition(p, 'aud', 'c', 'd')).toMatch(/vídeo/)
    expect(canTransition(p, 'off', 'e', 'f')).toMatch(/ativos/)
    expect(canTransition(p, 'novis', 'g', 'h')).toMatch(/vídeo, imagem ou texto/)
    expect(canTransition(p, 'short', 'i', 'j')).toBe('Clipes curtos demais para a transição')
    expect(canTransition(p, 'ok', 'k', 'l')).toBeNull()
    expect(canTransition(p, 'ok', undefined, 'k')).toMatch(/encostados/)
    expect(canTransition(p, 'ok', 'k', 'm')).toMatch(/encostados/)
    expect(canTransition(p, 'nada', 'k', 'l')).toMatch(/encostados/)
  })
  it('duração acima do máximo (arquivo antigo) é desenhada limitada ao máximo', () => {
    const t = track([clip('a', 0, S), clip('b', S, 4 * S, cf(3 * S))])
    expect(maxTransitionUs(t.items[0], t.items[1])).toBe(500_000)
    expect(transitionWindows(proj(t))[0]).toMatchObject({ durationUs: 500_000, startUs: 750_000, endUs: 1_250_000 })
  })
  it('janelas vizinhas no mesmo clipe nunca se sobrepõem (d máximo dos dois lados)', () => {
    const d = Math.floor(300_001 / 2)
    const t = track([clip('a', 0, 300_001), clip('b', 300_001, 300_001, cf(d)), clip('c', 600_002, 300_001, cf(d))])
    const ws = transitionWindows(proj(t))
    expect(ws).toHaveLength(2)
    expect(ws[0].endUs).toBeLessThanOrEqual(ws[1].startUs)
    for (let u = 0; u < 900_003; u += 1013) {
      const hit = ws.filter((w) => u >= w.startUs && u < w.endUs)
      expect(transitionAt(t, u)).toEqual(hit[0] ?? null)
    }
  })
  it('desempenho: 1 h com 400 itens por faixa, 10 000 consultas em < 20 ms', () => {
    const n = 400, dur = Math.floor(3600 * S / n)
    const items = Array.from({ length: n }, (_, i) => clip(`c${i}`, i * dur, dur, i > 0 && i % 2 === 0 ? cf(MIN_TRANSITION_US * 5) : undefined))
    const t = track(items)
    // confere a resposta em alguns pontos e aquece o JIT
    expect(transitionAt(t, 2 * dur)).toMatchObject({ toId: 'c2' })
    expect(transitionAt(t, 3 * dur)).toBeNull()
    for (let i = 0; i < 2000; i++) transitionAt(t, (i * 1_800_017) % (3600 * S))
    const t0 = performance.now()
    let hits = 0
    for (let i = 0; i < 10_000; i++) if (transitionAt(t, (i * 360_007) % (3600 * S))) hits++
    const ms = performance.now() - t0
    expect(hits).toBeGreaterThan(0)
    expect(ms).toBeLessThan(20)
  })
})
