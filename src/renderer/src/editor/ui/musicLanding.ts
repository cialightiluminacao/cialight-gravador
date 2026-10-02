import { findItem, moveItems, removeTrack, voiceTrackFor } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'

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

/**
 * "É narração? Mover para Voz": só aquele item vai para uma faixa de Voz desbloqueada e livre no trecho (ou uma nova
 * "Voz"), no mesmo tempo — a faixa de música e o que mais houver nela continuam música. `removeEmptyTrackId`: a faixa
 * de música criada só para o item sai se ficou vazia. Item que não existe mais: o mesmo projeto.
 */
export function moveToVoice(p: Project, itemId: string, opts?: { removeEmptyTrackId?: string }): Project {
  const f = findItem(p, itemId)
  if (!f) return p
  const r = voiceTrackFor(p, f.item.startUs, itemEndUs(f.item), { name: 'Voz' })
  let q = moveItems(r.project, [itemId], 0, { toTrackId: r.trackId, includeLinked: false })
  const empty = opts?.removeEmptyTrackId ? q.tracks.find((t) => t.id === opts.removeEmptyTrackId && t.items.length === 0 && !t.locked) : undefined
  if (empty) q = removeTrack(q, empty.id)
  return q
}
