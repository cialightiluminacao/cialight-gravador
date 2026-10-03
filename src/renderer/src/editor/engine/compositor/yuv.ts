// Caminho de upload YUV do compositor (G1): contas puras — matriz/faixa de cor, planos/layout e a decisão do caminho.
// O quadro em memória de CPU (I420/I420A/NV12) sobe plano a plano (R8/RG8) e um shader converte para RGBA na textura
// da camada; só a matriz (sem conversão de primárias/transferência), como o Chromium faz no caminho antigo.
import { untaggedFamily } from '@shared/editor/sourceColor'

export type YuvFormat = 'I420' | 'I420A' | 'NV12'
export type YuvMatrix = 'bt709' | 'bt601' | 'bt2020'
export interface YuvColor { matrix: YuvMatrix; fullRange: boolean }

/** Coeficientes Kr/Kb de cada matriz (ITU-R BT.709, BT.601, BT.2020 não constante). */
const KRB: Record<YuvMatrix, { kr: number; kb: number }> = {
  bt709: { kr: 0.2126, kb: 0.0722 },
  bt601: { kr: 0.299, kb: 0.114 },
  bt2020: { kr: 0.2627, kb: 0.0593 }
}

const FORMATS: ReadonlySet<string> = new Set<YuvFormat>(['I420', 'I420A', 'NV12'])

/**
 * Cor do quadro: `matrix`/`fullRange` do VideoFrame.colorSpace; matriz nula → regra das fontes sem marcação
 * (untaggedFamily pelas dimensões codificadas); faixa nula → limitada. Matriz sem suporte (rgb) → null (caminho antigo).
 */
export function resolveYuvColor(cs: { matrix?: string | null; fullRange?: boolean | null } | null | undefined, codedWidth: number, codedHeight: number): YuvColor | null {
  const fullRange = cs?.fullRange === true
  const m = cs?.matrix ?? null
  if (m === null) return { matrix: untaggedFamily(codedWidth, codedHeight), fullRange }
  if (m === 'bt709') return { matrix: 'bt709', fullRange }
  if (m === 'smpte170m' || m === 'bt470bg') return { matrix: 'bt601', fullRange }
  if (m === 'bt2020-ncl') return { matrix: 'bt2020', fullRange }
  return null
}

/** Escala/deslocamento dos códigos de 8 bits: Y' = ys·código + yo; C = cs·código + co. */
function levels(fullRange: boolean): { ys: number; yo: number; cs: number; co: number } {
  return fullRange ? { ys: 1 / 255, yo: 0, cs: 1 / 255, co: -128 / 255 } : { ys: 1 / 219, yo: -16 / 219, cs: 1 / 224, co: -128 / 224 }
}

/** Fatores de Cb/Cr em R, G, B (R = Y' + crR·Cr; G = Y' + cbG·Cb + crG·Cr; B = Y' + cbB·Cb). */
function chromaFactors(matrix: YuvMatrix): { crR: number; cbG: number; crG: number; cbB: number } {
  const { kr, kb } = KRB[matrix]
  const kg = 1 - kr - kb
  return { crR: 2 * (1 - kr), cbG: (-2 * kb * (1 - kb)) / kg, crG: (-2 * kr * (1 - kr)) / kg, cbB: 2 * (1 - kb) }
}

/** Códigos de 8 bits (Y, U=Cb, V=Cr) → RGB em 0–255 (sem arredondar nem limitar). */
export function yuvToRgb(y: number, u: number, v: number, c: YuvColor): [number, number, number] {
  const { ys, yo, cs, co } = levels(c.fullRange)
  const { crR, cbG, crG, cbB } = chromaFactors(c.matrix)
  const yy = ys * y + yo
  const cb = cs * u + co
  const cr = cs * v + co
  return [255 * (yy + crR * cr), 255 * (yy + cbG * cb + crG * cr), 255 * (yy + cbB * cb)]
}

/** RGB 0–255 → códigos de 8 bits (Y, U, V) sem arredondar (inversa exata de yuvToRgb; quadros de teste). */
export function rgbToYuv(r: number, g: number, b: number, c: YuvColor): [number, number, number] {
  const { ys, yo, cs, co } = levels(c.fullRange)
  const { kr, kb } = KRB[c.matrix]
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const yy = kr * R + (1 - kr - kb) * G + kb * B
  const cb = (B - yy) / (2 * (1 - kb))
  const cr = (R - yy) / (2 * (1 - kr))
  return [(yy - yo) / ys, (cb - co) / cs, (cr - co) / cs]
}

/**
 * Matriz do shader: rgb = m · (Y, U, V) + off, com Y/U/V normalizados 0–1 (o que a textura R8/RG8 devolve =
 * código/255) e rgb 0–1. `m` coluna-maior (convenção GL: m[0..2] = coluna de Y).
 */
export function yuvCoeffs(c: YuvColor): { m: number[]; off: [number, number, number] } {
  const { ys, yo, cs, co } = levels(c.fullRange)
  const { crR, cbG, crG, cbB } = chromaFactors(c.matrix)
  const Y = 255 * ys
  const C = 255 * cs
  return {
    m: [Y, Y, Y, 0, cbG * C, cbB * C, crR * C, crG * C, 0],
    off: [yo + crR * co, yo + (cbG + crG) * co, yo + cbB * co]
  }
}

export interface PlaneSpec { width: number; height: number; channels: 1 | 2 }

/** Planos de um quadro w×h: Y, croma 4:2:0 (arredondado para cima) como U+V (I420) ou UV entrelaçado (NV12), e A (I420A). */
export function planeSpecs(format: YuvFormat, w: number, h: number): PlaneSpec[] {
  const cw = Math.ceil(w / 2)
  const ch = Math.ceil(h / 2)
  const y: PlaneSpec = { width: w, height: h, channels: 1 }
  if (format === 'NV12') return [y, { width: cw, height: ch, channels: 2 }]
  const c: PlaneSpec = { width: cw, height: ch, channels: 1 }
  return format === 'I420A' ? [y, c, c, { ...y }] : [y, c, { ...c }]
}

/** Layout justo (planos em sequência, stride = largura × canais), como o copyTo devolve sem layout pedido. */
export function tightLayout(format: YuvFormat, w: number, h: number): { planes: { offset: number; stride: number }[]; size: number } {
  let offset = 0
  const planes = planeSpecs(format, w, h).map((p) => {
    const stride = p.width * p.channels
    const out = { offset, stride }
    offset += stride * p.height
    return out
  })
  return { planes, size: offset }
}

/**
 * Decisão do caminho (R1): só o VideoFrame que o chamador declarou em memória de CPU (`cpuFrames`, mesmas chaves do
 * mapa de fontes) e de formato coberto vai pelo caminho YUV. Nunca pelo formato sozinho: o NV12 do decoder de hardware
 * (na GPU) tem o mesmo `format`, e o copyTo dele é um readback caro. null = caminho antigo.
 */
export function yuvFormatFor(id: string, src: unknown, cpuFrames: ReadonlySet<string> | undefined): YuvFormat | null {
  if (!cpuFrames?.has(id) || typeof VideoFrame === 'undefined' || !(src instanceof VideoFrame)) return null
  const f = src.format
  return f !== null && FORMATS.has(f) ? (f as YuvFormat) : null
}
