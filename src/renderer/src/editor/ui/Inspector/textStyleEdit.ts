import { DEFAULT_TEXT_FONT } from '@shared/editor/factory'

// Peças puras do inspetor de texto/forma: cores com opacidade (#rrggbbaa), lista de fontes e pesos.

/** Separa uma cor `#rgb`, `#rrggbb` ou `#rrggbbaa` em cor (`#rrggbb`) e opacidade 0–1; 'none'/inválida = preto opaco. */
export function splitColor(c: string | undefined): { hex: string; alpha: number } {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec((c ?? '').trim())
  if (!m) return { hex: '#000000', alpha: 1 }
  let h = m[1].toLowerCase()
  if (h.length === 3) h = [...h].map((x) => x + x).join('')
  const alpha = h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) / 100 : 1
  return { hex: `#${h.slice(0, 6)}`, alpha }
}

/** Junta cor e opacidade: opacidade 1 = `#rrggbb`; senão `#rrggbbaa`. */
export function joinColor(hex: string, alpha: number): string {
  const { hex: base } = splitColor(hex)
  const a = Math.min(1, Math.max(0, alpha))
  if (a >= 1) return base
  return `${base}${Math.round(a * 255).toString(16).padStart(2, '0')}`
}

/** Pesos oferecidos (CSS font-weight). */
export const WEIGHT_OPTIONS: { value: string; label: string }[] = [
  { value: '300', label: 'Leve (300)' },
  { value: '400', label: 'Normal (400)' },
  { value: '500', label: 'Médio (500)' },
  { value: '600', label: 'Seminegrito (600)' },
  { value: '700', label: 'Negrito (700)' },
  { value: '800', label: 'Extranegrito (800)' },
  { value: '900', label: 'Preto (900)' }
]

/** Opções do seletor de peso: as da lista e, se o item tem outro valor (ex.: 350), ele também. */
export function weightOptions(current: number): { value: string; label: string }[] {
  return WEIGHT_OPTIONS.some((o) => Number(o.value) === current) ? WEIGHT_OPTIONS : [{ value: String(current), label: `Personalizado (${current})` }, ...WEIGHT_OPTIONS]
}

/** Fontes do app (carregadas pelo editor) e a lista curada do Windows. */
export const APP_FONTS: string[] = [DEFAULT_TEXT_FONT]
export const CURATED_FONTS: string[] = ['Arial', 'Segoe UI', 'Calibri', 'Cambria', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Consolas', 'Courier New', 'Comic Sans MS']

export interface FontOption { value: string; label: string; hint?: string }

/**
 * Opções do seletor de fonte: app, lista curada, fontes do sistema (sem repetir as anteriores, em ordem alfabética) e,
 * se a fonte atual não está em nenhuma (projeto aberto em outro PC), ela no topo.
 */
export function buildFontOptions(current: string, system: readonly string[]): FontOption[] {
  const seen = new Set<string>()
  const out: FontOption[] = []
  const add = (value: string, hint?: string): void => {
    const key = value.toLowerCase()
    if (!value || seen.has(key)) return
    seen.add(key)
    out.push({ value, label: value, ...(hint ? { hint } : {}) })
  }
  for (const f of APP_FONTS) add(f, 'do app')
  for (const f of CURATED_FONTS) add(f)
  for (const f of [...system].sort((a, b) => a.localeCompare(b, 'pt-BR'))) add(f, 'sistema')
  if (!seen.has(current.toLowerCase())) out.unshift({ value: current, label: current, hint: 'do projeto' })
  return out
}

let systemFonts: Promise<string[]> | null = null

/**
 * Famílias das fontes instaladas (queryLocalFonts, só na thread principal). Sem a API, sem permissão ou com erro,
 * devolve [] — o seletor fica só com a lista curada, sem aviso nem exceção. O resultado vazio por recusa não fica em
 * cache (um novo clique do usuário pode ter a permissão); o de sucesso, sim.
 */
export function loadSystemFonts(): Promise<string[]> {
  const q = (globalThis as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
  if (typeof q !== 'function') return Promise.resolve([])
  if (systemFonts) return systemFonts
  const p = (async (): Promise<string[]> => {
    try {
      const all = await q.call(globalThis)
      return [...new Set(all.map((f) => f.family))]
    } catch {
      return []
    }
  })()
  systemFonts = p
  void p.then((r) => {
    if (r.length === 0 && systemFonts === p) systemFonts = null
  })
  return p
}

/** Só para testes. */
export function resetSystemFontsCache(): void {
  systemFonts = null
}
