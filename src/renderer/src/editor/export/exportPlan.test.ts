import { describe, expect, it } from 'vitest'
import { estimateBytes, exportRange, frameCount, outputSize, presetVideoBitrate, targetBitrate, WHATSAPP_MAX_BPS } from './exportPlan'

const MiB = 1024 * 1024

describe('targetBitrate', () => {
  it('64 MB em 60 s com áudio de 128 kbps e margem de 4 %', () => {
    // 64·1 048 576·8·0,96 / 60 − 128 000
    expect(targetBitrate(64, 60_000_000, 128)).toBe(Math.floor((64 * MiB * 8 * 0.96) / 60 - 128_000))
    expect(targetBitrate(64, 60_000_000, 128)).toBe(8_461_934)
  })
  it('vídeo + áudio cabem no alvo com a margem', () => {
    const dur = 300_000_000
    const v = targetBitrate(64, dur, 128)
    expect(estimateBytes(v, 128_000, dur)).toBeLessThanOrEqual(64 * MiB * 0.96)
    expect(estimateBytes(v, 128_000, dur)).toBeGreaterThan(64 * MiB * 0.95)
  })
  it('nunca abaixo do piso (vídeo longo demais) nem com duração inválida', () => {
    expect(targetBitrate(64, 10 * 3600 * 1e6, 128)).toBe(100_000)
    expect(targetBitrate(64, 0, 128)).toBe(100_000)
  })
})

describe('frameCount', () => {
  it('ceil da duração em quadros', () => {
    expect(frameCount(0, 7_000_000, 30)).toBe(210)
    expect(frameCount(2_000_000, 9_000_000, 30)).toBe(210)
    expect(frameCount(0, 7_010_000, 30)).toBe(211)
    expect(frameCount(0, 1, 30)).toBe(1)
    expect(frameCount(0, 0, 30)).toBe(0)
    expect(frameCount(5, 3, 30)).toBe(0)
  })
  it('tolera o arredondamento de frameToUs (91 quadros = 3 033 333 µs)', () => {
    expect(frameCount(0, 3_033_333, 30)).toBe(91)
    expect(frameCount(0, 3_033_334, 30)).toBe(91)
    expect(frameCount(0, 10_010_000, 29.97)).toBe(300)
  })
})

describe('outputSize', () => {
  const c = (width: number, height: number): { width: number; height: number } => ({ width, height })
  it('Alta 1080p e WhatsApp cabem na caixa mantendo a proporção (pares)', () => {
    expect(outputSize('high1080', c(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('high1080', c(1280, 720))).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('high1080', c(1080, 1920))).toEqual({ width: 1080, height: 1920 })
    expect(outputSize('high1080', c(1080, 1080))).toEqual({ width: 1080, height: 1080 })
    expect(outputSize('whatsapp', c(1920, 1080))).toEqual({ width: 1280, height: 720 })
    expect(outputSize('whatsapp', c(1080, 1350))).toEqual({ width: 720, height: 900 })
  })
  it('Original: resolução do projeto (par)', () => {
    expect(outputSize('original', c(2560, 1440))).toEqual({ width: 2560, height: 1440 })
    expect(outputSize('original', c(1001, 777))).toEqual({ width: 1002, height: 778 })
  })
  it('Vertical 9:16: 1080×1920 só para projeto 9:16', () => {
    expect(outputSize('vertical', c(720, 1280))).toEqual({ width: 1080, height: 1920 })
    expect(outputSize('vertical', c(1920, 1080))).toBeNull()
  })
})

describe('presetVideoBitrate', () => {
  it('Alta: 12 Mbps a 30 fps, 20 Mbps a 60 fps; Original 20 Mbps', () => {
    expect(presetVideoBitrate('high1080', 30, 10_000_000)).toBe(12_000_000)
    expect(presetVideoBitrate('high1080', 60, 10_000_000)).toBe(20_000_000)
    expect(presetVideoBitrate('vertical', 30, 10_000_000)).toBe(12_000_000)
    expect(presetVideoBitrate('original', 30, 10_000_000)).toBe(20_000_000)
  })
  it('WhatsApp: bitrate calculado para 64 MB, limitado em vídeos curtos', () => {
    expect(presetVideoBitrate('whatsapp', 30, 600_000_000)).toBe(targetBitrate(64, 600_000_000, 128))
    expect(presetVideoBitrate('whatsapp', 30, 10_000_000)).toBe(WHATSAPP_MAX_BPS)
  })
})

describe('exportRange', () => {
  it('tudo, ou I–O quando definidos e válidos', () => {
    expect(exportRange(9_000_000, null, null, 'inout')).toEqual({ fromUs: 0, toUs: 9_000_000 })
    expect(exportRange(9_000_000, 1_000_000, 4_000_000, 'all')).toEqual({ fromUs: 0, toUs: 9_000_000 })
    expect(exportRange(9_000_000, 1_000_000, 4_000_000, 'inout')).toEqual({ fromUs: 1_000_000, toUs: 4_000_000 })
    expect(exportRange(9_000_000, 1_000_000, null, 'inout')).toEqual({ fromUs: 1_000_000, toUs: 9_000_000 })
    expect(exportRange(9_000_000, null, 4_000_000, 'inout')).toEqual({ fromUs: 0, toUs: 4_000_000 })
    expect(exportRange(9_000_000, 5_000_000, 4_000_000, 'inout')).toEqual({ fromUs: 0, toUs: 9_000_000 })
  })
})
