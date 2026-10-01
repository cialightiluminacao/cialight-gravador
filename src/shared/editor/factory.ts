import { newId } from './ids'
import { secToUs } from './time'
import type { Asset, AudioProps, MediaItem, Project, ProjectCanvas, TrackKind, Transform, Us, VisualProps } from './project'

export function defaultTransform(): Transform {
  return { x: { value: 0.5 }, y: { value: 0.5 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }
}

export function defaultVisual(): VisualProps {
  return { transform: defaultTransform(), crop: { l: 0, t: 0, r: 0, b: 0 }, fit: 'contain', fadeInUs: 0, fadeOutUs: 0 }
}

export function defaultAudio(): AudioProps {
  return { enabled: true, volume: { value: 1 }, fadeInUs: 0, fadeOutUs: 0, preservePitch: true, denoise: false, normalize: false }
}

export function createEmptyProject(name: string, canvas?: Partial<ProjectCanvas>): Project {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { width: 1920, height: 1080, fps: 30, background: '#000000', ...canvas },
    assets: [],
    tracks: [
      { id: newId('t_'), kind: 'video', name: 'Vídeo 1', muted: false, hidden: false, locked: false, volume: 1, items: [] },
      { id: newId('t_'), kind: 'audio', name: 'Áudio 1', muted: false, hidden: false, locked: false, volume: 1, items: [] }
    ],
    markers: []
  }
}

/** Item de mídia cobrindo o asset inteiro (imagem → 5 s). `visual` só em faixa de vídeo. */
export function createMediaItem(asset: Asset, startUs: Us, trackKind: TrackKind): MediaItem {
  const durationUs = asset.kind === 'image' || asset.durationUs == null ? secToUs(5) : asset.durationUs
  return {
    id: newId('i_'),
    type: 'media',
    assetId: asset.id,
    startUs,
    durationUs,
    inUs: 0,
    speed: 1,
    reverse: false,
    audio: defaultAudio(),
    ...(trackKind === 'video' ? { visual: defaultVisual() } : {})
  }
}
