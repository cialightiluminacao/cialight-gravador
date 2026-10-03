import { z } from 'zod'

// Trilha do cursor gravada ao lado da sessão (<sessionDir>/cursor.json, F6). Arquivo próprio e versionado: o
// session.json NÃO ganha campo novo (a v1.3 instalada rejeita campos desconhecidos na sessão).
// Coordenadas normalizadas 0–1 ao quadro GRAVADO (modo tela: o monitor capturado; modo janela: a janela, com os
// limites amostrados ao longo do tempo). Amostras fora do quadro ficam sem prender (quem consome prende); cliques
// fora do quadro são descartados na gravação. Tempos em ms de MÍDIA (pausas removidas), inteiros.
// Puro: sem DOM/Electron/Node.

export type CursorButton = 'left' | 'right' | 'middle'
/** tMs = tempo de mídia em ms (pausas removidas), inteiro. */
export interface CursorSample { tMs: number; x: number; y: number }
export interface CursorClick { tMs: number; x: number; y: number; button: CursorButton }
export interface CursorTrackV1 { version: 1; width: number; height: number; samples: CursorSample[]; clicks: CursorClick[] }

export const CURSOR_FILE = 'cursor.json'

const tMs = z.number().int().nonnegative()
const coord = z.number().finite()
const sampleSchema = z.object({ tMs, x: coord, y: coord })
const clickSchema = z.object({ tMs, x: coord, y: coord, button: z.enum(['left', 'right', 'middle']) })

export const CursorTrackSchema = z.object({
  version: z.literal(1),
  /** Tamanho (px) do vídeo de tela gravado. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  samples: z.array(sampleSchema).refine((s) => s.every((p, i) => i === 0 || p.tMs > s[i - 1].tMs), 'tMs das amostras deve ser estritamente crescente'),
  clicks: z.array(clickSchema)
})

/** Valida a trilha; nunca lança. null para inválida ou de outra versão. */
export function parseCursorTrack(json: unknown): CursorTrackV1 | null {
  try {
    const r = CursorTrackSchema.safeParse(json)
    return r.success ? (r.data as CursorTrackV1) : null
  } catch {
    return null
  }
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Ponto (px físicos de tela) → 0–1 do quadro (px físicos de tela). Sem prender; quadro vazio vira 0. */
export function normalizeToFrame(p: { x: number; y: number }, frame: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: frame.width > 0 ? (p.x - frame.x) / frame.width : 0,
    y: frame.height > 0 ? (p.y - frame.y) / frame.height : 0
  }
}

/**
 * Ponto → 0–1 do VÍDEO quando o encoder encaixa o quadro atual no tamanho fixo do vídeo com `contain` (modo janela:
 * `sizeChangeBehavior: 'contain'` do RecordingEngine). Uma janela redimensionada vira uma caixa centrada de escala
 * min(W/w, H/h) com barras; o ponto é levado para dentro dela. Mesma proporção do vídeo = `normalizeToFrame`.
 */
export function normalizeContain(p: { x: number; y: number }, frame: Rect, video: { width: number; height: number }): { x: number; y: number } {
  const u = normalizeToFrame(p, frame)
  if (!(frame.width > 0 && frame.height > 0 && video.width > 0 && video.height > 0)) return u
  const s = Math.min(video.width / frame.width, video.height / frame.height)
  const cw = (frame.width * s) / video.width
  const ch = (frame.height * s) / video.height
  return { x: 0.5 + (u.x - 0.5) * cw, y: 0.5 + (u.y - 0.5) * ch }
}

/** Monitor com os limites em DIP (como o Electron informa) e em px físicos (como o vídeo é capturado). */
export interface DisplayGeometry { id: string; dip: Rect; phys: Rect; scaleFactor: number }

/**
 * Monta a tabela de monitores. `toPhysical` é o conversor de retângulos DIP → físico do sistema (no main:
 * `screen.dipToScreenRect(null, r)`), que conhece a origem física real de cada monitor com DPI misto.
 */
export function physicalDisplays(displays: { id: number | string; bounds: Rect; scaleFactor: number }[], toPhysical: (r: Rect) => Rect): DisplayGeometry[] {
  return displays.map((d) => ({ id: String(d.id), dip: { ...d.bounds }, phys: toPhysical(d.bounds), scaleFactor: d.scaleFactor }))
}

function distToRect(p: { x: number; y: number }, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width))
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height))
  return dx * dx + dy * dy
}

/**
 * Ponto DIP (`screen.getCursorScreenPoint()`) → px físicos de tela. Cada monitor tem a própria escala: o ponto é
 * convertido a partir da origem do monitor que o contém (ou do mais próximo): físico = origemFísica + (dip −
 * origemDIP) × escala. Sem monitores, devolve o ponto.
 */
export function dipToPhysical(p: { x: number; y: number }, displays: DisplayGeometry[]): { x: number; y: number } {
  let best: DisplayGeometry | null = null
  let bestD = Infinity
  for (const d of displays) {
    const dist = distToRect(p, d.dip)
    if (dist < bestD) {
      bestD = dist
      best = d
      if (dist === 0) break
    }
  }
  if (!best) return { x: p.x, y: p.y }
  return { x: best.phys.x + (p.x - best.dip.x) * best.scaleFactor, y: best.phys.y + (p.y - best.dip.y) * best.scaleFactor }
}

/** HWND do id de fonte de janela do desktopCapturer (`window:<hwnd>:0`); null para tela ou id inválido. */
export function hwndFromSourceId(sourceId: string): number | null {
  const m = /^window:(\d+):/.exec(sourceId)
  const h = m ? Number(m[1]) : 0
  return Number.isSafeInteger(h) && h > 0 ? h : null
}

// ---- Consulta da trilha no editor (F6) ----

/**
 * Atraso do vídeo em relação à trilha (ruling R11): um quadro mostra a tela 55–120 ms depois do tMs do cursor
 * daquele instante. Quem converte tempo de vídeo em tempo do cursor (editor/cursorTime.ts) subtrai este valor; o
 * cursor.json fica bruto.
 */
export const CURSOR_VIDEO_LAG_MS = 80
/**
 * O cursor ampliado é desenhado por cima do cursor que já está no vídeo (ruling R6): a suavização nunca o leva a
 * mais que isto (px da FONTE gravada) da posição bruta, senão apareceriam dois cursores.
 */
export const CURSOR_MAX_DEVIATION_PX = 4
/** Meia janela (ms) da média centrada com suavização 1 (proporcional: 0,5 → 40 ms). */
export const CURSOR_SMOOTH_HALF_WINDOW_MS = 80

/** Índice da última amostra com tMs ≤ t (−1 se nenhuma). Amostras em tMs estritamente crescente (schema). */
function lastAtOrBefore(samples: readonly CursorSample[], t: number): number {
  let lo = 0, hi = samples.length - 1, r = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].tMs <= t) {
      r = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return r
}

/** Posição bruta (interpolação linear entre amostras vizinhas; depois da última, fica nela). */
function rawAt(samples: readonly CursorSample[], t: number, i: number): { x: number; y: number } {
  const a = samples[i]
  const b = samples[i + 1]
  if (!b || t <= a.tMs) return { x: a.x, y: a.y }
  const q = (t - a.tMs) / (b.tMs - a.tMs)
  return { x: a.x + (b.x - a.x) * q, y: a.y + (b.y - a.y) * q }
}

/**
 * Posição do cursor (0–1 do vídeo gravado) no instante `tMs` da trilha (tempo do CURSOR: use cursorTimeMs para
 * converter o tempo da timeline). null antes da 1ª amostra (ou trilha vazia); depois da última, a última.
 * `smoothing` 0–1 (ausente = 0, bruto): filtro de tremor — média centrada com peso triangular das amostras numa
 * janela de ±smoothing·CURSOR_SMOOTH_HALF_WINDOW_MS (sem atraso: olha para os dois lados), com o desvio da posição
 * bruta limitado a CURSOR_MAX_DEVIATION_PX px da fonte (ruling R6). O(log n + amostras da janela).
 */
export function cursorAt(track: CursorTrackV1, tMs: number, smoothing = 0): { x: number; y: number } | null {
  const s = track.samples
  if (s.length === 0 || !(tMs >= s[0].tMs)) return null
  const i = lastAtOrBefore(s, tMs)
  const raw = rawAt(s, tMs, i)
  const half = Math.min(1, Math.max(0, smoothing)) * CURSOR_SMOOTH_HALF_WINDOW_MS
  if (!(half > 0)) return raw
  // a própria posição bruta entra com peso 1; cada amostra da janela com 1 − |Δt|/meia janela
  let wSum = 1, x = raw.x, y = raw.y
  for (let j = i; j >= 0 && tMs - s[j].tMs < half; j--) {
    const w = 1 - (tMs - s[j].tMs) / half
    wSum += w
    x += s[j].x * w
    y += s[j].y * w
  }
  for (let j = i + 1; j < s.length && s[j].tMs - tMs < half; j++) {
    const w = 1 - (s[j].tMs - tMs) / half
    wSum += w
    x += s[j].x * w
    y += s[j].y * w
  }
  const W = track.width, H = track.height
  const dx = (x / wSum - raw.x) * W, dy = (y / wSum - raw.y) * H
  const d = Math.hypot(dx, dy)
  const k = d > CURSOR_MAX_DEVIATION_PX ? CURSOR_MAX_DEVIATION_PX / d : 1
  return { x: raw.x + (dx * k) / W, y: raw.y + (dy * k) / H }
}

/** Cliques em ordem de tempo (o arquivo já vem assim; se não vier, ordena uma vez por trilha). */
const sortedClicksCache = new WeakMap<CursorTrackV1, CursorClick[]>()
function sortedClicks(track: CursorTrackV1): CursorClick[] {
  let c = sortedClicksCache.get(track)
  if (!c) {
    const cl = track.clicks
    c = cl.every((k, i) => i === 0 || k.tMs >= cl[i - 1].tMs) ? cl : [...cl].sort((a, b) => a.tMs - b.tMs)
    sortedClicksCache.set(track, c)
  }
  return c
}

/** Primeiro índice com tMs ≥ t. */
function firstAtOrAfter(clicks: readonly CursorClick[], t: number): number {
  let lo = 0, hi = clicks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (clicks[mid].tMs < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Cliques com tMs em [t0, t1) (tempo do cursor), em ordem de tempo. Busca binária: O(log n + resultado). */
export function clicksBetween(track: CursorTrackV1, t0Ms: number, t1Ms: number): CursorClick[] {
  if (!(t1Ms > t0Ms)) return []
  const c = sortedClicks(track)
  return c.slice(firstAtOrAfter(c, t0Ms), firstAtOrAfter(c, t1Ms))
}
