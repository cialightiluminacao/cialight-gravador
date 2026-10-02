// Balística dos medidores de nível (VU com pico) do editor: escala em dB de METER_FLOOR_DB a 0 dBFS mapeada em 0–1;
// a barra sobe na hora e cai a METER_FALL_DB_S; o indicador de pico segura METER_HOLD_MS e depois cai igual. Puro.

export const METER_FLOOR_DB = -60
export const METER_FALL_DB_S = 24
export const METER_HOLD_MS = 1500

export interface MeterState { level: number; peak: number; peakAtMs: number }
export const METER_ZERO: MeterState = { level: 0, peak: 0, peakAtMs: 0 }

/** Pico linear (0–1+) → posição 0–1 na escala em dB (abaixo do piso = 0; acima de 0 dBFS = 1). */
export function peakToFraction(peak: number): number {
  if (!(peak > 0)) return 0
  const db = 20 * Math.log10(peak)
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))
}

/** Próximo estado: `input` (0–1, já na escala) no instante nowMs, dtMs depois do anterior. */
export function meterStep(s: MeterState, input: number, nowMs: number, dtMs: number): MeterState {
  const fall = (METER_FALL_DB_S / -METER_FLOOR_DB) * (Math.max(0, dtMs) / 1000)
  const level = Math.max(input, s.level - fall, 0)
  if (input >= s.peak) return { level, peak: input, peakAtMs: nowMs }
  const peak = nowMs - s.peakAtMs < METER_HOLD_MS ? s.peak : Math.max(level, s.peak - fall, 0)
  return { level, peak, peakAtMs: s.peakAtMs }
}
