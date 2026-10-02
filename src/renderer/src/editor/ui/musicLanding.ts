import { findItem } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'

// Áudio importado que caiu sozinho na faixa de música (addMediaFromAsset): o editor oferece "É narração? Mover para
// Voz" num aviso. Puro.

/**
 * Faixa de música em que o asset só de áudio caiu automaticamente (sem faixa escolhida, ou numa faixa nova), ou null.
 * `auto`: o usuário não escolheu uma faixa existente.
 */
export function autoMusicLanding(p: Project, assetId: string, itemIds: string[], auto: boolean): { trackId: string; trackName: string } | null {
  if (!auto || p.assets.find((a) => a.id === assetId)?.kind !== 'audio') return null
  for (const id of itemIds) {
    const t = findItem(p, id)?.track
    if (t?.role === 'music') return { trackId: t.id, trackName: t.name }
  }
  return null
}
