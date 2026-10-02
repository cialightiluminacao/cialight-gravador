import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CURSOR_FILE, type CursorTrackV1 } from '@shared/cursor'
import { readSessionCursorTrack, sessionCursorRef, sessionDirFor } from './cursorTrackFile'
import { SessionStore } from '../session/sessionStore'

const track: CursorTrackV1 = { version: 1, width: 1920, height: 1080, samples: [{ tMs: 0, x: 0.5, y: 0.5 }, { tMs: 16, x: 0.6, y: 0.5 }], clicks: [{ tMs: 8, x: 0.55, y: 0.5, button: 'left' }] }

describe('cursor.json da gravação', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cialight-cursor-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('válido: lê a trilha e o asset aponta para cursor.json', () => {
    writeFileSync(join(dir, CURSOR_FILE), JSON.stringify(track))
    expect(readSessionCursorTrack(dir)).toEqual(track)
    expect(sessionCursorRef(dir)).toBe('cursor.json')
  })
  it('ausente, JSON quebrado, versão desconhecida ou tMs fora de ordem: null, sem lançar', () => {
    expect(readSessionCursorTrack(dir)).toBeNull()
    expect(sessionCursorRef(dir)).toBeNull()
    for (const body of ['{', JSON.stringify({ ...track, version: 2 }), JSON.stringify({ ...track, samples: [{ tMs: 5, x: 0, y: 0 }, { tMs: 5, x: 1, y: 1 }] })]) {
      writeFileSync(join(dir, CURSOR_FILE), body)
      expect(readSessionCursorTrack(dir)).toBeNull()
      expect(sessionCursorRef(dir)).toBeNull()
    }
    expect(readSessionCursorTrack(join(dir, 'nao-existe'))).toBeNull()
  })
})

describe('sessionDirFor (só pastas de gravação)', () => {
  const store = new SessionStore({ rawRoot: () => 'C:/brutos', trash: async () => {} })
  const dirOf = (id: string): string => store.dirOf(id)
  it('id de gravação → pasta dentro dos brutos', () => expect(sessionDirFor(dirOf, '2026-10-02T17-00-00')).toBe(join('C:/brutos', '2026-10-02T17-00-00')))
  it.each(['..', '.', '', '../x', 'a/b', 'a\\b', '..\\x', 'C:', 42, null])('recusa %s', (id) => expect(sessionDirFor(dirOf, id)).toBeNull())
})
