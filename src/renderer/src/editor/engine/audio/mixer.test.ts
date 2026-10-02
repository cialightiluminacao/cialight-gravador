import { describe, expect, it } from 'vitest'
import type { AudioSegment } from '@shared/editor/audioPlan'
import { ChunkedPcm, limit, mixBlock, resampleLinear, SR, StretchBank, type PcmSource } from './mixer'
import type { Stretcher } from './stretch'

// Fonte sintética: senoide de `hz` com amplitude `amp` no tempo da fonte (os dois canais iguais).
function sine(hz: number, amp: number): PcmSource {
  return {
    readStretched(_key, srcFromUs, frames, speed) {
      return this.read(srcFromUs, frames, speed, false)
    },
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
  const assetId = over.assetId ?? 'a1'
  return {
    itemId: 'i1', assetId, sourceKey: assetId, processKey: null, startUs, durationUs, srcInUs: 0, speed: 1, reverse: false, preservePitch: true, keepFastAudio: false, mode: 'copy',
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

  it('lê a fonte do segmento (sourceKey): versão processada quando pronta, original senão', () => {
    const processed = seg({ sourceKey: 'a1~dn-sh', processKey: 'dn-sh' })
    const sources = new Map([['a1', sine(1000, 0.8)], ['a1~dn-sh', sine(1000, 0.2)]])
    expect(peak(mixBlock([processed], 0, 4800, sources))).toBeCloseTo(0.2, 2)
    expect(peak(mixBlock([seg()], 0, 4800, sources))).toBeCloseTo(0.8, 2)
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
      },
      readStretched: () => new Float32Array(0)
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
      },
      readStretched: () => new Float32Array(0)
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

describe('mixBlock + StretchBank (fake determinístico)', () => {
  // fonte rampa: valor = índice absoluto do frame / 1e6 (identifica a posição de fonte entregue ao stretcher)
  function rampSource(bank: StretchBank, seconds: number): ChunkedPcm {
    const pcm = new ChunkedPcm(64, bank)
    for (let k = 0; k < seconds; k++) {
      const c = new Float32Array(SR * 2)
      for (let i = 0; i < SR; i++) c[i * 2] = c[i * 2 + 1] = (k * SR + i) / 1e6
      pcm.put(k, c)
    }
    return pcm
  }
  const pos = (input: Float32Array, frame: number): number => Math.round(input[frame * 2] * 1e6)
  type Call = { op: 'reset' } | { op: 'seek'; from: number; to: number; rate: number } | { op: 'process'; from: number; to: number; out: number }

  /** Stretcher falso: latências 30/20 frames; registra o que recebe; saída = entrada reamostrada (vizinho). */
  function fake(calls: Call[]): Stretcher {
    return {
      inputLatency: 30,
      outputLatency: 20,
      latencyFrames: 50,
      reset: () => calls.push({ op: 'reset' }),
      seek: (input, rate) => calls.push({ op: 'seek', from: pos(input, 0), to: pos(input, input.length / 2 - 1) + 1, rate }),
      process(input, outFrames) {
        const n = input.length / 2
        calls.push({ op: 'process', from: n ? pos(input, 0) : NaN, to: n ? pos(input, n - 1) + 1 : NaN, out: outFrames })
        const out = new Float32Array(outFrames * 2)
        for (let j = 0; j < outFrames; j++) out[j * 2] = out[j * 2 + 1] = n ? input[Math.min(n - 1, Math.floor((j * n) / outFrames)) * 2] : 0
        return out
      }
    }
  }

  function setup(maxLive = 16): { calls: Call[]; created: number[]; bank: StretchBank; srcs: Map<string, PcmSource> } {
    const calls: Call[] = []
    const created: number[] = []
    const bank = new StretchBank(async (rate) => {
      created.push(rate)
      return fake(calls)
    }, maxLive)
    return { calls, created, bank, srcs: new Map([['a1', rampSource(bank, 20)]]) }
  }
  const stretchSeg = (over: Partial<AudioSegment> = {}): AudioSegment => seg({ durationUs: 5_000_000, srcInUs: 2_000_000, speed: 2, mode: 'stretch', ...over })
  const BASE = 2 * SR // srcIn 2 s
  const LEAD = 20 * 2 + 30 // outputLatency·speed + inputLatency

  it('blocos consecutivos: um só reset; entrada contínua (sem lacuna nem sobreposição), adiantada pela latência', async () => {
    const { calls, bank, srcs } = setup()
    const s = stretchSeg()
    await bank.ensure('i1', 2)
    for (let b = 0; b < 3; b++) mixBlock([s], b * 100_000, 4800, srcs)
    expect(calls.filter((c) => c.op === 'reset')).toHaveLength(1)
    // pré-roll: histórico de latencyFrames até base + inputLatency; descarte de outputLatency frames de saída
    expect(calls[1]).toEqual({ op: 'seek', from: BASE + 30 - 50, to: BASE + 30, rate: 2 })
    expect(calls[2]).toEqual({ op: 'process', from: BASE + 30, to: BASE + LEAD, out: 20 })
    const blocks = calls.slice(3) as Extract<Call, { op: 'process' }>[]
    expect(blocks.map((c) => c.out)).toEqual([4800, 4800, 4800])
    expect(blocks[0].from).toBe(BASE + LEAD)
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].from).toBe(blocks[i - 1].to)
    expect(blocks[2].to).toBe(BASE + LEAD + 3 * 4800 * 2)
  })

  it('seek (bloco fora de sequência) → reset + pré-roll no novo ponto; mudança de velocidade também', async () => {
    const { calls, bank, srcs } = setup()
    await bank.ensure('i1', 2)
    mixBlock([stretchSeg()], 0, 4800, srcs)
    mixBlock([stretchSeg()], 1_000_000, 4800, srcs) // salto: fonte 2 s + 1 s·2 = 4 s
    const resets = calls.flatMap((c, i) => (c.op === 'reset' ? [i] : []))
    expect(resets).toHaveLength(2)
    expect(calls[resets[1] + 1]).toEqual({ op: 'seek', from: 4 * SR + 30 - 50, to: 4 * SR + 30, rate: 2 })
    mixBlock([stretchSeg({ speed: 1.5 })], 1_100_000, 4800, srcs)
    expect(calls.filter((c) => c.op === 'reset')).toHaveLength(3)
  })

  it('o bloco seguinte continua de onde o anterior parou (fake sem atraso: 1º frame = fonte do bloco + lead)', async () => {
    const { bank, srcs } = setup()
    await bank.ensure('i1', 2)
    mixBlock([stretchSeg()], 0, 4800, srcs)
    const out = mixBlock([stretchSeg()], 100_000, 4800, srcs)
    expect(Math.round(out[0] * 1e6)).toBe(BASE + 4800 * 2 + LEAD)
  })

  it('sem stretcher para o segmento (ensure não chamado) → reamostra (tom muda) em vez de silenciar', () => {
    const { calls, srcs } = setup()
    const out = mixBlock([stretchSeg()], 0, 3, srcs)
    expect([out[0], out[2], out[4]].map((v) => Math.round(v * 1e6))).toEqual([BASE, BASE + 2, BASE + 4])
    expect(calls).toEqual([])
  })

  it('modo mute não lê a fonte e sai em silêncio', async () => {
    const { calls, bank, srcs } = setup()
    await bank.ensure('i1', 8)
    expect(peak(mixBlock([stretchSeg({ speed: 8, mode: 'mute' })], 0, 4800, srcs))).toBe(0)
    expect(calls).toEqual([])
  })

  it('span cobre tudo o que a leitura pede à fonte (pré-roll e avanço)', async () => {
    const { calls, bank, srcs } = setup()
    expect(bank.span(2_000_000, 4800, 2)).toBeNull() // latências desconhecidas antes do 1º stretcher
    await bank.ensure('i1', 2)
    const [a, b] = bank.span(2_000_000, 4800, 2)!
    mixBlock([stretchSeg()], 0, 4800, srcs)
    const ranges = calls.filter((c): c is Extract<Call, { op: 'seek' | 'process' }> => c.op !== 'reset')
    expect(Math.min(...ranges.map((c) => c.from))).toBeGreaterThanOrEqual(a)
    expect(Math.max(...ranges.map((c) => c.to))).toBeLessThanOrEqual(b)
  })

  it('LRU: acima de maxLive o segmento mais antigo perde o estado e o stretcher é reaproveitado; retain solta os que saíram', async () => {
    const { created, bank } = setup(2)
    await bank.ensure('a', 2)
    await bank.ensure('b', 2)
    await bank.ensure('a', 2) // a fica mais recente
    await bank.ensure('c', 2)
    expect(bank.has('b')).toBe(false)
    expect(bank.has('a') && bank.has('c')).toBe(true)
    expect(created).toHaveLength(2) // c reaproveitou o de b
    bank.retain(new Set(['c']))
    expect(bank.has('a')).toBe(false)
    await bank.ensure('d', 2)
    expect(created).toHaveLength(2)
  })

  it('pin: segmentos do bloco atual não são despejados pelo aquecimento à frente (o banco passa do limite)', async () => {
    const { created, bank, srcs } = setup(2)
    await bank.ensure('i1', 2)
    await bank.ensure('b', 2)
    bank.pin(new Set(['i1', 'b'])) // os dois tocam no bloco atual
    await bank.ensure('c', 2) // aquecimento de um segmento que começa adiante
    expect(bank.has('i1') && bank.has('b') && bank.has('c')).toBe(true)
    expect(created).toHaveLength(3)
    // e o mixBlock do bloco atual ainda estica (não cai na reamostragem)
    const out = mixBlock([stretchSeg()], 0, 4800, srcs)
    expect(Math.round(out[0] * 1e6)).toBe(BASE + LEAD)
    bank.pin(new Set())
    await bank.ensure('d', 2) // sem pin: volta ao limite despejando os mais antigos (i1 foi lido por último)
    expect([bank.has('b'), bank.has('c'), bank.has('i1'), bank.has('d')]).toEqual([false, false, true, true])
  })

  it('falha ao criar o stretcher: ensure rejeita sempre, sem tentar de novo', async () => {
    let tries = 0
    const bank = new StretchBank(async () => {
      tries++
      throw new Error('sem WASM')
    })
    await expect(bank.ensure('i1', 2)).rejects.toThrow('sem WASM')
    await expect(bank.ensure('i2', 2)).rejects.toThrow('sem WASM')
    expect(tries).toBe(1)
  })
})
