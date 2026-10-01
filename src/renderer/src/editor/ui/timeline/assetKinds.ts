import type { Asset, TrackKind } from '@shared/editor/project'

/** Tipos de faixa que a mídia gera ao entrar na linha do tempo (mesma regra de addMediaFromAsset). */
export function assetProduces(a: Asset): TrackKind[] {
  const out: TrackKind[] = []
  if (a.kind !== 'audio') out.push('video')
  if (a.kind === 'audio' || (a.kind === 'video' && !!a.audio)) out.push('audio')
  return out
}
