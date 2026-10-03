import { describe, expect, it } from 'vitest'
import { h264FitsLevel52, h264LevelFor, hevcCodecString } from './encoderSupport'

describe('h264LevelFor / h264FitsLevel52', () => {
  it('nível pela resolução e fps', () => {
    expect(h264LevelFor(1920, 1080, 30)).toBe('avc1.640028')
    expect(h264LevelFor(3840, 2160, 60)).toBe('avc1.640034')
  })
  it('limite do nível 5.2: 36 864 macroblocos por quadro e 2 073 600 por segundo', () => {
    expect(h264FitsLevel52(3840, 2160, 60)).toBe(true)
    expect(h264FitsLevel52(4096, 2160, 60)).toBe(true)
    expect(h264FitsLevel52(4096, 2304, 60)).toBe(false)
    expect(h264FitsLevel52(4096, 4096, 24)).toBe(false)
  })
})

describe('hevcCodecString', () => {
  it('Main, tier Main, nível pela área e amostras por segundo (tag hvc1)', () => {
    expect(hevcCodecString(1280, 720, 30)).toBe('hvc1.1.6.L93.B0')
    expect(hevcCodecString(1920, 1080, 30)).toBe('hvc1.1.6.L120.B0')
    expect(hevcCodecString(1920, 1080, 60)).toBe('hvc1.1.6.L123.B0')
    expect(hevcCodecString(3840, 2160, 30)).toBe('hvc1.1.6.L150.B0')
    expect(hevcCodecString(3840, 2160, 60)).toBe('hvc1.1.6.L153.B0')
    expect(hevcCodecString(640, 360, 30)).toBe('hvc1.1.6.L90.B0')
  })
})
