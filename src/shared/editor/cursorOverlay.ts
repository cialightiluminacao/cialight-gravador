// Sobreposição do cursor (F6) de um clipe de mídia num instante: anéis de realce dos cliques e a seta do cursor
// ampliado. Calculada no resolveFrame (puro: o mesmo caminho do preview e da exportação) e desenhada pelo compositor
// no espaço do conteúdo da camada — acompanha transform, corte, fit, rotação, espelho, zoom e reenquadrar, e fica
// abaixo dos efeitos que agem na camada (privacidade cobre o anel e a seta). Pura, sem DOM/Electron.
import { clicksBetween, cursorAt, type CursorTrackV1 } from '../cursor'
import { cursorTimeMs, timelineUsAtCursorMs } from './cursorTime'
import type { Asset, MediaItem, Project, Us } from './project'

/**
 * Trilhas do cursor por id do asset (entrada lateral do resolveFrame/render worker; nunca vai para o project.json).
 * Só a tela de uma gravação com cursor.json tem trilha (renderer: cursorSessionOf).
 */
export type CursorTracks = ReadonlyMap<string, CursorTrackV1>

/** Raio do anel no instante do clique, em fração de sizePx (cresce até 1 em durationMs). */
export const CLICK_RING_FROM = 0.6
/** Espessura do traço do anel, px da fonte gravada (escala com a camada). */
export const CLICK_RING_STROKE_PX = 3
/**
 * Altura gravada (px) em que 1 unidade do desenho da seta (CURSOR_ARROW, ~ o cursor do Windows a 100 %) = 1 px da
 * fonte com escala 1. A seta acompanha a resolução da gravação (telas maiores costumam ter DPI maior): em 2160 linhas,
 * 2 px por unidade.
 */
export const CURSOR_REFERENCE_HEIGHT = 1080

/** Anel de um clique: centro em fração da fonte exibida (0–1, sem corte), raio em px da fonte, alfa e progresso 0–1. */
export interface ClickRing { x: number; y: number; radiusPx: number; alpha: number; progress: number }
/** Seta: ponta (hotspot) em fração da fonte exibida; `scale` = px da fonte por unidade do desenho da seta. */
export interface CursorSprite { x: number; y: number; scale: number }
/**
 * O que o compositor desenha por cima da camada de mídia. refW/refH: tamanho (px) do vídeo gravado (os px da fonte
 * dos tamanhos — o proxy do preview tem outro tamanho, a conta não muda).
 */
export interface CursorOverlay {
  refW: number; refH: number
  color: string; strokePx: number
  rings: ClickRing[]
  sprite: CursorSprite | null
}

// folga (ms da trilha) da busca dos cliques além da janela exata (arredondamentos e o quadro do reverso); o filtro
// pela idade na timeline é o exato
const CLICK_SEARCH_PAD_MS = 100

/**
 * Sobreposição do clipe `item` (de vídeo, com a trilha `track`) no instante tUs da timeline; null = nada a desenhar
 * (sem cursorFx, tudo desligado, fora do clipe, nenhum anel nem seta no instante).
 * - Anel (ruling R15): a idade é o tempo da TIMELINE desde o instante em que o clique aparece (timelineUsAtCursorMs,
 *   com o atraso R11): durationMs constante na tela com qualquer velocidade; no reverso o anel anda para a frente a
 *   partir do instante em que o clique aparece; congelado → sem anéis. Botões direito e do meio: o mesmo anel.
 *   Busca: clicksBetween numa janela de ±durationMs × velocidade (O(log n + cliques na janela)).
 * - Seta: cursorAt(track, cursorTimeMs, suavização); nenhuma fora do quadro gravado ou antes da 1ª amostra.
 */
export function cursorOverlayAt(p: Project, item: MediaItem, asset: Asset, track: CursorTrackV1, tUs: Us): CursorOverlay | null {
  const fx = item.cursorFx
  if (!fx || (!fx.highlight.enabled && !fx.cursor.enabled) || asset.kind !== 'video') return null
  const tMs = cursorTimeMs(p, item, tUs)
  if (tMs === null) return null
  const rings: ClickRing[] = []
  const h = fx.highlight
  if (h.enabled && !item.freeze && h.durationMs > 0) {
    const durUs = Math.round(h.durationMs * 1000)
    const span = h.durationMs * item.speed + CLICK_SEARCH_PAD_MS
    for (const c of clicksBetween(track, tMs - span, tMs + span)) {
      const at = timelineUsAtCursorMs(p, item, c.tMs)
      if (at === null) continue
      const age = tUs - at
      if (age < 0 || age >= durUs) continue
      const q = age / durUs
      rings.push({ x: c.x, y: c.y, radiusPx: h.sizePx * (CLICK_RING_FROM + (1 - CLICK_RING_FROM) * q), alpha: 1 - q, progress: q })
    }
  }
  let sprite: CursorSprite | null = null
  if (fx.cursor.enabled) {
    const pos = cursorAt(track, tMs, fx.cursor.smoothing)
    if (pos && pos.x >= 0 && pos.x <= 1 && pos.y >= 0 && pos.y <= 1) sprite = { x: pos.x, y: pos.y, scale: (fx.cursor.scale * track.height) / CURSOR_REFERENCE_HEIGHT }
  }
  if (rings.length === 0 && !sprite) return null
  return { refW: track.width, refH: track.height, color: h.color, strokePx: CLICK_RING_STROKE_PX, rings, sprite }
}
