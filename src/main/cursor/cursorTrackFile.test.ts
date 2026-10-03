import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// espiões sobre o fs real (o código só passa por eles): o flag lê UM pedaço de ≤ 64 bytes, nunca o arquivo inteiro
vi.mock('fs', async (importOriginal) => {
  const o = await importOriginal<typeof import('fs')>()
  const spied = { ...o, readSync: vi.fn(o.readSync), readFileSync: vi.fn(o.readFileSync), readFile: vi.fn(o.readFile) }
  return { ...spied, default: spied }
})
vi.mock('fs/promises', async (importOriginal) => {
  const o = await importOriginal<typeof import('fs/promises')>()
  const spied = { ...o, readFile: vi.fn(o.readFile) }
  return { ...spied, default: spied }
})

import * as fs from 'fs'
import * as fsp from 'fs/promises'
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
  it('flag lê só o cabeçalho: uma leitura de ≤ 64 bytes, nenhuma leitura do arquivo inteiro (corpo de 12 MB que nem é JSON)', () => {
    const header = `{"version":1,"width":1920,"height":1080,"samples":[`.padEnd(64, ' ')
    expect(Buffer.byteLength(header)).toBe(64)
    writeFileSync(join(dir, CURSOR_FILE), header + 'x'.repeat(12_000_000))
    vi.mocked(fs.readSync).mockClear()
    vi.mocked(fs.readFileSync).mockClear()
    vi.mocked(fs.readFile).mockClear()
    vi.mocked(fsp.readFile).mockClear()
    expect(sessionCursorRef(dir)).toBe('cursor.json')
    const reads = vi.mocked(fs.readSync).mock.calls as unknown as [number, Buffer, number, number, number][]
    expect(reads).toHaveLength(1)
    // readSync(fd, buffer, offset, length, position)
    expect(reads[0][3]).toBeLessThanOrEqual(64)
    expect(reads[0][4]).toBe(0)
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
    expect(fsp.readFile).not.toHaveBeenCalled()
  })
  it('desempenho (1 h a 60 Hz, 216 000 amostras): flag < 5 % da leitura completa (teto de 50 ms); leitura completa assíncrona válida', async () => {
    const n = 216_000
    const samples = Array.from({ length: n }, (_, i) => ({ tMs: Math.round(i * 16.667), x: (i % 1920) / 1920, y: (i % 1080) / 1080 }))
    const big: CursorTrackV1 = { version: 1, width: 1920, height: 1080, samples, clicks: Array.from({ length: 2000 }, (_, i) => ({ tMs: i * 1800, x: 0.5, y: 0.5, button: 'left' as const })) }
    const json = JSON.stringify(big)
    writeFileSync(join(dir, CURSOR_FILE), json)
    expect(json.length).toBeGreaterThan(10e6)
    sessionCursorRef(dir) // aquece
    // relativo, medido no mesmo processo e na mesma carga: a leitura completa (12,7 MB + JSON.parse + zod, ~120 ms no
    // relatório da Task 2) contra o flag (~0,6 ms). Intercalados em 3 rodadas e o mínimo de 30 flags: com a máquina
    // cheia (outros testes em paralelo) uma chamada síncrona curta perde o quantum do agendador (~15 ms no Windows) —
    // o mínimo é o custo da chamada, não a carga. O teto absoluto só pega uma regressão grosseira.
    let flagMs = Infinity, fullMs = Infinity
    for (let round = 0; round < 3; round++) {
      for (let r = 0; r < 10; r++) {
        const t0 = performance.now()
        expect(sessionCursorRef(dir)).toBe('cursor.json')
        flagMs = Math.min(flagMs, performance.now() - t0)
      }
      const t0 = performance.now()
      const got = await readSessionCursorTrack(dir)
      fullMs = Math.min(fullMs, performance.now() - t0)
      expect(got?.samples.length).toBe(n)
    }
    expect(flagMs, `flag ${flagMs.toFixed(2)} ms × leitura completa ${fullMs.toFixed(1)} ms`).toBeLessThan(0.05 * fullMs)
    expect(flagMs).toBeLessThan(50)
  })
})

describe('sessionDirFor (só pastas de gravação)', () => {
  const store = new SessionStore({ rawRoot: () => 'C:/brutos', trash: async () => {} })
  const dirOf = (id: string): string => store.dirOf(id)
  it('id de gravação → pasta dentro dos brutos', () => expect(sessionDirFor(dirOf, '2026-10-02T17-00-00')).toBe(join('C:/brutos', '2026-10-02T17-00-00')))
  it.each(['..', '.', '', '../x', 'a/b', 'a\\b', '..\\x', 'C:', 42, null])('recusa %s', (id) => expect(sessionDirFor(dirOf, id)).toBeNull())
})
