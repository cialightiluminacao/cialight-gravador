// Spike F0 — sinal de teste "tipo voz" e análise (frequência dominante, posição da pausa).
export const SR = 48000
export const F0 = 220
export const GAP_START = 2.0
export const GAP_END = 2.25

/** Harmônicos de 220 Hz (1, ½, ¼) com modulação de amplitude de 4 Hz (sílabas) e uma pausa 2,00–2,25 s. */
export function makeTestSignal(seconds: number): Float32Array[] {
  const n = Math.round(seconds * SR)
  const L = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    if (t >= GAP_START && t < GAP_END) continue
    const am = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)
    const w = 2 * Math.PI * F0 * t
    L[i] = 0.3 * am * (Math.sin(w) + 0.5 * Math.sin(2 * w) + 0.25 * Math.sin(3 * w))
  }
  return [L, L.slice()]
}

function goertzelPower(x: Float32Array, start: number, len: number, hz: number): number {
  const k = (2 * Math.PI * hz) / SR
  const coeff = 2 * Math.cos(k)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < len; i++) {
    // janela de Hann
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1))
    const s0 = x[start + i] * w + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** Análise de um canal produzido com velocidade `rate` (1 = original). */
export function analyze(x: Float32Array, rate: number): Record<string, number | null> {
  // janela correspondente a 0,5–1,5 s da entrada (≥ 8192 amostras)
  const start = Math.round((0.5 / rate) * SR)
  const len = Math.max(8192, Math.min(Math.round((1.0 / rate) * SR), x.length - start))
  let best = 0
  let bestHz = 0
  for (let hz = 80; hz <= 1000; hz += 1) {
    const p = goertzelPower(x, start, Math.min(len, x.length - start), hz)
    if (p > best) {
      best = p
      bestHz = hz
    }
  }
  // pausa: maior sequência de quadros de 5 ms com RMS < 5% do RMS global
  const frame = Math.round(SR * 0.005)
  let tot = 0
  for (const v of x) tot += v * v
  const rmsAll = Math.sqrt(tot / x.length)
  let run = 0
  let bestRun = 0
  let bestEnd = -1
  const frames = Math.floor(x.length / frame)
  for (let f = 0; f < frames; f++) {
    let s = 0
    for (let i = f * frame; i < (f + 1) * frame; i++) s += x[i] * x[i]
    const rms = Math.sqrt(s / frame)
    if (rms < 0.05 * rmsAll) {
      run++
      if (run > bestRun) {
        bestRun = run
        bestEnd = f
      }
    } else run = 0
  }
  const gapStart = bestEnd >= 0 ? ((bestEnd - bestRun + 1) * frame) / SR : null
  const gapEnd = bestEnd >= 0 ? ((bestEnd + 1) * frame) / SR : null
  return {
    dominantHz: bestHz,
    rms: +rmsAll.toFixed(4),
    gapStartSec: gapStart === null ? null : +gapStart.toFixed(3),
    gapEndSec: gapEnd === null ? null : +gapEnd.toFixed(3),
    gapExpectedStartSec: +(GAP_START / rate).toFixed(3),
    gapExpectedEndSec: +(GAP_END / rate).toFixed(3)
  }
}
