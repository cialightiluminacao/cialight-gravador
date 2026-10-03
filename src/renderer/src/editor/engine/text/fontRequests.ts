// Fontes usadas pelos textos de um projeto (puro; o worker as carrega em fonts.ts).
import type { Project } from '@shared/editor/project'
import { cssFont } from './textRaster'

export interface FontRequest { font: string; text: string }

/** Fontes (estilo/peso/família) usadas pelos textos do projeto, com os caracteres de cada uma (faixas Unicode). */
export function projectFontRequests(p: Project): FontRequest[] {
  const by = new Map<string, Set<string>>()
  for (const t of p.tracks) {
    for (const it of t.items) {
      if (it.type !== 'text') continue
      const font = cssFont(it.style, 16)
      const chars = by.get(font) ?? new Set<string>()
      for (const ch of it.counter ? '-0123456789' : it.text) if (chars.size < 512) chars.add(ch)
      by.set(font, chars)
    }
  }
  return [...by].map(([font, chars]) => ({ font, text: [...chars].join('') || ' ' }))
}
/** Família de uma fonte CSS de cssFont ('normal 800 16px "Manrope Variable", sans-serif' → 'Manrope Variable'). */
export const fontFamilyOf = (font: string): string => /"([^"]+)"/.exec(font)?.[1] ?? font
