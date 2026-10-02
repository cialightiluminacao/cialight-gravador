// Análise de PCM para os testes de áudio do editor (vitest, harness no Chromium e checagens do main):
// frequência dominante e descontinuidade nas emendas entre blocos. Puro.
const SR = 48000

/** Canal `c` de PCM estéreo intercalado. */
export function channel(pcm: Float32Array, c: 0 | 1): Float32Array {
  const out = new Float32Array(pcm.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = pcm[i * 2 + c]
  return out
}

function goertzelPower(x: Float32Array, start: number, len: number, hz: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / SR)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)) // Hann
    const s0 = x[start + i] * w + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** Frequência de maior energia em [loHz, hiHz] no trecho [start, start+len) (varredura de 1 Hz, refino de 0,1 Hz). */
export function dominantHz(x: Float32Array, start: number, len: number, loHz = 50, hiHz = 2000): number {
  const n = Math.min(len, x.length - start)
  let best = -1
  let bestHz = loHz
  for (let hz = loHz; hz <= hiHz; hz += 1) {
    const p = goertzelPower(x, start, n, hz)
    if (p > best) {
      best = p
      bestHz = hz
    }
  }
  const coarse = bestHz
  for (let hz = coarse - 1; hz <= coarse + 1; hz += 0.1) {
    const p = goertzelPower(x, start, n, hz)
    if (p > best) {
      best = p
      bestHz = hz
    }
  }
  return Math.round(bestHz * 10) / 10
}

/**
 * Descontinuidade nas emendas: maior energia de diferença amostra-a-amostra (x[i] − x[i−1])² nos índices
 * `seams` dividida pela média dessa energia no trecho [from, to). Senoide contínua: ≤ 2.
 */
export function seamRatio(x: Float32Array, seams: number[], from = 1, to = x.length): number {
  let sum = 0
  for (let i = Math.max(1, from); i < to; i++) sum += (x[i] - x[i - 1]) ** 2
  const mean = sum / (to - Math.max(1, from))
  let worst = 0
  for (const s of seams) if (s >= 1 && s < x.length) worst = Math.max(worst, (x[s] - x[s - 1]) ** 2)
  return mean > 0 ? worst / mean : 0
}

/** RMS de [from, to). */
export function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, to - from))
}

/**
 * Amplitude (pico da senoide) da componente de `hz` em x[start, start + len) pelo algoritmo de Goertzel. Com `len`
 * múltiplo do período de `hz` e dos outros tons presentes, não há vazamento entre eles (medir a música sob a voz).
 */
export function toneAmplitude(x: Float32Array, start: number, len: number, hz: number, sr: number): number {
  const w = (2 * Math.PI * hz) / sr
  const k = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  const end = Math.min(x.length, start + len)
  for (let i = Math.max(0, start); i < end; i++) {
    const s0 = x[i] + k * s1 - s2
    s2 = s1
    s1 = s0
  }
  const re = s1 - s2 * Math.cos(w)
  const im = s2 * Math.sin(w)
  return (2 * Math.sqrt(re * re + im * im)) / Math.max(1, end - Math.max(0, start))
}
