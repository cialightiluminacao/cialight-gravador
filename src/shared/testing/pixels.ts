// Medidas de pixels para os testes de integração (o harness do renderer e o main, que lê a exportação com o ffmpeg,
// usam a mesma conta e o mesmo limiar). Puro.

export interface RedBlob { cx: number; cy: number; n: number; w: number; h: number }

/** Centro de massa (px, centro do pixel, y para baixo) e caixa dos pixels vermelhos; stride 4 = RGBA, 3 = RGB24. */
export function redBlob(d: Uint8Array, w: number, h: number, stride = 4): RedBlob | null {
  let sx = 0
  let sy = 0
  let n = 0
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * stride
      if (d[i] < 150 || d[i + 1] > 90 || d[i + 2] > 90) continue
      sx += x + 0.5
      sy += y + 0.5
      n++
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  }
  return n ? { cx: sx / n, cy: sy / n, n, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null
}
