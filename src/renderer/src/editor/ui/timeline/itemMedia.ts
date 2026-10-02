import { evalAnim } from '@shared/editor/anim'
import type { FilmstripInfo, MediaItem, Us } from '@shared/editor/project'

// Matemática pura do conteúdo dos itens: qual quadro do sprite (filmstrip) mostrar em cada
// posição, o min/max da forma de onda por coluna de pixel (peaks: Int8 min/max, 100 por segundo) e o ganho
// de exibição por coluna (volume da faixa × volume do item com keyframes).

export const PEAKS_PER_SEC = 100
const PEAK_US = 1e6 / PEAKS_PER_SEC

/** Instante da fonte mostrado em `localUs` (tempo dentro do item), com inUs, velocidade, reverso e congelado. */
export function sourceUsAt(item: Pick<MediaItem, 'inUs' | 'speed' | 'reverse' | 'durationUs' | 'freeze'>, localUs: Us): Us {
  if (item.freeze) return item.freeze.atUs
  const off = item.reverse ? item.durationUs - localUs : localUs
  return Math.round(item.inUs + off * item.speed)
}

/**
 * Quadros do filmstrip: um slot de `slotW` px a cada `slotW` px a partir do início do item (não
 * "nada" ao rolar); só os slots que cruzam [clipFromPx, clipToPx) (px relativos ao início do item).
 */
export function filmstripSlots(item: MediaItem, fs: FilmstripInfo, slotW: number, pxPerSec: number, clipFromPx: number, clipToPx: number): { x: number; frame: number }[] {
  const out: { x: number; frame: number }[] = []
  if (slotW <= 0 || fs.frames <= 0) return out
  const itemW = (item.durationUs * pxPerSec) / 1e6
  const first = Math.max(0, Math.floor(clipFromPx / slotW))
  for (let i = first; ; i++) {
    const x = i * slotW
    if (x >= clipToPx || x >= itemW) break
    const src = sourceUsAt(item, Math.min(item.durationUs, Math.round((x * 1e6) / pxPerSec)))
    out.push({ x, frame: Math.min(fs.frames - 1, Math.max(0, Math.floor(src / fs.everyUs))) })
  }
  return out
}

/** min/max (intercalados) por coluna de pixel em [fromPx, toPx) relativos ao início do item. */
export function waveColumns(peaks: Int8Array, item: MediaItem, pxPerSec: number, fromPx: number, toPx: number): Int8Array {
  const n = Math.max(0, Math.ceil(toPx - fromPx))
  const out = new Int8Array(n * 2)
  const count = peaks.length >> 1
  for (let c = 0; c < n; c++) {
    const l0 = ((fromPx + c) * 1e6) / pxPerSec
    const l1 = ((fromPx + c + 1) * 1e6) / pxPerSec
    const s0 = sourceUsAt(item, Math.round(l0)), s1 = sourceUsAt(item, Math.round(l1))
    const i0 = Math.max(0, Math.floor(Math.min(s0, s1) / PEAK_US))
    const i1 = Math.min(count, Math.max(i0 + 1, Math.ceil(Math.max(s0, s1) / PEAK_US)))
    let mn = 0, mx = 0
    for (let i = i0; i < i1; i++) {
      const a = peaks[i * 2], b = peaks[i * 2 + 1]
      if (a < mn) mn = a
      if (b > mx) mx = b
    }
    out[c * 2] = mn
    out[c * 2 + 1] = mx
  }
  return out
}

/** Altura relativa da onda com o áudio do item desligado (fica visível, mas apagada). */
export const WAVE_DISABLED_GAIN = 0.15

/**
 * Ganho de exibição por coluna de pixel em [fromPx, fromPx + n) (relativos ao início do item): volume da faixa ×
 * volume do item no meio da coluna (estático + keyframes). Fades e ducking não entram (têm a sua própria marcação).
 */
export function waveGains(item: Pick<MediaItem, 'audio'>, trackVolume: number, pxPerSec: number, fromPx: number, n: number): Float32Array {
  const out = new Float32Array(Math.max(0, n))
  if (!item.audio.enabled) return out.fill(WAVE_DISABLED_GAIN)
  const vol = item.audio.volume
  if (!vol.keys?.length) return out.fill(trackVolume * vol.value)
  for (let c = 0; c < out.length; c++) out[c] = trackVolume * evalAnim(vol, Math.round(((fromPx + c + 0.5) * 1e6) / pxPerSec))
  return out
}
