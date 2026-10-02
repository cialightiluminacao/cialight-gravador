import type { TransitionKind } from '../editor/project'

// Modelo de referência das transições (F5) para o teste real de pixels (transitionHarness no renderer; verificação em
// editorTestMode no main): A e B de cor uniforme cobrindo o quadro inteiro, fundo preto. Mesma semântica do shader
// (compositor/shadersTransitions.ts), escrita de forma independente. Puro.

export type Rgb = [number, number, number]

export const TRANSITION_KINDS: TransitionKind[] = ['crossfade', 'dipBlack', 'dipWhite', 'slideL', 'slideR', 'slideU', 'slideD', 'wipeL', 'wipeR', 'zoomIn', 'blur']

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k]

/**
 * Cor esperada no ponto (u, v) do quadro (0–1, v para BAIXO) com progresso p (o já suavizado da TransitionLayer).
 * Deslizar/cortina: lado de cada ponto pela borda (a borda suave de 1 % da cortina fica de fora: ver boundaryDist).
 * Zoom: A (escala ≥ 1) cobre tudo com alfa 1 − p; B (escala 0,85 + 0,15p, centrado) com alfa p só dentro da caixa dele.
 */
export function transitionPixel(kind: TransitionKind, p: number, u: number, v: number, A: Rgb, B: Rgb): Rgb {
  switch (kind) {
    case 'crossfade':
    case 'blur':
      return mix(A, B, p)
    case 'dipBlack':
    case 'dipWhite': {
      const c: Rgb = kind === 'dipBlack' ? [0, 0, 0] : [255, 255, 255]
      return p < 0.5 ? mix(A, c, 2 * p) : mix(c, B, 2 * p - 1)
    }
    case 'slideL':
      return u < 1 - p ? A : B
    case 'slideR':
      return u >= p ? A : B
    case 'slideU':
      return v < 1 - p ? A : B
    case 'slideD':
      return v >= p ? A : B
    case 'wipeL':
      return u > 1 - p ? B : A
    case 'wipeR':
      return u < p ? B : A
    case 'zoomIn': {
      const half = (0.85 + 0.15 * p) / 2
      const inB = Math.abs(u - 0.5) <= half && Math.abs(v - 0.5) <= half
      const a = scale(A, 1 - p)
      return inB ? [a[0] + B[0] * p, a[1] + B[1] * p, a[2] + B[2] * p] : a
    }
  }
}

/** Distância (fração do quadro) do ponto à borda mais próxima entre regiões de cores diferentes; Infinity = sem borda. */
export function boundaryDist(kind: TransitionKind, p: number, u: number, v: number): number {
  switch (kind) {
    case 'slideL':
    case 'wipeL':
      return Math.abs(u - (1 - p))
    case 'slideR':
    case 'wipeR':
      return Math.abs(u - p)
    case 'slideU':
      return Math.abs(v - (1 - p))
    case 'slideD':
      return Math.abs(v - p)
    case 'zoomIn': {
      const half = (0.85 + 0.15 * p) / 2
      return Math.min(Math.abs(Math.abs(u - 0.5) - half), Math.abs(Math.abs(v - 0.5) - half))
    }
    default:
      return Infinity
  }
}

/** Pontos de amostra (u, v) da grade 10×10 (centros das células). */
export const SAMPLE_GRID: [number, number][] = Array.from({ length: 100 }, (_, k) => [((k % 10) + 0.5) / 10, (Math.floor(k / 10) + 0.5) / 10])

// ---- relatório do teste real (renderer → main) ----

/** Instante medido: maior erro por canal contra o modelo nos pontos válidos da grade e o pior ponto. */
export interface TransitionShot { tUs: number; linear: number; p: number; n: number; maxErr: number; worst: { u: number; v: number; got: Rgb; want: Rgb } | null }
export interface TransitionKindReport { kind: TransitionKind; before: TransitionShot; after: TransitionShot; inside: TransitionShot[] }
/** Privacidade: brancos (r, g, b > 200) visíveis por quadro da janela. */
export interface TransitionPrivacyRun { kind: TransitionKind; side: 'A' | 'B'; frames: number; whiteMax: number; whiteFrames: number; controlWhiteMax: number }
export interface TransitionBench { mean: number; median: number; p95: number; max: number; n: number }
export interface TransitionReport {
  error?: string
  renderer?: string
  colors?: { A: Rgb; B: Rgb }
  kinds?: TransitionKindReport[]
  privacy?: TransitionPrivacyRun[]
  /** escopo `track` (tarja #123456 no centro) sobre a faixa em transição, nos instantes 0,25/0,5/0,75 */
  trackScope?: { kind: TransitionKind; centers: Rgb[] }
  /** maior salto de soma RGB entre vizinhos através da borda do quadrado branco: fora da janela × no meio do 'blur' */
  blurEdge?: { sharp: number; mid: number }
  /** quadros do preview (amostra a cada PARITY_STRIDE px) para comparar com a exportação no main */
  parity?: { kind: TransitionKind; exportPath?: string; exportError?: string; fromUs: number; frames: { frame: number; preview: number[] }[]; meanDiff?: number[] }[]
  bench?: { crossfade?: TransitionBench; blur?: TransitionBench; error?: string }
}

/** Passo da amostra de paridade (px) e deslocamento: pontos (STRIDE·i + 1, STRIDE·j + 1). */
export const PARITY_STRIDE = 4

/** Amostra RGB (a cada PARITY_STRIDE px) de uma imagem w×h com `channels` canais por pixel. */
export function paritySample(d: Uint8Array, w: number, h: number, channels: number): number[] {
  const out: number[] = []
  for (let y = 1; y < h; y += PARITY_STRIDE) {
    for (let x = 1; x < w; x += PARITY_STRIDE) {
      const i = (y * w + x) * channels
      out.push(d[i], d[i + 1], d[i + 2])
    }
  }
  return out
}

/** Diferença média absoluta por canal (R, G, B) entre duas amostras do mesmo tamanho. */
export function meanDiffPerChannel(a: readonly number[], b: readonly number[]): number[] {
  const s = [0, 0, 0]
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s[i % 3] += Math.abs(a[i] - b[i])
  return s.map((x) => Math.round((x / Math.max(1, n / 3)) * 100) / 100)
}
