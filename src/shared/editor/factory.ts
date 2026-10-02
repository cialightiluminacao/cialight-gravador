import { newId } from './ids'
import { secToUs } from './time'
import type { Asset, AudioProps, EffectItem, MediaItem, Project, ProjectCanvas, TrackKind, Transform, Us, VisualProps } from './project'

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

export type EffectPresetId = 'blur' | 'pixelate' | 'solid' | 'blurFace' | 'blurText' | 'blurAllExcept'
export type EffectRegionInit = Partial<{ x: number; y: number; w: number; h: number; rotation: number; shape: 'rect' | 'ellipse' }>

/** Item de efeito de privacidade a partir de um preset; `region` sobrescreve a região padrão do preset. */
export function createEffectItem(preset: EffectPresetId, startUs: Us, durationUs: Us, region?: EffectRegionInit): EffectItem {
  const cfg = {
    blur: { effect: 'blur', shape: 'rect', w: 0.4, h: 0.3, strength: 60, feather: 0.15, invert: false },
    pixelate: { effect: 'pixelate', shape: 'rect', w: 0.4, h: 0.3, strength: 50, feather: 0, invert: false },
    solid: { effect: 'solid', shape: 'rect', w: 0.4, h: 0.3, strength: 100, feather: 0, invert: false },
    blurFace: { effect: 'blur', shape: 'ellipse', w: 0.18, h: 0.32, strength: 70, feather: 0.3, invert: false },
    blurText: { effect: 'blur', shape: 'rect', w: 0.4, h: 0.08, strength: 60, feather: 0, invert: false },
    blurAllExcept: { effect: 'blur', shape: 'rect', w: 0.5, h: 0.5, strength: 60, feather: 0.2, invert: true }
  } as const
  const c = cfg[preset]
  const r = { x: 0.5, y: 0.5, w: c.w, h: c.h, rotation: 0, shape: c.shape as 'rect' | 'ellipse', ...region }
  return {
    id: newId('i_'),
    type: 'effect',
    effect: c.effect,
    startUs,
    durationUs,
    region: { shape: r.shape, x: { value: r.x }, y: { value: r.y }, w: { value: r.w }, h: { value: r.h }, rotation: { value: r.rotation } },
    strength: { value: c.strength },
    feather: c.feather,
    color: '#000000',
    invert: c.invert,
    scope: 'below'
  }
}
