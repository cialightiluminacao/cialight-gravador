import { describe, expect, it } from 'vitest'
import { assetFromInfo, audioIntermediateRel, filmstripRel, intermediateRel, peaksRel, proxyRel } from './ingest'
import type { MediaInfo } from './probe'

const info: MediaInfo = {
  durationUs: 6_000_000,
  kind: 'video',
  video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 90, gopUs: 10_000_000 },
  audio: { channels: 2, sampleRate: 48000, codec: 'aac' },
  vfr: false,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2'
}

describe('assetFromInfo', () => {
  it('vídeo: origem de arquivo, decodable provisório, status processing', () => {
    const a = assetFromInfo('a1', 'C:/v/Férias.mp4', { size: 123, mtimeMs: 1700000000000.4 }, info)
    expect(a).toEqual({
      id: 'a1',
      name: 'Férias.mp4',
      kind: 'video',
      source: { type: 'file', path: 'C:/v/Férias.mp4', size: 123, mtimeMs: 1700000000000 },
      durationUs: 6_000_000,
      video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 90, gopUs: 10_000_000, decodable: true },
      audio: { channels: 2, sampleRate: 48000, codec: 'aac' },
      status: 'processing'
    })
  })
  it('imagem já fica pronta', () => {
    const a = assetFromInfo('i1', 'C:/img/logo.png', { size: 1, mtimeMs: 1 }, { ...info, kind: 'image', durationUs: null, audio: undefined })
    expect(a.status).toBe('ready')
    expect(a.audio).toBeUndefined()
  })
})

describe('caminhos de saída', () => {
  it('relativos à pasta do projeto', () => {
    expect(proxyRel('a1')).toBe('proxies/a1.mp4')
    expect(intermediateRel('a1')).toBe('proxies/a1.intermediate.mp4')
    expect(audioIntermediateRel('a1')).toBe('proxies/a1.intermediate.m4a')
    expect(filmstripRel('a1')).toBe('cache/a1.strip.jpg')
    expect(peaksRel('a1')).toBe('cache/a1.peaks.bin')
  })
})
