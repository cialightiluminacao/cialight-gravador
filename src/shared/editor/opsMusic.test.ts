import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, Project } from './project'
import * as ops from './ops'
import { validateProject } from './schema'

// Áudio importado (música) vai para a faixa "Música" (role 'music'); o som de vídeo não entra nela.

const S = 1_000_000
const vid = (id: string): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
const aud = (id: string): Asset => ({ id, name: id, kind: 'audio', source: { type: 'file', path: `C:/${id}.mp3`, size: 1, mtimeMs: 1 }, durationUs: 10 * S, audio: { channels: 2, sampleRate: 44100, codec: 'mp3' }, status: 'ready' })
const withAssets = (...a: Asset[]): Project => a.reduce((p, x) => ops.addAsset(p, x), createEmptyProject('t'))
const trackOf = (p: Project, itemId: string) => ops.findItem(p, itemId)!.track

describe('addMediaFromAsset: música', () => {
  it('áudio importado cria a faixa "Música" com papel música', () => {
    const r = ops.addMediaFromAsset(withAssets(aud('m1')), 'm1', 0)
    const t = trackOf(r.project, r.itemIds[0])
    expect(t).toMatchObject({ kind: 'audio', name: 'Música', role: 'music' })
    expect(validateProject(r.project)).toEqual([])
  })
  it('a 2ª música reusa a faixa de música livre; ocupada → nova "Música 2"', () => {
    let p = ops.addMediaFromAsset(withAssets(aud('m1'), aud('m2'), aud('m3')), 'm1', 0).project
    const r2 = ops.addMediaFromAsset(p, 'm2', 10 * S)
    expect(trackOf(r2.project, r2.itemIds[0]).name).toBe('Música')
    p = r2.project
    const r3 = ops.addMediaFromAsset(p, 'm3', 5 * S)
    expect(trackOf(r3.project, r3.itemIds[0])).toMatchObject({ name: 'Música 2', role: 'music' })
  })
  it('não usa a faixa do som de um vídeo (sem papel) nem a de voz', () => {
    let p = ops.addMediaFromAsset(withAssets(vid('v1'), aud('m1')), 'v1', 0).project
    p = ops.updateTrack(p, p.tracks[1].id, { role: 'voice' })
    const r = ops.addMediaFromAsset(p, 'm1', 20 * S)
    expect(trackOf(r.project, r.itemIds[0]).role).toBe('music')
    expect(r.project.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2)
  })
  it('o som de um vídeo não vai para a faixa de música', () => {
    const p = ops.addMediaFromAsset(withAssets(vid('v1'), aud('m1')), 'm1', 0).project
    const r = ops.addMediaFromAsset(p, 'v1', 20 * S)
    expect(trackOf(r.project, r.itemIds[1]).role).toBeUndefined()
  })
  it('faixa explícita continua valendo (soltar numa faixa de áudio qualquer)', () => {
    const p = ops.addMediaFromAsset(withAssets(vid('v1'), aud('m1')), 'v1', 0).project
    const r = ops.addMediaFromAsset(p, 'm1', 20 * S, { audioTrackId: p.tracks[1].id })
    expect(trackOf(r.project, r.itemIds[0]).id).toBe(p.tracks[1].id)
  })
  it('com modo (insert/overwrite) usa a 1ª faixa de música desbloqueada', () => {
    const p = ops.addMediaFromAsset(withAssets(aud('m1'), aud('m2')), 'm1', 0).project
    const r = ops.addMediaFromAsset(p, 'm2', 2 * S, { mode: 'overwrite' })
    expect(trackOf(r.project, r.itemIds[0]).name).toBe('Música')
  })
})
