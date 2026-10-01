import { describe, expect, it } from 'vitest'
import type { AudioSegment } from '@shared/editor/audioPlan'
import { ChunkedPcm, limit, mixBlock, resampleLinear, SR, type PcmSource } from './mixer'

// Fonte sintética: senoide de `hz` com amplitude `amp` no tempo da fonte (os dois canais iguais).
function sine(hz: number, amp: number): PcmSource {
  return {
    read(srcFromUs, frames, speed, reverse) {
      const out = new Float32Array(frames * 2)
      const step = (reverse ? -speed : speed) / SR
      for (let i = 0; i < frames; i++) {
        const v = amp * Math.sin(2 * Math.PI * hz * (srcFromUs / 1e6 + i * step))
        out[i * 2] = v
        out[i * 2 + 1] = v
      }
      return out
    }
  }
}

function seg(over: Partial<AudioSegment> = {}): AudioSegment {
  const startUs = over.startUs ?? 0
  const durationUs = over.durationUs ?? 2_000_000
  return {
    itemId: 'i1', assetId: 'a1', startUs, durationUs, srcInUs: 0, speed: 1, reverse: false, preservePitch: true,
    gain: [{ tUs: startUs, gain: 1 }, { tUs: startUs + durationUs, gain: 1 }],
    ...over
  }
}

function rms(pcm: Float32Array, fromFrame: number, toFrame: number): number {
  let s = 0
  for (let i = fromFrame * 2; i < toFrame * 2; i++) s += pcm[i] * pcm[i]
  return Math.sqrt(s / ((toFrame - fromFrame) * 2))
}

const peak = (pcm: Float32Array): number => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

describe('mixBlock', () => {
  it('fadeIn de 1 s: RMS dos primeiros 100 ms < RMS de 900–1000 ms', () => {
    const s = seg({ gain: [{ tUs: 0, gain: 0 }, { tUs: 1_000_000, gain: 1 }, { tUs: 2_000_000, gain: 1 }] })
    const out = mixBlock([s], 0, SR, new Map([['a1', sine(1000, 0.5)]]))
    expect(out.length).toBe(SR * 2)
    const early = rms(out, 0, SR / 10)
    const late = rms(out, (SR * 9) / 10, SR)
    expect(early).toBeLessThan(late)
    expect(late).toBeGreaterThan(0.3) // ~0,5/√2 com ganho perto de 1
    expect(early).toBeLessThan(0.05)
  })

  it('dois segmentos de 0,8 somados → limitador: pico ≤ 1,0 e > 0,9', () => {
    const a = seg({ itemId: 'i1', assetId: 'a1' })
    const b = seg({ itemId: 'i2', assetId: 'a2' })
    const out = mixBlock([a, b], 0, 4800, new Map([['a1', sine(1000, 0.8)], ['a2', sine(1000, 0.8)]]))
    const p = peak(out)
    expect(p).toBeLessThanOrEqual(1)
    expect(p).toBeGreaterThan(0.9)
  })

  it('segmento fora do bloco → zeros', () => {
    const s = seg({ startUs: 5_000_000, durationUs: 1_000_000 })
    const out = mixBlock([s], 0, 4800, new Map([['a1', sine(1000, 0.5)]]))
    expect(peak(out)).toBe(0)
  })

  it('segmento começa no meio do bloco: zeros antes, sinal depois; lê a fonte a partir de srcInUs', () => {
    const reads: [number, number][] = []
    const src: PcmSource = {
      read(from, frames) {
        reads.push([from, frames])
        return new Float32Array(frames * 2).fill(0.25)
      }
    }
    const s = seg({ startUs: 50_000, durationUs: 30_000, srcInUs: 2_000_000 })
    const out = mixBlock([s], 0, 4800, new Map([['a1', src]]))
    expect(reads).toEqual([[2_000_000, 1440]]) // 30 ms a 48 kHz, a partir do frame 2400
    expect(out[2399 * 2]).toBe(0)
    expect(out[2400 * 2]).toBeCloseTo(0.25)
    expect(out[3839 * 2 + 1]).toBeCloseTo(0.25)
    expect(out[3840 * 2]).toBe(0)
  })

  it('bloco no meio do segmento: posição na fonte = srcIn + (t − start)·speed; reverso conta do fim', () => {
    const reads: [number, number, number, boolean][] = []
    const src: PcmSource = {
      read(from, frames, speed, reverse) {
        reads.push([from, frames, speed, reverse])
        return new Float32Array(frames * 2)
      }
    }
    mixBlock([seg({ startUs: 1_000_000, srcInUs: 500_000, speed: 2 })], 1_100_000, 4800, new Map([['a1', src]]))
    mixBlock([seg({ startUs: 1_000_000, durationUs: 2_000_000, srcInUs: 500_000, speed: 2, reverse: true })], 1_100_000, 4800, new Map([['a1', src]]))
    expect(reads).toEqual([
      [700_000, 4800, 2, false],
      [500_000 + (2_000_000 - 100_000) * 2, 4800, 2, true]
    ])
  })

  it('segmento sem fonte é ignorado', () => {
    expect(peak(mixBlock([seg()], 0, 480, new Map()))).toBe(0)
  })
})

describe('limit', () => {
  it('linear até 0,9; suave acima, nunca passa de 1', () => {
    expect(limit(0.5)).toBe(0.5)
    expect(limit(-0.9)).toBe(-0.9)
    expect(limit(0.95)).toBeCloseTo(0.9 + 0.1 * Math.tanh(0.5))
    expect(limit(-3)).toBeGreaterThanOrEqual(-1)
    expect(limit(3)).toBeLessThanOrEqual(1)
  })
})

describe('resampleLinear', () => {
  it('44,1 → 48 kHz de 441 amostras → 480 frames estéreo', () => {
    const out = resampleLinear(new Float32Array(441).fill(0.5), 44100, 1, 48000)
    expect(out.length).toBe(480 * 2)
  })

  it('mono duplica nos dois canais', () => {
    const inp = Float32Array.from({ length: 100 }, (_, i) => i / 100)
    const out = resampleLinear(inp, 48000, 1, 48000)
    for (let i = 0; i < 100; i++) {
      expect(out[i * 2]).toBeCloseTo(inp[i])
      expect(out[i * 2 + 1]).toBeCloseTo(inp[i])
    }
  })

  it('estéreo na mesma taxa é cópia; interpolação linear entre amostras', () => {
    const st = Float32Array.from([0, 1, 1, 0, 0, 1])
    expect([...resampleLinear(st, 48000, 2, 48000)]).toEqual([0, 1, 1, 0, 0, 1])
    const up = resampleLinear(Float32Array.from([0, 1]), 24000, 1, 48000) // 2 → 4 frames
    expect(up[2]).toBeCloseTo(0.5) // meio caminho entre 0 e 1
  })

  it('>2 canais: L = média dos pares, R = média dos ímpares', () => {
    const quad = Float32Array.from([0.2, 0.4, 0.6, 0.8]) // 1 frame, 4 canais
    const out = resampleLinear(quad, 48000, 4, 48000)
    expect(out[0]).toBeCloseTo(0.4)
    expect(out[1]).toBeCloseTo(0.6)
  })
})

describe('ChunkedPcm', () => {
  // rampa: valor = índice absoluto do frame / 1e6 (canal L) e negativo (canal R)
  function ramp(k: number): Float32Array {
    const c = new Float32Array(SR * 2)
    for (let i = 0; i < SR; i++) {
      c[i * 2] = (k * SR + i) / 1e6
      c[i * 2 + 1] = -(k * SR + i) / 1e6
    }
    return c
  }

  it('lê através da fronteira entre chunks; fora do cache → zeros', () => {
    const pcm = new ChunkedPcm(30)
    pcm.put(0, ramp(0))
    pcm.put(1, ramp(1))
    const out = pcm.read(Math.round(((SR - 2) * 1e6) / SR), 4, 1, false)
    expect([...out].map((v) => Math.round(v * 1e6))).toEqual([SR - 2, -(SR - 2), SR - 1, -(SR - 1), SR, -SR, SR + 1, -(SR + 1)])
    expect(peak(pcm.read(5_000_000, 10, 1, false))).toBe(0)
  })

  it('speed 2 pula frames; reverso anda para trás', () => {
    const pcm = new ChunkedPcm(30)
    pcm.put(0, ramp(0))
    const fwd = pcm.read(Math.round((100 * 1e6) / SR), 3, 2, false)
    expect([fwd[0], fwd[2], fwd[4]].map((v) => Math.round(v * 1e6))).toEqual([100, 102, 104])
    const rev = pcm.read(Math.round((100 * 1e6) / SR), 3, 1, true)
    expect([rev[0], rev[2], rev[4]].map((v) => Math.round(v * 1e6))).toEqual([100, 99, 98])
  })

  it('chunk de silêncio (null) e LRU com limite de chunks', () => {
    const pcm = new ChunkedPcm(2)
    pcm.put(0, null)
    expect(pcm.has(0)).toBe(true)
    expect(peak(pcm.read(0, 10, 1, false))).toBe(0)
    pcm.put(1, ramp(1))
    pcm.touch(0) // 0 fica mais recente que 1
    pcm.put(2, ramp(2))
    expect(pcm.has(1)).toBe(false)
    expect(pcm.has(0)).toBe(true)
    expect(pcm.has(2)).toBe(true)
  })

  it('chunks necessários para uma leitura (inclui vizinho da interpolação; reverso para trás)', () => {
    expect(ChunkedPcm.chunksFor(900_000, SR / 5, 1, false)).toEqual([0, 1])
    expect(ChunkedPcm.chunksFor(100_000, SR / 10, 1, true)).toEqual([0])
    expect(ChunkedPcm.chunksFor(-10_000, 600, 1, false)).toEqual([-1, 0])
    expect(ChunkedPcm.chunksFor(-10_000, 100, 1, false)).toEqual([-1])
  })
})
