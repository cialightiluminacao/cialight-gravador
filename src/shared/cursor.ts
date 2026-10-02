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
