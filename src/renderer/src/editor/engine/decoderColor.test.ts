import { describe, expect, it } from 'vitest'
import { applySourceColorRule } from './decoderPool'

const track = (cs: VideoColorSpaceInit, w: number, h: number) => ({
  getColorSpace: async () => cs,
  getCodedWidth: async () => w,
  getCodedHeight: async () => h,
  getDecoderConfig: async () => ({ codec: 'avc1.64001f', codedWidth: w, codedHeight: h }) as VideoDecoderConfig
})

describe('applySourceColorRule (regra única de cor no decoder)', () => {
  it('SD sem marcação: o decoder recebe BT.601, primárias/transferência BT.709', async () => {
    const t = track({ fullRange: false }, 640, 480)
    expect(await applySourceColorRule(t)).toBe(true)
    expect((await t.getDecoderConfig())?.colorSpace).toEqual({ primaries: 'bt709', transfer: 'bt709', matrix: 'smpte170m', fullRange: false })
  })
  it('HD sem marcação: padrão do Chromium (BT.709), sem troca', async () => {
    const t = track({ fullRange: false }, 1280, 720)
    expect(await applySourceColorRule(t)).toBe(false)
    expect((await t.getDecoderConfig())?.colorSpace).toBeUndefined()
  })
  it('marcada não muda (nem em SD)', async () => {
    const t = track({ matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false }, 640, 480)
    expect(await applySourceColorRule(t)).toBe(false)
    expect((await t.getDecoderConfig())?.colorSpace).toBeUndefined()
  })
})
