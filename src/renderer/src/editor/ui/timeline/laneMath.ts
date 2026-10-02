import { easeValue } from '@shared/editor/anim'
import type { AnimPath } from '@shared/editor/animPaths'
import type { Anim, Ease, Us } from '@shared/editor/project'

// Matemática pura das linhas de keyframes (uma por propriedade animada do item expandido): nomes das
// propriedades, cor de cada ease e a mini-curva do valor (valor → y, trechos em caminhos SVG).

export const PATH_LABEL: Record<AnimPath, string> = {
  'transform.x': 'Posição X',
  'transform.y': 'Posição Y',
  'transform.scale': 'Escala',
  'transform.rotation': 'Rotação',
  'transform.opacity': 'Opacidade',
  'crop.l': 'Corte esquerda',
  'crop.t': 'Corte topo',
  'crop.r': 'Corte direita',
  'crop.b': 'Corte base',
  'adjust.brightness': 'Brilho',
  'adjust.contrast': 'Contraste',
  'adjust.saturation': 'Saturação',
  'visual.radius': 'Raio',
  'text.size': 'Tamanho do texto',
  'region.x': 'Região X',
  'region.y': 'Região Y',
  'region.w': 'Largura',
  'region.h': 'Altura',
  'region.rotation': 'Rotação da região',
  strength: 'Intensidade',
  'audio.volume': 'Volume'
}

const num = (n: number, digits = 1): string => String(Math.round(n * 10 ** digits) / 10 ** digits).replace('.', ',')

/** Valor do key na unidade do inspetor (rótulo acessível e dica do losango). */
export function formatKeyValue(path: AnimPath, v: number): string {
  if (path === 'transform.rotation' || path === 'region.rotation') return `${num(v)}°`
  if (path === 'visual.radius' || path === 'text.size') return `${num(v)} px`
  if (path === 'strength') return num(v)
  if (path === 'audio.volume') return v <= 0.001 ? 'mudo' : `${num(20 * Math.log10(v), 0)} dB`
  return `${num(v * 100)}%`
}

export type EaseKind = 'linear' | 'hold' | 'in' | 'out' | 'inOut' | 'custom'

export function easeKind(e: Ease): EaseKind {
  return typeof e === 'object' ? 'custom' : e
}

/** Cor do losango e do trecho que começa nele (a mesma dos presets no editor de curvas). */
export const EASE_COLOR: Record<EaseKind | 'flat', string> = {
  linear: '#c7ced9',
  hold: '#ff6b6b',
  in: '#5ec8ff',
  out: '#59d98e',
  inOut: '#f5b74a',
  custom: '#c08cff',
  flat: 'rgba(199, 206, 217, 0.35)'
}

export const EASE_LABEL: Record<EaseKind, string> = {
  linear: 'Linear',
  hold: 'Segurar',
  in: 'Suavizar entrada',
  out: 'Suavizar saída',
  inOut: 'Suavizar ambos',
  custom: 'Curva personalizada'
}

export interface ValueRange { min: number; max: number }

/** Amostras por trecho não linear para achar o alcance (overshoot da bezier passa dos keys). */
const RANGE_SAMPLES = 16

/** Menor e maior valor da curva (keys e o que ela passa entre eles); constante → faixa aberta em volta. */
export function valueRange(a: Anim<number>): ValueRange {
  const k = a.keys ?? []
  let min = Infinity, max = -Infinity
  const see = (v: number): void => {
    if (v < min) min = v
    if (v > max) max = v
  }
  for (let i = 0; i < k.length; i++) {
    see(k[i].value)
    const n = k[i + 1]
    if (!n || typeof k[i].ease !== 'object') continue // presets ficam entre os dois valores
    for (let j = 1; j < RANGE_SAMPLES; j++) see(k[i].value + (n.value - k[i].value) * easeValue(k[i].ease, j / RANGE_SAMPLES))
  }
  if (!Number.isFinite(min)) return { min: a.value - 0.5, max: a.value + 0.5 }
  if (max - min < 1e-9) return { min: min - 0.5, max: max + 0.5 }
  return { min, max }
}

/** y (px, para baixo) do valor numa linha de altura h: máximo em pad, mínimo em h − pad. */
export function valueToY(v: number, r: ValueRange, h: number, pad = 3): number {
  return pad + ((r.max - v) / (r.max - r.min)) * (h - 2 * pad)
}

export interface CurveSegment { kind: EaseKind | 'flat'; d: string }

const r1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Mini-curva do valor numa linha: um caminho SVG por trecho entre keys (cor = ease do key que o começa) e trechos
 * planos antes do 1º e depois do último key (até a duração do item). x relativo à parte visível do item (clipFrom);
 * trechos fora de [0, visW] ficam de fora (busca binária: O(log n + visíveis)). Não lineares viram polilinha (~1 ponto
 * a cada 3 px, 2..48 por trecho). Curvas densas (um key por quadro do "Seguir conteúdo"): trechos lineares seguidos
 * viram UMA polilinha com no máximo 4 pontos por coluna de pixel (o 1º, o menor, o maior e o último — o envelope não se
 * perde) — o tamanho do SVG fica proporcional à largura, não ao número de keys.
 */
export function curveSegments(a: Anim<number>, durationUs: Us, pxPerSec: number, clipFrom: number, visW: number, h: number): CurveSegment[] {
  const k = a.keys ?? []
  if (k.length === 0) return []
  const range = valueRange(a)
  const X = (t: Us): number => (t * pxPerSec) / 1e6 - clipFrom
  const Y = (v: number): number => valueToY(v, range, h)
  const pt = (x: number, y: number): string => `${r1(x)} ${r1(y)}`
  const visible = (x0: number, x1: number): boolean => x1 >= 0 && x0 <= visW
  const out: CurveSegment[] = []
  const flat = (t0: Us, t1: Us, v: number): void => {
    if (t1 > t0 && visible(X(t0), X(t1))) out.push({ kind: 'flat', d: `M${pt(X(t0), Y(v))}L${pt(X(t1), Y(v))}` })
  }
  flat(0, k[0].tUs, k[0].value)
  // polilinha linear em curso, decimada por coluna de pixel
  let run: string[] = []
  let col: { c: number; pts: { x: number; y: number }[] } | null = null
  const flushCol = (): void => {
    if (!col) return
    const ps = col.pts
    if (ps.length <= 4) for (const q of ps) run.push(pt(q.x, q.y))
    else {
      let mn = 0, mx = 0
      ps.forEach((q, j) => { if (q.y < ps[mn].y) mn = j; if (q.y > ps[mx].y) mx = j })
      for (const j of [...new Set([0, Math.min(mn, mx), Math.max(mn, mx), ps.length - 1])].sort((p, q) => p - q)) run.push(pt(ps[j].x, ps[j].y))
    }
    col = null
  }
  const addPt = (x: number, y: number): void => {
    const c = Math.floor(x)
    if (col && col.c !== c) flushCol()
    if (!col) col = { c, pts: [] }
    const lastP = col.pts[col.pts.length - 1]
    if (!lastP || lastP.x !== x || lastP.y !== y) col.pts.push({ x, y })
  }
  const flushRun = (): void => {
    flushCol()
    if (run.length >= 2) out.push({ kind: 'linear', d: `M${run.join('L')}` })
    run = []
  }
  // primeiro trecho visível: o último key com x ≤ 0
  let lo = 0, hi = k.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (X(k[mid].tUs) <= 0) lo = mid
    else hi = mid - 1
  }
  for (let i = lo; i + 1 < k.length; i++) {
    const k0 = k[i], k1 = k[i + 1]
    const x0 = X(k0.tUs), x1 = X(k1.tUs)
    if (x0 > visW) break
    if (!visible(x0, x1)) continue
    const kind = easeKind(k0.ease)
    // trecho não linear com menos de 1 px de largura: desenhado como reta (a curva não aparece nessa escala)
    if (kind === 'linear' || (kind !== 'hold' && x1 - x0 < 1)) {
      addPt(x0, Y(k0.value))
      addPt(x1, Y(k1.value))
      continue
    }
    flushRun()
    let d: string
    if (kind === 'hold') d = `M${pt(x0, Y(k0.value))}L${pt(x1, Y(k0.value))}L${pt(x1, Y(k1.value))}`
    else {
      const n = Math.max(2, Math.min(48, Math.ceil((x1 - x0) / 3)))
      const pts: string[] = []
      for (let j = 0; j <= n; j++) pts.push(pt(x0 + ((x1 - x0) * j) / n, Y(k0.value + (k1.value - k0.value) * easeValue(k0.ease, j / n))))
      d = `M${pts.join('L')}`
    }
    out.push({ kind, d })
  }
  flushRun()
  const last = k[k.length - 1]
  flat(last.tUs, durationUs, last.value)
  return out
}
