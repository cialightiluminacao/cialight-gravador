import { describe, expect, it } from 'vitest'
import { parseProgressLines } from './ffmpegRunner'

describe('parseProgressLines', () => {
  it('lê out_time_us, frame, fps e speed', () => {
    const p = parseProgressLines(['frame=120', 'fps=59.9', 'out_time_us=4000000', 'out_time_ms=4000000', 'speed=2.1x', 'progress=continue'])
    expect(p).toEqual({ outTimeUs: 4000000, frame: 120, speed: '2.1x', fps: 59.9 })
  })
  it('sem out_time → null', () => {
    expect(parseProgressLines(['frame=1', 'progress=continue'])).toBeNull()
  })
  it('ignora valores negativos (N/A)', () => {
    expect(parseProgressLines(['out_time_us=-9223372036854775808', 'progress=continue'])).toBeNull()
  })
})
