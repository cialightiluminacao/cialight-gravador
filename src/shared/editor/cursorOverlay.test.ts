import { describe, expect, it } from 'vitest'
import { cursorAt, type CursorTrackV1 } from '../cursor'
import { CLICK_RING_FROM, CLICK_RING_STROKE_PX, CURSOR_REFERENCE_HEIGHT, type CursorTracks } from './cursorOverlay'
import { cursorTimeMs, timelineUsAtCursorMs } from './cursorTime'
import { createEmptyProject, createMediaItem } from './factory'
import { DEFAULT_CURSOR_FX, type Asset, type CursorFx, type MediaItem, type Project, type Track } from './project'
import { resolveFrame, type MediaLayer } from './resolve'

const screen: Asset = {
  id: 'scr', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' }, durationUs: 3_700_000_000,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 }, status: 'ready', cursor: 'cursor.json'
}

/** Trilha de 20 s a 60 Hz: o cursor anda na diagonal; cliques em 2000 (esq.), 5000 (dir.) e 9000 ms (meio). */
function makeTrack(): CursorTrackV1 {
  const samples: CursorTrackV1['samples'] = []
  for (let t = 100; t <= 20_000; t += 16) samples.push({ tMs: t, x: 0.1 + (0.8 * t) / 20_000, y: 0.2 + (0.6 * t) / 20_000 })
  return {
    version: 1, width: 1920, height: 1080, samples,
    clicks: [
      { tMs: 2000, x: 0.25, y: 0.4, button: 'left' },
      { tMs: 5000, x: 0.5, y: 0.5, button: 'right' },
      { tMs: 9000, x: 0.75, y: 0.6, button: 'middle' }
    ]
  }
}

const fxOn = (over?: { highlight?: Partial<CursorFx['highlight']>; cursor?: Partial<CursorFx['cursor']> }): CursorFx => ({
  highlight: { ...DEFAULT_CURSOR_FX.highlight, enabled: true, ...over?.highlight },
  cursor: { ...DEFAULT_CURSOR_FX.cursor, enabled: true, ...over?.cursor }
})

function setup(over: Partial<MediaItem> = {}, track = makeTrack()): { p: Project; item: MediaItem; cursors: CursorTracks; track: CursorTrackV1 } {
  const p = createEmptyProject('x')
  p.assets = [screen]
  const item: MediaItem = { ...createMediaItem(screen, 0, 'video'), id: 'it', startUs: 1_000_000, durationUs: 15_000_000, cursorFx: fxOn(), ...over }
  p.tracks[0].items = [item]
  return { p, item, cursors: new Map([[screen.id, track]]), track }
}

const media = (p: Project, tUs: number, cursors?: CursorTracks): MediaLayer | undefined => resolveFrame(p, tUs, cursors).find((l): l is MediaLayer => l.kind === 'media')

describe('resolveFrame: sobreposição do cursor (realce de cliques e cursor ampliado)', () => {
  it('anel no instante do clique, na metade e nada depois de durationMs (raio 0,6 → 1 de sizePx, alfa 1 → 0)', () => {
    const { p, item, cursors } = setup({ cursorFx: fxOn({ highlight: { sizePx: 40, durationMs: 400, color: '#ff00ff' } }) })
    const at = timelineUsAtCursorMs(p, item, 2000)!
    const r0 = media(p, at, cursors)!.cursor!
    expect(r0.color).toBe('#ff00ff')
    expect(r0.strokePx).toBe(CLICK_RING_STROKE_PX)
    expect(r0.refW).toBe(1920)
    expect(r0.refH).toBe(1080)
    expect(r0.rings).toHaveLength(1)
    expect(r0.rings[0]).toMatchObject({ x: 0.25, y: 0.4, progress: 0, alpha: 1 })
    expect(r0.rings[0].radiusPx).toBeCloseTo(40 * CLICK_RING_FROM, 9)
    const half = media(p, at + 200_000, cursors)!.cursor!.rings
    expect(half).toHaveLength(1)
    expect(half[0].progress).toBeCloseTo(0.5, 9)
    expect(half[0].alpha).toBeCloseTo(0.5, 9)
    expect(half[0].radiusPx).toBeCloseTo(40 * (CLICK_RING_FROM + (1 - CLICK_RING_FROM) * 0.5), 9)
    expect(media(p, at + 399_999, cursors)!.cursor!.rings).toHaveLength(1)
    expect(media(p, at + 400_000, cursors)!.cursor!.rings).toHaveLength(0)
    expect(media(p, at + 2_000_000, cursors)!.cursor!.rings).toHaveLength(0)
    // antes do clique aparecer: nenhum anel
    expect(media(p, at - 1, cursors)!.cursor!.rings).toHaveLength(0)
  })

  it('botão direito e do meio: o mesmo anel', () => {
    const { p, item, cursors } = setup()
    for (const ms of [5000, 9000]) {
      const at = timelineUsAtCursorMs(p, item, ms)!
      const rings = media(p, at, cursors)!.cursor!.rings
      expect(rings).toHaveLength(1)
      expect(rings[0].progress).toBe(0)
    }
  })

  it('cursor ampliado: posição = cursorAt(trilha, cursorTimeMs, suavização); tamanho pela escala e pela altura gravada', () => {
    const { p, item, cursors, track } = setup({ cursorFx: fxOn({ cursor: { scale: 2.5, smoothing: 0.7 } }) })
    for (let t = item.startUs + 200_000; t < item.startUs + item.durationUs; t += 333_333) {
      const s = media(p, t, cursors)!.cursor!.sprite!
      const want = cursorAt(track, cursorTimeMs(p, item, t)!, 0.7)!
      expect(s.x).toBe(want.x)
      expect(s.y).toBe(want.y)
      expect(s.scale).toBeCloseTo((2.5 * 1080) / 1080, 12)
    }
    // gravação em 2160 linhas: a seta dobra (px da fonte por unidade)
    const big = setup({ cursorFx: fxOn({ cursor: { scale: 2 } }) }, { ...makeTrack(), width: 3840, height: 2160 })
    expect(media(big.p, 3_000_000, big.cursors)!.cursor!.sprite!.scale).toBeCloseTo(4, 12)
    expect(CURSOR_REFERENCE_HEIGHT).toBe(1080)
  })

  it('cursor fora do quadro gravado ou antes da 1ª amostra: sem a seta (o anel continua)', () => {
    const tr = makeTrack()
    // cursor sai do quadro (x > 1) entre 4 e 6 s
    tr.samples = tr.samples.map((s) => (s.tMs >= 4000 && s.tMs <= 6000 ? { ...s, x: 1.3 } : s))
    const { p, item, cursors } = setup({}, tr)
    const at = timelineUsAtCursorMs(p, item, 5000)!
    const o = media(p, at, cursors)!.cursor!
    expect(o.sprite).toBeNull()
    expect(o.rings).toHaveLength(1)
    // primeira amostra em 100 ms: com inUs = 0 e o atraso de 80 ms, o 1º quadro mostra o cursor de −80 ms
    expect(media(p, item.startUs, cursors)?.cursor).toBeUndefined()
  })

  it('nada é emitido sem cursorFx, com tudo desligado, sem trilha ou em clipe de outra mídia', () => {
    const { p, item, cursors } = setup()
    const t = timelineUsAtCursorMs(p, item, 2000)!
    expect(media(p, t, cursors)!.cursor).toBeDefined()
    expect(media(p, t)!.cursor).toBeUndefined()
    expect(media(p, t, new Map())!.cursor).toBeUndefined()
    const none = setup({ cursorFx: undefined })
    expect(media(none.p, t, none.cursors)!.cursor).toBeUndefined()
    const off = setup({ cursorFx: { highlight: { ...DEFAULT_CURSOR_FX.highlight }, cursor: { ...DEFAULT_CURSOR_FX.cursor } } })
    expect(media(off.p, t, off.cursors)!.cursor).toBeUndefined()
    // só o realce ligado e nenhum clique no instante: nada
    const ringOnly = setup({ cursorFx: fxOn({ cursor: { enabled: false } }) })
    expect(media(ringOnly.p, timelineUsAtCursorMs(ringOnly.p, ringOnly.item, 3000)!, ringOnly.cursors)!.cursor).toBeUndefined()
    const ro = media(ringOnly.p, t, ringOnly.cursors)!.cursor!
    expect(ro.sprite).toBeNull()
    expect(ro.rings).toHaveLength(1)
    // só a seta ligada: nenhum anel
    const spriteOnly = setup({ cursorFx: fxOn({ highlight: { enabled: false } }) })
    const so = media(spriteOnly.p, t, spriteOnly.cursors)!.cursor!
    expect(so.rings).toHaveLength(0)
    expect(so.sprite).not.toBeNull()
  })

  it('item numa faixa de áudio com cursorFx (e a trilha): nenhuma camada, nenhuma sobreposição', () => {
    const { p, item, cursors } = setup()
    const audioTrack: Track = { id: 't_a', kind: 'audio', name: 'Áudio', muted: false, hidden: false, locked: false, volume: 1, items: [{ ...item, id: 'aud', visual: undefined }] }
    const q: Project = { ...p, tracks: [audioTrack] }
    expect(resolveFrame(q, timelineUsAtCursorMs(p, item, 2000)!, cursors)).toEqual([])
  })

  it('R15: velocidade 2× — o anel dura durationMs na timeline (não na fonte)', () => {
    const { p, item, cursors } = setup({ speed: 2, durationUs: 7_000_000, cursorFx: fxOn({ highlight: { durationMs: 450 } }) })
    const at = timelineUsAtCursorMs(p, item, 5000)!
    expect(media(p, at, cursors)!.cursor!.rings[0].progress).toBe(0)
    expect(media(p, at + 225_000, cursors)!.cursor!.rings[0].progress).toBeCloseTo(0.5, 9)
    expect(media(p, at + 449_999, cursors)!.cursor!.rings).toHaveLength(1)
    expect(media(p, at + 450_000, cursors)!.cursor!.rings).toHaveLength(0)
  })

  it('R15: reverso — o anel começa quando o clique aparece e anda para a frente na timeline', () => {
    const { p, item, cursors } = setup({ reverse: true, inUs: 1_000_000, durationUs: 10_000_000, cursorFx: fxOn({ highlight: { durationMs: 450 } }) })
    const at = timelineUsAtCursorMs(p, item, 5000)!
    // no reverso, depois do instante do clique a fonte mostra um tempo ANTERIOR ao do clique
    expect(cursorTimeMs(p, item, at + 100_000)!).toBeLessThan(5000)
    expect(media(p, at - 1, cursors)!.cursor!.rings).toHaveLength(0)
    expect(media(p, at, cursors)!.cursor!.rings[0]).toMatchObject({ x: 0.5, y: 0.5, progress: 0 })
    expect(media(p, at + 300_000, cursors)!.cursor!.rings[0].progress).toBeCloseTo(300 / 450, 9)
    expect(media(p, at + 450_000, cursors)!.cursor!.rings).toHaveLength(0)
  })

  it('congelado: sem anéis (R15: não inversível); a seta fica na posição do quadro congelado', () => {
    const { p, item, cursors, track } = setup({ freeze: { atUs: 2_000_000 + 80_000 }, durationUs: 3_000_000 })
    const o = media(p, 2_000_000, cursors)!.cursor!
    expect(o.rings).toHaveLength(0)
    expect(o.sprite).toMatchObject(cursorAt(track, 2000, DEFAULT_CURSOR_FX.cursor.smoothing)!)
    expect(cursorTimeMs(p, item, 2_000_000)).toBe(2000)
  })

  it('cliques fora do trecho usado do clipe nunca aparecem (corte)', () => {
    // fonte de 3 s a 8 s: o clique de 2000 ms fica fora; o de 5000 ms dentro
    const { p, cursors } = setup({ inUs: 3_000_000, durationUs: 5_000_000, cursorFx: fxOn({ cursor: { enabled: false } }) })
    let seen = 0
    for (let t = 1_000_000; t < 6_000_000; t += 1_000_000 / 60) {
      const o = media(p, Math.round(t), cursors)?.cursor
      if (o) for (const r of o.rings) { expect(r.x).toBe(0.5); seen++ }
    }
    expect(seen).toBeGreaterThan(0)
  })

  it('desempenho: 1000 quadros com 216 000 amostras e 2000 cliques < 50 ms (O(log n) por quadro)', () => {
    const samples: CursorTrackV1['samples'] = []
    for (let i = 0; i < 216_000; i++) samples.push({ tMs: i * 16 + 3, x: (i % 997) / 997, y: (i % 541) / 541 })
    const clicks: CursorTrackV1['clicks'] = []
    for (let i = 0; i < 2000; i++) clicks.push({ tMs: 1000 + i * 1700, x: 0.5, y: 0.5, button: 'left' })
    const big: CursorTrackV1 = { version: 1, width: 1920, height: 1080, samples, clicks }
    const { p, cursors } = setup({ inUs: 0, startUs: 0, durationUs: 3_456_000_000 }, big)
    let best = Infinity
    for (let round = 0; round < 5; round++) {
      const t0 = performance.now()
      for (let f = 0; f < 1000; f++) resolveFrame(p, Math.round(((f * 3_456_000) / 1000) * 1000 + f * 1700), cursors)
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(50)
  })
})
