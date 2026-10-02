import { describe, expect, it, vi } from 'vitest'
import type { CursorTrackV1 } from '@shared/cursor'
import type { Asset } from '@shared/editor/project'
import { CursorTrackCache, cursorSessionOf } from './cursorTracks'

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
