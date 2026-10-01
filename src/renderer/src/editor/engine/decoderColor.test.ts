import { describe, expect, it } from 'vitest'
import { assumeBt601WhenUntagged } from './decoderPool'

const track = (cs: VideoColorSpaceInit) => ({
  getColorSpace: async () => cs,
  getDecoderConfig: async () => ({ codec: 'avc1.64001f', codedWidth: 2, codedHeight: 2 }) as VideoDecoderConfig
})

describe('assumeBt601WhenUntagged', () => {
  it('faixa sem matriz: o decoder recebe BT.601 (como o ffmpeg lê), primárias/transferência BT.709', async () => {
    const t = track({ fullRange: false })
    expect(await assumeBt601WhenUntagged(t)).toBe(true)
    expect((await t.getDecoderConfig())?.colorSpace).toEqual({ primaries: 'bt709', transfer: 'bt709', matrix: 'smpte170m', fullRange: false })
  })
  it('faixa marcada não muda', async () => {
    const t = track({ matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false })
    expect(await assumeBt601WhenUntagged(t)).toBe(false)
    expect((await t.getDecoderConfig())?.colorSpace).toBeUndefined()
  })
})
