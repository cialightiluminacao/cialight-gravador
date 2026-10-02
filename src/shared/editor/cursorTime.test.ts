import { describe, expect, it } from 'vitest'
import { CURSOR_VIDEO_LAG_MS } from '../cursor'
import { createEmptyProject, createMediaItem } from './factory'
import type { Asset, MediaItem, Project } from './project'
import { cursorTimeMap, cursorTimeMs, timelineUsAtCursorMs } from './cursorTime'
import { resolveFrame, type MediaLayer } from './resolve'

const screen: Asset = {
  id: 'scr', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' }, durationUs: 20_000_000,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 }, status: 'ready', cursor: 'cursor.json'
}
const project = (over: Partial<MediaItem>): { p: Project; item: MediaItem } => {
  const p = createEmptyProject('x')
  p.assets = [screen]
  const item: MediaItem = { ...createMediaItem(screen, 0, 'video'), id: 'it', startUs: 1_000_000, durationUs: 4_000_000, ...over }
  p.tracks[0].items = [item]
  return { p, item }
}
/** O tempo da fonte que o resolve manda desenhar (a fonte da verdade do quadro mostrado). */
const shownSrcUs = (p: Project, tUs: number): number => (resolveFrame(p, tUs).find((l) => l.kind === 'media') as MediaLayer).srcUs!

describe('cursorTimeMs (tempo da timeline → tempo da trilha do cursor)', () => {
  const cases: [string, Partial<MediaItem>][] = [
    ['corte (inUs)', { inUs: 3_000_000 }],
    ['velocidade 2×', { inUs: 500_000, speed: 2 }],
    ['reverso', { inUs: 2_000_000, reverse: true }],
    ['reverso a 0,5×', { inUs: 2_000_000, reverse: true, speed: 0.5 }],
    ['congelado', { inUs: 6_000_000, freeze: { atUs: 6_000_000 } }]
  ]
  it.each(cases)('%s: o tempo da fonte do resolve menos o atraso do vídeo (R11)', (_l, over) => {
    const { p, item } = project(over)
    for (let t = item.startUs; t < item.startUs + item.durationUs; t += 123_457) {
      const ms = cursorTimeMs(p, item, t)
      expect(ms).not.toBeNull()
      expect(ms!).toBeCloseTo(shownSrcUs(p, t) / 1000 - CURSOR_VIDEO_LAG_MS, 6)
    }
  })
  it('valores conferidos à mão: corte e 2×', () => {
    expect(cursorTimeMs(project({ inUs: 3_000_000 }).p, project({ inUs: 3_000_000 }).item, 1_500_000)).toBe(3500 - 80)
    const two = project({ inUs: 500_000, speed: 2 })
    expect(cursorTimeMs(two.p, two.item, 2_000_000)).toBe(500 + 2000 - 80)
    const fr = project({ inUs: 6_000_000, freeze: { atUs: 6_000_000 } })
    expect(cursorTimeMs(fr.p, fr.item, 1_000_000)).toBe(6000 - 80)
    expect(cursorTimeMs(fr.p, fr.item, 4_999_999)).toBe(6000 - 80)
  })
  it('fora do clipe ou sem asset de vídeo: null', () => {
    const { p, item } = project({})
    expect(cursorTimeMs(p, item, 999_999)).toBeNull()
    expect(cursorTimeMs(p, item, 5_000_000)).toBeNull()
    expect(cursorTimeMs(p, { ...item, assetId: 'nada' }, 2_000_000)).toBeNull()
    const img = { ...p, assets: [{ ...screen, kind: 'image' as const }] }
    expect(cursorTimeMs(img, item, 2_000_000)).toBeNull()
  })
})

describe('timelineUsAtCursorMs (inverso: tempo do cursor → timeline) e cursorTimeMap', () => {
  const cases: [string, Partial<MediaItem>][] = [
    ['corte (inUs)', { inUs: 3_000_000 }],
    ['velocidade 2×', { inUs: 500_000, speed: 2 }],
    ['velocidade 0,5×', { inUs: 1_000_000, speed: 0.5 }],
    ['reverso', { inUs: 2_000_000, reverse: true }],
    ['reverso a 0,5×', { inUs: 2_000_000, reverse: true, speed: 0.5 }]
  ]
  it.each(cases)('%s: ida e volta (timeline → cursor → timeline) a ±1 µs, denso', (_l, over) => {
    const { p, item } = project(over)
    for (let t = item.startUs; t < item.startUs + item.durationUs; t += 7_919) {
      const ms = cursorTimeMs(p, item, t)!
      const back = timelineUsAtCursorMs(p, item, ms)
      expect(back).not.toBeNull()
      expect(Math.abs(back! - t)).toBeLessThanOrEqual(1)
    }
  })
  it('monótono: crescente no clipe normal, decrescente no reverso', () => {
    const fwd = project({ inUs: 1_000_000, speed: 2 })
    const rev = project({ inUs: 1_000_000, reverse: true })
    let a = -Infinity, b = Infinity
    for (let ms = 1_000; ms < 9_000; ms += 37) {
      const f = timelineUsAtCursorMs(fwd.p, fwd.item, ms)
      if (f !== null) { expect(f).toBeGreaterThanOrEqual(a); a = f }
      const r = timelineUsAtCursorMs(rev.p, rev.item, ms)
      if (r !== null) { expect(r).toBeLessThanOrEqual(b); b = r }
    }
  })
  it('valores à mão; o atraso R11 entra (clique em 3420 ms aparece no quadro de 3500 ms da fonte)', () => {
    const { p, item } = project({ inUs: 3_000_000 })
    expect(timelineUsAtCursorMs(p, item, 3500 - 80)).toBe(1_500_000)
    const two = project({ inUs: 500_000, speed: 2 })
    expect(timelineUsAtCursorMs(two.p, two.item, 500 + 2000 - 80)).toBe(2_000_000)
  })
  it('fora do clipe, congelado, sem asset de vídeo: null', () => {
    const { p, item } = project({ inUs: 3_000_000 })
    expect(timelineUsAtCursorMs(p, item, 3000 - 80 - 1)).toBeNull()
    expect(timelineUsAtCursorMs(p, item, 7000 - 80)).toBeNull()
    const fr = project({ inUs: 6_000_000, freeze: { atUs: 6_000_000 } })
    expect(timelineUsAtCursorMs(fr.p, fr.item, 6000 - 80)).toBeNull()
    expect(timelineUsAtCursorMs(p, { ...item, assetId: 'nada' }, 4000)).toBeNull()
    expect(cursorTimeMap(fr.p, fr.item)).toBeNull()
  })
  it('cursorTimeMap: o mesmo par em tempo local do item', () => {
    const { p, item } = project({ inUs: 500_000, speed: 2 })
    const m = cursorTimeMap(p, item)!
    expect(m.durationUs).toBe(item.durationUs)
    expect(m.reversed).toBe(false)
    expect(m.toCursorMs(1_000_000)).toBe(cursorTimeMs(p, item, item.startUs + 1_000_000))
    expect(m.toLocalUs(m.toCursorMs(1_000_000)!)).toBe(1_000_000)
    expect(m.toCursorMs(item.durationUs)).toBeNull()
    expect(cursorTimeMap(project({ reverse: true }).p, project({ reverse: true }).item)!.reversed).toBe(true)
  })
})
