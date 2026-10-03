import { newId } from './ids'
import { secToUs } from './time'
import { DEFAULT_TEXT_SHADOW } from './project'
import type { Asset, AudioProps, EffectItem, MediaItem, PresetAnim, Project, ProjectCanvas, ShapeItem, TextCounter, TextItem, TextStyle, TrackKind, Transform, Us, VisualProps } from './project'

export function defaultTransform(): Transform {
  return { x: { value: 0.5 }, y: { value: 0.5 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }
}

export function defaultVisual(): VisualProps {
  return { transform: defaultTransform(), crop: { l: { value: 0 }, t: { value: 0 }, r: { value: 0 }, b: { value: 0 } }, fit: 'contain', fadeInUs: 0, fadeOutUs: 0 }
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
    blurFace: { effect: 'blur', shape: 'ellipse', w: 0.18, h: 0.32, strength: 80, feather: 0.3, invert: false },
    blurText: { effect: 'blur', shape: 'rect', w: 0.4, h: 0.08, strength: 80, feather: 0, invert: false },
    blurAllExcept: { effect: 'blur', shape: 'rect', w: 0.5, h: 0.5, strength: 80, feather: 0.2, invert: true }
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

// ---------------------------------------------------------------- texto e formas

/** Fonte padrão dos textos: a da interface do app (empacotada; disponível no preview e na exportação). */
export const DEFAULT_TEXT_FONT = 'Manrope Variable'
/** Duração padrão de um texto/forma novo. */
export const TEXT_DEFAULT_US = 3_000_000

export type TextPresetId = 'title' | 'subtitle' | 'lowerThird' | 'caption' | 'quote' | 'countdown'
export interface TextPreset {
  label: string; text: string; style: TextStyle
  /** Centro do texto (transform x/y), normalizado ao quadro. */
  x: number; y: number
  durationUs: Us; counter?: TextCounter; animIn?: PresetAnim; animOut?: PresetAnim
}

const baseStyle = (s: Partial<Omit<TextStyle, 'size'>> & { size: number }): TextStyle => {
  const { size, ...rest } = s
  return { font: DEFAULT_TEXT_FONT, size: { value: size }, weight: 600, color: '#ffffff', align: 'center', lineHeight: 1.2, ...rest }
}
const shadowed = { shadow: true, shadowStyle: { ...DEFAULT_TEXT_SHADOW } } as const

/** Modelos de texto (rótulos da biblioteca). Tamanhos em px com o lado menor do quadro = 1080 (TextStyle.size). */
export const TEXT_PRESETS: Record<TextPresetId, TextPreset> = {
  title: {
    label: 'Título', text: 'Título', x: 0.5, y: 0.5, durationUs: TEXT_DEFAULT_US,
    style: baseStyle({ size: 110, weight: 800, lineHeight: 1.1, maxWidth: 0.9, ...shadowed }),
    animIn: { preset: 'fade', durationUs: 500_000 }, animOut: { preset: 'fade', durationUs: 400_000 }
  },
  subtitle: {
    label: 'Subtítulo', text: 'Subtítulo', x: 0.5, y: 0.62, durationUs: TEXT_DEFAULT_US,
    style: baseStyle({ size: 56, weight: 500, maxWidth: 0.85, ...shadowed }),
    animIn: { preset: 'fade', durationUs: 400_000 }, animOut: { preset: 'fade', durationUs: 300_000 }
  },
  lowerThird: {
    label: 'Terço inferior', text: 'Nome Sobrenome\nCargo',x: 0.24, y: 0.82, durationUs: TEXT_DEFAULT_US,
    style: baseStyle({ size: 44, weight: 600, align: 'left', lineHeight: 1.25, background: '#000000a6', padding: 0.5, backgroundRadius: 0.2 }),
    animIn: { preset: 'slideL', durationUs: 400_000 }, animOut: { preset: 'fade', durationUs: 300_000 }
  },
  caption: {
    label: 'Legenda', text: 'Legenda', x: 0.5, y: 0.88, durationUs: TEXT_DEFAULT_US,
    style: baseStyle({ size: 44, weight: 500, lineHeight: 1.25, background: '#000000b3', padding: 0.3, backgroundRadius: 0.15, maxWidth: 0.8 })
  },
  quote: {
    label: 'Citação', text: '“Uma frase marcante.”', x: 0.5, y: 0.5, durationUs: TEXT_DEFAULT_US,
    style: baseStyle({ size: 64, weight: 400, italic: true, lineHeight: 1.3, maxWidth: 0.7, ...shadowed }),
    animIn: { preset: 'fade', durationUs: 600_000 }, animOut: { preset: 'fade', durationUs: 400_000 }
  },
  countdown: {
    label: 'Contagem', text: '3', x: 0.5, y: 0.5, durationUs: 3_000_000, counter: { from: 3, to: 0 },
    style: baseStyle({ size: 240, weight: 800, lineHeight: 1, ...shadowed })
  }
}

/** Cópia profunda de dados simples (JSON): o item novo nunca compartilha objetos com os presets. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * Aplica `patch` ao estilo (chave com `undefined` = remover o campo) e mantém `shadow === !!shadowStyle`: `shadow: true`
 * sem parâmetros liga DEFAULT_TEXT_SHADOW; `shadow: false` tira os parâmetros.
 */
export function patchTextStyle(style: TextStyle, patch: Partial<TextStyle>): TextStyle {
  const out: TextStyle = { ...style }
  for (const [k, v] of Object.entries(patch) as [keyof TextStyle, unknown][]) {
    if (v === undefined) delete out[k]
    else (out as unknown as Record<string, unknown>)[k] = v
  }
  if ('shadowStyle' in patch) {
    if (out.shadowStyle) out.shadow = true
    else delete out.shadow
  } else if ('shadow' in patch) {
    if (out.shadow && !out.shadowStyle) out.shadowStyle = { ...DEFAULT_TEXT_SHADOW }
    if (!out.shadow) { delete out.shadow; delete out.shadowStyle }
  }
  return out
}

/** Item de texto a partir de um modelo; `text`/`durationUs` sobrescrevem os do modelo. */
export function createTextItem(preset: TextPresetId, startUs: Us, opts?: { text?: string; durationUs?: Us }): TextItem {
  const c = TEXT_PRESETS[preset]
  const v = defaultVisual()
  return {
    id: newId('i_'),
    type: 'text',
    startUs,
    durationUs: opts?.durationUs ?? c.durationUs,
    text: opts?.text ?? c.text,
    style: clone(c.style),
    visual: {
      ...v,
      transform: { ...v.transform, x: { value: c.x }, y: { value: c.y } },
      ...(c.animIn ? { animIn: { ...c.animIn } } : {}),
      ...(c.animOut ? { animOut: { ...c.animOut } } : {})
    },
    ...(c.counter ? { counter: { ...c.counter } } : {})
  }
}

export type ShapePresetId = 'rect' | 'ellipse' | 'arrow' | 'highlight' | 'spotlight'
export interface ShapePreset {
  label: string; shape: ShapeItem['shape']; fill: string; stroke: string; strokeWidth: number
  box: { w: number; h: number }; cornerRadius?: number; spotlight?: { dim: number }
  /** Centro (transform x/y), normalizado ao quadro. */
  x: number; y: number
}

/** Modelos de forma (rótulos da biblioteca). strokeWidth em px com o lado menor do quadro = 1080. */
export const SHAPE_PRESETS: Record<ShapePresetId, ShapePreset> = {
  rect: { label: 'Retângulo', shape: 'rect', fill: '#ffffff', stroke: 'none', strokeWidth: 0, box: { w: 0.3, h: 0.2 }, x: 0.5, y: 0.5 },
  ellipse: { label: 'Elipse', shape: 'ellipse', fill: 'none', stroke: '#ff3b30', strokeWidth: 8, box: { w: 0.2, h: 0.3 }, x: 0.5, y: 0.5 },
  arrow: { label: 'Seta', shape: 'arrow', fill: '#ff3b30', stroke: '#ff3b30', strokeWidth: 12, box: { w: 0.25, h: 0.1 }, x: 0.5, y: 0.5 },
  highlight: { label: 'Destaque', shape: 'rect', fill: 'none', stroke: '#ffd400', strokeWidth: 10, box: { w: 0.3, h: 0.15 }, cornerRadius: 0.15, x: 0.5, y: 0.5 },
  spotlight: { label: 'Holofote', shape: 'ellipse', fill: 'none', stroke: 'none', strokeWidth: 0, box: { w: 0.3, h: 0.45 }, spotlight: { dim: 0.6 }, x: 0.5, y: 0.5 }
}

/** Item de forma a partir de um modelo (duração padrão 3 s). */
export function createShapeItem(preset: ShapePresetId, startUs: Us, opts?: { durationUs?: Us }): ShapeItem {
  const c = SHAPE_PRESETS[preset]
  const v = defaultVisual()
  return {
    id: newId('i_'),
    type: 'shape',
    name: c.label, // a linha do tempo e o inspetor mostram o nome do modelo (Holofote, Destaque…)
    startUs,
    durationUs: opts?.durationUs ?? TEXT_DEFAULT_US,
    shape: c.shape,
    fill: c.fill,
    stroke: c.stroke,
    strokeWidth: c.strokeWidth,
    visual: { ...v, transform: { ...v.transform, x: { value: c.x }, y: { value: c.y } } },
    box: { ...c.box },
    ...(c.cornerRadius !== undefined ? { cornerRadius: c.cornerRadius } : {}),
    ...(c.spotlight ? { spotlight: { ...c.spotlight } } : {})
  }
}
