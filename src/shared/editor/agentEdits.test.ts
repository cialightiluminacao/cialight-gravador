import { describe, expect, it } from 'vitest'
import { agentTools } from '../agentProtocol'
import { applyAgentEdits } from './agentEdits'
import { createEmptyProject } from './factory'
import { addAsset, addMediaFromAsset, findItem, projectDurationUs } from './ops'
import type { Asset } from './project'

function fixture() {
  const asset: Asset = { id: 'video', name: 'fala.mp4', kind: 'video', durationUs: 10_000_000, source: { type: 'file', path: 'C:/fala.mp4', size: 100, mtimeMs: 1 }, video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 0, gopUs: 1_000_000, decodable: true }, audio: { codec: 'aac', channels: 2, sampleRate: 48000 }, status: 'ready' }
  return addAsset(createEmptyProject('Teste'), asset)
}
describe('agent edit transactions', () => {
  it('assembles linked video/audio with a source cut, titles and captions in seconds', () => {
    const before = fixture()
    const actions = agentTools.cialight_edit.schema.parse({ projectId: 'p', revision: 'r', actions: [{ type: 'add_media', assetId: 'video', at: 0, sourceStart: 2, duration: 5 }, { type: 'text', at: 0, duration: 2, text: 'Demonstração' }, { type: 'caption', at: 2, duration: 1, text: 'Olá' }] }).actions
    const r = applyAgentEdits(before, actions)
    const media = r.project.tracks.flatMap(t => t.items).filter(i => i.type === 'media')
    expect(media).toHaveLength(2)
    expect(media.every(i => i.inUs === 2_000_000 && i.durationUs === 5_000_000)).toBe(true)
    expect(media[0].linkId).toBe(media[1].linkId)
    expect(projectDurationUs(r.project)).toBe(5_000_000)
    expect(r.createdIds).toHaveLength(4)
    expect(before.tracks.flatMap(t => t.items)).toHaveLength(0)
  })
  it('rejects a source range outside the asset without mutating the input', () => {
    const before = fixture()
    expect(() => applyAgentEdits(before, [{ type: 'rename', name: 'Changed' }, { type: 'add_media', assetId: 'video', at: 0, sourceStart: 8, duration: 5 }])).toThrow()
    expect(before.name).toBe('Teste')
    expect(before.tracks.flatMap(t => t.items)).toHaveLength(0)
  })
  it('keeps locked tracks intact and rejects edits on them', () => {
    const r = addMediaFromAsset(fixture(), 'video', 0)
    const p = { ...r.project, tracks: r.project.tracks.map(t => ({ ...t, locked: true })) }
    expect(() => applyAgentEdits(p, [{ type: 'audio', itemId: r.itemIds[1], volume: 0.5 }])).toThrow()
    expect(findItem(p, r.itemIds[1])?.item).toEqual(findItem(r.project, r.itemIds[1])?.item)
  })
  it('splits and removes synchronized ranges without losing linked audio', () => {
    const p = addMediaFromAsset(fixture(), 'video', 0).project
    const r = applyAgentEdits(p, [{ type: 'delete_ranges', ranges: [{ from: 3, to: 5 }] }])
    expect(projectDurationUs(r.project)).toBe(8_000_000)
    expect(r.project.tracks.filter(t => t.items.some(i => i.type === 'media')).map(t => t.items.reduce((n, i) => n + i.durationUs, 0))).toEqual([8_000_000, 8_000_000])
  })
  it('rejects unknown operations, nonfinite times and reversed cut ranges', () => {
    const parse = (action: unknown) => agentTools.cialight_edit.schema.parse({ projectId: 'p', revision: 'r', actions: [action] })
    expect(() => parse({ type: 'shell', command: 'anything' })).toThrow()
    expect(() => parse({ type: 'marker', at: Infinity, label: '' })).toThrow()
    expect(() => parse({ type: 'delete_ranges', ranges: [{ from: 4, to: 2 }] })).toThrow()
    expect(() => parse({ type: 'rename', name: 'x', unexpected: 'field' })).toThrow()
  })
  it('updates an existing animation key without deleting it, and rejects keys outside the clip', () => {
    const r = addMediaFromAsset(fixture(), 'video', 0)
    const key = { type: 'keyframe' as const, itemId: r.itemIds[0], path: 'transform.scale' as const, at: 1, value: 1.5, ease: 'inOut' as const }
    const first = applyAgentEdits(r.project, [key]).project
    const second = applyAgentEdits(first, [{ ...key, value: 2 }]).project
    const item = findItem(second, key.itemId)?.item
    expect(item?.type === 'media' && item.visual?.transform.scale.keys).toEqual([{ tUs: 1_000_000, value: 2, ease: 'inOut' }])
    expect(() => applyAgentEdits(second, [{ ...key, at: 20 }])).toThrow()
  })
  it('uses the requested source duration when placing adjacent clips on the same tracks', () => {
    const p = fixture()
    const first = applyAgentEdits(p, [{ type: 'add_media', assetId: 'video', at: 3, sourceStart: 0, duration: 2 }]).project
    const second = applyAgentEdits(first, [{ type: 'add_media', assetId: 'video', at: 0, sourceStart: 7, duration: 3 }]).project
    expect(second.tracks.filter(t => t.items.some(i => i.type === 'media'))).toHaveLength(2)
    expect(second.tracks.every(t => t.items.length === 2)).toBe(true)
  })
})
