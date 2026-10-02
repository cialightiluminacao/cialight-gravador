// Relatório do teste real de texto e formas (F5 Task 4): textHarness (renderer) mede, editorTestMode (main) confere.
// Só tipos e utilidades de pixel puras.

export type Rgb = [number, number, number]
/** Caixa em px do quadro, x1/y1 exclusivos; null = nenhum pixel. */
export interface PxBounds { x0: number; y0: number; x1: number; y1: number; n: number }

/** Caixa e contagem dos pixels (RGBA, linha a linha de cima) que satisfazem `pred`, dentro de `area` (padrão: tudo). */
export function boundsOf(d: Uint8Array, W: number, H: number, pred: (r: number, g: number, b: number) => boolean, area?: { x0: number; y0: number; x1: number; y1: number }): PxBounds | null {
  const a = area ?? { x0: 0, y0: 0, x1: W, y1: H }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0
  for (let y = Math.max(0, a.y0); y < Math.min(H, a.y1); y++) {
    for (let x = Math.max(0, a.x0); x < Math.min(W, a.x1); x++) {
      const i = (y * W + x) * 4
      if (!pred(d[i], d[i + 1], d[i + 2])) continue
      n++
      if (x < x0) x0 = x
      if (x >= x1) x1 = x + 1
      if (y < y0) y0 = y
      if (y >= y1) y1 = y + 1
    }
  }
  return n ? { x0, y0, x1, y1, n } : null
}

export interface TextBoxPx { cx: number; cy: number; w: number; h: number }

export interface TitleShot {
  align: 'left' | 'center' | 'right'
  /** Caixa esperada (measureTextBox na thread principal, Manrope carregada). */
  expected: TextBoxPx
  /** Pixels da cor do fundo (#2050ff ±3). */
  blue: PxBounds | null
  /** Cor no meio do padding esquerdo (fora das letras). */
  bgPixel: Rgb
  /** Pixels brancos (> 200) na caixa e caixa deles. */
  white: PxBounds | null
  /** Tinta branca da 2ª linha ("T"): o alinhamento. */
  line2: PxBounds | null
  /** Padding em px (0,3 em). */
  pad: number
  /** Quadros pedidos até sair sem `fontsPending` (fonte do app carregada no worker). */
  fontTries: number
}

export interface TextReport {
  error?: string
  titles?: TitleShot[]
  stroke?: { white: PxBounds | null; red: PxBounds | null; strokePx: number }
  shadow?: { white: PxBounds | null; dark: PxBounds | null; offsetPx: number }
  wrap?: { lines: number; blue: PxBounds | null; expectedH: number; maxW: number }
  shapes?: { rectCenter: Rgb; ellipseCenter: Rgb; ellipseCorner: Rgb; arrowTip: Rgb; arrowTail: Rgb; spotOutside: Rgb; spotInside: Rgb; spotEdgeOutside: Rgb }
  /** Desfoque da camada de texto: diferença máx. fora da área (caixa + alcance) e soma da diferença dentro da caixa. */
  layerBlur?: { blurPx: number; outsideMaxDiff: number; insideDiff: number; area: { x0: number; y0: number; x1: number; y1: number } }
  /** Efeito `track` (blur) com alvo na faixa do texto: a mídia abaixo (fora do alcance do texto) intacta, o texto borrado. */
  trackScope?: { radius: number; mediaMaxDiff: number; textDiff: number; mediaPixels: number }
  /** Crossfade A = imagem vermelha → B = título: meio da janela. */
  crossfade?: { p: number; A: Rgb; inBox: Rgb; outside: Rgb; expectedIn: Rgb; expectedOut: Rgb }
  parity?: { frame: number; fromUs: number; preview: number[]; exportPath?: string; exportError?: string; meanDiff?: number[] }
}
