import { describe, expect, it } from 'vitest'
import { CURSOR_MAX_DEVIATION_PX, CURSOR_VIDEO_LAG_MS, CursorTrackSchema, clicksBetween, cursorAt, dipToPhysical, hwndFromSourceId, normalizeContain, normalizeToFrame, parseCursorTrack, physicalDisplays, type CursorTrackV1, type DisplayGeometry } from './cursor'

const track = (over: Partial<CursorTrackV1> = {}): CursorTrackV1 => ({
  version: 1,
  width: 1920,
  height: 1080,
  samples: [
    { tMs: 0, x: 0.5, y: 0.5 },
    { tMs: 16, x: 0.51, y: 0.5 }
  ],
  clicks: [{ tMs: 10, x: 0.5, y: 0.5, button: 'left' }],
  ...over
})

describe('CursorTrackSchema / parseCursorTrack', () => {
  it('aceita a trilha v1 válida e devolve igual', () => {
    expect(parseCursorTrack(track())).toEqual(track())
    expect(CursorTrackSchema.safeParse(track()).success).toBe(true)
  })

  it('amostras fora do quadro (sem clamp) são válidas', () => {
    const t = track({ samples: [{ tMs: 0, x: -0.2, y: 1.4 }] })
    expect(parseCursorTrack(t)).toEqual(t)
  })

  it('devolve null (sem lançar) para entradas inválidas e outras versões', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      { ...track(), version: 2 },
      { ...track(), width: 0 },
      { ...track(), height: 10.5 },
      { ...track(), width: -1 },
      { ...track(), samples: [{ tMs: 1.5, x: 0, y: 0 }] },
      { ...track(), samples: [{ tMs: 0, x: Number.NaN, y: 0 }] },
      { ...track(), clicks: [{ tMs: 0, x: 0, y: 0, button: 'back' }] },
      { ...track(), samples: 'nope' }
    ]
    for (const b of bad) expect(parseCursorTrack(b)).toBeNull()
    // objeto que lança ao ser lido
    const evil = new Proxy({}, { get: () => { throw new Error('boom') } })
    expect(() => parseCursorTrack(evil)).not.toThrow()
    expect(parseCursorTrack(evil)).toBeNull()
  })

  it('rejeita tMs fora de ordem estrita nas amostras', () => {
    expect(parseCursorTrack(track({ samples: [{ tMs: 5, x: 0, y: 0 }, { tMs: 5, x: 1, y: 1 }] }))).toBeNull()
    expect(parseCursorTrack(track({ samples: [{ tMs: 6, x: 0, y: 0 }, { tMs: 5, x: 1, y: 1 }] }))).toBeNull()
  })
})

describe('normalizeToFrame', () => {
  it('normaliza ao retângulo do quadro, sem prender', () => {
    const f = { x: 100, y: 50, width: 800, height: 600 }
    expect(normalizeToFrame({ x: 100, y: 50 }, f)).toEqual({ x: 0, y: 0 })
    expect(normalizeToFrame({ x: 900, y: 650 }, f)).toEqual({ x: 1, y: 1 })
    expect(normalizeToFrame({ x: 500, y: 350 }, f)).toEqual({ x: 0.5, y: 0.5 })
    expect(normalizeToFrame({ x: 0, y: 0 }, f)).toEqual({ x: -0.125, y: -50 / 600 })
  })

  it('origem negativa (monitor à esquerda do principal)', () => {
    const f = { x: -2880, y: -200, width: 2880, height: 1620 }
    const n = normalizeToFrame({ x: -1440, y: 610 }, f)
    expect(n.x).toBeCloseTo(0.5, 12)
    expect(n.y).toBeCloseTo(0.5, 12)
  })

  it('quadro degenerado não produz NaN/Infinity', () => {
    const n = normalizeToFrame({ x: 5, y: 5 }, { x: 0, y: 0, width: 0, height: 0 })
    expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
  })
})

describe('DIP → físico com DPI misto', () => {
  // Principal 1920×1080 @1,0 em (0,0); direita 2560×1440 físicos @1,5 (1706,67×960 DIP) colado à direita;
  // esquerda 2880×1620 físicos @1,5 com origem física negativa (−2880, −200) → DIP (−1920, −133,33).
  const displays: DisplayGeometry[] = [
    { id: '1', dip: { x: 0, y: 0, width: 1920, height: 1080 }, phys: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: '2', dip: { x: 1920, y: 0, width: 2560 / 1.5, height: 960 }, phys: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 },
    { id: '3', dip: { x: -1920, y: -200 / 1.5, width: 1920, height: 1080 }, phys: { x: -2880, y: -200, width: 2880, height: 1620 }, scaleFactor: 1.5 }
  ]

  it('ponto no principal (1,0) fica igual', () => {
    expect(dipToPhysical({ x: 960, y: 540 }, displays)).toEqual({ x: 960, y: 540 })
  })

  it('ponto no monitor da direita (1,5) escala a partir da origem do monitor', () => {
    const p = dipToPhysical({ x: 1920 + 100, y: 200 }, displays)
    expect(p.x).toBeCloseTo(1920 + 150, 9)
    expect(p.y).toBeCloseTo(300, 9)
    // centro do monitor da direita → centro físico → normalizado 0,5/0,5 no quadro desse monitor
    const c = dipToPhysical({ x: 1920 + 2560 / 3, y: 480 }, displays)
    const n = normalizeToFrame(c, displays[1].phys)
    expect(n.x).toBeCloseTo(0.5, 9)
    expect(n.y).toBeCloseTo(0.5, 9)
  })

  it('ponto no monitor de origem negativa (1,5)', () => {
    const p = dipToPhysical({ x: -960, y: 540 - 200 / 1.5 }, displays)
    expect(p.x).toBeCloseTo(-2880 + 960 * 1.5, 9)
    expect(p.y).toBeCloseTo(-200 + 540 * 1.5, 9)
    const n = normalizeToFrame(p, displays[2].phys)
    expect(n.x).toBeCloseTo(0.5, 9)
    expect(n.y).toBeCloseTo(0.5, 9)
  })

  it('cursor gravado num monitor e visto no outro: coordenadas fora de 0–1, sem prender', () => {
    const p = dipToPhysical({ x: 1920 + 10, y: 10 }, displays)
    const n = normalizeToFrame(p, displays[0].phys)
    expect(n.x).toBeGreaterThan(1)
  })

  it('ponto fora de todos os monitores usa o mais próximo', () => {
    const p = dipToPhysical({ x: 1920 + 2560 / 1.5 + 10, y: 100 }, displays)
    expect(p.x).toBeCloseTo(1920 + 2560 + 15, 9)
    expect(p.y).toBeCloseTo(150, 9)
  })

  it('sem monitores devolve o ponto como está', () => {
    expect(dipToPhysical({ x: 3, y: 4 }, [])).toEqual({ x: 3, y: 4 })
  })

  it('physicalDisplays monta a tabela com o conversor de retângulos dado', () => {
    const t = physicalDisplays(
      [{ id: 7, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }],
      (r) => ({ x: r.x, y: r.y, width: r.width * 1.5, height: r.height * 1.5 })
    )
    expect(t).toEqual([{ id: '7', dip: { x: 1920, y: 0, width: 1280, height: 720 }, phys: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 }])
  })
})

describe('hwndFromSourceId', () => {
  it('extrai o HWND do id do desktopCapturer de janela', () => {
    expect(hwndFromSourceId('window:132456:0')).toBe(132456)
    expect(hwndFromSourceId('window:0:0')).toBeNull()
    expect(hwndFromSourceId('screen:0:0')).toBeNull()
    expect(hwndFromSourceId('window:abc:0')).toBeNull()
    expect(hwndFromSourceId('')).toBeNull()
  })
})

describe('normalizeContain (caixa do encoder no modo janela)', () => {
  const video = { width: 1280, height: 720 }
  it('mesma proporção do vídeo = normalizeToFrame', () => {
    const f = { x: 100, y: 50, width: 640, height: 360 }
    expect(normalizeContain({ x: 260, y: 140 }, f, video)).toEqual(normalizeToFrame({ x: 260, y: 140 }, f))
  })
  it('janela mais alta: barras laterais', () => {
    const f = { x: 0, y: 0, width: 360, height: 360 } // quadrada em 16:9 → ocupa 720/1280 = 0,5625 da largura
    const a = normalizeContain({ x: 0, y: 0 }, f, video)
    expect(a.x).toBeCloseTo(0.5 - 0.5625 / 2, 12)
    expect(a.y).toBe(0)
    const b = normalizeContain({ x: 360, y: 360 }, f, video)
    expect(b.x).toBeCloseTo(0.5 + 0.5625 / 2, 12)
    expect(b.y).toBe(1)
  })
  it('janela mais larga: barras em cima e embaixo; fora da janela continua fora', () => {
    const f = { x: 10, y: 10, width: 1280, height: 360 } // 32:9 em 16:9 → altura 0,5
    expect(normalizeContain({ x: 10 + 640, y: 10 }, f, video)).toEqual({ x: 0.5, y: 0.25 })
    expect(normalizeContain({ x: 10, y: 10 + 360 }, f, video)).toEqual({ x: 0, y: 0.75 })
    expect(normalizeContain({ x: 0, y: 10 }, f, video).x).toBeLessThan(0)
  })
  it('quadro vazio não gera NaN', () => {
    const n = normalizeContain({ x: 1, y: 1 }, { x: 0, y: 0, width: 0, height: 0 }, video)
    expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
  })
})

describe('cursorAt (posição no instante, O(log n))', () => {
  const tr = (samples: CursorTrackV1['samples'], clicks: CursorTrackV1['clicks'] = []): CursorTrackV1 => ({ version: 1, width: 1000, height: 500, samples, clicks })
  const lin = tr([
    { tMs: 100, x: 0.1, y: 0.2 },
    { tMs: 200, x: 0.3, y: 0.6 },
    { tMs: 400, x: 0.3, y: 0.6 }
  ])

  it('interpola linearmente entre amostras', () => {
    expect(cursorAt(lin, 100)).toEqual({ x: 0.1, y: 0.2 })
    const m = cursorAt(lin, 150)!
    expect(m.x).toBeCloseTo(0.2, 12)
    expect(m.y).toBeCloseTo(0.4, 12)
    expect(cursorAt(lin, 300)).toEqual({ x: 0.3, y: 0.6 })
    const f = cursorAt(lin, 125.5)! // tempo fracionário (cursorTimeMs não arredonda)
    expect(f.x).toBeCloseTo(0.1 + 0.2 * 0.255, 12)
  })

  it('antes da 1ª amostra: null; depois da última: fica na última; trilha vazia: null', () => {
    expect(cursorAt(lin, 99.9)).toBeNull()
    expect(cursorAt(lin, -80)).toBeNull()
    expect(cursorAt(lin, 10_000)).toEqual({ x: 0.3, y: 0.6 })
    expect(cursorAt(tr([]), 0)).toBeNull()
    expect(cursorAt(tr([{ tMs: 5, x: 0.4, y: 0.4 }]), 5)).toEqual({ x: 0.4, y: 0.4 })
  })

  it('suavização 0 (ou ausente) = posição bruta', () => {
    for (const t of [100, 133, 250, 399]) expect(cursorAt(lin, t, 0)).toEqual(cursorAt(lin, t))
  })

  it('suavização reduz o tremor sem se afastar mais que CURSOR_MAX_DEVIATION_PX da posição bruta (denso, com pico de 1 amostra)', () => {
    // trilha de 60 Hz: deriva lenta + tremor de ±3 px + um pico de 1 amostra de 60 px + um salto de 300 px
    let seed = 7
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const W = 1920, H = 1080
    const samples: CursorTrackV1['samples'] = []
    for (let i = 0; i < 600; i++) {
      const tMs = Math.round(i * 16.67)
      let px = 400 + i * 0.8 + (rnd() - 0.5) * 6
      let py = 300 + Math.sin(i / 20) * 40 + (rnd() - 0.5) * 6
      if (i === 200) { px += 60; py -= 60 } // pico
      if (i >= 400) px += 300 // salto
      samples.push({ tMs, x: px / W, y: py / H })
    }
    const track = { version: 1 as const, width: W, height: H, samples, clicks: [] }
    let maxDev = 0
    let roughRaw = 0, roughSmooth = 0
    let prevRaw: { x: number; y: number } | null = null, prevSm: { x: number; y: number } | null = null
    for (const s of [0.25, 0.5, 1]) {
      for (let t = 0; t <= samples[samples.length - 1].tMs + 50; t += 1000 / 240) {
        const raw = cursorAt(track, t)!
        const sm = cursorAt(track, t, s)!
        maxDev = Math.max(maxDev, Math.hypot((sm.x - raw.x) * W, (sm.y - raw.y) * H))
        if (s === 1 && t > 50 && t < 3000) {
          if (prevRaw && prevSm) {
            roughRaw += Math.hypot((raw.x - prevRaw.x) * W, (raw.y - prevRaw.y) * H)
            roughSmooth += Math.hypot((sm.x - prevSm.x) * W, (sm.y - prevSm.y) * H)
          }
          prevRaw = raw
          prevSm = sm
        }
      }
    }
    expect(maxDev).toBeLessThanOrEqual(CURSOR_MAX_DEVIATION_PX + 1e-9)
    expect(maxDev).toBeGreaterThan(1) // a suavização age de fato
    expect(roughSmooth).toBeLessThan(roughRaw * 0.9) // caminho percorrido menor = menos tremor
  })

  it('desempenho: 10 000 consultas aleatórias em 216 000 amostras (1 h a 60 Hz) < 20 ms', () => {
    const n = 216_000
    const samples: CursorTrackV1['samples'] = new Array(n)
    for (let i = 0; i < n; i++) samples[i] = { tMs: Math.round(i * 16.667), x: (i % 1000) / 1000, y: (i % 777) / 777 }
    const track = { version: 1 as const, width: 1920, height: 1080, samples, clicks: [] }
    const last = samples[n - 1].tMs
    const ts = Array.from({ length: 10_000 }, (_, i) => ((i * 7919) % 10_000) / 10_000 * last)
    for (let i = 0; i < 200; i++) cursorAt(track, ts[i], 0.5) // aquece o JIT
    // melhor de 5 rodadas: a suíte inteira roda em paralelo e uma rodada isolada pode pegar a CPU ocupada
    let ms = Infinity
    let acc = 0
    for (let round = 0; round < 5; round++) {
      const t0 = performance.now()
      for (const t of ts) acc += cursorAt(track, t, 0.5)!.x
      ms = Math.min(ms, performance.now() - t0)
    }
    expect(acc).toBeGreaterThan(0)
    expect(ms).toBeLessThan(20)
  })
})

describe('clicksBetween ([t0, t1), busca binária)', () => {
  const clicks: CursorTrackV1['clicks'] = [
    { tMs: 100, x: 0.1, y: 0.1, button: 'left' },
    { tMs: 200, x: 0.2, y: 0.2, button: 'right' },
    { tMs: 200, x: 0.25, y: 0.2, button: 'left' },
    { tMs: 300, x: 0.3, y: 0.3, button: 'middle' }
  ]
  const tr: CursorTrackV1 = { version: 1, width: 100, height: 100, samples: [], clicks }
  it('inclui t0 e exclui t1', () => {
    expect(clicksBetween(tr, 100, 200).map((c) => c.tMs)).toEqual([100])
    expect(clicksBetween(tr, 100, 200.0001).map((c) => c.x)).toEqual([0.1, 0.2, 0.25])
    expect(clicksBetween(tr, 200, 300).map((c) => c.button)).toEqual(['right', 'left'])
    expect(clicksBetween(tr, 0, 1e9)).toHaveLength(4)
    expect(clicksBetween(tr, 301, 400)).toEqual([])
    expect(clicksBetween(tr, 300, 300)).toEqual([])
    expect(clicksBetween(tr, 250, 150)).toEqual([])
  })
  it('cliques fora de ordem no arquivo ainda saem certos (ordenados por tempo)', () => {
    const t2: CursorTrackV1 = { ...tr, clicks: [clicks[3], clicks[0], clicks[1]] }
    expect(clicksBetween(t2, 0, 250).map((c) => c.tMs)).toEqual([100, 200])
  })
})

it('CURSOR_VIDEO_LAG_MS = 80 (ruling R11)', () => expect(CURSOR_VIDEO_LAG_MS).toBe(80))
