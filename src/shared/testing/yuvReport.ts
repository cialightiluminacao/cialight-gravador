// Relatório do teste real do caminho de upload YUV (G1): yuvHarness (renderer) mede, editorTestMode (main) confere.
// Só tipos e utilidades de pixel puras.

export interface YuvCase {
  name: string
  /** Formato/cor do VideoFrame medido (diagnóstico). */
  format?: string | null
  colorSpace?: { matrix?: string | null; fullRange?: boolean | null; primaries?: string | null; transfer?: string | null }
  /** O desenho "novo" passou mesmo pelo caminho YUV (contador de conversões do compositor). */
  yuv?: boolean
  max?: number
  p99?: number
  /** Valores (por canal RGB) com diferença acima de 2. */
  over?: number
  /** Diferença máxima fora dos pixels a 1 px de uma borda de cor (colorEdgeMask) e quantos pixels são borda. */
  maxOffEdge?: number
  edgePx?: number
  /** Quadros construídos: maior diferença contra a conta de referência (yuvToRgb, fora das bordas) — antigo e novo. */
  refOld?: number
  refNew?: number
  /** Pior pixel (x, y no canvas) e a caixa dos pixels com diferença > 2 (diagnóstico). */
  worst?: { x: number; y: number; old: number[]; neu: number[] }
  box?: { x0: number; y0: number; x1: number; y1: number; n: number } | null
  /** Média RGB do quadro do caminho antigo (prova de conteúdo). */
  mean?: number
  /** Só informativo (não reprova): ex. primárias diferentes de BT.709. */
  informative?: boolean
  error?: string
}

export interface YuvTiming {
  frames: number
  /** draw + gl.finish com o VideoFrame direto (texImage2D do Chromium). */
  oldMs: number
  /** prepareCpuFrames (copyTo) + draw (upload dos planos + conversão) + gl.finish. */
  newMs: number
  copyMs: number
  drawMs: number
}

export interface YuvReport { error?: string; cases: YuvCase[]; timing?: YuvTiming; renderer?: string }

/**
 * Diferença por canal RGB (alfa ignorado) de duas imagens RGBA do mesmo tamanho: máximo, p99 e quantos valores >
 * `limit`. `mask` (1 por pixel): pixels marcados ficam de fora.
 */
export function rgbDiffStats(a: Uint8Array, b: Uint8Array, limit: number, mask?: Uint8Array): { max: number; p99: number; over: number; n: number } {
  const hist = new Uint32Array(256)
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    if (mask?.[i >> 2]) continue
    for (let c = 0; c < 3; c++) {
      hist[Math.abs(a[i + c] - b[i + c])]++
      n++
    }
  }
  let max = 0
  let over = 0
  for (let d = 0; d < 256; d++) {
    if (!hist[d]) continue
    max = d
    if (d > limit) over += hist[d]
  }
  let p99 = 0
  for (let d = 0, acc = 0; d < 256; d++) {
    acc += hist[d]
    if (acc >= 0.99 * n) {
      p99 = d
      break
    }
  }
  return { max, p99, over, n }
}

/**
 * Pixels a 1 px de uma borda de cor (exceção da paridade: amostragem do croma subamostrado nas bordas): 1 onde o pixel
 * ou um vizinho (4-vizinhança) difere do outro por mais de `jump` em algum canal RGB, em `a` ou em `b`.
 */
export function colorEdgeMask(a: Uint8Array, b: Uint8Array, w: number, h: number, jump: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  const differs = (img: Uint8Array, p: number, q: number): boolean =>
    Math.abs(img[p * 4] - img[q * 4]) > jump || Math.abs(img[p * 4 + 1] - img[q * 4 + 1]) > jump || Math.abs(img[p * 4 + 2] - img[q * 4 + 2]) > jump
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      for (const q of [x + 1 < w ? p + 1 : -1, y + 1 < h ? p + w : -1]) {
        if (q >= 0 && (differs(a, p, q) || differs(b, p, q))) {
          mask[p] = 1
          mask[q] = 1
        }
      }
    }
  }
  return mask
}

/** Maior diferença por canal RGB de `img` contra a referência `ref(x, y)` (null = sem referência), fora de `mask`. */
export function refDiffMax(img: Uint8Array, ref: (x: number, y: number) => readonly number[] | null, w: number, h: number, mask?: Uint8Array): number {
  let max = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (mask?.[p]) continue
      const r = ref(x, y)
      if (!r) continue
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(img[p * 4 + c] - r[c]))
    }
  }
  return max
}
