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

// Sink falso a 30 fps (GOP 1 s): samples(start, end) decodifica do keyframe anterior a `start` e entrega os
// quadros com timestamp em [quadro que contém start, end). Conta decodificações e quadros vivos (não fechados).
function fakeVideo(durS = 4) {
  const FPS = 30
  const stats = { blocks: 0, decoded: 0, live: 0, maxLive: 0 }
  const mk = (i: number): VideoSample => {
    stats.live++
    stats.maxLive = Math.max(stats.maxLive, stats.live)
    let open = true
    const s = { timestamp: i / FPS, duration: 1 / FPS, close() { if (open) { open = false; stats.live-- } }, clone() { return mk(i) } }
    return s as unknown as VideoSample
  }
  const frames = Math.round(durS * FPS)
  const open = async () => ({
    input: { dispose() {} },
    firstS: 0,
    meta: async () => ({ frameS: 1 / FPS, frameBytes: 1920 * 1080 * 4 }),
    sink: {
      getSample: async (t: number) => mk(Math.min(frames - 1, Math.max(0, Math.floor(t * FPS + 1e-6)))),
      samples: async function* (start = 0, end = Infinity) {
        stats.blocks++
        const first = Math.max(0, Math.floor(start * FPS + 1e-6))
        const key = Math.floor(first / FPS) * FPS
        for (let i = key; i < frames && i / FPS < end - 1e-9; i++) {
          stats.decoded++
          if (i >= first) yield mk(i)
        }
      }
    }
  })
  return { open: open as never, stats, FPS }
}

describe('DecoderPool: reverso eficiente (bloco do GOP decodificado para trás, servido do cache)', () => {
  const ident = async (s: VideoSample): Promise<VideoSample> => s
  it('quadros em ordem decrescente corretos, poucas decodificações e memória limitada', async () => {
    const v = fakeVideo()
    const pool = new DecoderPool(8, { open: v.open, detach: ident })
    pool.setSources({ a: 'x' })
    const got: number[] = []
    // de 3,5 s até 0,5 s, um quadro por vez (reverso a 1×), com uma folga de tempo entre os quadros
    for (let i = 105; i >= 15; i--) {
      const s = await pool.frameAt('a', Math.round((i / v.FPS) * 1e6) + 100, true)
      got.push(Math.round(s!.timestamp * v.FPS))
      s!.close()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(got).toEqual(Array.from({ length: 91 }, (_, k) => 105 - k))
    // 91 quadros em blocos de 12 (96 MiB / 1080p RGBA): ~8 blocos (+1 pré-buscado), não um seek por quadro
    expect(v.stats.blocks).toBeLessThanOrEqual(10)
    // no máximo o bloco atual + o anterior pré-buscado vivos (cada um com até 1 quadro a mais: o que contém o início)
    // + o quadro entregue
    expect(v.stats.maxLive).toBeLessThanOrEqual(2 * 13 + 1)
    pool.releaseAll()
    await new Promise((r) => setTimeout(r, 0))
    expect(v.stats.live).toBe(0)
  })
  it('pré-busca o bloco anterior logo depois do primeiro', async () => {
    const v = fakeVideo()
    const pool = new DecoderPool(8, { open: v.open, detach: ident })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 3_000_000, false))!.close() // seek (pausado)
    ;(await pool.frameAt('a', 2_966_667, true))!.close() // 1º pedido para trás: seek
    ;(await pool.frameAt('a', 2_933_334, true))!.close() // 2º: bloco
    await new Promise((r) => setTimeout(r, 0))
    expect(v.stats.blocks).toBe(2)
  })
  it('voltar a andar para frente retoma o iterador sequencial e libera o cache do reverso', async () => {
    const v = fakeVideo()
    const pool = new DecoderPool(8, { open: v.open, detach: ident })
    pool.setSources({ a: 'x' })
    for (const t of [2_000_000, 1_966_667, 1_933_334]) (await pool.frameAt('a', t, true))!.close()
    const f = await pool.frameAt('a', 2_500_000, true)
    expect(Math.round(f!.timestamp * v.FPS)).toBe(75)
    f!.close()
    await new Promise((r) => setTimeout(r, 0))
    expect(v.stats.live).toBeLessThanOrEqual(2) // só o buffer do iterador (held/ahead)
  })
  it('antes do primeiro quadro do arquivo devolve o primeiro', async () => {
    const v = fakeVideo()
    const pool = new DecoderPool(8, { open: v.open, detach: ident })
    pool.setSources({ a: 'x' })
    for (const t of [100_000, 66_667, 33_334, 0]) {
      const s = await pool.frameAt('a', t, true)
      expect(s!.timestamp).toBeLessThanOrEqual(t / 1e6 + 1e-6)
      s!.close()
    }
  })
})

describe('DecoderPool: reverso com passos grandes', () => {
  it('passo grande: bloco esparso (um quadro a cada meio passo) serve vários pedidos; salto vai por seek', async () => {
    const v = fakeVideo(8)
    const pool = new DecoderPool(8, { open: v.open, detach: async (s: VideoSample) => s })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 7_000_000, false))!.close()
    const got: number[] = []
    // −8× com o render a ~20 quadros/s: 0,4 s por quadro
    for (let t = 6_600_000; t >= 600_000; t -= 400_000) {
      const s = await pool.frameAt('a', t, true)
      got.push(Math.round(s!.timestamp * v.FPS))
      s!.close()
      await new Promise((r) => setTimeout(r, 0))
    }
    // quadro exato (os pedidos caem nos alvos do bloco) e poucos blocos: 16 pedidos (6,4 s) em blocos esparsos de 1,5 s
    // (8 quadros a 0,2 s) ≈ 5 blocos — não um seek por pedido
    expect(got).toEqual(Array.from({ length: 16 }, (_, k) => Math.round((6.6 - 0.4 * k) * v.FPS)))
    expect(v.stats.blocks).toBeLessThanOrEqual(6)
    expect(v.stats.maxLive).toBeLessThanOrEqual(2 * 13 + 1)
    // pedido fora dos alvos: o quadro guardado mais próximo antes dele, a menos de meio passo
    const off = await pool.frameAt('a', 450_000, true)
    expect(off!.timestamp).toBeLessThanOrEqual(0.45)
    expect(0.45 - off!.timestamp).toBeLessThan(0.2 + 1e-6)
    off!.close()
    // salto (> 2 s para trás) vai por seek: nenhum bloco novo
    ;(await pool.frameAt('a', 7_500_000, false))!.close()
    const before = v.stats.blocks
    const j = await pool.frameAt('a', 4_000_000, true)
    expect(Math.round(j!.timestamp * v.FPS)).toBe(120)
    j!.close()
    expect(v.stats.blocks).toBe(before)
  })
})

/** Sink falso com timestamps dados (VFR); GOP = `keyEvery` quadros. */
function fakeVfr(ts: number[], keyEvery = 30, frameS = 1 / 30, throwOnDetach = -1) {
  const stats = { blocks: 0, live: 0, maxLive: 0, detaches: 0 }
  const mk = (i: number): VideoSample => {
    stats.live++
    stats.maxLive = Math.max(stats.maxLive, stats.live)
    let open = true
    const s = { timestamp: ts[i], duration: (ts[i + 1] ?? ts[i] + frameS) - ts[i], close() { if (open) { open = false; stats.live-- } }, clone() { return mk(i) } }
    return s as unknown as VideoSample
  }
  const idxAt = (t: number): number => { let i = 0; while (i + 1 < ts.length && ts[i + 1] <= t + 1e-6) i++; return i } // mesma tolerância do pool
  const open = async () => ({
    input: { dispose() {} },
    firstS: ts[0],
    meta: async () => ({ frameS, frameBytes: 1920 * 1080 * 4 }),
    sink: {
      getSample: async (t: number) => mk(idxAt(t)),
      samples: async function* (start = 0, end = Infinity) {
        stats.blocks++
        const first = idxAt(start)
        for (let i = Math.floor(first / keyEvery) * keyEvery; i < ts.length && ts[i] < end - 1e-9; i++) if (i >= first) yield mk(i)
      }
    }
  })
  const detach = async (s: VideoSample): Promise<VideoSample> => {
    if (++stats.detaches === throwOnDetach) throw new Error('falha na cópia')
    return s
  }
  return { open: open as never, stats, detach, idxAt }
}

describe('DecoderPool: revisão do reverso', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  it('1º passo para trás vai por seek (sem bloco nem pré-busca); o reverso em bloco só a partir do 2º', async () => {
    const v = fakeVideo()
    const pool = new DecoderPool(8, { open: v.open, detach: async (s: VideoSample) => s })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 3_000_000, false))!.close()
    const s1 = await pool.frameAt('a', 2_966_667, true)
    expect(Math.round(s1!.timestamp * v.FPS)).toBe(89)
    s1!.close()
    await tick()
    expect(v.stats.blocks).toBe(0)
    ;(await pool.frameAt('a', 2_933_334, true))!.close()
    await tick()
    expect(v.stats.blocks).toBe(2) // bloco + pré-busca do anterior
  })
  it('bloco denso limitado a n quadros mesmo com fonte VFR mais densa que a taxa média (memória limitada, quadros certos)', async () => {
    // 0–2 s a 10 quadros/s, 2–4 s a 120 quadros/s; o meta diz 30 quadros/s
    const ts = [...Array.from({ length: 20 }, (_, i) => i / 10), ...Array.from({ length: 240 }, (_, i) => 2 + i / 120)]
    const v = fakeVfr(ts)
    const pool = new DecoderPool(8, { open: v.open, detach: v.detach })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 3_900_000, false))!.close()
    const got: number[] = []
    for (let k = 1; k <= 120; k++) {
      const t = Math.round((3.9 - k / 120) * 1e6)
      const s = await pool.frameAt('a', t, true)
      got.push(Math.round(s!.timestamp * 1e6))
      expect(s!.timestamp).toBe(ts[v.idxAt(t / 1e6)])
      s!.close()
      await tick()
    }
    expect(new Set(got).size).toBe(120)
    // n = 12 (96 MiB / 1080p RGBA): bloco atual + anterior, cada um com no máximo 12 (+ o entregue + o pendente)
    expect(v.stats.maxLive).toBeLessThanOrEqual(2 * 12 + 3)
  })
  it('passo volta a ser pequeno: o próximo bloco (e a pré-busca) é denso de novo — quadros exatos', async () => {
    const v = fakeVideo(8)
    const pool = new DecoderPool(8, { open: v.open, detach: async (s: VideoSample) => s })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 7_000_000, false))!.close()
    for (const t of [6_600_000, 6_200_000, 5_800_000]) {
      ;(await pool.frameAt('a', t, true))!.close()
      await tick()
    }
    const got: number[] = []
    for (let k = 1; k <= 60; k++) {
      const t = Math.round((5.8 - k / 30) * 1e6)
      const s = await pool.frameAt('a', t, true)
      got.push(Math.round(s!.timestamp * v.FPS))
      s!.close()
      await tick()
    }
    expect(got).toEqual(Array.from({ length: 60 }, (_, k) => Math.round(5.8 * 30) - 1 - k))
  })
  it('cópia que falha não vaza o quadro que acabou de sair do decoder', async () => {
    const ts = Array.from({ length: 120 }, (_, i) => i / 30)
    const v = fakeVfr(ts, 30, 1 / 30, 3)
    const pool = new DecoderPool(8, { open: v.open, detach: v.detach })
    pool.setSources({ a: 'x' })
    for (const t of [3_000_000, 2_966_667, 2_933_334, 2_900_000]) {
      const s = await pool.frameAt('a', t, true)
      s?.close()
      await tick()
    }
    pool.releaseAll()
    await tick()
    await tick()
    expect(v.stats.live).toBe(0)
  })
})

describe('DecoderPool: −8× na fronteira denso/esparso', () => {
  it('passo oscilando em torno de 4 quadros (−8× a 60 Hz): nenhum pedido decodifica mais de um bloco (a pré-busca serve)', async () => {
    const v = fakeVideo(8)
    const pool = new DecoderPool(8, { open: v.open, detach: async (s: VideoSample) => s })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 7_950_000, false))!.close()
    let t = 7_950_000
    let worst = 0
    for (const step of [16_667, 33_000, 66_000, 133_000, 140_000, 120_000, 135_000, 150_000, 130_000, 133_000, 133_000, 140_000, 133_000, 125_000, 133_000]) {
      t -= step
      const b0 = v.stats.blocks
      const s = await pool.frameAt('a', t, true)
      // nunca depois do alvo, no máximo meio passo antes
      expect(s!.timestamp).toBeLessThanOrEqual(t / 1e6 + 1e-6)
      expect(t / 1e6 - s!.timestamp).toBeLessThanOrEqual(0.075 + 1e-6)
      s!.close()
      await new Promise((r) => setTimeout(r, 0))
      if (step > 33_000) worst = Math.max(worst, v.stats.blocks - b0)
    }
    expect(worst).toBe(1) // o bloco do pedido OU a pré-busca do seguinte, nunca os dois descartados e refeitos
  })
})

describe('DecoderPool: revisão 2 do reverso', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  it('|taxa| ≈ 1 depois de um trecho rápido: bloco esparso recusado, quadros exatos já no 1º passo pequeno', async () => {
    const v = fakeVideo(8)
    const pool = new DecoderPool(8, { open: v.open, detach: async (s: VideoSample) => s })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 7_000_000, false))!.close()
    // passos de 0,2 s (6 quadros) → espaçamento de 3 quadros (a folga 3× aceitaria isso a 1×)
    for (const t of [6_800_000, 6_600_000, 6_400_000]) {
      ;(await pool.frameAt('a', t, true))!.close()
      await tick()
    }
    for (let k = 1; k <= 10; k++) {
      const t = Math.round((6.4 - k / 30) * 1e6)
      const s = await pool.frameAt('a', t, true)
      expect(Math.round(s!.timestamp * v.FPS)).toBe(Math.round(6.4 * 30) - k)
      s!.close()
      await tick()
    }
  })
  it('pedido sequencial repetido no mesmo instante é servido do cache do reverso sem descartá-lo', async () => {
    const v = fakeVideo(8)
    const pool = new DecoderPool(8, { open: v.open, detach: async (s: VideoSample) => s })
    pool.setSources({ a: 'x' })
    ;(await pool.frameAt('a', 7_000_000, false))!.close()
    for (const t of [6_600_000, 6_200_000, 5_800_000]) {
      ;(await pool.frameAt('a', t, true))!.close()
      await tick()
    }
    const blocks = v.stats.blocks
    const again = await pool.frameAt('a', 5_800_000, true)
    expect(Math.round(again!.timestamp * v.FPS)).toBe(174)
    again!.close()
    await tick()
    const next = await pool.frameAt('a', 5_400_000, true)
    expect(Math.round(next!.timestamp * v.FPS)).toBe(162)
    next!.close()
    await tick()
    expect(v.stats.blocks).toBe(blocks) // o bloco esparso continuou valendo: nenhum bloco novo
  })
})
