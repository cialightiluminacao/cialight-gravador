import { easeValue } from '@shared/editor/anim'
import type { AnimPreset, Ease, PresetAnim, Us } from '@shared/editor/project'
import { PRESET_BLUR_PX, PRESET_EASE, presetPose } from '@shared/editor/resolve'

// Painel de animações de entrada/saída (puro): cartões dos presets, prévia em miniatura (keyframes CSS gerados pela
// mesma conta do resolve, presetPose) e limites de duração.

export type AnimSide = 'in' | 'out' | 'both'

export const PRESET_CARDS: { preset: AnimPreset; label: string; title: string }[] = [
  { preset: 'fade', label: 'Fade', title: 'Aparece/some pela opacidade' },
  { preset: 'slideL', label: 'Esquerda', title: 'Desliza pela esquerda do quadro' },
  { preset: 'slideR', label: 'Direita', title: 'Desliza pela direita do quadro' },
  { preset: 'slideU', label: 'Cima', title: 'Desliza por cima do quadro' },
  { preset: 'slideD', label: 'Baixo', title: 'Desliza por baixo do quadro' },
  { preset: 'zoom', label: 'Zoom', title: 'Cresce de 80 % a 100 % enquanto aparece' },
  { preset: 'pop', label: 'Pop', title: 'Salta de 60 % a 105 % e assenta em 100 %' },
  { preset: 'rotate', label: 'Girar', title: 'Gira de −15° até a posição enquanto aparece' },
  { preset: 'bounce', label: 'Bater', title: 'Sobe por baixo, passa do ponto e volta' },
  { preset: 'blur', label: 'Desfoque', title: 'Sai do desfoque (20 px) enquanto aparece' }
]

/** Curvas do seletor; null = a padrão do preset (sem `ease` gravado). */
export const EASE_OPTIONS: { id: string; label: string; ease: Ease | null }[] = [
  { id: 'default', label: 'Padrão do preset', ease: null },
  { id: 'linear', label: 'Linear', ease: 'linear' },
  { id: 'in', label: 'Suavizar entrada', ease: 'in' },
  { id: 'out', label: 'Suavizar saída', ease: 'out' },
  { id: 'inOut', label: 'Suavizar ambos', ease: 'inOut' },
  { id: 'overshoot', label: 'Overshoot', ease: { bezier: [0.34, 1.56, 0.64, 1] } }
]

/** Id do seletor para a curva gravada (bezier fora da lista = 'custom'). */
export function easeOptionId(e: Ease | undefined): string {
  if (e === undefined) return 'default'
  const hit = EASE_OPTIONS.find((o) => o.ease !== null && JSON.stringify(o.ease) === JSON.stringify(e))
  return hit ? hit.id : 'custom'
}

export const DEFAULT_ANIM_US: Us = 500_000
export const MIN_ANIM_US: Us = 50_000

/** Maior duração de um lado: o item inteiro; na combinação (entrada e saída iguais), metade. */
export function maxAnimUs(itemDurUs: Us, side: AnimSide): Us {
  return Math.max(MIN_ANIM_US, side === 'both' ? Math.floor(itemDurUs / 2) : itemDurUs)
}

/** Duração presa a [MIN_ANIM_US, maxAnimUs], em µs inteiros. */
export function clampAnimUs(us: number, itemDurUs: Us, side: AnimSide): Us {
  return Math.round(Math.min(maxAnimUs(itemDurUs, side), Math.max(MIN_ANIM_US, us)))
}

/** Ciclo da miniatura (s) e os trechos com movimento (frações do ciclo). */
export const THUMB_CYCLE_S = 2.4
const SEGMENTS: Record<AnimSide, { from: number; to: number; isIn: boolean }[]> = {
  in: [{ from: 0, to: 0.45, isIn: true }],
  out: [{ from: 0.2, to: 0.65, isIn: false }],
  both: [{ from: 0, to: 0.35, isIn: true }, { from: 0.55, to: 0.9, isIn: false }]
}
// desfoque na miniatura: 20 px num quadro de 1080 seria invisível em ~30 px de altura — exagerado de propósito
const THUMB_BLUR_MAX_PX = 3

const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** Estilo CSS de uma pose (translate em % do próprio retângulo, que ocupa o quadro da miniatura inteiro). */
function poseCss(preset: AnimPreset, q: number): string {
  const p = presetPose(preset, q)
  const blur = (p.blur / PRESET_BLUR_PX) * THUMB_BLUR_MAX_PX
  return `opacity:${r3(Math.min(1, Math.max(0, p.opacity)))};transform:translate(${r3(p.dx * 100)}%,${r3(p.dy * 100)}%) scale(${r3(Math.max(0, p.scale))}) rotate(${r3(p.rotation)}deg);filter:blur(${r3(blur)}px)`
}

/**
 * @keyframes da miniatura do preset (nome `name`): a pose de presetPose ao longo do ciclo — entrada, repouso, saída
 * conforme o lado — com a curva `ease` (ausente = a do preset). Uma amostra a cada 2,5 % nos trechos com movimento.
 */
export function thumbKeyframes(name: string, preset: AnimPreset, side: AnimSide, ease?: Ease): string {
  const e = ease ?? PRESET_EASE[preset]
  const steps = new Map<number, string>()
  const segs = SEGMENTS[side]
  // antes do 1º trecho e depois do último: o estado da ponta (entrada: fora; saída: em repouso / fora no fim)
  steps.set(0, poseCss(preset, segs[0].isIn ? 0 : 1))
  for (const s of segs) {
    const n = Math.round((s.to - s.from) / 0.025)
    for (let i = 0; i <= n; i++) {
      const v = easeValue(e, i / n)
      steps.set(r3(s.from + ((s.to - s.from) * i) / n), poseCss(preset, s.isIn ? v : 1 - v))
    }
  }
  steps.set(1, poseCss(preset, segs[segs.length - 1].isIn ? 1 : 0))
  const body = [...steps.entries()].sort((a, b) => a[0] - b[0]).map(([k, css]) => `${r3(k * 100)}%{${css}}`).join('')
  return `@keyframes ${name}{${body}}`
}

/** A animação gravada no lado (combinação: entrada e saída iguais, senão null). */
export function sideAnim(v: { animIn?: PresetAnim; animOut?: PresetAnim }, side: AnimSide): PresetAnim | null {
  if (side === 'in') return v.animIn ?? null
  if (side === 'out') return v.animOut ?? null
  const a = v.animIn, b = v.animOut
  return a && b && a.preset === b.preset && a.durationUs === b.durationUs && JSON.stringify(a.ease) === JSON.stringify(b.ease) ? a : null
}
