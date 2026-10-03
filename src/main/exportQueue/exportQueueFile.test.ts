import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PersistedQueueItem } from '@shared/exportQueueFile'
import { ExportQueueFile, exportQueueFileFor, pidAlive, resolveExportQueueFile, sweepStaleQueueFiles } from './exportQueueFile'

describe('exportQueueFileFor', () => {
  it('uso normal: userData', () => {
    expect(exportQueueFileFor({}, 'C:/UD', 'C:/repo')).toBe(resolve('C:/UD', 'export-queue.json'))
  })
  it('CIALIGHT_EXPORT_QUEUE_FILE vence', () => {
    expect(exportQueueFileFor({ CIALIGHT_EXPORT_QUEUE_FILE: 'test-out/q.json', CIALIGHT_QA: '1' }, 'C:/UD', 'C:/repo')).toBe(join('C:/repo', 'test-out', 'q.json'))
  })
  it('teste/QA/shot NUNCA usam o userData: arquivo por instância (PID), efêmero', () => {
    const want = join('C:/repo', 'test-out', 'export-queue', 'export-queue-42.json')
    expect(exportQueueFileFor({ CIALIGHT_QA: 'x', CIALIGHT_RAW_DIR: 'test-out/raw' }, 'C:/UD', 'C:/repo', 42)).toBe(want)
    expect(exportQueueFileFor({ CIALIGHT_TEST: 'x' }, 'C:/UD', 'C:/repo', 42)).toBe(want)
    expect(exportQueueFileFor({ CIALIGHT_SHOT: '1' }, 'C:/UD', 'C:/repo', 42)).toBe(want)
    expect(exportQueueFileFor({ CIALIGHT_QA: 'x', CIALIGHT_RAW_DIR: 'out2/raw' }, 'C:/UD', 'C:/repo', 42)).toBe(join('C:/repo', 'out2', 'export-queue', 'export-queue-42.json'))
    // duas instâncias em paralelo nunca dividem o arquivo
    expect(exportQueueFileFor({ CIALIGHT_QA: 'x' }, 'C:/UD', 'C:/repo', 1)).not.toBe(exportQueueFileFor({ CIALIGHT_QA: 'x' }, 'C:/UD', 'C:/repo', 2))
    expect(resolveExportQueueFile({ CIALIGHT_QA: 'x' }, 'C:/UD', 'C:/repo', 42).ephemeral).toBe(true)
    expect(resolveExportQueueFile({ CIALIGHT_QA: 'x', CIALIGHT_EXPORT_QUEUE_FILE: 'q.json' }, 'C:/UD', 'C:/repo', 42).ephemeral).toBe(false)
    expect(resolveExportQueueFile({}, 'C:/UD', 'C:/repo', 42).ephemeral).toBe(false)
  })
})

const item = (name: string): PersistedQueueItem => ({
  kind: 'video',
  label: name,
  durationUs: 1,
  privacy: [],
  projectId: 'p_1',
  createdAt: 1,
  request: { project: { id: 'p_1' }, fromUs: 0, toUs: 1, outputDir: 'C:/saida', fileName: name }
})

describe('ExportQueueFile', () => {
  let dir: string
  let file: string
  const warns: unknown[][] = []
  const mk = (): ExportQueueFile => new ExportQueueFile(file, { warn: (...a) => warns.push(a) })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eq-'))
    file = join(dir, 'sub', 'export-queue.json')
    warns.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ausente → vazio; grava atômico (sem sobra de tmp) e o último estado vence', () => {
    const q = mk()
    expect(q.load()).toEqual([])
    q.save([item('a.mp4'), item('b.mp4')])
    q.save([item('c.mp4')])
    expect(q.load().map((i) => i.label)).toEqual(['c.mp4'])
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
    expect(readdirSync(join(dir, 'sub'))).toEqual(['export-queue.json'])
  })
  it('vazio é gravado como envelope vazio', () => {
    const q = mk()
    q.save([item('a.mp4')])
    q.save([])
    expect(q.load()).toEqual([])
    expect(existsSync(file)).toBe(true)
  })
  it('save revalida: lixo do renderer não entra', () => {
    const q = mk()
    q.save([item('a.mp4'), { kind: 'video' }, 'x'])
    expect(q.load().map((i) => i.label)).toEqual(['a.mp4'])
  })
  it('corrompido → vazio, sem lançar, arquivo guardado como .bad', () => {
    const q = mk()
    q.save([item('a.mp4')])
    writeFileSync(file, '{lixo', 'utf8')
    expect(q.load()).toEqual([])
    expect(existsSync(`${file}.bad`)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(warns.length).toBeGreaterThan(0)
  })
  it('versão desconhecida → vazio e .bad', () => {
    const q = mk()
    q.save([])
    writeFileSync(file, JSON.stringify({ version: 99, items: [item('a.mp4')] }), 'utf8')
    expect(q.load()).toEqual([])
    expect(existsSync(`${file}.bad`)).toBe(true)
  })
})

describe('sweepStaleQueueFiles (teste/QA: arquivos por instância de processos mortos)', () => {
  it('apaga só os de PIDs mortos; os vivos e os alheios ficam', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qsweep-'))
    try {
      for (const n of ['export-queue-1.json', 'export-queue-2.json', 'export-queue-2.json.bad', 'export-queue-3.json.tmp-9', 'export-queue.json', 'outro.json']) writeFileSync(join(dir, n), '{}')
      expect(sweepStaleQueueFiles(dir, (pid) => pid === 1)).toBe(3)
      expect(readdirSync(dir).sort()).toEqual(['export-queue-1.json', 'export-queue.json', 'outro.json'])
      expect(sweepStaleQueueFiles(join(dir, 'nao-existe'))).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('pidAlive: o próprio processo vive', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })
})
