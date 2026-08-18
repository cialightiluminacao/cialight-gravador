import { describe, expect, it } from 'vitest'
import { FrameCursor, composeProgress, frameTimestamp, needsComposition, planFrames, shouldReportProgress, type TimedSample } from './composeMath'

// Sample fake: registra se foi fechado.
class FakeSample implements TimedSample {
  closed = false
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed = true
  }
}

async function* gen(samples: FakeSample[]): AsyncGenerator<FakeSample> {
  for (const s of samples) yield s
}

describe('planFrames', () => {
  it('gera grade CFR do corte com contagem arredondada', () => {
    const p = planFrames(1000, 9000, 30)
    expect(p.startSec).toBe(1)
    expect(p.endSec).toBe(9)
    expect(p.frameCount).toBe(240)
    expect(p.frameDuration).toBeCloseTo(1 / 30)
    expect(p.leadingHold).toBe(true)
  })
  it('sem corte inicial não precisa de frame segurado', () => {
    const p = planFrames(0, 2000, 60)
    expect(p.leadingHold).toBe(false)
    expect(p.frameCount).toBe(120)
  })
  it('defende-se de fim <= início e fps inválido', () => {
    const p = planFrames(5000, 5000, 0)
    expect(p.fps).toBe(30)
    expect(p.frameCount).toBe(1)
    expect(p.endSec).toBeGreaterThan(p.startSec)
  })
  it('frameTimestamp fica na linha do tempo original', () => {
    const p = planFrames(2000, 4000, 10)
    expect(frameTimestamp(p, 0)).toBe(2)
    expect(frameTimestamp(p, 5)).toBeCloseTo(2.5)
    expect(frameTimestamp(p, p.frameCount - 1)).toBeCloseTo(3.9)
  })
})

describe('FrameCursor', () => {
  it('devolve o último sample com timestamp <= t e repete em conteúdo estático', async () => {
    const s = [new FakeSample(0), new FakeSample(0.5), new FakeSample(2.0)]
    const c = new FrameCursor(gen(s))
    expect(await c.advanceTo(0)).toBe(s[0])
    expect(await c.advanceTo(0.4)).toBe(s[0])
    expect(await c.advanceTo(0.5)).toBe(s[1])
    expect(await c.advanceTo(1.9)).toBe(s[1]) // nenhum sample novo: mantém o anterior
    expect(await c.advanceTo(2.0)).toBe(s[2])
    expect(await c.advanceTo(99)).toBe(s[2]) // fim do iterador: mantém o último
    expect(s[0].closed).toBe(true)
    expect(s[1].closed).toBe(true)
    expect(s[2].closed).toBe(false)
    c.dispose()
    expect(s[2].closed).toBe(true)
  })
  it('antes do primeiro sample devolve null e não fecha o pendente', async () => {
    const s = [new FakeSample(1.0), new FakeSample(1.5)]
    const c = new FrameCursor(gen(s))
    expect(await c.advanceTo(0.2)).toBeNull()
    expect(s[0].closed).toBe(false)
    expect(await c.advanceTo(1.2)).toBe(s[0])
    c.dispose()
    expect(s[0].closed).toBe(true)
    expect(s[1].closed).toBe(true)
  })
  it('salta vários samples de uma vez fechando os intermediários', async () => {
    const s = [0, 0.1, 0.2, 0.3, 0.4].map((t) => new FakeSample(t))
    const c = new FrameCursor(gen(s))
    expect(await c.advanceTo(0.35)).toBe(s[3])
    expect(s.slice(0, 3).every((x) => x.closed)).toBe(true)
    expect(s[4].closed).toBe(false)
    c.dispose()
  })
  it('iterador vazio devolve null sempre', async () => {
    const c = new FrameCursor(gen([]))
    expect(await c.advanceTo(0)).toBeNull()
    expect(await c.advanceTo(10)).toBeNull()
    c.dispose()
  })
})

describe('progresso', () => {
  it('composeProgress em 0–100', () => {
    expect(composeProgress(0, 240)).toBe(0)
    expect(composeProgress(120, 240)).toBe(50)
    expect(composeProgress(240, 240)).toBe(100)
    expect(composeProgress(5, 0)).toBe(100)
  })
  it('shouldReportProgress a cada 15 frames e no último', () => {
    expect(shouldReportProgress(0, 100)).toBe(false)
    expect(shouldReportProgress(14, 100)).toBe(true)
    expect(shouldReportProgress(29, 100)).toBe(true)
    expect(shouldReportProgress(99, 100)).toBe(true)
    expect(shouldReportProgress(3, 4)).toBe(true)
  })
})

describe('needsComposition', () => {
  const withCam = { tracks: { screen: 0 as const, webcam: 1 as const }, strokes: [] }
  const withStrokes = { tracks: { screen: 0 as const }, strokes: [{ id: 'a', tMs: 0, tool: 'pen' as const, points: [], color: '#f00', width: 4 }] }
  it('compõe quando há webcam incluída num preset que re-encodifica', () => {
    expect(needsComposition(withCam, { presetId: 'high', includeWebcam: true, includeAnnotations: false })).toBe(true)
    expect(needsComposition(withCam, { presetId: 'high', includeWebcam: false, includeAnnotations: false })).toBe(false)
  })
  it('compõe quando há anotações incluídas', () => {
    expect(needsComposition(withStrokes, { presetId: 'small', includeWebcam: true, includeAnnotations: true })).toBe(true)
    expect(needsComposition(withStrokes, { presetId: 'small', includeWebcam: true, includeAnnotations: false })).toBe(false)
  })
  it('nunca compõe nos presets que copiam o vídeo', () => {
    expect(needsComposition(withCam, { presetId: 'cutOnly', includeWebcam: true, includeAnnotations: true })).toBe(false)
    expect(needsComposition(withStrokes, { presetId: 'separate', includeWebcam: true, includeAnnotations: true })).toBe(false)
  })
})
