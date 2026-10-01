import { describe, expect, it } from 'vitest'
import { snapToFrame, usToFrame, frameToUs, formatTimecodeUs } from './time'
describe('time', () => {
  it('snapToFrame', () => { expect(snapToFrame(16_000, 30)).toBe(0); expect(snapToFrame(17_000, 30)).toBe(33_333) })
  it('ida e volta de quadro', () => expect(usToFrame(frameToUs(123, 30), 30)).toBe(123))
  it('ida e volta em todo quadro, mesmo quando frameToUs arredonda para baixo (ex.: 91 @ 30 → 3 033 333 µs)', () => {
    for (const fps of [24, 25, 29.97, 30, 50, 59.94, 60, 120]) {
      for (let f = 0; f < 2000; f++) expect(usToFrame(frameToUs(f, fps), fps)).toBe(f)
    }
    expect(formatTimecodeUs(3_033_333, 30)).toBe('00:03:01')
  })
  it('timecode', () => {
    expect(formatTimecodeUs(61_500_000, 30)).toBe('01:01:15')
    expect(formatTimecodeUs(3_600_000_000, 30)).toBe('01:00:00:00')
  })
})
