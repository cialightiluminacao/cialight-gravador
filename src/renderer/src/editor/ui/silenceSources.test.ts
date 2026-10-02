import { describe, expect, it } from 'vitest'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import type { Asset, Project, Track } from '@shared/editor/project'
import { defaultSilenceSource, formatSaved, silenceSourceTracks } from './silenceSources'

const S = 1_000_000
const asset = (id: string, kind: Asset['kind'], audio: boolean): Asset => ({
  id, name: id, kind, source: { type: 'file', path: `C:/${id}`, size: 1, mtimeMs: 1 }, durationUs: 10 * S, status: 'ready',
  ...(audio ? { audio: { channels: 2, sampleRate: 48000, codec: 'aac' } } : {})
})
const track = (id: string, kind: Track['kind'], a: Asset | null, role?: Track['role']): Track => ({
  id, kind, name: id, muted: false, hidden: false, locked: false, volume: 1, ...(role ? { role } : {}), items: a ? [{ ...createMediaItem(a, 0, kind), id: `i_${id}` }] : []
})

function proj(): Project {
  const scr = asset('scr', 'video', false), vid = asset('vid', 'video', true), mic = asset('mic', 'audio', true), mus = asset('mus', 'audio', true)
  return { ...createEmptyProject('t'), assets: [scr, vid, mic, mus], tracks: [track('t_scr', 'video', scr), track('t_vid', 'video', vid), track('t_mus', 'audio', mus, 'music'), track('t_sys', 'audio', mic, 'sfx'), track('t_mic', 'audio', mic, 'voice'), track('t_vazia', 'audio', null)] }
}

describe('fontes do Remover silêncios', () => {
  it('só faixas com som; Voz primeiro, música por último', () => {
    expect(silenceSourceTracks(proj()).map((t) => t.id)).toEqual(['t_mic', 't_sys', 't_vid', 't_mus'])
  })
  it('sugestão: a preferida se tiver som, senão a primeira', () => {
    expect(defaultSilenceSource(proj())).toBe('t_mic')
    expect(defaultSilenceSource(proj(), 't_vid')).toBe('t_vid')
    expect(defaultSilenceSource(proj(), 't_scr')).toBe('t_mic')
    expect(defaultSilenceSource(createEmptyProject('x'))).toBeNull()
  })
  it('formatSaved', () => {
    expect(formatSaved(5_400_000)).toBe('5,4 s')
    expect(formatSaved(65_000_000)).toBe('1 min 05 s')
  })
})
