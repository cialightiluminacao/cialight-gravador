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

  it('válido: lê a trilha (assíncrono) e o asset aponta para cursor.json', async () => {
    writeFileSync(join(dir, CURSOR_FILE), JSON.stringify(track))
    await expect(readSessionCursorTrack(dir)).resolves.toEqual(track)
    expect(sessionCursorRef(dir)).toBe('cursor.json')
  })
  it('ausente, JSON quebrado, versão desconhecida ou tMs fora de ordem: leitura null, sem lançar', async () => {
    await expect(readSessionCursorTrack(dir)).resolves.toBeNull()
    for (const body of ['{', JSON.stringify({ ...track, version: 2 }), JSON.stringify({ ...track, samples: [{ tMs: 5, x: 0, y: 0 }, { tMs: 5, x: 1, y: 1 }] })]) {
      writeFileSync(join(dir, CURSOR_FILE), body)
      await expect(readSessionCursorTrack(dir)).resolves.toBeNull()
    }
    await expect(readSessionCursorTrack(join(dir, 'nao-existe'))).resolves.toBeNull()
  })
  it('sessionCursorRef: só confere o cabeçalho (barato); sem arquivo, vazio ou outra versão → null', () => {
    expect(sessionCursorRef(dir)).toBeNull()
    for (const [body, want] of [
      ['', null],
      ['{', null],
      ['lixo', null],
      [JSON.stringify({ ...track, version: 2 }), null],
      [JSON.stringify({ ...track, version: 12 }), null],
      [JSON.stringify(track), 'cursor.json'],
      [`{ "version" : 1 , "width": 1}`, 'cursor.json'],
      // corpo inválido com cabeçalho certo: o flag fica (a leitura completa, no IPC, devolve null = "sem dados")
      [JSON.stringify({ ...track, samples: [{ tMs: 5, x: 0, y: 0 }, { tMs: 5, x: 1, y: 1 }] }), 'cursor.json']
    ] as const) {
      writeFileSync(join(dir, CURSOR_FILE), body)
      expect(sessionCursorRef(dir)).toBe(want)
    }
  })
  it('desempenho (1 h a 60 Hz, 216 000 amostras): flag em < 5 ms; leitura completa assíncrona válida', async () => {
    const n = 216_000
    const samples = Array.from({ length: n }, (_, i) => ({ tMs: Math.round(i * 16.667), x: (i % 1920) / 1920, y: (i % 1080) / 1080 }))
    const big: CursorTrackV1 = { version: 1, width: 1920, height: 1080, samples, clicks: Array.from({ length: 2000 }, (_, i) => ({ tMs: i * 1800, x: 0.5, y: 0.5, button: 'left' as const })) }
    const json = JSON.stringify(big)
    writeFileSync(join(dir, CURSOR_FILE), json)
    sessionCursorRef(dir) // aquece
    let flagMs = Infinity
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now()
      expect(sessionCursorRef(dir)).toBe('cursor.json')
      flagMs = Math.min(flagMs, performance.now() - t0)
    }
    // medido (relatório da Task 2): 12,7 MB; flag ~0,6 ms (antes, validação completa: ~95 ms síncronos no main);
    // leitura assíncrona + JSON.parse + zod ~120 ms, só quando o editor pede a trilha
    const got = await readSessionCursorTrack(dir)
    expect(got?.samples.length).toBe(n)
    expect(json.length).toBeGreaterThan(10e6)
    expect(flagMs).toBeLessThan(5)
  })
})

describe('sessionDirFor (só pastas de gravação)', () => {
  const store = new SessionStore({ rawRoot: () => 'C:/brutos', trash: async () => {} })
  const dirOf = (id: string): string => store.dirOf(id)
  it('id de gravação → pasta dentro dos brutos', () => expect(sessionDirFor(dirOf, '2026-10-02T17-00-00')).toBe(join('C:/brutos', '2026-10-02T17-00-00')))
  it.each(['..', '.', '', '../x', 'a/b', 'a\\b', '..\\x', 'C:', 42, null])('recusa %s', (id) => expect(sessionDirFor(dirOf, id)).toBeNull())
})
