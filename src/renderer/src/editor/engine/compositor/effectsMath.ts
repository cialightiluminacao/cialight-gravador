// Matemática pura do passe de efeitos (blur/pixelização/tarja) do compositor, sem WebGL.
// Tamanhos proporcionais à ALTURA do quadro de saída: o mesmo efeito tem a mesma aparência no preview
// (canvas do visualizador) e em qualquer resolução de exportação.

export interface RegionGeom { x: number; y: number; w: number; h: number; rotation: number }
export interface PxRect { x: number; y: number; w: number; h: number }

const clampStrength = (s: number): number => Math.min(100, Math.max(0, s)) / 100
// folga contra erro de ponto flutuante (0,4 × 1920 = 768,0000000000001) no floor/ceil das caixas
const EPS = 1e-6

/** Raio do blur em px de saída: intensidade 0–100 → 0…4 % da altura (60 em 1080p ≈ 26 px). */
export function blurRadiusPx(strength: number, outH: number): number {
  return clampStrength(strength) * outH * 0.04
}

/** Lado do bloco da pixelização em px de saída: 0–100 → 2…altura/12 (nunca abaixo de 2). */
export function pixelBlockPx(strength: number, outH: number): number {
  const max = Math.max(2, outH / 12)
  return 2 + clampStrength(strength) * (max - 2)
}

/** Redução da resolução antes do blur (ruling F0: sempre ≥ 2×). */
export function downsampleFactor(radiusPx: number): 2 | 4 | 8 {
  if (radiusPx > 64) return 8
  if (radiusPx > 24) return 4
  return 2
}

/** Largura da borda suave em px: feather × min(w, h)/2 (cresce para fora da região; invertido: para dentro). */
export function featherPx(region: { w: number; h: number }, feather: number, W: number, H: number): number {
  return Math.max(0, feather) * Math.min(Math.abs(region.w) * W, Math.abs(region.h) * H) / 2
}

/**
 * Pesos do kernel gaussiano 1D com σ = raio/2 e suporte de 3σ (limitado a `maxTaps` de cada lado):
 * w[0] é o centro, w[i] vale para ±i; normalizados (w[0] + 2·Σw[i>0] = 1).
 */
export function gaussianWeights(radius: number, maxTaps = 32): number[] {
  const sigma = Math.max(0.5, radius / 2)
  const n = Math.min(maxTaps, Math.max(1, Math.ceil(3 * sigma)))
  const w: number[] = []
  for (let i = 0; i <= n; i++) w.push(Math.exp(-(i * i) / (2 * sigma * sigma)))
  const sum = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0)
  return w.map((v) => v / sum)
}

/**
 * Caixa alinhada aos eixos (px inteiros, origem embaixo à esquerda como no GL) que contém todo pixel com máscara > 0
 * da região rotacionada (horária na tela, em torno do centro) mais a borda suave, clampada ao quadro W×H.
 * Retângulo: caixa do retângulo + feather (distância exata). Elipse: caixa da elipse ampliada por
 * s = 1 + feather/min(a, b) — fora dela a cota de regionDistPx já passa do feather. Fora do quadro → w ou h = 0.
 */
export function regionScissor(region: RegionGeom & { shape?: 'rect' | 'ellipse' }, feather: number, W: number, H: number): PxRect {
  const th = (region.rotation * Math.PI) / 180
  const c = Math.abs(Math.cos(th))
  const s = Math.abs(Math.sin(th))
  const hw = (Math.abs(region.w) * W) / 2
  const hh = (Math.abs(region.h) * H) / 2
  const pad = featherPx(region, feather, W, H)
  let ex: number
  let ey: number
  if (region.shape === 'ellipse') {
    const k = 1 + pad / Math.max(1e-3, Math.min(hw, hh))
    ex = Math.hypot(k * hw * c, k * hh * s)
    ey = Math.hypot(k * hw * s, k * hh * c)
  } else {
    ex = c * hw + s * hh + pad
    ey = s * hw + c * hh + pad
  }
  const cx = region.x * W
  const cyUp = H - region.y * H
  const x0 = Math.max(0, Math.floor(cx - ex + EPS))
  const x1 = Math.min(W, Math.ceil(cx + ex - EPS))
  const y0 = Math.max(0, Math.floor(cyUp - ey + EPS))
  const y1 = Math.min(H, Math.ceil(cyUp + ey - EPS))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/**
 * Distância com sinal (px; < 0 dentro) do ponto (px, py), y para baixo, à região — espelho exato da máscara de
 * FS_APPLY (shaders.ts). Retângulo: exata. Elipse: aproximação f·(f−1)/|∇f|, e fora (f > 1) nunca menor que
 * (f − 1)·min(a, b), que é cota inferior da distância real (a elipse ampliada por f contém a elipse + disco desse raio).
 */
export function regionDistPx(region: RegionGeom & { shape: 'rect' | 'ellipse' }, px: number, py: number, W: number, H: number): number {
  const th = (region.rotation * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  const dx = px - region.x * W
  const dy = py - region.y * H
  const lx = c * dx + s * dy
  const ly = -s * dx + c * dy
  const hx = Math.max((Math.abs(region.w) * W) / 2, 1e-3)
  const hy = Math.max((Math.abs(region.h) * H) / 2, 1e-3)
  if (region.shape === 'ellipse') {
    const f = Math.hypot(lx / hx, ly / hy)
    const g = Math.hypot(lx / (hx * hx), ly / (hy * hy))
    let d = g > 1e-6 ? (f * (f - 1)) / g : -Math.min(hx, hy)
    if (f > 1) d = Math.max(d, (f - 1) * Math.min(hx, hy))
    return d
  }
  const qx = Math.abs(lx) - hx
  const qy = Math.abs(ly) - hy
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
}
