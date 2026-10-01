import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore } from './sessionStore'
import type { RecordingConfig } from '@shared/types'
import { DEFAULT_PIP } from '@shared/defaults'

const config: RecordingConfig = {
  source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', displayId: '1' },
  quality: '1080p',
  fps: 30,
  countdownSec: 3,
  webcam: { deviceId: 'cam', label: 'Cam', mirrored: true },
  mic: { deviceId: 'mic', label: 'Mic', echoCancellation: false, noiseSuppression: true, autoGainControl: true },
  systemAudio: true,
  pipInitial: DEFAULT_PIP
}
const extra = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1.640028', bitrate: 12e6 } }

describe('SessionStore', () => {
  let root: string
  let trashed: string[]
  let store: SessionStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cl-sess-'))
    trashed = []
    store = new SessionStore({ rawRoot: () => root, trash: async (p) => { trashed.push(p); rmSync(p, { recursive: true, force: true }) } })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('create cria pasta e session.json inicial', () => {
    const { dir, session } = store.create(config, '2026-08-18T10-00-00', extra)
    expect(existsSync(join(dir, 'session.json'))).toBe(true)
    expect(session.state).toBe('recording')
    expect(session.pip[0]).toEqual(DEFAULT_PIP)
    expect(store.get('2026-08-18T10-00-00')?.source.name).toBe('Monitor 1')
  })

  it('escrita posicional grava nos offsets certos', () => {
    store.create(config, 's1', extra)
    const h = store.openWrite('s1', 'rec.mp4')
    store.write(h, new Uint8Array([1, 2, 3, 4]), 0)
    store.write(h, new Uint8Array([9, 9]), 1)
    store.write(h, new Uint8Array([7]), 6)
    store.closeWrite(h)
    const buf = readFileSync(join(root, 's1', 'rec.mp4'))
    expect([...buf]).toEqual([1, 9, 9, 4, 0, 0, 7])
  })

  it('save sobrescreve atomicamente e list ordena por data desc', () => {
    const a = store.create(config, 'a', extra).session
    const b = store.create(config, 'b', extra).session
    a.createdAt = '2026-08-18T10:00:00.000Z'
    b.createdAt = '2026-08-18T11:00:00.000Z'
    a.state = 'stopped'
    a.durationMs = 1234
    store.save(a)
    store.save(b)
    const list = store.list()
    expect(list.map((s) => s.id)).toEqual(['b', 'a'])
    expect(list[1].durationMs).toBe(1234)
    expect(existsSync(join(root, 'a', 'session.json.tmp'))).toBe(false)
  })

  it('findUnfinished retorna só sessões em gravação', () => {
    const a = store.create(config, 'a', extra).session
    store.create(config, 'b', extra)
    a.state = 'stopped'
    store.save(a)
    expect(store.findUnfinished().map((s) => s.id)).toEqual(['b'])
  })

  it('delete envia à lixeira e cleanupOld respeita a idade', async () => {
    const a = store.create(config, 'a', extra).session
    a.state = 'finalized'
    a.createdAt = '2020-01-01T00:00:00.000Z'
    store.save(a)
    store.create(config, 'b', extra)
    const n = await store.cleanupOld(30)
    expect(n).toBe(1)
    expect(trashed[0]).toBe(join(root, 'a'))
    expect(store.list().map((s) => s.id)).toEqual(['b'])
  })

  it('cleanupOld nunca apaga gravação usada por um projeto', async () => {
    for (const id of ['velha-usada', 'velha-livre']) {
      const s = store.create(config, id, extra).session
      s.state = 'finalized'
      s.createdAt = '2020-01-01T00:00:00.000Z'
      store.save(s)
    }
    const n = await store.cleanupOld(30, (id) => id === 'velha-usada')
    expect(n).toBe(1)
    expect(trashed).toEqual([join(root, 'velha-livre')])
    expect(store.list().map((s) => s.id)).toEqual(['velha-usada'])
  })

  it('rejeita ids e nomes perigosos', () => {
    expect(() => store.dirOf('../x')).toThrow()
    expect(() => store.filePath('a', '..\\b')).toThrow()
  })

  it('freeSpaceMB retorna número positivo', async () => {
    expect(await store.freeSpaceMB()).toBeGreaterThan(0)
  })
})
