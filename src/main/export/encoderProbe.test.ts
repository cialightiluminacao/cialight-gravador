import { describe, expect, it } from 'vitest'
import { gpuVendorOrder } from './encoderProbe'

describe('gpuVendorOrder', () => {
  it('NVIDIA primeiro quando presente', () => {
    expect(gpuVendorOrder([{ vendor: 'Intel' }, { vendor: 'NVIDIA' }])).toEqual(['h264_nvenc', 'h264_qsv', 'h264_mf', 'libx264'])
  })
  it('Intel sem NVIDIA', () => {
    expect(gpuVendorOrder([{ vendor: 'Intel' }])).toEqual(['h264_qsv', 'h264_mf', 'h264_nvenc', 'libx264'])
  })
  it('AMD/desconhecida', () => {
    expect(gpuVendorOrder([{ vendor: 'AMD' }])[0]).toBe('h264_mf')
    expect(gpuVendorOrder([])).toEqual(['h264_mf', 'h264_qsv', 'h264_nvenc', 'libx264'])
  })
})
