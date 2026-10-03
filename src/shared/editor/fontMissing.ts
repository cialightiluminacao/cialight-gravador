// Fontes ausentes (G4): decisão pura "instalada?" e ops sobre as famílias dos textos (incl. legendas). Sem DOM.
import { patchTextStyle, DEFAULT_TEXT_FONT } from './factory'
import type { Project, TextItem } from './project'

/** Famílias genéricas do CSS: sempre existem. */
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'])

/** Família como o cssFont a usa (sem aspas, aparada). */
export const normalizeFamily = (f: string): string => f.replace(/["']/g, '').trim()

/** Genérica ou empacotada com o app: dispensa medição. */
export function isAlwaysInstalled(family: string): boolean {
  const f = normalizeFamily(family)
  return f === '' || GENERIC.has(f.toLowerCase()) || f === DEFAULT_TEXT_FONT
}

/**
 * Larguras medidas de uma sonda com a fonte candidata sobre cada reserva (`withFont[i]`) e a reserva sozinha
 * (`baseline[i]`). Instalada se em ALGUMA reserva a largura diferiu (fonte ausente = igual à reserva em todas).
 */
export function installedFromWidths(withFont: readonly number[], baseline: readonly number[]): boolean {
  return baseline.length > 0 && baseline.length === withFont.length && withFont.some((w, i) => Math.abs(w - baseline[i]) > 0.01)
}

/** Famílias (normalizadas, sem repetição, em ordem de aparição) dos textos ATIVOS que `isInstalled` recusa. */
export function missingFontFamilies(p: Project, isInstalled: (family: string) => boolean): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of p.tracks) {
    for (const it of t.items) {
      if (it.type !== 'text' || it.enabled === false) continue
      const f = normalizeFamily(it.style.font)
      if (seen.has(f)) continue
      seen.add(f)
      if (!isAlwaysInstalled(f) && !isInstalled(f)) out.push(f)
    }
  }
  return out
}

/**
 * Troca a família `from` por `to` em todos os textos (legendas incluídas) — um novo projeto (um passo de desfazer).
 * Faixas bloqueadas são puladas (`skippedLocked` = itens que ficaram). Outras fontes não mudam.
 */
export function replaceFontFamily(p: Project, from: string, to: string = DEFAULT_TEXT_FONT): { project: Project; changed: number; skippedLocked: number } {
  const f = normalizeFamily(from)
  let changed = 0
  let skippedLocked = 0
  const tracks = p.tracks.map((t) => {
    if (!t.items.some((i) => i.type === 'text' && normalizeFamily(i.style.font) === f)) return t
    if (t.locked) {
      skippedLocked += t.items.filter((i) => i.type === 'text' && normalizeFamily(i.style.font) === f).length
      return t
    }
    return {
      ...t,
      items: t.items.map((i) => {
        if (i.type !== 'text' || normalizeFamily(i.style.font) !== f) return i
        changed++
        return { ...i, style: patchTextStyle(i.style, { font: to }) } as TextItem
      })
    }
  })
  return { project: changed ? { ...p, tracks } : p, changed, skippedLocked }
}
