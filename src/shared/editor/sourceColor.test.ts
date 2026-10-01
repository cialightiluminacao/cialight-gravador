import { describe, expect, it } from 'vitest'
import { colorTagArgs, decoderMatrixOverride, effectiveColor, isColorTagged, jpegScaleColorOpts, untaggedFamily } from './sourceColor'

describe('regra de cor das fontes', () => {
  it('sem marcação: HD (altura > 576 ou largura > 1024) BT.709, SD BT.601', () => {
    expect(untaggedFamily(1280, 720)).toBe('bt709')
    expect(untaggedFamily(1920, 1080)).toBe('bt709')
    expect(untaggedFamily(1280, 576)).toBe('bt709')
    expect(untaggedFamily(640, 480)).toBe('bt601')
    expect(untaggedFamily(720, 576)).toBe('bt601')
    expect(untaggedFamily(1024, 576)).toBe('bt601')
  })
  it('marcada vale a marcação; o que faltar vem da família; "unknown" = sem marcação', () => {
    expect(effectiveColor({ space: 'smpte170m', primaries: 'unknown', transfer: null, range: 'tv' }, 1920, 1080)).toEqual({ space: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', range: 'tv' })
    expect(effectiveColor({ space: 'bt709', range: 'pc' }, 640, 480)).toEqual({ space: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'pc' })
    expect(effectiveColor({ space: 'unknown' }, 640, 480)).toEqual({ space: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', range: 'tv' })
    expect(effectiveColor(undefined, 1280, 720)).toEqual({ space: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'tv' })
    expect(isColorTagged({ space: 'unknown' })).toBe(false)
    expect(isColorTagged({ space: 'bt470bg' })).toBe(true)
  })
  it('marcações de proxy/intermediário', () => {
    expect(colorTagArgs(undefined, 1920, 1080)).toEqual([
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0'
    ])
    expect(colorTagArgs({}, 640, 480)).toEqual([
      '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv',
      '-bsf:v', 'h264_metadata=colour_primaries=6:transfer_characteristics=6:matrix_coefficients=6:video_full_range_flag=0'
    ])
  })
  it('miniatura JPEG: lê pela regra e sai em BT.601 faixa cheia (JFIF)', () => {
    expect(jpegScaleColorOpts({ width: 1920, height: 1080 })).toBe('in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc')
    expect(jpegScaleColorOpts({ color: { space: 'bt470bg' }, width: 1920, height: 1080 })).toBe('in_color_matrix=bt601:in_range=tv:out_color_matrix=bt601:out_range=pc')
    expect(jpegScaleColorOpts(null)).toBe('out_color_matrix=bt601:out_range=pc')
  })
  it('decoder do editor: só SD sem marcação troca a matriz (BT.601)', () => {
    expect(decoderMatrixOverride(false, 640, 480)).toBe('smpte170m')
    expect(decoderMatrixOverride(false, 1280, 720)).toBeNull()
    expect(decoderMatrixOverride(true, 640, 480)).toBeNull()
  })
})
