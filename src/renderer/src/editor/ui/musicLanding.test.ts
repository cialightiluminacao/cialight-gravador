import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import { addAsset, addMediaFromAsset } from '@shared/editor/ops'
import type { Asset } from '@shared/editor/project'
import { autoMusicLanding } from './musicLanding'

const S = 1_000_000
const aud: Asset = { id: 'm', name: 'm', kind: 'audio', source: { type: 'file', path: 'C:/m.mp3', size: 1, mtimeMs: 1 }, durationUs: 5 * S, audio: { channels: 2, sampleRate: 44100, codec: 'mp3' }, status: 'ready' }
const vid: Asset = { ...aud, id: 'v', name: 'v', kind: 'video', video: { width: 640, height: 360, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S } }

describe('autoMusicLanding (aviso "É narração? Mover para Voz")', () => {
  it('áudio importado que caiu sozinho na faixa Música', () => {
    const r = addMediaFromAsset(addAsset(createEmptyProject('t'), aud), 'm', 0)
    expect(autoMusicLanding(r.project, 'm', r.itemIds, true)).toEqual({ trackId: r.project.tracks.find((t) => t.role === 'music')!.id, trackName: 'Música' })
  })
  it('faixa escolhida pelo usuário, vídeo ou faixa sem papel de música: sem aviso', () => {
    const r = addMediaFromAsset(addAsset(createEmptyProject('t'), aud), 'm', 0)
    expect(autoMusicLanding(r.project, 'm', r.itemIds, false)).toBeNull()
    const v = addMediaFromAsset(addAsset(createEmptyProject('t'), vid), 'v', 0)
    expect(autoMusicLanding(v.project, 'v', v.itemIds, true)).toBeNull()
    const sfx = { ...r.project, tracks: r.project.tracks.map((t) => ({ ...t, role: 'sfx' as const })) }
    expect(autoMusicLanding(sfx, 'm', r.itemIds, true)).toBeNull()
  })
})
