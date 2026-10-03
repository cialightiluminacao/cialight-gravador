// Varredura de dados sensíveis (G3 "Procurar dados sensíveis"): a parte PURA (sem DOM/Electron/Node) que transforma as
// amostras do OCR (quadros a 2 qps da gravação) em OCORRÊNCIAS temporais — caixas ao longo do tempo — e as keys de
// região que o efeito (Task 4) usa sem reinterpretar. O laço com ffmpeg/helper de OCR fica em src/main/sensitive/.
//
// Tempo: µs INTEIROS da mídia de origem (ruling R2). Caixas: topo-esquerda, normalizadas 0–1 ao quadro da origem.
// Privacidade (R6): `ScanSample`/`Detection.value` só existem no main; `Occurrence` (o que cruza o IPC) não tem valor —
// só tipo, texto mascarado, confiança, caixas e tempos.
//
// Cobertura conservadora entre amostras (R5): em [s_i, s_{i+1}) a região é a caixa que contém as caixas das duas
// amostras, crescida pela margem max(2 px, 0,15 × altura da caixa) (spike §4); antes da 1ª e depois da última, a
// caixa da ponta (pré/pós-rolagem de um intervalo de amostra). O NCC (F6) refina pré/pós-rolagem e intervalos com
// movimento; na perda, a última caixa boa é segurada e CRESCE até o fim do intervalo (nunca encolhe).
import type { Us } from './project'
import type { Detection, OcrBox, OcrLine, SensitiveKind } from './sensitive'
import { startTracker, trackNext, type GrayImage, type TrackBox, type TrackOpts, type TrackResult } from './track'

/** Amostragem do OCR: 2 quadros/s da origem (ruling R1). */
export const SAMPLE_FPS = 2
export const SAMPLE_INTERVAL_US = 500_000
/** Ampliação do quadro antes do OCR (spike §7.5: 2× lanczos em cinza). */
export const OCR_UPSCALE = 2
/** Sub-quadros do refinamento por NCC. */
export const REFINE_FPS = 10
export const REFINE_STEP_US = 100_000
/** IoU mínima para continuar uma ocorrência quando o OCR leu o valor de outro jeito. */
export const GROUP_MIN_IOU = 0.3
/** Margem do blur (spike §4): max(MARGIN_MIN_PX, MARGIN_FRAC × altura da caixa), px do quadro da origem, por lado. */
export const MARGIN_MIN_PX = 2
export const MARGIN_FRAC = 0.15
/** Intervalo com movimento (refinável): o centro anda mais que isso × a altura da caixa entre duas amostras. */
export const MOVE_FRAC = 0.5

/**
 * Rastreador do refinamento: janela de busca de 24 px da análise por sub-quadro (a 10 qps ≈ 240 px/s com a análise em
 * escala 1) e crescimento da cobertura da perda de 1,5× por sub-quadro (o `growth` 2× do F6 é para trechos longos
 * do "Seguir conteúdo"; aqui a perda dura no máximo um intervalo de amostra = 5 sub-quadros: 24 → 36 → 54 → 81 → 122 px).
 */
export const REFINE_TRACK_OPTS: Partial<TrackOpts> = { searchPx: 24, growth: 1.5 }
/** Lado mínimo do molde do NCC (px da análise): abaixo disso a análise sobe de escala (até a resolução da origem). */
export const REFINE_MIN_TPL_PX = 16
/** Molde de no máximo 8 × a altura de largura (o começo de um token/JWT longo basta para a translação). */
export const REFINE_TPL_MAX_ASPECT = 8

export type ScanPhase = 'amostrando' | 'lendo' | 'analisando'
export interface ScanProgress { phase: ScanPhase; done: number; total: number }
export type ScanErrorCode = 'ocrUnavailable' | 'ffmpeg' | 'busy' | 'invalid'
export interface ScanError { code: ScanErrorCode; message: string }

/** Uma amostra (quadro lido pelo OCR, ou reaproveitado se não mudou). SÓ NO MAIN: as detecções têm o valor. */
export interface ScanSample { tUs: Us; detections: Detection[] }
/** Caixa de uma ocorrência num instante; `src`: amostra do OCR, ponte de uma falha do OCR, NCC confiante ou perda. */
export interface OccurrenceSample { tUs: Us; box: OcrBox; src?: 'ocr' | 'bridge' | 'track' | 'lost' }
export interface Occurrence {
  id: string
  kind: SensitiveKind
  masked: string
  confidence: 'validated' | 'pattern'
  /** Ordenadas por tUs; incluem as do refinamento. */
  samples: OccurrenceSample[]
  /** 1ª/última amostra do OCR em que foi detectada. */
  firstSeenUs: Us
  lastSeenUs: Us
  /** Intervalo conservador: um intervalo de amostra antes/depois, limitado a [fromUs, toUs]. */
  startUs: Us
  endUs: Us
  sourceW: number
  sourceH: number
  /** Perdas do refinamento (caixa segurada e ampliada dali até o fim do intervalo). */
  lostAt?: Us[]
  /**
   * Movimento dominante da tela (normalizado por µs) em volta da 1ª/última amostra: estende as pontas de uma
   * ocorrência vista numa amostra só (sem movimento próprio) quando a tela rola.
   */
  motion?: { pre?: { x: number; y: number }; post?: { x: number; y: number } }
}
/** Tempos (ms) da varredura: partida do helper, amostragem (decodificação + OCR), só OCR, refinamento. */
export interface ScanTimings { startMs: number; samplingMs: number; ocrMs: number; refineMs: number }
export interface ScanResult {
  occurrences: Occurrence[]
  framesSampled: number
  framesOcr: number
  ms: number
  lang: string
  timings?: ScanTimings
  /** Jobs de refinamento de intervalos com movimento que ficaram com a regra conservadora pelo teto. */
  refineCapped?: number
  cancelled?: boolean
  error?: ScanError
}

// ---------------------------------------------------------------- caixas

export function clampBox(b: OcrBox): OcrBox {
  const x0 = Math.max(0, Math.min(1, b.x)), y0 = Math.max(0, Math.min(1, b.y))
  const x1 = Math.max(0, Math.min(1, b.x + b.w)), y1 = Math.max(0, Math.min(1, b.y + b.h))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

export function unionBox(a: OcrBox, b: OcrBox): OcrBox {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y)
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }
}

export function iou(a: OcrBox, b: OcrBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const u = a.w * a.h + b.w * b.h - inter
  return u > 0 ? inter / u : 0
}

/** `inner` ⊆ `outer` (com folga numérica de 1e-9). */
export function boxContains(outer: OcrBox, inner: OcrBox): boolean {
  const e = 1e-9
  return inner.x >= outer.x - e && inner.y >= outer.y - e && inner.x + inner.w <= outer.x + outer.w + e && inner.y + inner.h <= outer.y + outer.h + e
}

/** Cresce `b` por `mx`/`my` (normalizados) de cada lado e limita a 0–1. */
function grow(b: OcrBox, mx: number, my: number): OcrBox {
  return clampBox({ x: b.x - mx, y: b.y - my, w: b.w + 2 * mx, h: b.h + 2 * my })
}

// ---------------------------------------------------------------- detecção de mudança

/**
 * Mudança = pixels com |diferença| > CHANGE_LEVEL CONCENTRADOS: ≥ CHANGE_MIN_PIXELS numa janela 2×2 de blocos de
 * CHANGE_BLOCK px (da imagem comparada, a ampliada 2×). Medido nos vídeos sintéticos (H.264 crf 20, GOP 2 s): o ruído
 * de quadro-chave/residual em tela parada é espalhado — no máx. 17 pixels por janela —, enquanto um único dígito
 * trocado em cinza claro (#9A9A9A sobre branco) a 12 px dá 50 (texto escuro, muito mais). Limiar 30 no meio.
 */
export const CHANGE_LEVEL = 32
export const CHANGE_BLOCK = 16
export const CHANGE_MIN_PIXELS = 30

/** Contagem de pixels mudados por bloco no retângulo [x0,x1)×[y0,y1) e o máximo numa janela 2×2 de blocos. */
function maxWindowChange(prev: ArrayLike<number>, cur: ArrayLike<number>, w: number, x0: number, y0: number, x1: number, y1: number, level = CHANGE_LEVEL): number {
  const B = CHANGE_BLOCK
  const bw = Math.ceil((x1 - x0) / B), bh = Math.ceil((y1 - y0) / B)
  const blk = new Uint32Array(bw * bh)
  for (let y = y0; y < y1; y++) {
    const row = (((y - y0) / B) | 0) * bw
    let i = y * w + x0
    for (let x = x0; x < x1; x++, i++) {
      const d = prev[i] - cur[i]
      if (d > level || d < -level) blk[row + (((x - x0) / B) | 0)]++
    }
  }
  let m = 0
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const s = blk[by * bw + bx] + (bx + 1 < bw ? blk[by * bw + bx + 1] : 0) + (by + 1 < bh ? blk[(by + 1) * bw + bx] + (bx + 1 < bw ? blk[(by + 1) * bw + bx + 1] : 0) : 0)
      if (s > m) m = s
    }
  }
  return m
}

/**
 * O quadro `cur` mudou em relação a `prev` (o último que foi ao OCR)? Texto novo ou trocado nunca reaproveita as
 * detecções antigas; o ruído do H.264 em tela parada não conta. Tamanhos diferentes = mudou.
 */
export function frameChanged(prev: Uint8Array, cur: Uint8Array, w: number, h: number): boolean {
  if (prev.length < w * h || prev.length !== cur.length) return true
  return maxWindowChange(prev, cur, w, 0, 0, w, h) >= CHANGE_MIN_PIXELS
}

/**
 * Mudança MENOR (pontuação digitada — `.`, `-`, `,` dão 6–63 pixels na janela —, texto de baixo contraste com
 * |Δ| ≤ 32): ≥ CHANGE_MINOR_PIXELS pixels com |Δ| > CHANGE_MINOR_LEVEL numa janela. Não basta para reler na hora
 * (o ruído de quadro-chave também passa disso), mas uma tela com mudança menor desde a última leitura é relida a cada
 * STALE_SAMPLES amostras (2 s): detecção velha nunca vale indefinidamente.
 */
export const CHANGE_MINOR_LEVEL = 16
export const CHANGE_MINOR_PIXELS = 8
export const STALE_SAMPLES = 4

export type FrameChange = 'none' | 'minor' | 'major'

/** Nível de mudança de `cur` em relação a `prev` (o último quadro lido pelo OCR). */
export function frameChangeLevel(prev: Uint8Array, cur: Uint8Array, w: number, h: number): FrameChange {
  if (prev.length < w * h || prev.length !== cur.length) return 'major'
  if (maxWindowChange(prev, cur, w, 0, 0, w, h) >= CHANGE_MIN_PIXELS) return 'major'
  return maxWindowChange(prev, cur, w, 0, 0, w, h, CHANGE_MINOR_LEVEL) >= CHANGE_MINOR_PIXELS ? 'minor' : 'none'
}

/** Vai ao OCR? Mudança forte: sim; menor: quando a última leitura tem ≥ STALE_SAMPLES amostras; nenhuma: não. */
export function shouldOcr(change: FrameChange, samplesSinceOcr: number): boolean {
  return change === 'major' || (change === 'minor' && samplesSinceOcr >= STALE_SAMPLES)
}

/** A região `box` (normalizada, crescida pela margem do blur) mudou entre os dois quadros (w×h)? */
export function regionChanged(prev: Uint8Array, cur: Uint8Array, w: number, h: number, box: OcrBox): boolean {
  if (prev.length < w * h || prev.length !== cur.length) return true
  const m = Math.max(MARGIN_MIN_PX * 2, MARGIN_FRAC * box.h * h)
  const x0 = Math.max(0, Math.floor(box.x * w - m)), y0 = Math.max(0, Math.floor(box.y * h - m))
  const x1 = Math.min(w, Math.ceil((box.x + box.w) * w + m)), y1 = Math.min(h, Math.ceil((box.y + box.h) * h + m))
  if (x1 <= x0 || y1 <= y0) return false
  return maxWindowChange(prev, cur, w, x0, y0, x1, y1) >= CHANGE_MIN_PIXELS
}

/** Mesma detecção no mesmo lugar: mesmo tipo e ≥ 50 % da menor caixa em comum (o valor não conta). */
export function samePlace(n: Detection, p: Detection): boolean {
  if (n.kind !== p.kind) return false
  const ix = Math.max(0, Math.min(n.box.x + n.box.w, p.box.x + p.box.w) - Math.max(n.box.x, p.box.x))
  const iy = Math.max(0, Math.min(n.box.y + n.box.h, p.box.y + p.box.h) - Math.max(n.box.y, p.box.y))
  const minArea = Math.min(n.box.w * n.box.h, p.box.w * p.box.h)
  return minArea > 0 && ix * iy >= 0.5 * minArea
}

/**
 * Retropropagação de uma leitura melhor (`d`) para uma amostra anterior cujos pixels na região de `d` eram os mesmos:
 * a detecção no mesmo lugar ganha a união das caixas; sem ela, `d` entra. Nova lista (a original não muda).
 */
export function mergeDetection(dets: readonly Detection[], d: Detection): Detection[] {
  const i = dets.findIndex((e) => samePlace(d, e))
  if (i < 0) return [...dets, d]
  if (boxContains(dets[i].box, d.box)) return dets as Detection[]
  const out = [...dets]
  out[i] = { ...dets[i], box: unionBox(dets[i].box, d.box) }
  return out
}

/**
 * União entre leituras (spike §7.3): detecções da leitura anterior que a nova leitura do OCR perdeu (nenhuma do mesmo
 * tipo NO MESMO LUGAR) continuam valendo se os pixels da região delas não mudaram entre os dois quadros — o mesmo
 * conteúdo continua lá e o OCR só oscilou. E uma releitura no mesmo lugar com caixa MENOR (palavra partida, caractere
 * perdido) sobre pixels iguais fica com a união das duas caixas: a cobertura nunca encolhe porque outra parte da tela
 * mudou. "Mesmo lugar" é por posição (≥ 50 % da menor caixa em comum), não pelo valor: duas cópias do mesmo dado em
 * lugares diferentes são duas detecções.
 */
export function carryDetections(prev: readonly Detection[], next: readonly Detection[], prevFrame: Uint8Array, curFrame: Uint8Array, w: number, h: number): Detection[] {
  const same = samePlace
  const unchanged = new Map<Detection, boolean>()
  const still = (p: Detection): boolean => {
    let u = unchanged.get(p)
    if (u === undefined) unchanged.set(p, (u = !regionChanged(prevFrame, curFrame, w, h, p.box)))
    return u
  }
  const out = next.map((n) => {
    let box = n.box
    for (const p of prev) if (same(n, p) && !boxContains(box, p.box) && still(p)) box = unionBox(box, p.box)
    return box === n.box ? n : { ...n, box }
  })
  for (const p of prev) if (!next.some((n) => same(n, p)) && still(p)) out.push(p)
  return out
}

// ---------------------------------------------------------------- linhas do OCR → OcrLine normalizadas

/** Linha como o helper devolve: texto e palavras [texto, x, y, w, h] em px da imagem recebida. */
export interface HelperLine { t: string; w: [string, number, number, number, number][] }

/** Ladrilho de um quadro maior que o `maxDim` do OCR; o núcleo decide de qual ladrilho fica cada linha. */
export interface Tile { x: number; y: number; w: number; h: number; coreX0: number; coreY0: number; coreX1: number; coreY1: number }

function axisTiles(len: number, maxDim: number, overlap: number): { s: number; e: number; c0: number; c1: number }[] {
  if (len <= maxDim) return [{ s: 0, e: len, c0: 0, c1: len }]
  const step = maxDim - overlap
  const n = Math.ceil((len - overlap) / step)
  const out: { s: number; e: number; c0: number; c1: number }[] = []
  for (let i = 0; i < n; i++) {
    const s = i === n - 1 ? len - maxDim : i * step
    out.push({ s, e: s + maxDim, c0: 0, c1: len })
  }
  // núcleos: corte no meio de cada sobreposição
  for (let i = 1; i < out.length; i++) {
    const mid = Math.round((out[i].s + out[i - 1].e) / 2)
    out[i - 1].c1 = mid
    out[i].c0 = mid
  }
  return out
}

/** Ladrilhos ≤ maxDim com sobreposição (px) — uma linha de texto ampliada cabe inteira em algum deles. */
export function tilePlan(w: number, h: number, maxDim: number, overlap: number): Tile[] {
  const xs = axisTiles(w, maxDim, overlap), ys = axisTiles(h, maxDim, overlap)
  const out: Tile[] = []
  for (const ty of ys) for (const tx of xs) out.push({ x: tx.s, y: ty.s, w: tx.e - tx.s, h: ty.e - ty.s, coreX0: tx.c0, coreY0: ty.c0, coreX1: tx.c1, coreY1: ty.c1 })
  return out
}

/**
 * Linhas do helper (px do ladrilho) → OcrLine normalizadas ao quadro inteiro (imgW×imgH = origem × ampliação, então
 * dividir por eles já desfaz a ampliação). Com ladrilho, só ficam as linhas cujo centro cai no núcleo dele.
 */
export function helperLinesToOcr(lines: readonly HelperLine[], imgW: number, imgH: number, tile?: Tile): OcrLine[] {
  const ox = tile?.x ?? 0, oy = tile?.y ?? 0
  const out: OcrLine[] = []
  for (const l of lines) {
    if (!Array.isArray(l?.w) || l.w.length === 0) continue
    const words = []
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const wd of l.w) {
      if (!Array.isArray(wd) || wd.length < 5) continue
      const [text, x, y, w, h] = wd
      if (typeof text !== 'string' || ![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
      const gx = x + ox, gy = y + oy
      x0 = Math.min(x0, gx); y0 = Math.min(y0, gy); x1 = Math.max(x1, gx + w); y1 = Math.max(y1, gy + h)
      words.push({ text, box: clampBox({ x: gx / imgW, y: gy / imgH, w: w / imgW, h: h / imgH }) })
    }
    if (words.length === 0) continue
    if (tile) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
      if (cx < tile.coreX0 || cx >= tile.coreX1 || cy < tile.coreY0 || cy >= tile.coreY1) continue
    }
    out.push({ words })
  }
  return out
}

// ---------------------------------------------------------------- agrupamento

/** idPrefix: ids únicos entre varreduras (`${idPrefix}o1`…); o main passa o scanId. */
export interface GroupCtx { fromUs: Us; toUs: Us; sourceW: number; sourceH: number; intervalUs?: Us; idPrefix?: string }

interface Run {
  kind: SensitiveKind
  values: Set<string>
  masked: string
  confidence: 'validated' | 'pattern'
  samples: OccurrenceSample[]
  firstIdx: number
  lastIdx: number
  lastBox: OcrBox
  /** Movimento do centro (normalizado por µs) entre as duas últimas detecções; null = só uma até agora. */
  vel: { x: number; y: number } | null
  firstSeen: Us
  lastSeen: Us
}

const centre = (b: OcrBox): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/**
 * Amostras (TODAS as do trecho, inclusive as sem detecção, em ordem de tempo) → ocorrências. Continua a mesma ocorrência
 * a detecção do mesmo tipo com o mesmo valor (só em memória; não sai daqui) ou com IoU ≥ 0,3 com a última caixa; uma
 * amostra sem ela é ponte (falha do OCR: a caixa na falha é a união das vizinhas); duas seguidas encerram. Cada
 * ocorrência pega no máximo uma detecção por amostra (maior pontuação: mesmo valor + IoU; empate, a mais perto).
 * Movimento (rolagem): a IoU também é medida contra a caixa PREVISTA — a última deslocada pelo movimento da própria
 * ocorrência ou, sem ele (só uma detecção até agora), pelo movimento dominante da amostra (mediana dos pares com o
 * mesmo valor). Sem isso, um valor relido diferente numa tela rolando quebraria a ocorrência em duas, e o intervalo
 * entre elas ficaria só com as pontas paradas.
 */
export function groupOccurrences(samples: readonly ScanSample[], ctx: GroupCtx): Occurrence[] {
  const interval = ctx.intervalUs ?? SAMPLE_INTERVAL_US
  const runs: Run[] = []
  let active: Run[] = []
  /** Movimento dominante entre a amostra i−1 e a i (null = sem pares suficientes). */
  const dominant: ({ x: number; y: number } | null)[] = []
  const shift = (b: OcrBox, v: { x: number; y: number }, dt: number): OcrBox => ({ ...b, x: b.x + v.x * dt, y: b.y + v.y * dt })
  const median = (xs: number[]): number => { const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1] }
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    active = active.filter((r) => r.lastIdx >= i - 2)
    const dets = s.detections.map((d) => ({ ...d, box: clampBox(d.box) }))
    // movimento dominante: pares (ocorrência da amostra anterior, detecção) com o mesmo valor, sem ambiguidade
    const vx: number[] = [], vy: number[] = []
    for (const r of active) {
      if (r.lastIdx !== i - 1) continue
      const m = dets.filter((d) => d.kind === r.kind && r.values.has(d.value))
      if (m.length !== 1) continue
      const a = centre(r.lastBox), b = centre(m[0].box), dt = s.tUs - r.lastSeen
      if (dt > 0) { vx.push((b.x - a.x) / dt); vy.push((b.y - a.y) / dt) }
    }
    const global = vx.length >= 2 ? { x: median(vx), y: median(vy) } : null
    dominant.push(global)
    const pairs: { r: Run; j: number; score: number; dist: number }[] = []
    for (const r of active) {
      const v = r.vel ?? global
      const pred = v ? shift(r.lastBox, v, s.tUs - r.lastSeen) : r.lastBox
      for (let j = 0; j < dets.length; j++) {
        const d = dets[j]
        if (d.kind !== r.kind) continue
        const same = r.values.has(d.value)
        const o = Math.max(iou(r.lastBox, d.box), iou(pred, d.box))
        if (!same && o < GROUP_MIN_IOU) continue
        const a = centre(pred), b = centre(d.box)
        pairs.push({ r, j, score: (same ? 1 : 0) + o, dist: Math.hypot((a.x - b.x) * ctx.sourceW, (a.y - b.y) * ctx.sourceH) })
      }
    }
    pairs.sort((p, q) => q.score - p.score || p.dist - q.dist)
    const usedRun = new Set<Run>(), usedDet = new Set<number>()
    for (const p of pairs) {
      if (usedRun.has(p.r) || usedDet.has(p.j)) continue
      usedRun.add(p.r); usedDet.add(p.j)
      const d = dets[p.j], r = p.r
      if (r.lastIdx === i - 2) r.samples.push({ tUs: samples[i - 1].tUs, box: unionBox(r.lastBox, d.box), src: 'bridge' })
      r.samples.push({ tUs: s.tUs, box: d.box, src: 'ocr' })
      r.values.add(d.value)
      if (d.confidence === 'validated' && r.confidence !== 'validated') { r.confidence = 'validated'; r.masked = d.masked }
      const a = centre(r.lastBox), b = centre(d.box), dt = s.tUs - r.lastSeen
      if (dt > 0) r.vel = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt }
      r.lastIdx = i; r.lastBox = d.box; r.lastSeen = s.tUs
    }
    for (let j = 0; j < dets.length; j++) {
      if (usedDet.has(j)) continue
      const d = dets[j]
      const r: Run = { kind: d.kind, values: new Set([d.value]), masked: d.masked, confidence: d.confidence, samples: [{ tUs: s.tUs, box: d.box, src: 'ocr' }], firstIdx: i, lastIdx: i, lastBox: d.box, vel: null, firstSeen: s.tUs, lastSeen: s.tUs }
      runs.push(r)
      active.push(r)
    }
  }
  runs.sort((a, b) => a.firstSeen - b.firstSeen)
  const motionOf = (r: Run): Occurrence['motion'] => {
    const pre = dominant[r.firstIdx] ?? dominant[r.firstIdx + 1] ?? undefined
    const post = dominant[r.lastIdx + 1] ?? dominant[r.lastIdx] ?? undefined
    return pre || post ? { ...(pre ? { pre } : {}), ...(post ? { post } : {}) } : undefined
  }
  return runs.map((r, k) => ({
    id: `${ctx.idPrefix ?? ''}o${k + 1}`,
    kind: r.kind,
    masked: r.masked,
    confidence: r.confidence,
    samples: r.samples,
    firstSeenUs: r.firstSeen,
    lastSeenUs: r.lastSeen,
    startUs: Math.max(ctx.fromUs, r.firstSeen - interval),
    endUs: Math.min(ctx.toUs, r.lastSeen + interval),
    sourceW: ctx.sourceW,
    sourceH: ctx.sourceH,
    ...(r.samples.length === 1 && motionOf(r) ? { motion: motionOf(r) } : {})
  }))
}

// ---------------------------------------------------------------- keys da região

/** Key de degrau: a caixa vale de `tUs` até o próximo key (o último, até endUs inclusive). */
export interface RegionKey { tUs: Us; box: OcrBox }

function marginFor(occ: Occurrence, hNorm: number): { mx: number; my: number } {
  const m = Math.max(MARGIN_MIN_PX, MARGIN_FRAC * hNorm * occ.sourceH)
  return { mx: m / occ.sourceW, my: m / occ.sourceH }
}

function grownSpan(occ: Occurrence, a: OcrBox, b: OcrBox): OcrBox {
  const { mx, my } = marginFor(occ, Math.max(a.h, b.h))
  return grow(unionBox(a, b), mx, my)
}

/**
 * Keys de degrau da região (usadas tal como estão pelo efeito): pré-rolagem [startUs, 1ª amostra) com a 1ª caixa; em
 * cada [s_i, s_{i+1}) a caixa que contém as duas, crescida pela margem; pós-rolagem [última, endUs] com a última.
 * Pontas sem refinamento de um conteúdo que se move: a caixa da ponta é unida à dela EXTRAPOLADA pelo movimento entre
 * as duas amostras da ponta até startUs/endUs (rolagem: o conteúdo estava/vai estar mais abaixo/acima) — só cresce.
 * Com uma amostra só, o movimento é o dominante da tela naquela amostra (`motion`).
 */
export function occurrenceKeys(occ: Occurrence): RegionKey[] {
  // amostras no mesmo instante (não deveria haver, mas a região nunca perde uma delas): uma só, com a união
  const s: { tUs: Us; box: OcrBox }[] = []
  for (const x of occ.samples) {
    const prev = s[s.length - 1]
    if (prev && prev.tUs === x.tUs) prev.box = unionBox(prev.box, x.box)
    else s.push({ tUs: x.tUs, box: x.box })
  }
  if (s.length === 0) return []
  const n = s.length
  /** A caixa de `from` deslocada pelo movimento entre `other` e `from`, até o instante `toUs`. */
  const extrapolate = (from: { tUs: Us; box: OcrBox }, other: { tUs: Us; box: OcrBox }, toUs: Us): OcrBox => {
    const span = from.tUs - other.tUs
    if (span === 0) return from.box
    const cf = centre(from.box), co = centre(other.box), dt = toUs - from.tUs
    return { ...from.box, x: from.box.x + ((cf.x - co.x) / span) * dt, y: from.box.y + ((cf.y - co.y) / span) * dt }
  }
  const byMotion = (from: { tUs: Us; box: OcrBox }, v: { x: number; y: number } | undefined, toUs: Us): OcrBox =>
    v ? { ...from.box, x: from.box.x + v.x * (toUs - from.tUs), y: from.box.y + v.y * (toUs - from.tUs) } : from.box
  const keys: RegionKey[] = []
  if (occ.startUs < s[0].tUs) {
    const ext = n > 1 ? extrapolate(s[0], s[1], occ.startUs) : byMotion(s[0], occ.motion?.pre, occ.startUs)
    keys.push({ tUs: occ.startUs, box: grownSpan(occ, s[0].box, ext) })
  }
  for (let i = 0; i < n; i++) {
    const next = s[i + 1]
    if (next) keys.push({ tUs: s[i].tUs, box: grownSpan(occ, s[i].box, next.box) })
    else {
      const ext = n > 1 ? extrapolate(s[i], s[i - 1], occ.endUs) : byMotion(s[i], occ.motion?.post, occ.endUs)
      keys.push({ tUs: s[i].tUs, box: grownSpan(occ, s[i].box, ext) })
    }
  }
  return keys
}

const keysCache = new WeakMap<Occurrence, RegionKey[]>()

/** Caixa da região em `tUs` (null fora de [startUs, endUs]). */
export function occurrenceRegionAt(occ: Occurrence, tUs: Us): OcrBox | null {
  if (tUs < occ.startUs || tUs > occ.endUs) return null
  let keys = keysCache.get(occ)
  if (!keys) { keys = occurrenceKeys(occ); keysCache.set(occ, keys) }
  if (keys.length === 0 || tUs < keys[0].tUs) return null
  let lo = 0, hi = keys.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (keys[mid].tUs <= tUs) lo = mid
    else hi = mid - 1
  }
  return keys[lo].box
}

// ---------------------------------------------------------------- refinamento (NCC, F6)

export interface RefineJob {
  occId: string
  kind: 'pre' | 'post' | 'move'
  fromUs: Us
  toUs: Us
  /** Amostra conhecida de onde o rastreamento parte (pré: o fim, para trás; pós/movimento: o começo, para frente). */
  anchorUs: Us
  anchorBox: OcrBox
  dir: 'backward' | 'forward'
  /** Movimento: a caixa do OCR no fim do intervalo (valida o rastreamento e entra na união depois de uma perda). */
  endBox?: OcrBox
}

/** Intervalos refináveis de uma ocorrência recém-agrupada: pré/pós-rolagem e pares de amostras do OCR com movimento. */
export function refinementJobs(occ: Occurrence): RefineJob[] {
  const s = occ.samples
  if (s.length === 0) return []
  const jobs: RefineJob[] = []
  const first = s[0], last = s[s.length - 1]
  if (occ.startUs < first.tUs) jobs.push({ occId: occ.id, kind: 'pre', fromUs: occ.startUs, toUs: first.tUs, anchorUs: first.tUs, anchorBox: first.box, dir: 'backward' })
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i], b = s[i + 1]
    if (a.src !== 'ocr' || b.src !== 'ocr') continue // ponte: a união das vizinhas já cobre
    const ca = centre(a.box), cb = centre(b.box)
    const d = Math.hypot((ca.x - cb.x) * occ.sourceW, (ca.y - cb.y) * occ.sourceH)
    if (d > MOVE_FRAC * Math.max(a.box.h, b.box.h) * occ.sourceH) jobs.push({ occId: occ.id, kind: 'move', fromUs: a.tUs, toUs: b.tUs, anchorUs: a.tUs, anchorBox: a.box, dir: 'forward', endBox: b.box })
  }
  if (occ.endUs > last.tUs) jobs.push({ occId: occ.id, kind: 'post', fromUs: last.tUs, toUs: occ.endUs, anchorUs: last.tUs, anchorBox: last.box, dir: 'forward' })
  return jobs
}

/** Escala da análise do refinamento: a do F6 (`analysisSize`) subindo até o molde ter REFINE_MIN_TPL_PX (máx. 1). */
export function refineScale(W: number, H: number, boxes: readonly OcrBox[]): number {
  const longest = Math.max(W, H)
  let s = Math.min(1, 480 / longest)
  for (const b of boxes) {
    const tpl = templateBoxPx(b, W, H, 1)
    const need = REFINE_MIN_TPL_PX / Math.max(1e-6, Math.min(tpl.w, tpl.h))
    s = Math.max(s, need)
  }
  return Math.min(1, s)
}

/** Molde do NCC em px da análise (centro + tamanho): a caixa crescida pela margem do blur (contexto em volta do texto). */
function templateBoxPx(b: OcrBox, W: number, H: number, scale: number): TrackBox {
  const m = Math.max(MARGIN_MIN_PX, MARGIN_FRAC * b.h * H)
  const w = (b.w * W + 2 * m) * scale, h = (b.h * H + 2 * m) * scale
  return { x: (b.x + b.w / 2) * W * scale, y: (b.y + b.h / 2) * H * scale, w, h }
}

export interface RefineResult { points: OccurrenceSample[]; lostAt?: Us }

/**
 * Rastreia a caixa de `job` nos sub-quadros `frames` (cinza na análise aW×aH, ordem de tempo, cobrindo
 * [fromUs, toUs] e incluindo o quadro da âncora) a partir da âncora, no sentido do job. Cada sub-quadro 'ok' vira uma
 * amostra; no 1º que não é 'ok' (perda), a última caixa boa fica segurada e cresce pela cobertura do rastreador
 * (`reach`, ×1,5 por sub-quadro) até o fim do intervalo (num intervalo de movimento, unida à caixa do OCR do fim).
 * null = não refinável (molde liso/pequeno, âncora ausente) ou, no movimento, o rastreio confiante chegou ao fim longe
 * da caixa do OCR (rastreou outra coisa): o chamador fica com a regra conservadora.
 */
export function refineTrack(frames: readonly { tUs: Us; img: GrayImage }[], job: RefineJob, W: number, H: number): RefineResult | null {
  if (frames.length === 0) return null
  const aW = frames[0].img.width
  const scale = aW / W
  const order = job.dir === 'backward' ? [...frames].reverse() : [...frames]
  const ai = order.findIndex((f) => f.tUs === job.anchorUs)
  if (ai < 0) return null
  const seq = order.slice(ai).filter((f) => f.tUs >= job.fromUs && f.tUs <= job.toUs)
  const full = templateBoxPx(job.anchorBox, W, H, scale)
  // conteúdo parado na janela inteira (pré/pós-rolagem de tela estática, o caso comum): a caixa da âncora já vale —
  // sem NCC. Movimento de uma linha de texto muda muitos pixels nas bordas dos glifos; o ruído do codificador, não.
  if (job.kind !== 'move') {
    const a = seq[0].img
    const x0 = Math.max(0, Math.floor(full.x - full.w / 2)), y0 = Math.max(0, Math.floor(full.y - full.h / 2))
    const x1 = Math.min(a.width, Math.ceil(full.x + full.w / 2)), y1 = Math.min(a.height, Math.ceil(full.y + full.h / 2))
    if (x1 > x0 && y1 > y0 && seq.every((f) => f.img.width === a.width && f.img.height === a.height && maxWindowChange(a.data, f.img.data, a.width, x0, y0, x1, y1) < CHANGE_MIN_PIXELS)) return { points: [] }
  }
  // molde: a caixa inteira, ou só o começo dela numa linha longa (a translação é a mesma; o custo do NCC cai muito)
  const tpl: TrackBox = full.w > REFINE_TPL_MAX_ASPECT * full.h ? { x: full.x - full.w / 2 + (REFINE_TPL_MAX_ASPECT * full.h) / 2, y: full.y, w: REFINE_TPL_MAX_ASPECT * full.h, h: full.h } : full
  const offX = tpl.x - full.x
  let step: { tracker: ReturnType<typeof startTracker>['tracker']; result: TrackResult }
  try {
    step = startTracker(seq[0].img, tpl, seq[0].tUs, REFINE_TRACK_OPTS)
  } catch {
    return null
  }
  const bw = job.anchorBox.w, bh = job.anchorBox.h
  const toNorm = (r: TrackResult): OcrBox => {
    const w = bw * r.scale, h = bh * r.scale
    const cx = r.x - offX * r.scale
    return { x: cx / scale / W - w / 2, y: r.y / scale / H - h / 2, w, h }
  }
  const points: OccurrenceSample[] = []
  let lastGood = job.anchorBox
  let lostAt: Us | undefined
  for (let k = 1; k < seq.length; k++) {
    step = trackNext(step.tracker, seq[k].img, seq[k].tUs)
    const r = step.result
    if (lostAt === undefined && r.state === 'ok') {
      lastGood = toNorm(r)
      points.push({ tUs: r.tUs, box: clampBox(lastGood), src: 'track' })
      continue
    }
    if (lostAt === undefined) lostAt = r.tUs
    // perda: segurada e ampliada pela cobertura (o centro pode estar em qualquer ponto do quadrado ±reach)
    const rx = r.reach / scale / W, ry = r.reach / scale / H
    let box = grow(lastGood, rx, ry)
    if (job.endBox) box = unionBox(box, job.endBox)
    points.push({ tUs: r.tUs, box: clampBox(box), src: 'lost' })
  }
  if (job.kind === 'move' && lostAt === undefined) {
    const end = points.find((p) => p.tUs === job.toUs)
    if (!end || !job.endBox) return null
    const ce = centre(end.box), cb = centre(job.endBox)
    const d = Math.hypot((ce.x - cb.x) * W, (ce.y - cb.y) * H)
    if (iou(end.box, job.endBox) < GROUP_MIN_IOU && d > MOVE_FRAC * job.endBox.h * H) return null
  }
  // o instante da âncora/fim do OCR já tem amostra: os do rastreio nesses instantes não entram
  const filtered = points.filter((p) => p.tUs !== job.anchorUs && !(job.kind === 'move' && p.tUs === job.toUs && p.src === 'track'))
  return lostAt === undefined ? { points: filtered } : { points: filtered, lostAt }
}

/** Mescla o resultado do refinamento na ocorrência (nova, imutável); amostras do OCR nunca são substituídas. */
export function applyRefinement(occ: Occurrence, res: RefineResult): Occurrence {
  const have = new Set(occ.samples.filter((s) => s.src !== 'track' && s.src !== 'lost').map((s) => s.tUs))
  const add = res.points.filter((p) => !have.has(p.tUs))
  const samples = [...occ.samples, ...add].sort((a, b) => a.tUs - b.tUs)
  const lostAt = res.lostAt !== undefined ? [...(occ.lostAt ?? []), res.lostAt].sort((a, b) => a - b) : occ.lostAt
  return { ...occ, samples, ...(lostAt ? { lostAt } : {}) }
}

/** Grade dos sub-quadros do refinamento: fromUs + k·REFINE_STEP_US ≤ toUs (como o fps=10 do ffmpeg a partir de fromUs). */
export function refineTimes(fromUs: Us, toUs: Us): Us[] {
  const out: Us[] = []
  for (let t = fromUs; t <= toUs; t += REFINE_STEP_US) out.push(t)
  return out
}
