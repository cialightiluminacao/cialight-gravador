import { describe, expect, it } from 'vitest'
import { gpuVendorOrder, PROBE_CANDIDATES } from './encoderProbe'

describe('gpuVendorOrder', () => {
  it('NVIDIA primeiro quando presente', () => {
    expect(gpuVendorOrder([{ vendor: 'Intel' }, { vendor: 'NVIDIA' }])).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264'])
  })
  it('Intel sem NVIDIA', () => {
    expect(gpuVendorOrder([{ vendor: 'Intel' }])).toEqual(['h264_qsv', 'h264_amf', 'h264_mf', 'h264_nvenc', 'libx264'])
  })
  it('AMD/desconhecida: AMF logo depois do QSV', () => {
    expect(gpuVendorOrder([{ vendor: 'AMD' }])[0]).toBe('h264_mf')
    expect(gpuVendorOrder([])).toEqual(['h264_mf', 'h264_qsv', 'h264_amf', 'h264_nvenc', 'libx264'])
  })
  it('toda ordem testa o AMF (h264_amf) e termina em libx264', () => {
    for (const v of ['NVIDIA', 'Intel', 'AMD', '']) {
      const o = gpuVendorOrder(v ? [{ vendor: v }] : [])
      expect(o.indexOf('h264_amf')).toBe(o.indexOf('h264_qsv') + 1)
      expect(o[o.length - 1]).toBe('libx264')
    }
    expect(PROBE_CANDIDATES).toContain('h264_amf')
  })
})
