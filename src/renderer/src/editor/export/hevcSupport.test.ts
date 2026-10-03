import { afterEach, describe, expect, it, vi } from 'vitest'

const canEncodeVideo = vi.fn()
vi.mock('mediabunny', () => ({ canEncodeVideo: (...a: unknown[]) => canEncodeVideo(...a) }))

const isConfigSupported = vi.fn()
vi.stubGlobal('VideoEncoder', { isConfigSupported: (c: unknown) => isConfigSupported(c) })

const { probeHevc } = await import('./hevcSupport')

afterEach(() => {
  canEncodeVideo.mockReset()
  isConfigSupported.mockReset()
})

describe('probeHevc', () => {
  it('exige o mediabunny E o VideoEncoder por hardware com o codec string hvc1 da resolução/fps', async () => {
    canEncodeVideo.mockResolvedValue(true)
    isConfigSupported.mockResolvedValue({ supported: true })
    expect(await probeHevc(1920, 1080, 60)).toBe(true)
    expect(canEncodeVideo).toHaveBeenCalledWith('hevc', { width: 1920, height: 1080, hardwareAcceleration: 'prefer-hardware' })
    expect(isConfigSupported).toHaveBeenCalledWith(expect.objectContaining({ codec: 'hvc1.1.6.L123.B0', width: 1920, height: 1080, framerate: 60, hardwareAcceleration: 'prefer-hardware' }))
  })
  it('cache por (w, h, fps)', async () => {
    canEncodeVideo.mockResolvedValue(true)
    isConfigSupported.mockResolvedValue({ supported: true })
    await probeHevc(1280, 720, 30)
    await probeHevc(1280, 720, 30)
    expect(isConfigSupported).toHaveBeenCalledTimes(1)
  })
  it('qualquer recusa ou erro = sem HEVC', async () => {
    canEncodeVideo.mockResolvedValue(false)
    expect(await probeHevc(640, 360, 30)).toBe(false)
    expect(isConfigSupported).not.toHaveBeenCalled()
    canEncodeVideo.mockResolvedValue(true)
    isConfigSupported.mockResolvedValue({ supported: false })
    expect(await probeHevc(640, 360, 25)).toBe(false)
    isConfigSupported.mockRejectedValue(new Error('driver'))
    expect(await probeHevc(640, 360, 24)).toBe(false)
  })
})
