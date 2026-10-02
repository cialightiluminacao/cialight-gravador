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
/** decodable: o WebCodecs desta máquina decodifica a faixa de áudio (ausente = sim; false → intermediário AAC). */
export interface AssetAudioInfo { channels: number; sampleRate: number; codec: string; decodable?: boolean }
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
  /** Intervalos de fala (cache/<id>.speech.json, ver speech.ts) e loudness da faixa de áudio analisada na ingestão. */
  speech?: string
  loudness?: { integrated: number; truePeak: number; lra: number }
  /**
   * Versões de áudio pré-processadas (ruído/normalização) prontas: chave (audioProcess.ts) → impressão digital da fonte,
   * em generated/<id>.audio-<chave>.<impressão>.m4a. Cache: arquivo ausente ao abrir (outro PC) ou fonte diferente da
   * impressão tira a chave e o editor reprocessa.
   */
  processedAudio?: Record<string, string>
  /**
   * Trilha do cursor (F6): nome do cursor.json DENTRO da pasta da gravação do asset (só assets de sessão da tela;
   * o arquivo fica na sessão, ao lado do rec.mp4). Presente só se o arquivo existe e é válido (preenchido na
   * ingestão e restaurado ao abrir o projeto). Lido por IPC (cursor.readTrack).
   */
  cursor?: string
  status: 'ready' | 'processing' | 'missing' | 'error'; error?: string
}
export const ANIM_PRESETS = ['fade', 'slideL', 'slideR', 'slideU', 'slideD', 'zoom', 'pop', 'rotate', 'bounce', 'blur'] as const
export type AnimPreset = (typeof ANIM_PRESETS)[number]
/** Curva do progresso de uma animação de entrada/saída: as do keyframe menos 'segurar' (sem sentido num preset). */
export type PresetEase = Exclude<Ease, 'hold'>
/**
 * Animação de entrada/saída: preset, duração e curva do progresso (ausente = a padrão do preset, PRESET_EASE em
 * resolve.ts: fade linear e deslizar suavizando a saída como até a v1.3; quicar linear; os outros suavizando a saída).
 */
export interface PresetAnim { preset: AnimPreset; durationUs: Us; ease?: PresetEase }
export interface Transform { x: Anim<number>; y: Anim<number>; scale: Anim<number>; rotation: Anim<number>; opacity: Anim<number> }
export interface VisualProps {
  transform: Transform
  /** Corte de cada lado (fração da fonte). Projetos até a v1.3 gravavam números: o schema converte para `{ value }`. */
  crop: { l: Anim<number>; t: Anim<number>; r: Anim<number>; b: Anim<number> }
  fit: 'contain' | 'cover' | 'fill'
  fadeInUs: Us; fadeOutUs: Us
  animIn?: PresetAnim; animOut?: PresetAnim
  adjust?: { brightness: Anim<number>; contrast: Anim<number>; saturation: Anim<number> }
  shape?: 'rect' | 'rounded' | 'circle'; radius?: Anim<number>
  border?: { width: number; color: string }
  mirror?: boolean
}
export interface AudioProps {
  enabled: boolean; volume: Anim<number>; fadeInUs: Us; fadeOutUs: Us; preservePitch: boolean; denoise: boolean; normalize: boolean
  /** "Manter áudio acelerado": com preservePitch acima de 4× o áudio continua (esticado) em vez de ficar mudo. */
  keepFastAudio?: boolean
}
export type TransitionKind = 'crossfade' | 'dipBlack' | 'dipWhite' | 'slideL' | 'slideR' | 'slideU' | 'slideD' | 'wipeL' | 'wipeR' | 'zoomIn' | 'blur'
export interface Transition { kind: TransitionKind; durationUs: Us }
/** enabled: ausente = ativo; false = item desativado (não gera camada nem áudio). Só é gravado quando false. */
export interface ItemBase { id: string; startUs: Us; durationUs: Us; name?: string; linkId?: string; enabled?: boolean }
/**
 * Efeitos de cursor do clipe da TELA de uma gravação com cursor.json (F6): destaque dos cliques (anel) e cursor
 * ampliado/suavizado, desenhados pelo compositor. Campo opcional da mídia (não um tipo de item novo: a v1.3 recusa
 * tipos desconhecidos e descarta campos desconhecidos — ruling R2). Tamanhos em px da FONTE gravada.
 */
export interface CursorFx {
  highlight: { enabled: boolean; color: string; sizePx: number; durationMs: number }
  cursor: { enabled: boolean; scale: number; smoothing: number }
}
/** Limites de CursorFx (schema e validateProject). */
export const CURSOR_FX_LIMITS = {
  sizePx: { min: 8, max: 120 },
  durationMs: { min: 150, max: 1500 },
  scale: { min: 1, max: 4 },
  smoothing: { min: 0, max: 1 }
} as const
/** Padrão: tudo desligado (opt-in; o vídeo sai como antes até o usuário ligar). */
export const DEFAULT_CURSOR_FX: CursorFx = {
  highlight: { enabled: false, color: '#ffd400', sizePx: 28, durationMs: 450 },
  cursor: { enabled: false, scale: 1.8, smoothing: 0.5 }
}
export interface MediaItem extends ItemBase {
  type: 'media'; assetId: string; inUs: Us; speed: number; reverse: boolean
  freeze?: { atUs: Us }
  audio: AudioProps; visual?: VisualProps; transitionIn?: Transition
  /** Só no clipe da tela de uma gravação com trilha do cursor (asset.cursor). */
  cursorFx?: CursorFx
}
export interface TextStyle { font: string; size: Anim<number>; weight: number; color: string; background?: string; stroke?: { width: number; color: string }; shadow?: boolean; align: 'left' | 'center' | 'right'; lineHeight: number }
export interface TextItem extends ItemBase { type: 'text'; text: string; style: TextStyle; visual: VisualProps; transitionIn?: Transition }
export interface ShapeItem extends ItemBase { type: 'shape'; shape: 'rect' | 'ellipse' | 'arrow'; fill: string; stroke: string; strokeWidth: number; visual: VisualProps }
export interface EffectRegion { shape: 'rect' | 'ellipse'; x: Anim<number>; y: Anim<number>; w: Anim<number>; h: Anim<number>; rotation: Anim<number> }
export interface EffectItem extends ItemBase {
  type: 'effect'; effect: 'blur' | 'pixelate' | 'solid'; region: EffectRegion
  strength: Anim<number>; feather: number; color: string; invert: boolean; scope: 'below' | 'track'
  /**
   * Faixa cuja camada o escopo `track` ("só a faixa abaixo") afeta — ligação explícita, nunca pela posição. Ausente
   * (projetos antigos) = faixa de vídeo visível logo abaixo do efeito; qualquer edição grava a faixa atual aqui.
   */
  targetTrackId?: string
  /**
   * Ancorado a um clipe de mídia: a região (anims de `region`) fica no ESPAÇO DO CONTEÚDO dele — centro e tamanho em
   * fração da fonte exibida, rotação relativa à do clipe — e o resolve a leva ao quadro em cada instante
   * (contentPose.contentToScreen), seguindo zoom/pan/corte/rotação/animação e edições futuras do clipe. `fallback`:
   * caixa do quadro (normalizada, sem rotação) que envolve a região ao longo do efeito, atualizada a cada edição
   * enquanto o clipe existe; usada se ele for apagado ou desativado (aviso attachLost).
   */
  attach?: EffectAttach
}
export interface EffectAttach { mediaItemId: string; fallback?: { x: number; y: number; w: number; h: number } }
/** autoFadeMs: sumiço automático dos traços (como settings.annotations.autoFadeSec da v1); null/ausente = ficam até apagar. */
export interface AnnotationsItem extends ItemBase { type: 'annotations'; sessionId: string; inUs: Us; autoFadeMs?: number | null }
export type Item = MediaItem | TextItem | ShapeItem | EffectItem | AnnotationsItem
export type TrackKind = 'video' | 'audio'
/** role 'effects': faixa de efeitos de privacidade (só recebe efeitos; identificada pelo papel, não pelo nome). */
export interface Track { id: string; kind: TrackKind; name: string; muted: boolean; hidden: boolean; locked: boolean; volume: number; role?: 'voice' | 'music' | 'sfx' | 'effects'; items: Item[] }
export interface Marker { id: string; tUs: Us; label: string; color: string }
export interface ProjectCanvas { width: number; height: number; fps: number; background: string }
/**
 * Mixagem do projeto. Ducking: as faixas `role: 'music'` abaixam `duckingDb` enquanto há fala nas faixas `role: 'voice'`
 * (rampa de `attackMs` terminando no início da fala, `holdMs` depois do fim, soltura em `releaseMs`). Ausente = padrões
 * (AUDIO_MIX_DEFAULTS em audioPlan.ts: ligado, −12 dB, 250/400/300 ms).
 */
export interface AudioMix { enabled: boolean; duckingDb: number; attackMs: number; releaseMs: number; holdMs: number }
export interface Project {
  version: 1; id: string; name: string; createdAt: string; updatedAt: string
  canvas: ProjectCanvas; assets: Asset[]; tracks: Track[]; markers: Marker[]
  originSessionId?: string
  audioMix?: AudioMix
}
export const MIN_ITEM_US = 33_334 // ~1 quadro a 30 fps; nenhuma operação cria item menor
export const MIN_SPEED = 0.1, MAX_SPEED = 16
