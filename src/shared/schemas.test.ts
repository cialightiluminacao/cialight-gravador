import { describe, expect, it } from 'vitest'
import { parseSession, parseSettings, SessionSchema } from './schemas'
import { DEFAULT_SETTINGS } from './defaults'
import type { HwEncoder, Settings } from './types'
import { settingsInputSchemaV101 } from './__fixtures__/settingsSchemaV101'
import { v1ProbeProjection } from './encoderCache'

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
  it('probe de encoders: encoderProbeV2 aceita AMF; probe ilegível vira null sem perder o resto', () => {
    const probe = { gpuKey: 'AMD:1:1', probedAt: 'x', available: ['h264_amf', 'libx264'], preferred: 'h264_amf' }
    expect(parseSettings({ encoderProbeV2: probe }).encoderProbeV2).toEqual(probe)
    const s = parseSettings({ quality: '720p', encoderProbeV2: { ...probe, preferred: 'h264_vaapi' }, lastEncoderProbe: probe })
    expect(s.encoderProbeV2).toBeNull()
    expect(s.lastEncoderProbe).toBeNull() // v1 não conhece AMF: o build novo nunca grava AMF ali
    expect(s.quality).toBe('720p')
  })
  it('compatibilidade com a v1.0.1 instalada: o arquivo gravado pelo build novo passa no schema antigo', () => {
    const amd = { gpuKey: 'AMD:1:1', probedAt: 'x', available: ['h264_amf', 'h264_mf', 'libx264'] as HwEncoder[], preferred: 'h264_amf' as const }
    const written: Settings = { ...parseSettings({ quality: '720p' }), encoderProbeV2: amd, lastEncoderProbe: v1ProbeProjection(amd) }
    const onDisk = JSON.parse(JSON.stringify(written))
    const r = settingsInputSchemaV101.safeParse(onDisk)
    expect(r.success).toBe(true) // sem isso a v1 voltaria TODAS as configurações ao padrão
    expect(r.data?.quality).toBe('720p')
    expect(r.data?.lastEncoderProbe).toEqual({ ...amd, available: ['h264_mf', 'libx264'], preferred: 'h264_mf' })
    // e o arquivo da v1 (só lastEncoderProbe) continua legível no build novo
    expect(parseSettings({ lastEncoderProbe: { gpuKey: 'k', probedAt: 'x', available: ['h264_qsv', 'libx264'], preferred: 'h264_qsv' } }).encoderProbeV2).toBeNull()
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
