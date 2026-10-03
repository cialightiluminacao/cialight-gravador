import { describe, expect, it } from 'vitest'
import { firstEncodeStep, needsAvcCheck, nextEncodeStep, x264PipeSpec, type EncodeStep } from './encodeChain'

const chain = (first: EncodeStep): (EncodeStep | null)[] => {
  const out: (EncodeStep | null)[] = [first]
  let s: EncodeStep | null = first
  while (s) out.push((s = nextEncodeStep(s)))
  return out
}

describe('cadeia de codificadores', () => {
  it('H.264: hardware → software → libx264 → fim', () => {
    expect(chain(firstEncodeStep('h264'))).toEqual([
      { kind: 'webcodecs', codec: 'h264', hw: 'prefer-hardware' },
      { kind: 'webcodecs', codec: 'h264', hw: 'prefer-software' },
      { kind: 'x264' },
      null
    ])
  })

  it('HEVC: HEVC (hardware) → H.264 hardware → software → libx264 → fim', () => {
    expect(chain(firstEncodeStep('hevc'))).toEqual([
      { kind: 'webcodecs', codec: 'hevc', hw: 'prefer-hardware' },
      { kind: 'webcodecs', codec: 'h264', hw: 'prefer-hardware' },
      { kind: 'webcodecs', codec: 'h264', hw: 'prefer-software' },
      { kind: 'x264' },
      null
    ])
  })

  it('só o passo H.264 em software checa canEncodeVideo (indisponível no tamanho → libx264)', () => {
    expect(needsAvcCheck({ kind: 'webcodecs', codec: 'h264', hw: 'prefer-software' })).toBe(true)
    expect(needsAvcCheck({ kind: 'webcodecs', codec: 'h264', hw: 'prefer-hardware' })).toBe(false)
    expect(needsAvcCheck({ kind: 'webcodecs', codec: 'hevc', hw: 'prefer-hardware' })).toBe(false)
    expect(needsAvcCheck({ kind: 'x264' })).toBe(false)
    expect(nextEncodeStep({ kind: 'webcodecs', codec: 'h264', hw: 'prefer-software' })).toEqual({ kind: 'x264' })
  })
})

describe('pedido x264', () => {
  const base = { width: 1920, height: 1080, fps: 30, fromUs: 1_000_000, toUs: 5_000_000, videoBitrate: 12_000_000, audioBitrate: 128_000, keyFrameIntervalS: 2 }

  it('GOP em quadros, áudio com o total exato de amostras do trecho (4 s = 192 000)', () => {
    expect(x264PipeSpec(base, true)).toEqual({ kind: 'x264', width: 1920, height: 1080, fps: 30, videoBitrate: 12_000_000, keyFrameInterval: 60, audio: { kbps: 128, samples: 192_000 } })
  })

  it('sem áudio audível: audio null; 29,97 fps; bitrate dentro dos limites do main', () => {
    expect(x264PipeSpec({ ...base, fps: 30000 / 1001, videoBitrate: 50_000.4, toUs: 1_500_000 }, false)).toEqual({
      kind: 'x264', width: 1920, height: 1080, fps: 30000 / 1001, videoBitrate: 100_000, keyFrameInterval: 60, audio: null
    })
  })

  it('trecho de duração quebrada: amostras = round(duração × 48 kHz)', () => {
    expect(x264PipeSpec({ ...base, fromUs: 0, toUs: 1_234_567 }, true).audio).toEqual({ kbps: 128, samples: 59_259 })
  })
})
