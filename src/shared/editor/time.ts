import type { Us } from './project'

export const msToUs = (ms: number): Us => Math.round(ms * 1000)
export const usToMs = (us: Us): number => us / 1000
export const usToSec = (us: Us): number => us / 1e6
export const secToUs = (s: number): Us => Math.round(s * 1e6)
export const frameDurUs = (fps: number): Us => Math.round(1e6 / fps)
export const usToFrame = (us: Us, fps: number): number => Math.floor((us * fps) / 1e6 + 1e-6)
export const frameToUs = (frame: number, fps: number): Us => Math.round((frame * 1e6) / fps)
export const snapToFrame = (us: Us, fps: number): Us => frameToUs(Math.round((us * fps) / 1e6), fps)
export const itemEndUs = (it: { startUs: Us; durationUs: Us }): Us => it.startUs + it.durationUs

/** "HH:MM:SS:FF" (sem horas se < 1h → "MM:SS:FF"). */
export function formatTimecodeUs(us: Us, fps: number): string {
  const totalFrames = Math.max(0, usToFrame(us, fps))
  const fpsInt = Math.max(1, Math.round(fps))
  const ff = totalFrames % fpsInt
  const totalSec = Math.floor(totalFrames / fpsInt)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600)
  const p = (n: number): string => String(n).padStart(2, '0')
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}` : `${p(mm)}:${p(ss)}:${p(ff)}`
}
