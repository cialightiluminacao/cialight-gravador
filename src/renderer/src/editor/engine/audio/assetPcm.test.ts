import { describe, expect, it, vi } from 'vitest'
import { AssetPcm, type Opened } from './assetPcm'
import { StretchBank } from './mixer'
import type { Stretcher } from './stretch'

// Sample falso no formato do mediabunny: mono, valor constante.
function fakeSample(timestamp: number, frames: number, value: number): unknown {
  return {
    timestamp, numberOfFrames: frames, numberOfChannels: 1,
    copyTo: (buf: Float32Array) => buf.fill(value, 0, frames),
    close: () => {}
  }
}

function opened(samples: (start?: number, end?: number) => AsyncGenerator<unknown>): Opened {
  return {
    input: { dispose: () => {} },
    sink: { samples } as unknown as Opened['sink'],
    sampleRate: 48000, channels: 1, firstS: 0, endS: 10
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('AssetPcm', () => {
  it('decodifica o chunk na janela com margem e lê a 48 kHz estéreo', async () => {
    const calls: [number | undefined, number | undefined][] = []
    const pcm = new AssetPcm('u', null, {
      open: async () => opened(async function* (start, end) {
        calls.push([start, end])
        for (let t = 0; t < 1.2; t += 0.1) yield fakeSample(t, 4800, 0.5)
      })
    })
    await pcm.ensure(100_000, 4800, 1, false)
    expect(calls).toEqual([[0, 1.2]]) // max(k − 0,2, firstS) … k + 1 + 0,2
    const out = pcm.read(100_000, 4800, 1, false)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[out.length - 1]).toBeCloseTo(0.5)
  })

  it('falha de decodificação: reporta uma vez e só tenta de novo após 2 s', async () => {
    let now = 0
    let calls = 0
    const onError = vi.fn()
    const pcm = new AssetPcm('u', null, {
      now: () => now,
      onError,
      // eslint-disable-next-line require-yield
      open: async () => opened(async function* () {
        calls++
        throw new Error('quebrado')
      })
    })
    await pcm.ensure(0, 4800, 1, false)
    expect(calls).toBe(1)
    now = 1000
    await pcm.ensure(0, 4800, 1, false)
    expect(calls).toBe(1)
    now = 2100
    await pcm.ensure(0, 4800, 1, false)
    expect(calls).toBe(2)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatch(/quebrado/)
  })

  it('falha ao abrir: reporta uma vez, reabre só após 2 s', async () => {
    let now = 0
    const open = vi.fn(async () => {
      throw new Error('sem arquivo')
    })
    const onError = vi.fn()
    const pcm = new AssetPcm('u', null, { now: () => now, onError, open })
    await flush()
    await pcm.ensure(0, 4800, 1, false)
    now = 1000
    await pcm.ensure(0, 4800, 1, false)
    expect(open).toHaveBeenCalledTimes(1)
    now = 2500
    await pcm.ensure(0, 4800, 1, false)
    expect(open).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('pedido obsoleto não decodifica; um pedido válido depois decodifica', async () => {
    let calls = 0
    const pcm = new AssetPcm('u', null, {
      open: async () => opened(async function* () {
        calls++
        yield fakeSample(0, 4800, 0.25)
      })
    })
    await pcm.ensure(0, 4800, 1, false, () => true)
    expect(calls).toBe(0)
    // obsoleto enfileirado junto com um válido para o mesmo chunk
    let stale = false
    const a = pcm.ensure(0, 4800, 1, false, () => stale)
    stale = true
    await Promise.all([a, pcm.ensure(0, 4800, 1, false)])
    expect(calls).toBe(1)
    expect(pcm.read(0, 1, 1, false)[0]).toBeCloseTo(0.25)
  })

  describe('ensureStretched', () => {
    // stretcher falso com latências de 0,5 s (entrada) e 0,25 s (saída): o pré-roll recua para o chunk anterior
    const fake = (): Stretcher => ({
      inputLatency: 24000, outputLatency: 12000, latencyFrames: 36000,
      reset: () => {}, seek: () => {}, process: (_i, n) => new Float32Array(n * 2)
    })
    const decoder = (calls: number[]): Opened => opened(async function* (start) {
      calls.push(Math.round((start ?? 0) * 10) / 10)
      for (let t = 0; t < 10; t += 0.1) yield fakeSample(t, 4800, 0.5)
    })

    it('cria o stretcher do segmento e decodifica os chunks do pré-roll ao avanço da latência', async () => {
      const calls: number[] = []
      const bank = new StretchBank(async () => fake())
      const pcm = new AssetPcm('u', null, { stretch: bank, open: async () => decoder(calls) })
      // fonte em 3,1 s, 0,1 s de saída a 2×: pré-roll desde 3,1 + 0,5 − 0,75 = 2,85 s; avanço até 3,1 + 1,0 + 0,2 = 4,3 s
      await pcm.ensureStretched('i1', 3_100_000, 4800, 2)
      expect(bank.has('i1')).toBe(true)
      expect(calls.sort()).toEqual([1.8, 2.8, 3.8]) // chunks 2, 3 e 4 (janela com margem de 0,2 s)
    })

    it('sem WASM: avisa uma vez e prepara a leitura reamostrada', async () => {
      const calls: number[] = []
      const onError = vi.fn()
      const bank = new StretchBank(async () => {
        throw new Error('sem WASM')
      })
      const pcm = new AssetPcm('u', null, { stretch: bank, onError, open: async () => decoder(calls) })
      await pcm.ensureStretched('i1', 3_100_000, 4800, 2)
      await pcm.ensureStretched('i1', 3_200_000, 4800, 2)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0][0]).toContain('tom preservado indisponível')
      expect(calls).toEqual([2.8]) // só o chunk 3 da leitura reamostrada
      expect(pcm.readStretched('i1', 3_100_000, 4, 2)[0]).toBeCloseTo(0.5)
    })
  })
})
