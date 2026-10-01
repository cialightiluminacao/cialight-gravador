// Modelo do projeto do editor. Tempos em microssegundos inteiros (Us); coordenadas normalizadas 0–1.
export type Us = number
export type Ease = 'linear' | 'hold' | 'in' | 'out' | 'inOut' | { bezier: [number, number, number, number] }
export interface Keyframe<T> { tUs: Us; value: T; ease: Ease }
export interface Anim<T> { value: T; keys?: Keyframe<T>[] }
export type AssetKind = 'video' | 'audio' | 'image'
export type SessionStream = 'screen' | 'webcam' | 'mic' | 'system'
export type AssetSource =
  | { type: 'session'; sessionId: string; stream: SessionStream }
  | { type: 'file'; path: string; size: number; mtimeMs: number }
  | { type: 'generated'; file: string }
export interface AssetVideoInfo { width: number; height: number; fps: number; codec: string; rotation: 0 | 90 | 180 | 270; decodable: boolean; gopUs: number }
export interface FilmstripInfo { frames: number; everyUs: Us; tileW: number; tileH: number }
export interface AssetAudioInfo { channels: number; sampleRate: number; codec: string }
export interface Asset {
  id: string; name: string; kind: AssetKind; source: AssetSource
  durationUs: Us | null
  video?: AssetVideoInfo; audio?: AssetAudioInfo
  /** Índice da faixa de áudio (a:N) no arquivo original multi-faixa (rec.mp4 da sessão: mic/sistema); ausente = faixa principal. */
  audioTrackIndex?: number
  /** Índice da faixa de vídeo (v:N) no arquivo original multi-faixa (rec.mp4 da sessão: tela 0, webcam 1); ausente = faixa principal. */
  videoTrackIndex?: number
  /** Caminhos relativos à pasta do projeto (proxies/…, cache/…). */
  proxy?: string; intermediate?: string; filmstrip?: string; peaks?: string
  /** Geometria do sprite do filmstrip: `frames` quadros de tileW×tileH, um a cada `everyUs`. */
  filmstripInfo?: FilmstripInfo
  status: 'ready' | 'processing' | 'missing' | 'error'; error?: string
}
export type AnimPreset = 'fade' | 'slideL' | 'slideR' | 'slideU' | 'slideD' | 'zoom' | 'pop'
export interface Transform { x: Anim<number>; y: Anim<number>; scale: Anim<number>; rotation: Anim<number>; opacity: Anim<number> }
export interface VisualProps {
  transform: Transform
  crop: { l: number; t: number; r: number; b: number }
  fit: 'contain' | 'cover' | 'fill'
  fadeInUs: Us; fadeOutUs: Us
  animIn?: { preset: AnimPreset; durationUs: Us }; animOut?: { preset: AnimPreset; durationUs: Us }
  adjust?: { brightness: number; contrast: number; saturation: number }
  shape?: 'rect' | 'rounded' | 'circle'; radius?: number
  border?: { width: number; color: string }
  mirror?: boolean
}
export interface AudioProps { enabled: boolean; volume: Anim<number>; fadeInUs: Us; fadeOutUs: Us; preservePitch: boolean; denoise: boolean; normalize: boolean }
export type TransitionKind = 'crossfade' | 'dipBlack' | 'dipWhite' | 'slideL' | 'slideR' | 'slideU' | 'slideD' | 'wipeL' | 'wipeR' | 'zoomIn' | 'blur'
export interface Transition { kind: TransitionKind; durationUs: Us }
export interface ItemBase { id: string; startUs: Us; durationUs: Us; name?: string; linkId?: string }
export interface MediaItem extends ItemBase {
  type: 'media'; assetId: string; inUs: Us; speed: number; reverse: boolean
  freeze?: { atUs: Us }
  audio: AudioProps; visual?: VisualProps; transitionIn?: Transition
}
export interface TextStyle { font: string; size: number; weight: number; color: string; background?: string; stroke?: { width: number; color: string }; shadow?: boolean; align: 'left' | 'center' | 'right'; lineHeight: number }
export interface TextItem extends ItemBase { type: 'text'; text: string; style: TextStyle; visual: VisualProps; transitionIn?: Transition }
export interface ShapeItem extends ItemBase { type: 'shape'; shape: 'rect' | 'ellipse' | 'arrow'; fill: string; stroke: string; strokeWidth: number; visual: VisualProps }
export interface EffectRegion { shape: 'rect' | 'ellipse'; x: Anim<number>; y: Anim<number>; w: Anim<number>; h: Anim<number>; rotation: Anim<number> }
export interface EffectItem extends ItemBase {
  type: 'effect'; effect: 'blur' | 'pixelate' | 'solid'; region: EffectRegion
  strength: Anim<number>; feather: number; color: string; invert: boolean; scope: 'below' | 'track'
}
/** autoFadeMs: sumiço automático dos traços (como settings.annotations.autoFadeSec da v1); null/ausente = ficam até apagar. */
export interface AnnotationsItem extends ItemBase { type: 'annotations'; sessionId: string; inUs: Us; autoFadeMs?: number | null }
export type Item = MediaItem | TextItem | ShapeItem | EffectItem | AnnotationsItem
export type TrackKind = 'video' | 'audio'
export interface Track { id: string; kind: TrackKind; name: string; muted: boolean; hidden: boolean; locked: boolean; volume: number; role?: 'voice' | 'music' | 'sfx'; items: Item[] }
export interface Marker { id: string; tUs: Us; label: string; color: string }
export interface ProjectCanvas { width: number; height: number; fps: number; background: string }
export interface Project {
  version: 1; id: string; name: string; createdAt: string; updatedAt: string
  canvas: ProjectCanvas; assets: Asset[]; tracks: Track[]; markers: Marker[]
  originSessionId?: string
}
export const MIN_ITEM_US = 33_334 // ~1 quadro a 30 fps; nenhuma operação cria item menor
export const MIN_SPEED = 0.1, MAX_SPEED = 16
