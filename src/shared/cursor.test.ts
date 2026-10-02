import { describe, expect, it } from 'vitest'
import { CursorTrackSchema, dipToPhysical, hwndFromSourceId, normalizeContain, normalizeToFrame, parseCursorTrack, physicalDisplays, type CursorTrackV1, type DisplayGeometry } from './cursor'

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
