// Texto dos avisos de privacidade e o aviso final do "Exportar quadro (PNG)" direto (Ctrl+Shift+E / botão
// "Quadro"). Puro (sem DOM/toast): o diálogo e o atalho usam o mesmo texto, e o atalho nunca mostra "sucesso"
// simples quando o quadro tem aviso de privacidade (invariante 2: nunca silêncio).
import { findItem } from '@shared/editor/ops'
import { privacyWarnings, type PrivacyWarning } from '@shared/editor/privacy'
import type { Project, Us } from '@shared/editor/project'
import { formatClock } from '@/lib/format'

export const EFFECT_LABEL = { blur: 'Blur', pixelate: 'Pixelizar', solid: 'Tarja' } as const

/** Aviso de privacidade como texto ("Blur em 00:03 — …"). */
export function privacyLine(p: Project, w: PrivacyWarning): string {
  const item = findItem(p, w.itemId)?.item
  const name = item?.type === 'effect' ? (item.name ?? EFFECT_LABEL[item.effect]) : 'Efeito'
  return `${name} em ${formatClock(w.tUs / 1000, false)} — ${w.message}`
}

/** Avisos de privacidade do quadro no instante `tUs` — o mesmo intervalo [t, t+1) que o diálogo usa no PNG. */
export const stillPrivacyWarnings = (p: Project, tUs: Us): PrivacyWarning[] => privacyWarnings(p, tUs, tUs + 1)

export interface StillNotice {
  kind: 'success' | 'warning'
  title: string
  description: string
  /** efeito que "Revisar" seleciona (o do primeiro aviso de privacidade) */
  reviewItemId: string | null
}

/** Aviso final do quadro exportado: com aviso de privacidade → `warning` com todos eles (nunca sucesso simples). */
export function stillNotice(p: Project, r: { path: string; width?: number; height?: number; warnings: string[] }, privacy: PrivacyWarning[]): StillNotice {
  const file = r.path.split(/[\\/]/).pop() ?? r.path
  if (privacy.length) {
    return {
      kind: 'warning',
      title: `Quadro exportado com aviso de privacidade: ${file}`,
      description: [...privacy.map((w) => privacyLine(p, w)), ...r.warnings].join(' · '),
      reviewItemId: privacy[0].itemId
    }
  }
  return { kind: 'success', title: `Quadro exportado: ${file}`, description: r.warnings.length ? r.warnings.join(' ') : r.width && r.height ? `PNG ${r.width}×${r.height}` : 'PNG', reviewItemId: null }
}
