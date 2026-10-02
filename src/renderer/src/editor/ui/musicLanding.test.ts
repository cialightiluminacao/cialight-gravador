import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import { addAsset, addMediaFromAsset, addTrack, findItem, updateTrack } from '@shared/editor/ops'
import type { Asset } from '@shared/editor/project'
import { autoMusicLanding, moveToVoice } from './musicLanding'

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

describe('moveToVoice ("É narração? Mover para Voz")', () => {
  const twoMusics = (): { p: ReturnType<typeof addMediaFromAsset>['project']; a: string; b: string; music: string } => {
    let p = addAsset(addAsset(createEmptyProject('t'), aud), { ...aud, id: 'm2', name: 'm2' })
    const r1 = addMediaFromAsset(p, 'm', 0)
    const r2 = addMediaFromAsset(r1.project, 'm2', 6 * S)
    p = r2.project
    return { p, a: r1.itemIds[0], b: r2.itemIds[0], music: findItem(p, r1.itemIds[0])!.track.id }
  }

  it('move só aquele item para uma faixa nova "Voz"; a faixa Música e o outro item continuam música', () => {
    const { p, a, b, music } = twoMusics()
    const q = moveToVoice(p, a)
    expect(findItem(q, a)!.track).toMatchObject({ name: 'Voz', role: 'voice', kind: 'audio' })
    expect(findItem(q, a)!.item.startUs).toBe(0)
    expect(findItem(q, b)!.track.id).toBe(music)
    expect(q.tracks.find((t) => t.id === music)!.role).toBe('music')
  })

  it('usa uma faixa de Voz existente livre no trecho (não a bloqueada nem a ocupada)', () => {
    const { p, a } = twoMusics()
    let q = addTrack(p, 'audio', undefined, 'Microfone', 'voice').project
    const mic = q.tracks[q.tracks.length - 1].id
    expect(findItem(moveToVoice(q, a), a)!.track.id).toBe(mic)
    q = updateTrack(q, mic, { locked: true })
    expect(findItem(moveToVoice(q, a), a)!.track.name).toBe('Voz')
  })

  it('faixa de música criada só para o item e que ficou vazia sai; item que já não existe: nada muda', () => {
    const r = addMediaFromAsset(addAsset(createEmptyProject('t'), aud), 'm', 0)
    const music = findItem(r.project, r.itemIds[0])!.track.id
    const q = moveToVoice(r.project, r.itemIds[0], { removeEmptyTrackId: music })
    expect(q.tracks.some((t) => t.id === music)).toBe(false)
    expect(findItem(q, r.itemIds[0])!.track.role).toBe('voice')
    expect(moveToVoice(r.project, 'nada')).toBe(r.project)
    // com outro item ainda nela, a faixa fica
    const { p, a, music: m2 } = twoMusics()
    expect(moveToVoice(p, a, { removeEmptyTrackId: m2 }).tracks.some((t) => t.id === m2)).toBe(true)
  })
})
