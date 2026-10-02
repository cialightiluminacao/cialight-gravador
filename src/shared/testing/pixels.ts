// Medidas de pixels para os testes de integração (o harness do renderer e o main, que lê a exportação com o ffmpeg,
// usam a mesma conta e o mesmo limiar). Puro.

export interface RedBlob { cx: number; cy: number; n: number; w: number; h: number }

const lumaAt = (d: Uint8Array, i: number): number => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]

/** Centro de massa (px, centro do pixel, y para baixo) e caixa dos pixels em que `match(r, g, b)`; stride 4 = RGBA, 3 = RGB24. */
export function colorBlob(d: Uint8Array, w: number, h: number, match: (r: number, g: number, b: number) => boolean, stride = 4): RedBlob | null {
  let sx = 0
  let sy = 0
  let n = 0
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * stride
      if (!match(d[i], d[i + 1], d[i + 2])) continue
      sx += x + 0.5
      sy += y + 0.5
      n++
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  }
  return n ? { cx: sx / n, cy: sy / n, n, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null
}

/** Pixels vermelhos (R ≥ 150, G e B ≤ 90). */
export function redBlob(d: Uint8Array, w: number, h: number, stride = 4): RedBlob | null {
  return colorBlob(d, w, h, (r, g, b) => r >= 150 && g <= 90 && b <= 90, stride)
}

/** Pixels verdes (a caixa 0x40a060 do alvo do zoom, também com opacidade ≥ ~0,6 sobre o fundo escuro): G > 90, G − R > 40, G − B > 30. */
export function greenBlob(d: Uint8Array, w: number, h: number, stride = 4): RedBlob | null {
  return colorBlob(d, w, h, (r, g, b) => g > 90 && g - r > 40 && g - b > 30, stride)
}

/**
 * Energia de detalhe (métrica do blur do F2): média de ΔL² entre vizinhos (horizontal + vertical) em [x0,x1)×[y0,y1)
 * de uma imagem de largura `w`. O blur espalha as bordas e derruba essa energia (~1/raio).
 */
export function detailEnergy(d: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number, stride = 4): number {
  let s = 0
  let n = 0
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const i = (y * w + x) * stride
      const l = lumaAt(d, i)
      s += (l - lumaAt(d, i + stride)) ** 2 + (l - lumaAt(d, i + w * stride)) ** 2
      n++
    }
  }
  return n ? s / n : 0
}

/** Caixa de pixels (px, inclusiva, y para baixo). */
export interface PxBox { x0: number; y0: number; x1: number; y1: number }

/** Caixa dos pixels claros (texto branco, luma > 128) entre as linhas y0 e y1. */
export function brightBox(d: Uint8Array, w: number, y0: number, y1: number, stride = 4): PxBox | null {
  let b: PxBox | null = null
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      if (lumaAt(d, (y * w + x) * stride) <= 128) continue
      b = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y }
    }
  }
  return b
}

/**
 * Contraste local de uma linha de texto (métrica de legibilidade do F2): caixa 3×3 na luma e p99 − p1 dentro da caixa
 * + `pad` px. Legível ≈ o da fonte; ilegível < 0,15 dele.
 */
export function localContrast(d: Uint8Array, w: number, h: number, b: PxBox, pad = 4, stride = 4): number {
  const vals: number[] = []
  for (let y = Math.max(1, b.y0 - pad); y <= Math.min(h - 2, b.y1 + pad); y++) {
    for (let x = Math.max(1, b.x0 - pad); x <= Math.min(w - 2, b.x1 + pad); x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += lumaAt(d, ((y + dy) * w + x + dx) * stride)
      vals.push(s / 9)
    }
  }
  vals.sort((p, q) => p - q)
  const at = (q: number): number => vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))]
  return at(0.99) - at(0.01)
}

/** Variância do laplaciano (4 vizinhos) da luma na caixa + `pad` px (métrica de legibilidade do F2: ilegível < 0,2 da fonte). */
export function laplacianVar(d: Uint8Array, w: number, h: number, b: PxBox, pad = 4, stride = 4): number {
  let n = 0
  let s = 0
  let s2 = 0
  const L = (x: number, y: number): number => lumaAt(d, (y * w + x) * stride)
  for (let y = Math.max(1, b.y0 - pad); y <= Math.min(h - 2, b.y1 + pad); y++) {
    for (let x = Math.max(1, b.x0 - pad); x <= Math.min(w - 2, b.x1 + pad); x++) {
      const l = 4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1)
      n++
      s += l
      s2 += l * l
    }
  }
  return n ? s2 / n - (s / n) ** 2 : 0
}
