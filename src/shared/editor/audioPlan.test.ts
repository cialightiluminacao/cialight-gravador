import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, MediaItem, Project } from './project'
import * as ops from './ops'
import { gainAt, planAudio } from './audioPlan'

const S = 1_000_000
const vid = (): Asset => ({ id: 'a1', name: 'a1', kind: 'video', source: { type: 'file', path: 'C:/a.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })

function base(): { p: Project; a: string } {
  const r = ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid()), 'a1', 0)
  return { p: r.project, a: r.itemIds[1] }
}

describe('planAudio', () => {
  it('usa o item de áudio; faixa muda some', () => {
    const { p } = base()
    const segs = planAudio(p)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ assetId: 'a1', startUs: 0, durationUs: 10 * S, srcInUs: 0, speed: 1 })
    expect(planAudio(ops.updateTrack(p, p.tracks[1].id, { muted: true }))).toEqual([])
  })
  it('volume de faixa 0,5 × item 0,5 → 0,25', () => {
    const { p, a } = base()
    const q = ops.updateItem<MediaItem>(ops.updateTrack(p, p.tracks[1].id, { volume: 0.5 }), a, (d) => { d.audio.volume = { value: 0.5 } })
    expect(gainAt(planAudio(q)[0], 5 * S)).toBeCloseTo(0.25)
  })
  it('fadeIn/fadeOut em rampa linear', () => {
    const { p, a } = base()
    const q = ops.updateItem<MediaItem>(p, a, (d) => { d.audio.fadeInUs = S; d.audio.fadeOutUs = 2 * S })
    const s = planAudio(q)[0]
    expect(gainAt(s, 0)).toBe(0)
    expect(gainAt(s, 0.5 * S)).toBeCloseTo(0.5)
    expect(gainAt(s, 5 * S)).toBe(1)
    expect(gainAt(s, 9 * S)).toBeCloseTo(0.5)
    expect(gainAt(s, 10 * S)).toBe(0)
  })
  it('keyframes de volume entram no envelope', () => {
    const { p, a } = base()
    const q = ops.updateItem<MediaItem>(p, a, (d) => { d.audio.volume = { value: 1, keys: [{ tUs: 2 * S, value: 0.2, ease: 'linear' }] } })
    const s = planAudio(q)[0]
    expect(s.gain.some((g) => g.tUs === 2 * S && Math.abs(g.gain - 0.2) < 1e-9)).toBe(true)
  })
  it('vídeo com audio.enabled=false não gera segmento', () => {
    const { p } = base()
    expect(planAudio(p).every((s) => s.itemId !== p.tracks[0].items[0].id)).toBe(true)
  })
  it('item de mídia com enabled:false não entra no plano', () => {
    const { p, a } = base()
    const off = ops.setItemEnabled(p, [a], false)
    expect(planAudio(off)).toEqual([])
    expect(planAudio(ops.setItemEnabled(off, [a], true))).toHaveLength(1)
  })
})
