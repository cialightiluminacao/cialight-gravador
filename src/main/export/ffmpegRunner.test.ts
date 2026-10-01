import { describe, expect, it } from 'vitest'
import { parseKeyframeTimes, parseProgressLines } from './ffmpegRunner'

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

describe('parseKeyframeTimes', () => {
  it('lê um instante por linha (CRLF, vírgula final) e ignora linhas vazias', () => {
    expect(parseKeyframeTimes('0.000000\r\n0.500000,\r\n1.000000\r\n')).toEqual([0, 0.5, 1])
  })
  it('sem 0 espúrio da linha vazia final nem de linhas em branco', () => {
    expect(parseKeyframeTimes('2.000000\n\n  \n4.000000\n')).toEqual([2, 4])
    expect(parseKeyframeTimes('')).toEqual([])
  })
  it('ignora valores não numéricos (N/A)', () => {
    expect(parseKeyframeTimes('N/A\n1.5\n')).toEqual([1.5])
  })
})
