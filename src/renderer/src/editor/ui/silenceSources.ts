import type { MediaItem, Project, Track } from '@shared/editor/project'

// Faixas que podem servir de voz de referência no "Remover silêncios" (puro).

/** Itens de mídia da faixa com áudio (asset com áudio, item não congelado). */
export function audioItems(p: Project, t: Track): MediaItem[] {
  return t.items.filter((i): i is MediaItem => i.type === 'media' && !i.freeze && !!p.assets.find((a) => a.id === i.assetId && a.kind !== 'image' && a.audio))
}

/** Faixas com som (as de papel Voz primeiro, depois as de áudio, depois as de vídeo com som próprio). */
export function silenceSourceTracks(p: Project): Track[] {
  const rank = (t: Track): number => (t.role === 'voice' ? 0 : t.kind === 'audio' && t.role !== 'music' ? 1 : t.kind === 'audio' ? 3 : 2)
  return p.tracks.filter((t) => audioItems(p, t).length > 0).map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t)
}

/** Faixa sugerida: a preferida (ex.: a do item do menu), se tiver som; senão a primeira de silenceSourceTracks. */
export function defaultSilenceSource(p: Project, preferred?: string | null): string | null {
  const all = silenceSourceTracks(p)
  return all.find((t) => t.id === preferred)?.id ?? all[0]?.id ?? null
}

/** "12,3 s" / "1 min 05 s" (economia mostrada no diálogo). */
export function formatSaved(us: number): string {
  const s = Math.round(us / 100_000) / 10
  if (s < 60) return `${s.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  const m = Math.floor(s / 60)
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, '0')} s`
}
