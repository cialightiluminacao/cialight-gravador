import type { ApplyMode, BrandTemplate, BrandTemplateKind } from '@shared/editor/brand'
import type { Us } from '@shared/editor/project'

// Textos da aba Modelos (marca): nomes dos tipos, ações disponíveis por tipo e as mensagens de cada aplicação.

export const BRAND_KIND_LABEL: Record<BrandTemplateKind, string> = {
  overlay: 'Sobreposição',
  intro: 'Abertura',
  outro: 'Encerramento',
  watermark: "Marca d'água"
}

export const BRAND_MODE_LABEL: Record<ApplyMode, string> = {
  playhead: 'Aplicar no playhead',
  intro: 'Usar como abertura',
  outro: 'Usar como encerramento',
  watermark: "Aplicar como marca d'água"
}

/** Ações de aplicar de um modelo: marca d'água só para os tipos marca d'água e sobreposição. */
export function brandModes(kind: BrandTemplateKind): ApplyMode[] {
  return kind === 'watermark' || kind === 'overlay' ? ['playhead', 'intro', 'outro', 'watermark'] : ['playhead', 'intro', 'outro']
}

/** "3 s", "2,5 s", "1 min 05 s". */
export function formatBrandDuration(us: Us): string {
  const s = Math.round(us / 100_000) / 10
  if (s < 60) return `${String(s).replace('.', ',')} s`
  const m = Math.floor(s / 60)
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, '0')} s`
}

/** Toast de sucesso de cada modo. */
export function applyMessage(mode: ApplyMode, t: Pick<BrandTemplate, 'name' | 'durationUs'>): { title: string; description: string } {
  switch (mode) {
    case 'playhead':
      return { title: `Modelo “${t.name}” aplicado no playhead`, description: 'Ctrl+Z desfaz.' }
    case 'intro':
      return { title: `“${t.name}” virou a abertura`, description: `O projeto foi para a frente ${formatBrandDuration(t.durationUs)} (efeitos, legendas e marcadores juntos). Ctrl+Z desfaz.` }
    case 'outro':
      return { title: `“${t.name}” virou o encerramento`, description: 'Entrou depois do fim do conteúdo. Ctrl+Z desfaz.' }
    case 'watermark':
      return { title: `“${t.name}” aplicado como marca d'água`, description: 'Do início ao fim do conteúdo, numa faixa própria no topo. Ctrl+Z desfaz.' }
  }
}
