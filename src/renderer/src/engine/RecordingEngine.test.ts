import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcApi } from '@shared/ipc'
import type { RecordingConfig, Session } from '@shared/types'
import { RecordingEngine } from './RecordingEngine'
import { pickVideoConfig } from './encoderSupport'

vi.mock('./encoderSupport', () => ({ pickVideoConfig: vi.fn(), aacSupported: vi.fn() }))

const config = {
  source: { kind: 'screen', id: 'screen:0', name: 'Teste' },
  quality: '1080p', fps: 30, systemAudio: false, webcam: null, mic: null
} as RecordingConfig

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('RecordingEngine: falhas na preparação', () => {
  function setup() {
    const stop = vi.fn()
    const track = { stop, getSettings: () => ({ width: 1920, height: 1080 }) }
    const screen = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] }
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(screen), getUserMedia } })
    const create = vi.fn()
    const cursorStop = vi.fn().mockResolvedValue(true)
    const save = vi.fn().mockResolvedValue(undefined)
    const api = { capture: { select: vi.fn().mockResolvedValue(undefined) }, session: { create, save }, cursor: { stop: cursorStop } } as unknown as IpcApi
    return { engine: new RecordingEngine(api), stop, create, getUserMedia, cursorStop }
  }

  it('solta a captura quando a consulta de encoder falha e permite tentar novamente', async () => {
    const { engine, stop } = setup()
    vi.mocked(pickVideoConfig).mockRejectedValue(new Error('Encoder probe failed'))
    await expect(engine.prepare(config)).rejects.toThrow('Encoder probe failed')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(engine.prepared).toBeNull()
    expect(engine.phase).toBe('idle')
    await expect(engine.prepare(config)).rejects.toThrow('Encoder probe failed')
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('solta a captura quando a criação da sessão falha', async () => {
    const { engine, stop, create } = setup()
    vi.mocked(pickVideoConfig).mockResolvedValue({ width: 1920, height: 1080, fps: 30 } as Awaited<ReturnType<typeof pickVideoConfig>>)
    create.mockRejectedValue(new Error('Disk unavailable'))
    await expect(engine.prepare(config)).rejects.toThrow('Disk unavailable')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(engine.prepared).toBeNull()
    expect(engine.phase).toBe('idle')
  })

  it('solta também câmera e microfone já abertos se a sessão falha', async () => {
    const { engine, stop, create, getUserMedia } = setup()
    const stopCam = vi.fn(), stopMic = vi.fn()
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop: stopCam }] })
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopMic }] })
    vi.mocked(pickVideoConfig).mockResolvedValue({ width: 1920, height: 1080, fps: 30 } as Awaited<ReturnType<typeof pickVideoConfig>>)
    create.mockRejectedValue(new Error('Disk unavailable'))
    await expect(engine.prepare({ ...config, webcam: { deviceId: 'cam', label: 'Camera', mirrored: false }, mic: { deviceId: 'mic', label: 'Microfone', echoCancellation: false, noiseSuppression: false, autoGainControl: false } })).rejects.toThrow('Disk unavailable')
    expect(stop).toHaveBeenCalledOnce()
    expect(stopCam).toHaveBeenCalledOnce()
    expect(stopMic).toHaveBeenCalledOnce()
    expect(engine.prepared).toBeNull()
  })

  it('consegue preparar uma nova sessão após uma consulta de encoder rejeitada', async () => {
    const { engine, create } = setup()
    vi.mocked(pickVideoConfig).mockRejectedValueOnce(new Error('Encoder probe failed'))
      .mockResolvedValueOnce({ width: 1920, height: 1080, fps: 30 } as Awaited<ReturnType<typeof pickVideoConfig>>)
    const session = { pip: [], systemAudio: false } as unknown as Session
    create.mockResolvedValue({ session })
    await expect(engine.prepare(config)).rejects.toThrow('Encoder probe failed')
    await expect(engine.prepare(config)).resolves.toMatchObject({ cam: null, mic: null })
    expect(engine.phase).toBe('prepared')
    expect(engine.session).toBe(session)
  })

  it('duas solicitações de parada aguardam o mesmo encerramento completo', async () => {
    const { engine, create, cursorStop } = setup()
    let finishCursor!: (value: boolean) => void
    cursorStop.mockReturnValue(new Promise<boolean>(resolve => { finishCursor = resolve }))
    vi.mocked(pickVideoConfig).mockResolvedValue({ width: 1920, height: 1080, fps: 30 } as Awaited<ReturnType<typeof pickVideoConfig>>)
    create.mockResolvedValue({ session: { id: 's', pip: [], pauses: [] } as unknown as Session })
    await engine.prepare(config)
    const first = engine.stop()
    const second = engine.stop()
    let resolved = false
    void second.then(() => { resolved = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolved).toBe(false)
    finishCursor(true)
    expect(await first).toBe(await second)
    expect(cursorStop).toHaveBeenCalledOnce()
    expect(engine.phase).toBe('stopped')
  })
})
