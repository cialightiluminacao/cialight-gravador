import { describe, expect, it } from 'vitest'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import type { Asset, Project, Track } from '@shared/editor/project'
import { duckingHint } from './duckingHint'

const aud = (id: string, speech?: string): Asset => ({ id, name: id, kind: 'audio', source: { type: 'file', path: `C:/${id}.m4a`, size: 1, mtimeMs: 1 }, durationUs: 5_000_000, audio: { channels: 2, sampleRate: 48000, codec: 'aac' }, status: 'ready', ...(speech ? { speech } : {}) })
const track = (id: string, role: Track['role'], a: Asset, over: Partial<Track> = {}): Track => ({ id, kind: 'audio', name: id, muted: false, hidden: false, locked: false, volume: 1, role, items: [{ ...createMediaItem(a, 0, 'audio'), id: `i_${id}` }], ...over })

function proj(voiceSpeech: boolean, tracks?: (v: Asset, m: Asset) => Track[]): Project {
  const v = aud('v', voiceSpeech ? 'cache/v.speech.json' : undefined)
  const m = aud('m')
  return { ...createEmptyProject('t'), assets: [v, m], tracks: tracks ? tracks(v, m) : [track('tv', 'voice', v), track('tm', 'music', m)] }
}

describe('duckingHint', () => {
  it('tudo pronto: sem aviso', () => {
    expect(duckingHint(proj(true))).toBeNull()
  })
  it('sem música, sem voz audível ou voz sem análise de fala: explica', () => {
    expect(duckingHint(proj(true, (v) => [track('tv', 'voice', v)]))).toMatch(/Nenhuma música/)
    expect(duckingHint(proj(true, (v, m) => [track('tv', 'voice', v, { muted: true }), track('tm', 'music', m)]))).toMatch(/Nenhuma faixa de Voz/)
    expect(duckingHint(proj(true, (v, m) => [track('tv', 'sfx', v), track('tm', 'music', m)]))).toMatch(/Nenhuma faixa de Voz/)
    expect(duckingHint(proj(false))).toMatch(/sem análise de fala/)
    // speech.json que não carregou no worker conta como sem dados
    expect(duckingHint(proj(true), { v: true })).toMatch(/sem análise de fala/)
    expect(duckingHint(proj(true), { m: true })).toBeNull()
  })
})
