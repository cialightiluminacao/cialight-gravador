import { detailEnergy, greenBlob, redBlob, type RedBlob } from './pixels'

// Medidas das animações de entrada/saída (F4) no projeto do zoom: o harness do renderer (preview) e o main (quadros
// da exportação lidos com o ffmpeg) usam as mesmas contas. Puro.

const W = 1920

/**
 * Instantes medidos (µs; quadros exatos a 30 fps): invisível, pop 0,6 + 0,45·4/7 ≈ 0,857 (opacidade 0,8), pop 1,05,
 * repouso, desfoque de saída 4 e 10 px.
 */
export const ANIM_TIMES = { start: 0, popMid: 400_000, popPeak: 700_000, rest: 1_500_000, blur4: 2_200_000, blur10: 2_500_000 } as const
/** Caixa (px de 1920×1080, [x0,x1)×[y0,y1)) da energia de detalhe: a caixa verde + 30 px. */
export const ANIM_DETAIL_BOX = { x0: 270, y0: 670, x1: 530, y1: 850 }

export interface AnimShot { green: RedBlob | null; red: RedBlob | null; maxChannel: number; detail: number }

/** Caixa verde, centro do vermelho, maior canal do quadro e energia de detalhe na caixa (escalada à largura `w`). */
export function measureShot(d: Uint8Array, w: number, h: number, stride: number): AnimShot {
  let maxChannel = 0
  for (let i = 0; i < d.length; i += stride) maxChannel = Math.max(maxChannel, d[i], d[i + 1], d[i + 2])
  const k = w / W
  const b = ANIM_DETAIL_BOX
  return {
    green: greenBlob(d, w, h, stride),
    red: redBlob(d, w, h, stride),
    maxChannel,
    detail: detailEnergy(d, w, Math.round(b.x0 * k), Math.round(b.y0 * k), Math.round(b.x1 * k), Math.round(b.y1 * k), stride)
  }
}


/** Redução 2× (média de cada bloco 2×2) de uma imagem RGBA w×h (w, h pares): o quadro de 1080 visto em 540. */
export function downsample2(d: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array((w / 2) * (h / 2) * 4)
  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < w / 2; x++) {
      for (let c = 0; c < 4; c++) {
        const i = (2 * y * w + 2 * x) * 4 + c
        out[(y * (w / 2) + x) * 4 + c] = Math.round((d[i] + d[i + 4] + d[i + w * 4] + d[i + w * 4 + 4]) / 4)
      }
    }
  }
  return out
}
