// Parte pura do relink automático (renderer): candidatos do main (project.findRelinks) → linhas do diálogo "Mídia
// encontrada em outro local" (todas marcadas) → lista a aplicar (só as marcadas, em ordem) → resumo dos toasts.
import type { Asset } from '@shared/editor/project'
import type { RelinkCandidate } from '@shared/ipc'

export interface RelinkRow {
  assetId: string
  name: string
  oldPath: string
  newPath: string
  checked: boolean
}

/** Linhas do diálogo: só mídias importadas ainda ausentes no projeto, um candidato por asset, caminho novo ≠ antigo. */
export function relinkRows(candidates: RelinkCandidate[], assets: Asset[]): RelinkRow[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const seen = new Set<string>()
  const rows: RelinkRow[] = []
  for (const c of candidates) {
    const a = byId.get(c.assetId)
    if (!a || a.source.type !== 'file' || a.status !== 'missing' || seen.has(a.id)) continue
    if (c.path.toLowerCase() === a.source.path.toLowerCase()) continue
    seen.add(a.id)
    rows.push({ assetId: a.id, name: a.name, oldPath: a.source.path, newPath: c.path, checked: true })
  }
  return rows
}

export function setRowChecked(rows: RelinkRow[], assetId: string, checked: boolean): RelinkRow[] {
  return rows.map((r) => (r.assetId === assetId ? { ...r, checked } : r))
}

/** O que "Reapontar selecionadas" aplica (pelo media.relink, uma por vez). */
export function relinkApplyList(rows: RelinkRow[]): { assetId: string; newPath: string }[] {
  return rows.filter((r) => r.checked).map((r) => ({ assetId: r.assetId, newPath: r.newPath }))
}

/**
 * Caminho para exibir em até `max` caracteres: o FIM (as pastas que mudaram e o nome do arquivo), cortado numa barra
 * quando possível — "…\aulas\originais\aula.mp4". O caminho inteiro fica no title.
 */
export function shortPath(path: string, max = 72): string {
  if (path.length <= max) return path
  const tail = path.slice(-(max - 1))
  const cut = tail.search(/[\\/]/)
  return '…' + (cut >= 0 ? tail.slice(cut) : tail)
}

/** Toasts do fim: "3 mídias reapontadas" e um erro por mídia que falhou. */
export function relinkSummary(outcomes: { name: string; error?: string }[]): { success: string | null; errors: string[] } {
  const ok = outcomes.filter((o) => o.error === undefined).length
  return {
    success: ok === 0 ? null : ok === 1 ? '1 mídia reapontada' : `${ok} mídias reapontadas`,
    errors: outcomes.filter((o) => o.error !== undefined).map((o) => `Não foi possível reapontar “${o.name}”: ${o.error}`)
  }
}
