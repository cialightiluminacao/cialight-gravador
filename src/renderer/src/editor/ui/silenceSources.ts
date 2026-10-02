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

/**
 * Faixas de referência sugeridas: todas as de papel Voz (mais a preferida — a do item do menu — se tiver som); sem
 * nenhuma, a primeira de silenceSourceTracks.
 */
export function defaultSilenceSources(p: Project, preferred?: string | null): string[] {
  const all = silenceSourceTracks(p)
  const out = all.filter((t) => t.role === 'voice' || t.id === preferred).map((t) => t.id)
  return out.length ? out : all.slice(0, 1).map((t) => t.id)
}

/** Limiar em dB com o sinal de menos tipográfico ("−35 dB"). */
export function formatDb(db: number): string {
  return `${db < 0 ? '−' : ''}${Math.abs(db).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dB`
}

/** "12,3 s" / "1 min 05 s" (economia mostrada no diálogo). */
export function formatSaved(us: number): string {
  const s = Math.round(us / 100_000) / 10
  if (s < 60) return `${s.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  const m = Math.floor(s / 60)
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, '0')} s`
}
