import { describe, expect, it } from 'vitest'
import { snapToFrame, usToFrame, frameToUs, formatTimecodeUs } from './time'
describe('time', () => {
  it('snapToFrame', () => { expect(snapToFrame(16_000, 30)).toBe(0); expect(snapToFrame(17_000, 30)).toBe(33_333) })
  it('ida e volta de quadro', () => expect(usToFrame(frameToUs(123, 30), 30)).toBe(123))
  it('timecode', () => {
    expect(formatTimecodeUs(61_500_000, 30)).toBe('01:01:15')
    expect(formatTimecodeUs(3_600_000_000, 30)).toBe('01:00:00:00')
  })
})
