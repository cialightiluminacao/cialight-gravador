import { describe, expect, it } from 'vitest'
import type { AudioSegment } from '@shared/editor/audioPlan'
import { channel, dominantHz, rmsOf, seamRatio } from '@shared/audio/pcmAnalysis'
import { ChunkedPcm, mixBlock, SR, StretchBank } from './mixer'
import { createStretcher } from './stretch'
import { SIGNALSMITH_WASM_BASE64, SIGNALSMITH_WASM_SHA256 } from './signalsmithWasm'
import { createHash } from 'crypto'

// WASM real do signalsmith no Node: o carregador próprio não depende de DOM nem de Worker.

const BLOCK = 4800 // 100 ms, como o PlaybackController

/** Fonte de `seconds` s em chunks de 1 s: senoide de `hz` (amplitude 0,5) com silêncio em [gapFrom, gapTo) s. */
function source(hz: number, seconds: number, gap?: [number, number]): { pcm: ChunkedPcm; bank: StretchBank } {
  const bank = new StretchBank((r) => createStretcher(r, 2))
  const pcm = new ChunkedPcm(64, bank)
  for (let k = 0; k < seconds; k++) {
    const c = new Float32Array(SR * 2)
    for (let i = 0; i < SR; i++) {
      const t = k + i / SR
      const v = gap && t >= gap[0] && t < gap[1] ? 0 : 0.5 * Math.sin(2 * Math.PI * hz * t)
      c[i * 2] = v
      c[i * 2 + 1] = v
    }
    pcm.put(k, c)
  }
  return { pcm, bank }
}

function seg(speed: number, srcSeconds: number, srcInUs = 0): AudioSegment {
  const durationUs = Math.round((srcSeconds * 1e6) / speed)
  return {
    itemId: 'i1', assetId: 'a1', sourceKey: 'a1', processKey: null, startUs: 0, durationUs, srcInUs, speed, reverse: false, preservePitch: true, keepFastAudio: false, mode: 'stretch',
    gain: [{ tUs: 0, gain: 1 }, { tUs: durationUs, gain: 1 }]
  }
}

/** Mixa o segmento inteiro em blocos consecutivos de BLOCK frames (ensure antes de cada bloco, como o worker). */
async function render(pcm: ChunkedPcm, s: AudioSegment, bank: StretchBank): Promise<Float32Array> {
  const frames = Math.round((s.durationUs * SR) / 1e6)
  const out = new Float32Array(frames * 2)
  for (let f = 0; f < frames; f += BLOCK) {
    await bank.ensure(s.itemId, s.speed)
    const fromUs = Math.round((f * 1e6) / SR)
    out.set(mixBlock([s], fromUs, Math.min(BLOCK, frames - f), new Map([['a1', pcm]])), f * 2)
  }
  return out
}

describe('signalsmithWasm (vendorizado)', () => {
  it('binário confere com o sha256 registrado', () => {
    expect(createHash('sha256').update(Buffer.from(SIGNALSMITH_WASM_BASE64, 'base64')).digest('hex')).toBe(SIGNALSMITH_WASM_SHA256)
  })
})

describe('createStretcher (WASM real)', () => {
  it('preset padrão a 48 kHz: latências de 60 ms + 60 ms', async () => {
    const st = await createStretcher(1, 2)
    expect(st.inputLatency).toBe(2880)
    expect(st.outputLatency).toBe(2880)
    expect(st.latencyFrames).toBe(5760)
    expect(st.process(new Float32Array(960 * 2), 480).length).toBe(960)
  })

  for (const speed of [0.5, 1.5, 2, 4]) {
    it(`${speed}×: tom de 440 Hz preservado (±2 %), sem clique nas emendas dos blocos`, async () => {
      // a partir de 1 s da fonte: o pré-roll tem áudio de verdade antes do ponto de entrada
      const { pcm, bank } = source(440, 7)
      const out = channel(await render(pcm, seg(speed, 4, 1_000_000), bank), 0)
      // janela de 0,5 s no meio da saída
      const hz = dominantHz(out, Math.round(out.length / 2 - SR / 4), SR / 2, 200, 1000)
      expect(Math.abs(hz - 440) / 440).toBeLessThan(0.02)
      // emendas dos blocos depois do 1º (o 1º é o início do fluxo)
      const seams: number[] = []
      for (let f = BLOCK; f < out.length - BLOCK; f += BLOCK) seams.push(f)
      expect(seamRatio(out, seams, BLOCK, out.length - BLOCK)).toBeLessThanOrEqual(3)
      expect(rmsOf(out, BLOCK, out.length - BLOCK)).toBeGreaterThan(0.3) // ~0,5/√2, sem buracos
      // pré-roll: o início do segmento já sai com nível cheio (sem rampa de entrada do stretcher)
      expect(rmsOf(out, 0, 480)).toBeGreaterThan(0.3)
    })
  }

  for (const speed of [0.5, 2]) {
    it(`${speed}×: alinhamento — pausa da fonte em 2,0–2,5 s cai em 2,0/${speed} s na saída (±10 ms)`, async () => {
      const { pcm, bank } = source(440, 6, [2, 2.5])
      const out = channel(await render(pcm, seg(speed, 4), bank), 0)
      // centro da pausa: janelas de 1 ms com RMS < 5 % da senoide
      const win = 48 // 1 ms
      const quiet: number[] = []
      for (let f = 0; f + win <= out.length; f += win) if (rmsOf(out, f, f + win) < 0.05 * 0.35) quiet.push(f + win / 2)
      expect(quiet.length).toBeGreaterThan(0)
      const center = (quiet[0] + quiet[quiet.length - 1]) / 2
      expect(Math.abs(center - (2.25 / speed) * SR)).toBeLessThanOrEqual(SR / 100)
    })
  }

  it('determinístico: duas renderizações idênticas', async () => {
    const a = source(440, 4)
    const b = source(440, 4)
    const ra = await render(a.pcm, seg(1.5, 3), a.bank)
    const rb = await render(b.pcm, seg(1.5, 3), b.bank)
    expect(ra).toEqual(rb)
  })

  it('seek: depois do salto o tom continua certo e o 1º bloco já tem sinal (pré-roll)', async () => {
    const { pcm, bank } = source(440, 8)
    const s = seg(2, 8)
    await render(pcm, { ...s, durationUs: 1_000_000 }, bank) // toca 1 s do começo
    await bank.ensure(s.itemId, s.speed)
    const blk = channel(mixBlock([s], 2_500_000, BLOCK, new Map([['a1', pcm]])), 0)
    expect(rmsOf(blk, BLOCK / 2, BLOCK)).toBeGreaterThan(0.25)
    const next = channel(mixBlock([s], 2_600_000, BLOCK * 4, new Map([['a1', pcm]])), 0)
    expect(Math.abs(dominantHz(next, 0, next.length, 200, 1000) - 440) / 440).toBeLessThan(0.02)
  })

  // Medida informativa: com a suíte inteira em paralelo a CPU é disputada. A meta (≥ 10× no worker) é
  // conferida no harness real (npm run test:editor).
  it('desempenho: 4 segmentos esticados mais rápidos que o tempo real (medido no Node)', async () => {
    const { pcm, bank } = source(440, 12)
    const segs = [0.5, 1.5, 2, 4].map((v, i): AudioSegment => ({ ...seg(v, 2.5), itemId: `i${i}`, durationUs: 2_500_000 }))
    for (const s of segs) await bank.ensure(s.itemId, s.speed)
    const srcs = new Map([['a1', pcm]])
    const t0 = performance.now()
    for (let f = 0; f < SR * 2.5; f += BLOCK) mixBlock(segs, Math.round((f * 1e6) / SR), BLOCK, srcs)
    const x = 2.5 / ((performance.now() - t0) / 1000)
    expect(x).toBeGreaterThan(1)
  })
})
