// Regra única de cor das fontes de vídeo (pura). Marcada → vale a marcação. Sem marcação → convenção dos
// players (VLC/mpv/Media Foundation): HD (altura > 576 ou largura > 1024) = BT.709, SD = BT.601; faixa limitada.
// Usada no decoder do editor (preview/export), nas miniaturas/filmstrip (in_color_matrix) e nas marcações
// gravadas em proxies e intermediários — linha do tempo, preview e export sempre concordam.

/** Cor como o ffprobe informa (nomes do ffmpeg); ausente/"unknown" = não marcado. */
export interface SourceColor {
  space?: string | null
  primaries?: string | null
  transfer?: string | null
  range?: string | null
}

export type ColorFamily = 'bt709' | 'bt601'

/** Fonte sem marcação: BT.709 em HD, BT.601 em SD (dimensões codificadas). */
export function untaggedFamily(width: number, height: number): ColorFamily {
  return height > 576 || width > 1024 ? 'bt709' : 'bt601'
}

const known = (v: string | null | undefined): string | null => (v && v !== 'unknown' && v !== 'unspecified' && v !== 'reserved' ? v : null)

/** A fonte declara a matriz de cor? */
export function isColorTagged(c: SourceColor | undefined | null): boolean {
  return !!known(c?.space)
}

const FAMILY_TAGS: Record<ColorFamily, { space: string; primaries: string; transfer: string }> = {
  bt709: { space: 'bt709', primaries: 'bt709', transfer: 'bt709' },
  bt601: { space: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m' }
}

/** Cor efetiva (marcação, com o que faltar preenchido pela regra) com nomes do ffmpeg. */
export function effectiveColor(c: SourceColor | undefined | null, width: number, height: number): Required<{ [K in keyof SourceColor]: string }> {
  const space = known(c?.space)
  const family: ColorFamily = space ? (/^(smpte170m|bt470bg)$/.test(space) ? 'bt601' : 'bt709') : untaggedFamily(width, height)
  const d = FAMILY_TAGS[family]
  return {
    space: space ?? d.space,
    primaries: known(c?.primaries) ?? d.primaries,
    transfer: known(c?.transfer) ?? d.transfer,
    range: known(c?.range) === 'pc' ? 'pc' : 'tv'
  }
}

// Códigos H.273 (VUI do H.264) dos nomes do ffmpeg, para o h264_metadata.
const PRIMARIES_CODE: Record<string, number> = { bt709: 1, bt470m: 4, bt470bg: 5, smpte170m: 6, smpte240m: 7, film: 8, bt2020: 9 }
const TRANSFER_CODE: Record<string, number> = { bt709: 1, gamma22: 4, gamma28: 5, smpte170m: 6, smpte240m: 7, linear: 8, 'iec61966-2-1': 13, 'bt2020-10': 14, 'bt2020-12': 15, smpte2084: 16, 'arib-std-b67': 18 }
const MATRIX_CODE: Record<string, number> = { bt709: 1, fcc: 4, bt470bg: 5, smpte170m: 6, smpte240m: 7, bt2020nc: 9, bt2020c: 10 }

/**
 * Marcações de saída para proxy/intermediário H.264 (o YUV é copiado sem conversão: a marcação diz como lê-lo).
 * Opções -color_* (contêiner/encoder) + h264_metadata no SPS, porque nem todo encoder de hardware grava a VUI completa.
 */
export function colorTagArgs(c: SourceColor | undefined | null, width: number, height: number): string[] {
  const e = effectiveColor(c, width, height)
  const vui = [
    PRIMARIES_CODE[e.primaries] ? `colour_primaries=${PRIMARIES_CODE[e.primaries]}` : null,
    TRANSFER_CODE[e.transfer] ? `transfer_characteristics=${TRANSFER_CODE[e.transfer]}` : null,
    MATRIX_CODE[e.space] ? `matrix_coefficients=${MATRIX_CODE[e.space]}` : null,
    `video_full_range_flag=${e.range === 'pc' ? 1 : 0}`
  ].filter((x): x is string => x !== null)
  return ['-colorspace', e.space, '-color_primaries', e.primaries, '-color_trc', e.transfer, '-color_range', e.range, '-bsf:v', `h264_metadata=${vui.join(':')}`]
}

/** Matriz para o filtro scale (in_color_matrix) a partir do espaço do ffmpeg. */
export function scaleMatrix(space: string): string {
  if (/^(smpte170m|bt470bg)$/.test(space)) return 'bt601'
  if (/^bt2020/.test(space)) return 'bt2020'
  if (space === 'smpte240m' || space === 'fcc') return space
  return 'bt709'
}

/**
 * Opções do scale para miniaturas JPEG: lê a fonte pela regra e converte para o que o JPEG (JFIF) supõe —
 * BT.601 faixa cheia. `src` null (sem probe: gravação do app, sempre marcada) → leitura "auto" do ffmpeg.
 */
export function jpegScaleColorOpts(src: { color?: SourceColor | null; width: number; height: number } | null): string {
  const out = 'out_color_matrix=bt601:out_range=pc'
  if (!src) return out
  const e = effectiveColor(src.color, src.width, src.height)
  return `in_color_matrix=${scaleMatrix(e.space)}:in_range=${e.range}:${out}`
}

/** Matriz que o decoder do Chromium deve usar para a faixa: null = a marcação dela (ou o padrão BT.709 em HD). */
export function decoderMatrixOverride(tagged: boolean, codedWidth: number, codedHeight: number): 'smpte170m' | null {
  if (tagged) return null
  return untaggedFamily(codedWidth, codedHeight) === 'bt601' ? 'smpte170m' : null
}
