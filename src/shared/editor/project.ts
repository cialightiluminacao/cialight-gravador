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
export interface MediaItem extends ItemBase {
  type: 'media'; assetId: string; inUs: Us; speed: number; reverse: boolean
  freeze?: { atUs: Us }
  audio: AudioProps; visual?: VisualProps; transitionIn?: Transition
}
/** Sombra do texto: cor `#rrggbb`/`#rrggbbaa`; desfoque e deslocamento em "em" (fração do tamanho da fonte). */
export interface TextShadow { color: string; blur: number; dx: number; dy: number }
/** Sombra de um projeto antigo que só tem `shadow: true` (e a de quem liga a sombra sem escolher). */
export const DEFAULT_TEXT_SHADOW: TextShadow = { color: '#000000b3', blur: 0.08, dx: 0.04, dy: 0.04 }
/**
 * Estilo do texto. Cores: `#rrggbb` ou `#rrggbbaa`.
 * - `size`: px num quadro cujo LADO MENOR mede 1080 (referência, como o desfoque das camadas): o compositor desenha
 *   `size × min(W, H) / 1080` px na saída W×H. Assim o texto mantém a proporção em qualquer canvas/resolução de
 *   exportação. (O reenquadrar mantém o lado menor do canvas, então a escala que ele aplica é 1.)
 * - `maxWidth`: largura máxima da linha, fração 0–1 da LARGURA do quadro; quebra automática por palavra. Ausente = sem
 *   quebra automática (só `\n`).
 * - `padding`: margem do fundo em "em" (fração de `size`); ausente com `background` = 0,3.
 * - `backgroundRadius`: raio dos cantos do fundo em "em".
 * - `shadow` (o que a v1.3 conhece) é SEMPRE `!!shadowStyle`; `shadowStyle` guarda os parâmetros (a v1.3 o descarta e
 *   o parse devolve DEFAULT_TEXT_SHADOW a quem só tem `shadow: true`).
 * Campos opcionais da v1.5: a v1.3 os descarta sem recusar o projeto.
 */
export interface TextStyle {
  font: string; size: Anim<number>; weight: number; color: string; background?: string; stroke?: { width: number; color: string }
  shadow?: boolean; align: 'left' | 'center' | 'right'; lineHeight: number
  italic?: boolean; maxWidth?: number; padding?: number; backgroundRadius?: number; shadowStyle?: TextShadow
}
/** Contagem (preset Contagem): o texto exibido é o inteiro que vai de `from` a `to` ao longo do item (textContentAt). */
export interface TextCounter { from: number; to: number }
export interface TextItem extends ItemBase { type: 'text'; text: string; style: TextStyle; visual: VisualProps; transitionIn?: Transition; counter?: TextCounter }
/**
 * Texto exibido no instante local: sem contagem, `text`; com contagem, v = from + (to − from)·local/dur (local limitado
 * a [0, dur]) arredondado para o lado de `from` (Math.ceil quando from > to, senão Math.floor).
 */
export function textContentAt(item: TextItem, localUs: Us): string {
  const c = item.counter
  if (!c) return item.text
  const dur = item.durationUs
  const local = Math.min(dur, Math.max(0, localUs))
  const raw = dur > 0 ? c.from + ((c.to - c.from) * local) / dur : c.from
  // contagem rebaseada num corte (from/to fracionários): resíduo de ponto flutuante num inteiro exato não vira ±1
  const v = Math.abs(raw - Math.round(raw)) < 1e-9 ? Math.round(raw) : raw
  const n = c.from > c.to ? Math.ceil(v) : Math.floor(v)
  return String(n === 0 ? 0 : n) // sem "-0"
}
/** Caixa padrão de uma forma sem `box` (frações da largura/altura do quadro). */
export const DEFAULT_SHAPE_BOX = { w: 0.3, h: 0.2 } as const
/**
 * Forma. `shape` fica em rect/elipse/seta (a v1.3 recusa valores novos); Destaque e Holofote são presets disso.
 * - `box`: tamanho em frações da largura/altura do quadro (centro = transform x/y); ausente = DEFAULT_SHAPE_BOX.
 * - `cornerRadius`: só rect; fração 0–0,5 do lado menor da caixa.
 * - `spotlight`: só rect/elipse; escurece com preto·dim (0–1) TUDO fora da forma; dentro fica intacto.
 * - Seta: da borda esquerda-centro à direita-centro da caixa, cabeça proporcional a `strokeWidth`.
 * - `fill`/`stroke`: `#rrggbb`, `#rrggbbaa` ou `'none'`. `strokeWidth`: px na mesma referência de `TextStyle.size`
 *   (lado menor do quadro = 1080).
 */
export interface ShapeItem extends ItemBase {
  type: 'shape'; shape: 'rect' | 'ellipse' | 'arrow'; fill: string; stroke: string; strokeWidth: number; visual: VisualProps
  box?: { w: number; h: number }; cornerRadius?: number; spotlight?: { dim: number }
}
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
   * Alvo gravado de um efeito ANTIGO (sem targetTrackId) cuja faixa-alvo tinha texto/forma: vale a regra do alvo antigo
   * — só mídia, anotações e transição da faixa contam (o texto dela não é afetado). Congela a ligação de hoje para que
   * uma faixa nova entre o efeito e a faixa dele não roube o alvo. A v1.3 descarta o campo e o resultado é o
   * mesmo: ela desenha texto, mas o efeito de escopo track dela nunca se liga a uma camada de texto.
   */
  targetMediaOnly?: true
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
/**
 * role 'effects': faixa de efeitos de privacidade (só recebe efeitos; identificada pelo papel, não pelo nome).
 * role 'captions': faixa de legendas (de vídeo, só itens de texto; no máximo uma, sempre a faixa de vídeo do topo). A
 * v1.3 recusa o papel: no disco vai sem `role` e com `captionsV15: true` (schema.ts).
 */
export interface Track { id: string; kind: TrackKind; name: string; muted: boolean; hidden: boolean; locked: boolean; volume: number; role?: 'voice' | 'music' | 'sfx' | 'effects' | 'captions'; items: Item[] }
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
