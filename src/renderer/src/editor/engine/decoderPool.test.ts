import { describe, expect, it } from 'vitest'
import type { VideoSample } from 'mediabunny'
import { DecoderPool } from './decoderPool'

// Abertura falsa: falha enquanto `locked` (arquivo preso por outro programa), depois abre um sink de seek.
function fakeOpen(state: { locked: boolean; opens: number }) {
  return async () => {
    state.opens++
    if (state.locked) throw new Error('arquivo em uso')
    const sample = { timestamp: 0, close() {}, clone() { return this } } as unknown as VideoSample
    return { input: { dispose() {} }, sink: { getSample: async () => sample, samples: async function* () {} }, firstS: 0 } as never
  }
}

describe('DecoderPool: abertura que falhou', () => {
  it('fica como placeholder por um tempo e é tentada de novo depois (arquivo preso por instantes)', async () => {
    const clock = { t: 0 }
    const state = { locked: true, opens: 0 }
    const pool = new DecoderPool(8, { now: () => clock.t, open: fakeOpen(state) })
    pool.setSources({ a: 'cialight-file://media/p/a' })
    expect(await pool.frameAt('a', 0, false)).toBeNull()
    state.locked = false
    clock.t = 1000
    expect(await pool.frameAt('a', 0, false)).toBeNull() // ainda dentro do intervalo: não reabre a cada quadro
    expect(state.opens).toBe(1)
    clock.t = 6000
    expect(await pool.frameAt('a', 0, false)).not.toBeNull() // reabriu
    expect(state.opens).toBe(2)
  })
})
