// Avisos de privacidade: efeitos fracos demais ou desativados num intervalo da timeline. Puro.
import { evalAnim } from './anim'
import type { Project, Us } from './project'
import { itemEndUs } from './time'

export interface PrivacyWarning { itemId: string; kind: 'weakBlur' | 'weakPixelate' | 'disabled' | 'feather'; message: string }

const MSG = {
  weakBlur: 'Blur fraco pode ser revertido; use intensidade ≥ 35 ou Tarja',
  weakPixelate: 'Pixelado fraco pode ser revertido; use intensidade ≥ 30 ou Tarja',
  disabled: 'Efeito de privacidade desativado neste trecho: o conteúdo aparece sem proteção',
  feather: 'Borda muito suave com intensidade baixa: as bordas podem revelar o conteúdo'
} as const

/** Avisos dos efeitos que tocam [fromUs,toUs]; no máximo um por tipo e por efeito. */
export function privacyWarnings(p: Project, fromUs: Us, toUs: Us): PrivacyWarning[] {
  const out: PrivacyWarning[] = []
  const hi = Math.max(toUs, fromUs + 1)
  for (const track of p.tracks) {
    for (const it of track.items) {
      if (it.type !== 'effect') continue
      const s = it.startUs, e = itemEndUs(it)
      if (s >= hi || e <= fromUs) continue
      // faixa oculta não renderiza, então também deixa o conteúdo sem proteção
      if (it.enabled === false || track.hidden) {
        out.push({ itemId: it.id, kind: 'disabled', message: MSG.disabled })
        continue
      }
      // pontos de avaliação (locais ao item): bordas do trecho visível e cada keyframe dentro dele
      const lo = Math.max(s, fromUs) - s, up = Math.max(lo, Math.min(e, toUs) - s)
      const times = [lo, up, ...(it.strength.keys ?? []).map((k) => k.tUs).filter((t) => t >= lo && t <= up)]
      const min = Math.min(...times.map((t) => evalAnim(it.strength, t)))
      if (it.effect === 'blur' && min < 35) out.push({ itemId: it.id, kind: 'weakBlur', message: MSG.weakBlur })
      if (it.effect === 'pixelate' && min < 30) out.push({ itemId: it.id, kind: 'weakPixelate', message: MSG.weakPixelate })
      if (it.feather > 0.4 && min < 50) out.push({ itemId: it.id, kind: 'feather', message: MSG.feather })
    }
  }
  return out
}
