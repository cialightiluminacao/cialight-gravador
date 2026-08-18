import type { PipKeyframe, PipShape } from '@shared/types'

// Escolha de posição da PiP na exportação (lógica pura, testável): "como gravado" mantém os
// keyframes da sessão; "fixa" usa um canto/tamanho/forma fixos, preservando a linha do tempo
// de visibilidade original (câmera desligada com F2 grava keyframes visible=false).

export type PipCorner = 'tl' | 'tr' | 'bl' | 'br'
export type PipSize = 'p' | 'm' | 'g'
export type PipChoice = { mode: 'original' } | { mode: 'fixed'; corner: PipCorner; size: PipSize; shape: PipShape }

/** Largura da PiP em fração da largura do vídeo, por tamanho. */
export const PIP_SIZE_W: Record<PipSize, number> = { p: 0.16, m: 0.2, g: 0.28 }
/** Margem até a borda, em fração da largura (a vertical usa a mesma medida em pixels). */
export const PIP_MARGIN_X = 0.03

/** Keyframes da PiP para a escolha; null = manter o movimento gravado. */
export function pipOverrideFor(choice: PipChoice, videoW: number, videoH: number, recorded: PipKeyframe[]): PipKeyframe[] | null {
  if (choice.mode === 'original') return null
  const aspect = videoW > 0 && videoH > 0 ? videoW / videoH : 16 / 9
  const w = PIP_SIZE_W[choice.size]
  const h = Math.min(1, w * aspect)
  const mx = PIP_MARGIN_X
  const my = PIP_MARGIN_X * aspect
  const x = choice.corner === 'tl' || choice.corner === 'bl' ? mx : 1 - w - mx
  const y = choice.corner === 'tl' || choice.corner === 'tr' ? my : 1 - h - my
  const base = recorded.length ? recorded.slice().sort((a, b) => a.tMs - b.tMs) : [{ tMs: 0, visible: true }]
  // Só os keyframes em que a visibilidade muda importam (posição/forma são sempre as mesmas).
  return base.filter((k, i) => i === 0 || k.visible !== base[i - 1].visible).map((k) => ({ tMs: k.tMs, x, y, w, h, shape: choice.shape, visible: k.visible }))
}
