import { describe, expect, it } from 'vitest'
import { parseSession, parseSettings, SessionSchema } from './schemas'
import { DEFAULT_SETTINGS } from './defaults'

describe('parseSettings', () => {
  it('objeto vazio → defaults completos', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS)
  })
  it('undefined/JSON inválido → defaults', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('lixo')).toEqual(DEFAULT_SETTINGS)
  })
  it('atalho parcial mantém os demais padrões', () => {
    const s = parseSettings({ hotkeys: { toggleRecord: 'CommandOrControl+Alt+R', annotate: null } })
    expect(s.hotkeys.toggleRecord).toBe('CommandOrControl+Alt+R')
    expect(s.hotkeys.annotate).toBeNull()
    expect(s.hotkeys.pauseResume).toBe(DEFAULT_SETTINGS.hotkeys.pauseResume)
  })
  it('campos aninhados parciais fazem merge', () => {
    const s = parseSettings({ devices: { cameraOn: false }, pip: { shape: 'rounded' }, rawRetentionDays: null })
    expect(s.devices.cameraOn).toBe(false)
    expect(s.devices.micOn).toBe(true)
    expect(s.pip.shape).toBe('rounded')
    expect(s.pip.w).toBe(DEFAULT_SETTINGS.pip.w)
    expect(s.rawRetentionDays).toBeNull()
  })
  it('probe de encoders: aceita AMF; probe ilegível vira null sem perder o resto', () => {
    const probe = { gpuKey: 'AMD:1:1', probedAt: 'x', available: ['h264_amf', 'libx264'], preferred: 'h264_amf' }
    expect(parseSettings({ lastEncoderProbe: probe }).lastEncoderProbe).toEqual(probe)
    const s = parseSettings({ quality: '720p', lastEncoderProbe: { ...probe, preferred: 'h264_vaapi' } })
    expect(s.lastEncoderProbe).toBeNull()
    expect(s.quality).toBe('720p')
  })
  it('campo desconhecido é ignorado', () => {
    const s = parseSettings({ foo: 1, quality: '720p' })
    expect(s.quality).toBe('720p')
    expect((s as unknown as Record<string, unknown>).foo).toBeUndefined()
  })
})

const minimalSession = {
  version: 1,
  id: '2026-08-18T14-32-05',
  createdAt: '2026-08-18T17:32:05.000Z',
  state: 'recording',
  source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1.640028', bitrate: 12e6 },
  systemAudio: true,
  tracks: { screen: 0, mic: 0, system: 1 },
  pauses: [],
  pip: [],
  strokes: [],
  clearEvents: [],
  markers: [],
  engine: 'webcodecs',
  files: { rec: 'rec.mp4' }
}

describe('SessionSchema', () => {
  it('aceita sessão mínima', () => {
    const s = parseSession(minimalSession)
    expect(s.id).toBe('2026-08-18T14-32-05')
    expect(s.tracks.system).toBe(1)
  })
  it('rejeita versão desconhecida', () => {
    expect(SessionSchema.safeParse({ ...minimalSession, version: 2 }).success).toBe(false)
  })
})
