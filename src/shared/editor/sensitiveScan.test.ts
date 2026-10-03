import { describe, expect, it } from 'vitest'
import type { Detection, OcrBox } from './sensitive'
import {
  applyRefinement,
  boxContains,
  CHANGE_MIN_PIXELS,
  frameChanged,
  groupOccurrences,
  helperLinesToOcr,
  iou,
  occurrenceKeys,
  occurrenceRegionAt,
  refinementJobs,
  refineScale,
  refineTimes,
  refineTrack,
  SAMPLE_INTERVAL_US,
  tilePlan,
  type Occurrence,
  type ScanSample
} from './sensitiveScan'
import type { GrayImage } from './track'

const W = 1920
const H = 1080
const ctx = { fromUs: 0, toUs: 8_000_000, sourceW: W, sourceH: H }

/** Caixa em px do quadro → normalizada. */
const px = (x: number, y: number, w: number, h: number): OcrBox => ({ x: x / W, y: y / H, w: w / W, h: h / H })
const det = (box: OcrBox, value = 'v1', kind: Detection['kind'] = 'cpf', confidence: Detection['confidence'] = 'validated'): Detection => ({ kind, value, masked: '***.***.***-**', box, confidence })
const times = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i * SAMPLE_INTERVAL_US)

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('frameChanged', () => {
  const w = 64, h = 32
  const base = new Uint8Array(w * h).fill(200)
  it('quadro igual ou com ruído fraco do codificador não mudou', () => {
    expect(frameChanged(base, base.slice(), w, h)).toBe(false)
    const r = rng(1)
    const noisy = base.map((v) => v + Math.round((r() - 0.5) * 60))
    expect(frameChanged(base, noisy, w, h)).toBe(false)
  })
  it('poucos pixels com diferença forte já contam (texto trocado)', () => {
    const a = base.slice()
    for (let i = 0; i < CHANGE_MIN_PIXELS - 1; i++) a[i * 7] = 20
    expect(frameChanged(base, a, w, h)).toBe(false)
    a[500] = 20
    expect(frameChanged(base, a, w, h)).toBe(true)
  })
  it('tamanho diferente = mudou', () => {
    expect(frameChanged(base, new Uint8Array(w * h * 2), w, h)).toBe(true)
  })
})

describe('tilePlan / helperLinesToOcr', () => {
  it('quadro que cabe = um ladrilho', () => {
    expect(tilePlan(3840, 2160, 10000, 200)).toEqual([{ x: 0, y: 0, w: 3840, h: 2160, coreX0: 0, coreY0: 0, coreX1: 3840, coreY1: 2160 }])
  })
  it('quadro maior: ladrilhos ≤ maxDim com sobreposição e núcleos que particionam o quadro', () => {
    const t = tilePlan(12000, 3000, 5000, 200)
    expect(t.length).toBe(3)
    for (const x of t) expect(x.w).toBeLessThanOrEqual(5000)
    expect(t[0].x).toBe(0)
    expect(t[t.length - 1].x + t[t.length - 1].w).toBe(12000)
    for (let i = 1; i < t.length; i++) {
      expect(t[i].x).toBeLessThan(t[i - 1].x + t[i - 1].w - 199) // sobreposição ≥ 200
      expect(t[i].coreX0).toBe(t[i - 1].coreX1)
      expect(t[i].coreX0).toBeGreaterThan(t[i].x)
      expect(t[i - 1].coreX1).toBeLessThan(t[i - 1].x + t[i - 1].w)
    }
    expect(t[0].coreX0).toBe(0)
    expect(t[t.length - 1].coreX1).toBe(12000)
  })
  it('normaliza pelo tamanho da imagem recebida (desfaz a ampliação) e respeita o núcleo do ladrilho', () => {
    const lines = [{ t: 'CPF 1', w: [['CPF', 100, 40, 60, 20], ['1', 170, 40, 10, 20]] as [string, number, number, number, number][] }]
    const out = helperLinesToOcr(lines, 3840, 2160)
    expect(out).toHaveLength(1)
    expect(out[0].words[0].box.x).toBeCloseTo(100 / 3840)
    expect(out[0].words[0].box.h).toBeCloseTo(20 / 2160)
    const tiles = tilePlan(12000, 3000, 5000, 400)
    // linha com centro fora do núcleo do 2º ladrilho é descartada lá (fica no 1º)
    const t1 = tiles[1]
    const local = [{ t: 'x', w: [['x', 2, 10, 20, 10]] as [string, number, number, number, number][] }]
    expect(helperLinesToOcr(local, 12000, 3000, t1)).toHaveLength(t1.coreX0 > t1.x + 12 ? 0 : 1)
    expect(helperLinesToOcr([{ t: 'x', w: [] }, { t: 'y', w: [['y', NaN, 0, 1, 1]] as [string, number, number, number, number][] }], 10, 10)).toHaveLength(0)
  })
})

describe('groupOccurrences', () => {
  it('mesmo valor em amostras seguidas = uma ocorrência, sem o valor na saída, intervalo conservador limitado', () => {
    const b = px(100, 100, 150, 14)
    const samples: ScanSample[] = times(6).map((tUs) => ({ tUs, detections: [det(b, '52998224725')] }))
    const occ = groupOccurrences(samples, ctx)
    expect(occ).toHaveLength(1)
    expect(occ[0].firstSeenUs).toBe(0)
    expect(occ[0].lastSeenUs).toBe(2_500_000)
    expect(occ[0].startUs).toBe(0) // limitado a fromUs
    expect(occ[0].endUs).toBe(3_000_000)
    expect(JSON.stringify(occ)).not.toContain('52998224725')
    expect(Object.keys(occ[0])).not.toContain('value')
  })
  it('valor lido diferente com IoU ≥ 0,3 continua a ocorrência', () => {
    const samples: ScanSample[] = [
      { tUs: 1_000_000, detections: [det(px(100, 100, 150, 14), 'a')] },
      { tUs: 1_500_000, detections: [det(px(102, 100, 148, 14), 'b')] }
    ]
    const occ = groupOccurrences(samples, ctx)
    expect(occ).toHaveLength(1)
    expect(occ[0].startUs).toBe(500_000)
  })
  it('uma falha do OCR vira ponte (união das vizinhas); duas encerram', () => {
    const a = px(100, 100, 150, 14), b = px(100, 130, 150, 14)
    const s1: ScanSample[] = [
      { tUs: 0, detections: [det(a)] },
      { tUs: 500_000, detections: [] },
      { tUs: 1_000_000, detections: [det(b)] }
    ]
    const o1 = groupOccurrences(s1, ctx)
    expect(o1).toHaveLength(1)
    expect(o1[0].samples.map((s) => s.src)).toEqual(['ocr', 'bridge', 'ocr'])
    expect(boxContains(o1[0].samples[1].box, a) && boxContains(o1[0].samples[1].box, b)).toBe(true)
    const s2: ScanSample[] = [{ tUs: 0, detections: [det(a)] }, { tUs: 500_000, detections: [] }, { tUs: 1_000_000, detections: [] }, { tUs: 1_500_000, detections: [det(a)] }]
    expect(groupOccurrences(s2, ctx)).toHaveLength(2)
  })
  it('rolagem (IoU 0 entre amostras) continua pelo valor; duas cópias do mesmo valor não se cruzam', () => {
    const samples: ScanSample[] = times(5).map((tUs, i) => ({
      tUs,
      detections: [det(px(100, 600 - 60 * i, 150, 14), 'x'), det(px(900, 300 - 60 * i, 150, 14), 'x')]
    }))
    const occ = groupOccurrences(samples, ctx)
    expect(occ).toHaveLength(2)
    for (const o of occ) {
      const xs = new Set(o.samples.map((s) => Math.round(s.box.x * W)))
      expect(xs.size).toBe(1)
    }
  })
  it('tipos diferentes nunca se juntam; confiança sobe para validated', () => {
    const b = px(100, 100, 150, 14)
    const samples: ScanSample[] = [
      { tUs: 0, detections: [det(b, 'v', 'cpf', 'pattern'), det(b, 'v', 'phone', 'pattern')] },
      { tUs: 500_000, detections: [{ ...det(b, 'v', 'cpf', 'validated'), masked: 'M2' }] }
    ]
    const occ = groupOccurrences(samples, ctx)
    expect(occ).toHaveLength(2)
    const cpf = occ.find((o) => o.kind === 'cpf')!
    expect(cpf.confidence).toBe('validated')
    expect(cpf.masked).toBe('M2')
  })
})

/** Ocorrência sintética com caixas andando aleatoriamente (algumas paradas, algumas com saltos). */
function randomOcc(seed: number): Occurrence {
  const r = rng(seed)
  const n = 1 + Math.floor(r() * 8)
  const t0 = SAMPLE_INTERVAL_US * (1 + Math.floor(r() * 4))
  let x = 50 + r() * 1500, y = 50 + r() * 900
  const h = 10 + r() * 20, w = 60 + r() * 400
  const samples: ScanSample[] = []
  for (let i = 0; i < n; i++) {
    samples.push({ tUs: t0 + i * SAMPLE_INTERVAL_US, detections: [det(px(x, y, w, h), 'same')] })
    if (r() < 0.6) { x += (r() - 0.5) * 200; y += (r() - 0.5) * 200 }
    x = Math.max(0, Math.min(W - w, x)); y = Math.max(0, Math.min(H - h, y))
  }
  const occ = groupOccurrences(samples, { ...ctx, toUs: t0 + n * SAMPLE_INTERVAL_US + 300_000 })
  expect(occ).toHaveLength(1)
  return occ[0]
}

describe('occurrenceKeys / occurrenceRegionAt (oráculo denso, 1/240 s)', () => {
  it('em todo instante de [firstSeen, lastSeen] a região contém as caixas das amostras vizinhas, com margem ≥ 2 px', () => {
    const step = Math.round(1_000_000 / 240)
    // falhas acumuladas (um expect por instante deixaria o teste lento sob a suíte paralela)
    const fails: string[] = []
    let checked = 0
    for (let seed = 1; seed <= 60; seed++) {
      const occ = randomOcc(seed)
      const s = occ.samples
      for (let t = occ.startUs - 2 * step; t <= occ.endUs + 2 * step; t += step) {
        const reg = occurrenceRegionAt(occ, t)
        if (t < occ.startUs || t > occ.endUs) {
          if (reg !== null) fails.push(`${seed}@${t}: região fora de [start, end]`)
          continue
        }
        if (!reg) { fails.push(`${seed}@${t}: sem região`); continue }
        let i = s.findIndex((x, k) => x.tUs <= t && (k === s.length - 1 || s[k + 1].tUs > t))
        if (i < 0) i = 0 // pré-rolagem: a 1ª caixa
        const adj = [s[i].box, ...(s[i + 1] && t >= s[i].tUs ? [s[i + 1].box] : [])]
        for (const b of adj) {
          checked++
          if (!boxContains(reg, b)) fails.push(`${seed}@${t}: não contém`)
          // margem: ≥ 2 px de cada lado (exceto onde a borda do quadro limita)
          if (b.x * W >= 2 && (b.x - reg.x) * W < 2 - 1e-6) fails.push(`${seed}@${t}: margem esquerda`)
          if ((b.y + b.h) * H <= H - 2 && (reg.y + reg.h - b.y - b.h) * H < 2 - 1e-6) fails.push(`${seed}@${t}: margem de baixo`)
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000)
    expect(fails.slice(0, 5)).toEqual([])
  })
  it('keys: pré-rolagem com a 1ª caixa, depois um key por amostra; o último vale até endUs inclusive', () => {
    const occ = randomOcc(7)
    const keys = occurrenceKeys(occ)
    expect(keys[0].tUs).toBe(occ.startUs)
    expect(keys.length).toBe(occ.samples.length + (occ.startUs < occ.samples[0].tUs ? 1 : 0))
    expect(occurrenceRegionAt(occ, occ.endUs)).toEqual(keys[keys.length - 1].box)
    for (let i = 1; i < keys.length; i++) expect(keys[i].tUs).toBeGreaterThan(keys[i - 1].tUs)
    for (const k of keys) {
      expect(Number.isInteger(k.tUs)).toBe(true)
      expect(k.box.x).toBeGreaterThanOrEqual(0)
      expect(k.box.x + k.box.w).toBeLessThanOrEqual(1 + 1e-12)
    }
  })
  it('margem proporcional: 0,15 × altura quando passa de 2 px', () => {
    const b = px(500, 500, 300, 40)
    const [o] = groupOccurrences([{ tUs: 0, detections: [det(b)] }], ctx)
    const reg = occurrenceRegionAt(o, 0)!
    expect((b.x - reg.x) * W).toBeCloseTo(6, 6)
    expect((b.y - reg.y) * H).toBeCloseTo(6, 6)
  })
})

// ---------------------------------------------------------------- refinamento com imagens sintéticas

const AW = 480, AH = 270 // origem pequena: a análise fica na escala 1

/** "Texto" texturizado (blocos 2×2 aleatórios escuros) num retângulo sobre fundo claro. */
function scene(boxPx: { x: number; y: number; w: number; h: number } | null, seed = 3): GrayImage {
  const data = new Float32Array(AW * AH).fill(235)
  if (boxPx) {
    const r = rng(seed)
    const cells: number[] = []
    for (let i = 0; i < Math.ceil(boxPx.w / 2) * Math.ceil(boxPx.h / 2); i++) cells.push(r() < 0.45 ? 30 : 235)
    const cw = Math.ceil(boxPx.w / 2)
    for (let y = 0; y < boxPx.h; y++) for (let x = 0; x < boxPx.w; x++) {
      const X = Math.round(boxPx.x) + x, Y = Math.round(boxPx.y) + y
      if (X >= 0 && X < AW && Y >= 0 && Y < AH) data[Y * AW + X] = cells[(y >> 1) * cw + (x >> 1)]
    }
  }
  return { width: AW, height: AH, data }
}
const nb = (b: { x: number; y: number; w: number; h: number }): OcrBox => ({ x: b.x / AW, y: b.y / AH, w: b.w / AW, h: b.h / AH })

describe('refinamento (NCC)', () => {
  it('refinementJobs: pré/pós-rolagem e intervalos com movimento > 0,5 × altura', () => {
    const samples: ScanSample[] = [
      { tUs: 1_000_000, detections: [det(px(100, 100, 150, 14), 'v')] },
      { tUs: 1_500_000, detections: [det(px(100, 103, 150, 14), 'v')] }, // 3 px: parado
      { tUs: 2_000_000, detections: [det(px(100, 160, 150, 14), 'v')] } // 57 px: movimento
    ]
    const [o] = groupOccurrences(samples, ctx)
    const jobs = refinementJobs(o)
    expect(jobs.map((j) => j.kind)).toEqual(['pre', 'move', 'post'])
    expect(jobs[0]).toMatchObject({ fromUs: 500_000, toUs: 1_000_000, dir: 'backward', anchorUs: 1_000_000 })
    expect(jobs[1]).toMatchObject({ fromUs: 1_500_000, toUs: 2_000_000, dir: 'forward' })
    expect(jobs[2]).toMatchObject({ fromUs: 2_000_000, toUs: 2_500_000 })
  })
  it('refineScale sobe a análise até o molde ter 16 px (máx. a escala da origem)', () => {
    expect(refineScale(1920, 1080, [px(0, 0, 400, 100)])).toBeCloseTo(0.25)
    const s = refineScale(1920, 1080, [px(0, 0, 150, 14)])
    expect(s).toBeGreaterThan(0.25)
    expect(s).toBeLessThanOrEqual(1)
    expect(refineScale(1920, 1080, [px(0, 0, 4, 2)])).toBe(1)
  })
  it('movimento rastreado: amostras confiantes no caminho real e a região as contém', () => {
    const t0 = 1_000_000, t1 = 1_500_000
    const at = (t: number): { x: number; y: number; w: number; h: number } => ({ x: 100 + ((t - t0) / 100_000) * 4, y: 120 - ((t - t0) / 100_000) * 6, w: 70, h: 14 })
    const frames = refineTimes(t0, t1).map((tUs) => ({ tUs, img: scene(at(tUs)) }))
    const samples: ScanSample[] = [{ tUs: t0, detections: [det(nb(at(t0)), 'v')] }, { tUs: t1, detections: [det(nb(at(t1)), 'v')] }]
    const [o] = groupOccurrences(samples, { fromUs: t0, toUs: t1, sourceW: AW, sourceH: AH })
    const job = refinementJobs(o).find((j) => j.kind === 'move')!
    expect(job).toBeTruthy()
    const res = refineTrack(frames, job, AW, AH)!
    expect(res).not.toBeNull()
    expect(res.lostAt).toBeUndefined()
    expect(res.points.map((p) => p.tUs)).toEqual([1_100_000, 1_200_000, 1_300_000, 1_400_000])
    for (const p of res.points) {
      const truth = nb(at(p.tUs))
      expect(iou(p.box, truth)).toBeGreaterThan(0.8)
    }
    const ref = applyRefinement(o, res)
    expect(ref.samples).toHaveLength(6)
    const step = Math.round(1_000_000 / 240)
    for (let t = t0; t <= t1; t += step) {
      const reg = occurrenceRegionAt(ref, t)!
      // a verdade em t: posição linear entre os sub-quadros vizinhos — contida
      expect(boxContains(reg, nb(at(Math.floor(t / 100_000) * 100_000)))).toBe(true)
      for (const s of ref.samples) if (Math.abs(s.tUs - t) < 100_000 && s.tUs <= t) expect(boxContains(reg, s.box)).toBe(true)
    }
  })
  it('perda: a última caixa boa fica segurada e cresce (nunca encolhe) até o fim do intervalo', () => {
    const t0 = 2_000_000, t1 = 2_500_000
    const b = { x: 200, y: 100, w: 70, h: 14 }
    // conteúdo some em 2,3 s (pós-rolagem)
    const frames = refineTimes(t0, t1).map((tUs) => ({ tUs, img: scene(tUs < 2_300_000 ? b : null) }))
    const [o] = groupOccurrences([{ tUs: t0, detections: [det(nb(b))] }], { fromUs: 0, toUs: t1, sourceW: AW, sourceH: AH })
    const job = refinementJobs(o).find((j) => j.kind === 'post')!
    const res = refineTrack(frames, job, AW, AH)!
    expect(res.lostAt).toBe(2_300_000)
    const lost = res.points.filter((p) => p.src === 'lost')
    expect(lost.map((p) => p.tUs)).toEqual([2_300_000, 2_400_000, 2_500_000])
    let prev: OcrBox = nb(b)
    for (const p of res.points) {
      expect(boxContains(p.box, prev) || p.src === 'track').toBe(true)
      if (p.src === 'lost') prev = p.box
    }
    const ref = applyRefinement(o, res)
    expect(ref.lostAt).toEqual([2_300_000])
    expect(boxContains(occurrenceRegionAt(ref, t1)!, nb(b))).toBe(true)
  })
  it('pré-rolagem para trás; molde liso não é refinável', () => {
    const t0 = 500_000, t1 = 1_000_000
    const b = { x: 50, y: 50, w: 70, h: 14 }
    const frames = refineTimes(t0, t1).map((tUs) => ({ tUs, img: scene(b) }))
    const [o] = groupOccurrences([{ tUs: t1, detections: [det(nb(b))] }], { fromUs: 0, toUs: t1, sourceW: AW, sourceH: AH })
    const job = refinementJobs(o).find((j) => j.kind === 'pre')!
    const res = refineTrack(frames, job, AW, AH)!
    expect(res.points.map((p) => p.tUs)).toEqual([900_000, 800_000, 700_000, 600_000, 500_000])
    expect(res.points.every((p) => p.src === 'track')).toBe(true)
    const flat = refineTimes(t0, t1).map((tUs) => ({ tUs, img: scene(null) }))
    expect(refineTrack(flat, job, AW, AH)).toBeNull()
  })
  it('movimento que chega longe da caixa do OCR do fim é rejeitado (fica a regra conservadora)', () => {
    const t0 = 1_000_000, t1 = 1_500_000
    const b = { x: 100, y: 100, w: 70, h: 14 }
    const frames = refineTimes(t0, t1).map((tUs) => ({ tUs, img: scene(b) }))
    const [o] = groupOccurrences([
      { tUs: t0, detections: [det(nb(b), 'v')] },
      { tUs: t1, detections: [det(nb({ ...b, y: 200 }), 'v')] }
    ], { fromUs: t0, toUs: t1, sourceW: AW, sourceH: AH })
    const job = refinementJobs(o).find((j) => j.kind === 'move')!
    expect(refineTrack(frames, job, AW, AH)).toBeNull()
  })
})
