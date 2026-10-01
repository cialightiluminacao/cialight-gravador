import type { Us } from '@shared/editor/project'
import { formatTimecodeUs } from '@shared/editor/time'

// Matemática pura da linha do tempo: conversão µs ↔ px (scrollUs = instante na borda esquerda),
// zoom ancorado no mouse, "ajustar tudo", escolha dos passos da régua e limite de rolagem.

export const ZOOM_MIN = 1
export const ZOOM_MAX = 4000
export const ZOOM_DEFAULT = 100
/** Tolerância do ímã (px), convertida em µs pelo zoom. */
export const SNAP_PX = 8

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

export function usToPx(us: Us, pxPerSec: number, scrollUs: Us): number {
  return ((us - scrollUs) * pxPerSec) / 1e6
}

/** Instante (µs inteiros) sob a coordenada px da área das faixas. */
export function pxToUs(px: number, pxPerSec: number, scrollUs: Us): Us {
  return Math.round(scrollUs + (px * 1e6) / pxPerSec)
}

/** Duração (µs) de `px` pixels no zoom atual. */
export const pxToDurUs = (px: number, pxPerSec: number): Us => Math.round((px * 1e6) / pxPerSec)

/** Zoom por `factor` mantendo `anchorUs` parado em `anchorPx` (posição do mouse). */
export function zoomAround(pxPerSec: number, factor: number, anchorUs: Us, scrollUs: Us, anchorPx: number): { pxPerSec: number; scrollUs: Us } {
  void scrollUs // a âncora já carrega a posição; o scroll antigo não entra na conta
  const z = clampZoom(pxPerSec * factor)
  return { pxPerSec: z, scrollUs: Math.max(0, Math.round(anchorUs - (anchorPx * 1e6) / z)) }
}

/** Zoom em que o projeto inteiro cabe na largura, com 5 % de folga à direita. */
export function fitZoom(durationUs: Us, widthPx: number): number {
  if (durationUs <= 0 || widthPx <= 0) return ZOOM_DEFAULT
  return clampZoom((widthPx * 0.95 * 1e6) / durationUs)
}

/** Rolagem máxima: o fim do projeto pode chegar até o meio da área visível. */
export function maxScrollUs(durationUs: Us, widthPx: number, pxPerSec: number): Us {
  const spanUs = (widthPx * 1e6) / pxPerSec
  return Math.max(0, Math.round(durationUs - spanUs / 2))
}

// passos [major, minor]: em quadros (f) e em segundos (s); o major é o menor com ≥ 80 px
const FRAME_STEPS: [number, number][] = [[1, 1], [2, 1], [5, 1], [10, 2]]
const SEC_STEPS: [number, number][] = [[1, 0.25], [2, 0.5], [5, 1], [10, 2], [15, 5], [30, 5], [60, 10], [120, 30], [300, 60], [600, 120]]
const MAJOR_MIN_PX = 80

/**
 * Passos da régua (µs; em passos de quadro o valor é fracionário — só para desenho):
 * de 1 quadro a 10 min, escolhidos para o major ter ≥ 80 px; o minor divide o major.
 */
export function rulerTicks(pxPerSec: number, fps: number): { majorUs: number; minorUs: number } {
  const steps: [number, number][] = [
    ...FRAME_STEPS.filter(([f]) => f / fps < 1).map(([a, b]): [number, number] => [(a * 1e6) / fps, (b * 1e6) / fps]),
    ...SEC_STEPS.map(([a, b]): [number, number] => [a * 1e6, b * 1e6])
  ]
  for (const [majorUs, minorUs] of steps) if ((majorUs * pxPerSec) / 1e6 >= MAJOR_MIN_PX) return { majorUs, minorUs }
  const [majorUs, minorUs] = steps[steps.length - 1]
  return { majorUs, minorUs }
}

/** Rótulo do tick: com quadro (mm:ss:ff) quando o passo é menor que 1 s; senão m:ss / h:mm:ss. */
export function rulerLabel(us: Us, majorUs: number, fps: number): string {
  if (majorUs < 1e6) return formatTimecodeUs(Math.round(us), fps)
  const s = Math.round(us / 1e6)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
