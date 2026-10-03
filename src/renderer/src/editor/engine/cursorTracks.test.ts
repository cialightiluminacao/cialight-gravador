import { describe, expect, it, vi } from 'vitest'
import type { CursorTrackV1 } from '@shared/cursor'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { DEFAULT_CURSOR_FX, type Asset, type MediaItem, type Project, type Track } from '@shared/editor/project'
import { CursorTrackCache, cursorSessionOf, cursorTrackNeeds, loadCursorTracks } from './cursorTracks'

const track: CursorTrackV1 = { version: 1, width: 10, height: 10, samples: [{ tMs: 0, x: 0, y: 0 }], clicks: [] }
const screen: Asset = { id: 'a', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' }, durationUs: 1, status: 'ready', cursor: 'cursor.json' }

describe('cursorSessionOf', () => {
  it('só a tela de gravação com `cursor` tem trilha', () => {
    expect(cursorSessionOf(screen)).toBe('s1')
    expect(cursorSessionOf({ ...screen, cursor: undefined })).toBeNull()
    expect(cursorSessionOf({ ...screen, source: { type: 'session', sessionId: 's1', stream: 'webcam' } })).toBeNull()
    expect(cursorSessionOf({ ...screen, source: { type: 'file', path: 'x', size: 1, mtimeMs: 1 } })).toBeNull()
    expect(cursorSessionOf(undefined)).toBeNull()
  })
})

describe('CursorTrackCache (uma leitura por gravação, compartilhada)', () => {
  it('pedidos simultâneos e seguintes usam a mesma leitura; peek síncrono depois de carregar', async () => {
    const read = vi.fn(async (_id: string) => track)
    const c = new CursorTrackCache(read)
    expect(c.peek('s1')).toBeUndefined()
    const [a, b] = await Promise.all([c.load('s1'), c.load('s1')])
    expect(a).toBe(track)
    expect(b).toBe(track)
    expect(await c.load('s1')).toBe(track)
    expect(c.peek('s1')).toBe(track)
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('sem trilha (null) ou falha do IPC: devolve null, não fica em cache (tenta de novo depois)', async () => {
    let n = 0
    const read = vi.fn(async (id: string) => {
      n++
      if (id === 'erro') throw new Error('ipc')
      return n > 2 ? track : null
    })
    const c = new CursorTrackCache(read)
    expect(await c.load('s2')).toBeNull()
    expect(await c.load('erro')).toBeNull()
    expect(c.peek('s2')).toBeUndefined()
    expect(await c.load('s2')).toBe(track)
    expect(read).toHaveBeenCalledTimes(3)
  })
})

describe('trilhas que o render precisa (cursorTrackNeeds / loadCursorTracks)', () => {
  const webcam: Asset = { ...screen, id: 'w', source: { type: 'session', sessionId: 's1', stream: 'webcam' }, cursor: undefined }
  const other: Asset = { ...screen, id: 'b', source: { type: 'session', sessionId: 's2', stream: 'screen' } }
  const on = { highlight: { ...DEFAULT_CURSOR_FX.highlight, enabled: true }, cursor: { ...DEFAULT_CURSOR_FX.cursor } }
  const mk = (): Project => {
    const p = createEmptyProject('x')
    p.assets = [screen, webcam, other]
    const it = (a: Asset, id: string, over: Partial<MediaItem> = {}): MediaItem => ({ ...createMediaItem(a, 0, 'video'), id, ...over })
    const audio: Track = { id: 't_a', kind: 'audio', name: 'Áudio', muted: false, hidden: false, locked: false, volume: 1, items: [it(other, 'aud', { cursorFx: on, visual: undefined })] }
    p.tracks = [
      { ...p.tracks[0], items: [it(screen, 'i1', { cursorFx: on }), it(webcam, 'i2', { startUs: 5_000_000, cursorFx: on })] },
      { ...p.tracks[0], id: 't2', items: [it(other, 'i3', { cursorFx: { ...on, highlight: { ...on.highlight, enabled: false } } })] },
      audio
    ]
    return p
  }
  it('só assets de tela com trilha usados por clipe de vídeo com algum efeito ligado', () => {
    expect([...cursorTrackNeeds(mk())]).toEqual([['a', 's1']])
    const p = mk()
    ;(p.tracks[1].items[0] as MediaItem).cursorFx = { ...on, cursor: { ...on.cursor, enabled: true } }
    expect([...cursorTrackNeeds(p)]).toEqual([['a', 's1'], ['b', 's2']])
  })
  it('loadCursorTracks: as trilhas por asset e os assets cuja trilha não carregou', async () => {
    const p = mk()
    ;(p.tracks[1].items[0] as MediaItem).cursorFx = on
    const c = new CursorTrackCache(async (id) => (id === 's1' ? track : null))
    const r = await loadCursorTracks(p, c)
    expect([...r.tracks]).toEqual([['a', track]])
    expect(r.failed).toEqual(['b'])
  })
})
