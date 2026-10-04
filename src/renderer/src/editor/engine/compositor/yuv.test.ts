import { afterEach, describe, expect, it, vi } from 'vitest'
import { planeSpecs, resolveYuvColor, rgbToYuv, tightLayout, yuvCoeffs, yuvFormatFor, yuvToRgb, type YuvColor } from './yuv'

const BT709_L: YuvColor = { matrix: 'bt709', fullRange: false }
const BT709_F: YuvColor = { matrix: 'bt709', fullRange: true }
const BT601_L: YuvColor = { matrix: 'bt601', fullRange: false }
const BT601_F: YuvColor = { matrix: 'bt601', fullRange: true }
const BT2020_L: YuvColor = { matrix: 'bt2020', fullRange: false }
const BT2020_F: YuvColor = { matrix: 'bt2020', fullRange: true }

const near = (got: readonly number[], want: readonly number[], tol: number): void => {
  for (let i = 0; i < want.length; i++) expect(Math.abs(got[i] - want[i]), `canal ${i}: ${got[i]} × ${want[i]}`).toBeLessThanOrEqual(tol)
}

// Barras de 75 % (Y, Cb, Cr em 8 bits, faixa limitada) — tabelas de referência (ITU-R BT.801 / SMPTE RP 219)
const BARS = ['branco', 'amarelo', 'ciano', 'verde', 'magenta', 'vermelho', 'azul'] as const
const RGB75: Record<(typeof BARS)[number], [number, number, number]> = {
  branco: [1, 1, 1], amarelo: [1, 1, 0], ciano: [0, 1, 1], verde: [0, 1, 0], magenta: [1, 0, 1], vermelho: [1, 0, 0], azul: [0, 0, 1]
}
const YUV601: Record<(typeof BARS)[number], [number, number, number]> = {
  branco: [180, 128, 128], amarelo: [162, 44, 142], ciano: [131, 156, 44], verde: [112, 72, 58], magenta: [84, 184, 198], vermelho: [65, 100, 212], azul: [35, 212, 114]
}
const YUV709: Record<(typeof BARS)[number], [number, number, number]> = {
  branco: [180, 128, 128], amarelo: [168, 44, 136], ciano: [145, 147, 44], verde: [133, 63, 52], magenta: [63, 193, 204], vermelho: [51, 109, 212], azul: [28, 212, 120]
}

describe('coeficientes YUV→RGB', () => {
  it.each([BT709_L, BT601_L, BT2020_L])('faixa limitada %o: Y=16 → preto, Y=235 → branco, croma 128 = cinza', (c) => {
    near(yuvToRgb(16, 128, 128, c), [0, 0, 0], 1e-9)
    near(yuvToRgb(235, 128, 128, c), [255, 255, 255], 1e-9)
    near(yuvToRgb(125.5, 128, 128, c), [127.5, 127.5, 127.5], 1e-9)
  })

  it.each([BT709_F, BT601_F, BT2020_F])('faixa cheia %o: Y=0 → preto, Y=255 → branco, croma centrado em 128', (c) => {
    near(yuvToRgb(0, 128, 128, c), [0, 0, 0], 1e-9)
    near(yuvToRgb(255, 128, 128, c), [255, 255, 255], 1e-9)
  })

  it('Kr/Kb por padrão: vermelho/azul puros na faixa cheia dão o Y = 255·Kr / 255·Kb', () => {
    near([rgbToYuv(255, 0, 0, BT709_F)[0], rgbToYuv(0, 0, 255, BT709_F)[0]], [255 * 0.2126, 255 * 0.0722], 1e-9)
    near([rgbToYuv(255, 0, 0, BT601_F)[0], rgbToYuv(0, 0, 255, BT601_F)[0]], [255 * 0.299, 255 * 0.114], 1e-9)
    near([rgbToYuv(255, 0, 0, BT2020_F)[0], rgbToYuv(0, 0, 255, BT2020_F)[0]], [255 * 0.2627, 255 * 0.0593], 1e-9)
  })

  it.each([
    ['BT.709', BT709_L, YUV709],
    ['BT.601', BT601_L, YUV601]
  ] as const)('barras 75 %% %s: RGB→YUV bate com a tabela (≤ 0,5 nível) e a volta dá 75 %% (≤ 1,5 nível, códigos arredondados)', (_n, c, table) => {
    for (const bar of BARS) {
      const rgb = RGB75[bar].map((v) => v * 0.75 * 255) as [number, number, number]
      near(rgbToYuv(rgb[0], rgb[1], rgb[2], c), table[bar], 0.5)
      near(yuvToRgb(table[bar][0], table[bar][1], table[bar][2], c), rgb, 1.5)
    }
  })

  it('ida e volta exata (sem arredondar) em todas as matrizes e faixas', () => {
    for (const c of [BT709_L, BT709_F, BT601_L, BT601_F, BT2020_L, BT2020_F]) {
      for (const rgb of [[10, 200, 90], [255, 0, 0], [0, 255, 255], [17, 17, 230]] as const) {
        const [y, u, v] = rgbToYuv(rgb[0], rgb[1], rgb[2], c)
        near(yuvToRgb(y, u, v, c), rgb, 1e-9)
      }
    }
  })

  it('matriz de shader (coluna-maior sobre Y/U/V normalizados 0–1) = a conta de referência', () => {
    for (const c of [BT709_L, BT601_F, BT2020_L]) {
      const { m, off } = yuvCoeffs(c)
      expect(m).toHaveLength(9)
      const [y, u, v] = [200 / 255, 60 / 255, 170 / 255]
      const out = [0, 1, 2].map((r) => (m[r] * y + m[3 + r] * u + m[6 + r] * v + off[r]) * 255)
      near(out, yuvToRgb(200, 60, 170, c), 1e-9)
    }
  })
})

describe('resolveYuvColor (marcação do quadro; nulo → regra de sourceColor.ts)', () => {
  it('matriz marcada: bt709 / smpte170m e bt470bg = BT.601', () => {
    expect(resolveYuvColor({ matrix: 'bt709', fullRange: false }, 640, 480)).toEqual(BT709_L)
    expect(resolveYuvColor({ matrix: 'smpte170m', fullRange: true }, 1920, 1080)).toEqual(BT601_F)
    expect(resolveYuvColor({ matrix: 'bt470bg', fullRange: false }, 1920, 1080)).toEqual(BT601_L)
  })

  it('bt2020-ncl → null (caminho antigo): sem caso de paridade com o Chromium (PQ/HLG podem ter mapeamento de tons)', () => {
    expect(resolveYuvColor({ matrix: 'bt2020-ncl', fullRange: null }, 3840, 2160)).toBeNull()
    expect(resolveYuvColor({ matrix: 'bt2020-ncl', fullRange: true }, 1920, 1080)).toBeNull()
  })

  it('sem matriz: 1920×1080 → BT.709 limitada; 640×480 → BT.601 limitada (untaggedFamily, dimensões codificadas)', () => {
    expect(resolveYuvColor({ matrix: null, fullRange: null }, 1920, 1088)).toEqual(BT709_L)
    expect(resolveYuvColor(null, 640, 480)).toEqual(BT601_L)
    expect(resolveYuvColor(undefined, 720, 576)).toEqual(BT601_L)
    expect(resolveYuvColor({ matrix: null, fullRange: true }, 640, 480)).toEqual(BT601_F)
  })

  it('matriz não suportada (rgb, bt2020-cl) → null (caminho antigo)', () => {
    expect(resolveYuvColor({ matrix: 'bt2020-cl', fullRange: false }, 3840, 2160)).toBeNull()
    expect(resolveYuvColor({ matrix: 'rgb', fullRange: true }, 1920, 1080)).toBeNull()
  })
})

describe('planos e layout', () => {
  it('I420 1920×1080: Y + U + V, croma pela metade; layout justo com offsets em sequência', () => {
    expect(planeSpecs('I420', 1920, 1080)).toEqual([
      { width: 1920, height: 1080, channels: 1 },
      { width: 960, height: 540, channels: 1 },
      { width: 960, height: 540, channels: 1 }
    ])
    expect(tightLayout('I420', 1920, 1080)).toEqual({
      planes: [{ offset: 0, stride: 1920 }, { offset: 2_073_600, stride: 960 }, { offset: 2_592_000, stride: 960 }],
      size: 3_110_400
    })
  })

  it('NV12 1920×1080: Y + UV entrelaçado (2 canais)', () => {
    expect(planeSpecs('NV12', 1920, 1080)).toEqual([
      { width: 1920, height: 1080, channels: 1 },
      { width: 960, height: 540, channels: 2 }
    ])
    expect(tightLayout('NV12', 1920, 1080)).toEqual({ planes: [{ offset: 0, stride: 1920 }, { offset: 2_073_600, stride: 1920 }], size: 3_110_400 })
  })

  it('I420A: quarto plano de alfa do tamanho do Y', () => {
    const p = planeSpecs('I420A', 4, 2)
    expect(p).toHaveLength(4)
    expect(p[3]).toEqual({ width: 4, height: 2, channels: 1 })
    expect(tightLayout('I420A', 4, 2).size).toBe(8 + 2 + 2 + 8)
  })

  it('largura/altura ímpares arredondam o croma para cima', () => {
    expect(planeSpecs('I420', 641, 361)[1]).toEqual({ width: 321, height: 181, channels: 1 })
    expect(planeSpecs('NV12', 641, 361)[1]).toEqual({ width: 321, height: 181, channels: 2 })
    expect(tightLayout('NV12', 641, 361)).toEqual({ planes: [{ offset: 0, stride: 641 }, { offset: 641 * 361, stride: 642 }], size: 641 * 361 + 642 * 181 })
  })
})

describe('yuvFormatFor (decisão do caminho, R1)', () => {
  class FakeVideoFrame {
    constructor(readonly format: string | null) {}
  }
  afterEach(() => vi.unstubAllGlobals())

  it('id no conjunto + VideoFrame I420 → YUV; NV12/I420A (R4), fora do conjunto, outro formato ou outra fonte → caminho antigo', () => {
    vi.stubGlobal('VideoFrame', FakeVideoFrame)
    const cpu = new Set(['a'])
    expect(yuvFormatFor('a', new FakeVideoFrame('I420'), cpu)).toBe('I420')
    // R4: NV12/I420A de CPU — o caminho antigo do Chromium (conversão em software) difere da conta da matriz em até 12
    // níveis; para não mudar a imagem, eles seguem no caminho antigo mesmo marcados
    expect(yuvFormatFor('a', new FakeVideoFrame('I420A'), cpu)).toBeNull()
    expect(yuvFormatFor('a', new FakeVideoFrame('NV12'), cpu)).toBeNull()
    expect(yuvFormatFor('b', new FakeVideoFrame('NV12'), cpu)).toBeNull() // NV12 de GPU tem o mesmo formato: só com opt-in
    expect(yuvFormatFor('a', new FakeVideoFrame('I420P10'), cpu)).toBeNull()
    expect(yuvFormatFor('a', new FakeVideoFrame('RGBA'), cpu)).toBeNull()
    expect(yuvFormatFor('a', new FakeVideoFrame(null), cpu)).toBeNull()
    expect(yuvFormatFor('a', { format: 'I420', width: 2, height: 2 }, cpu)).toBeNull() // ImageBitmap/canvas
    expect(yuvFormatFor('a', new FakeVideoFrame('I420'), undefined)).toBeNull()
    expect(yuvFormatFor('a', null, cpu)).toBeNull()
  })

  it('sem VideoFrame no ambiente: sempre o caminho antigo', () => {
    expect(yuvFormatFor('a', new FakeVideoFrame('I420'), new Set(['a']))).toBeNull()
  })
})
