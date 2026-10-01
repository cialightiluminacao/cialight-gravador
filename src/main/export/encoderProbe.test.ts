import { describe, expect, it } from 'vitest'
import type { EncoderProbe } from '@shared/types'
import { usableCachedProbe, v1ProbeProjection } from '@shared/encoderCache'
import { gpuVendorOrder, PROBE_CANDIDATES } from './encoderProbe'

describe('gpuVendorOrder', () => {
  it('NVIDIA primeiro quando presente', () => {
    expect(gpuVendorOrder([{ vendor: 'Intel' }, { vendor: 'NVIDIA' }])).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264'])
  })
  it('Intel sem NVIDIA', () => {
    expect(gpuVendorOrder([{ vendor: 'Intel' }])).toEqual(['h264_qsv', 'h264_amf', 'h264_mf', 'h264_nvenc', 'libx264'])
  })
  it('AMD: AMF antes do Media Foundation', () => {
    expect(gpuVendorOrder([{ vendor: 'AMD' }])).toEqual(['h264_amf', 'h264_mf', 'h264_qsv', 'h264_nvenc', 'libx264'])
    expect(gpuVendorOrder([{ vendor: '0x1002' }])[0]).toBe('h264_amf')
    expect(gpuVendorOrder([{ vendor: 'Advanced Micro Devices, Inc.' }])[0]).toBe('h264_amf')
  })
  it('desconhecida: AMF logo depois do QSV', () => {
    expect(gpuVendorOrder([])).toEqual(['h264_mf', 'h264_qsv', 'h264_amf', 'h264_nvenc', 'libx264'])
  })
  it('toda ordem testa o AMF (h264_amf) e termina em libx264', () => {
    for (const v of ['NVIDIA', 'Intel', 'AMD', '']) {
      const o = gpuVendorOrder(v ? [{ vendor: v }] : [])
      expect(o).toContain('h264_amf')
      expect(o[o.length - 1]).toBe('libx264')
    }
    expect(PROBE_CANDIDATES).toContain('h264_amf')
  })
})

describe('cache do probe (v1.0.1 divide o settings.json)', () => {
  const amd: EncoderProbe = { gpuKey: 'g', probedAt: 'x', available: ['h264_amf', 'h264_mf', 'libx264'], preferred: 'h264_amf' }
  it('projeção v1: sem AMF, preferido = primeiro não-AMF', () => {
    expect(v1ProbeProjection(amd)).toEqual({ ...amd, available: ['h264_mf', 'libx264'], preferred: 'h264_mf' })
    expect(v1ProbeProjection({ ...amd, available: ['h264_amf', 'libx264'] })).toEqual({ ...amd, available: ['libx264'], preferred: 'libx264' })
    const intel: EncoderProbe = { ...amd, available: ['h264_qsv', 'libx264'], preferred: 'h264_qsv' }
    expect(v1ProbeProjection(intel)).toEqual(intel)
  })
  it('só confia no encoderProbeV2: instalação antiga (só lastEncoderProbe) refaz o probe', () => {
    expect(usableCachedProbe({ encoderProbeV2: null }, 'g')).toBeNull()
    expect(usableCachedProbe({ encoderProbeV2: amd }, 'g')).toBe(amd)
    expect(usableCachedProbe({ encoderProbeV2: amd }, 'outra-gpu')).toBeNull()
    expect(usableCachedProbe({ encoderProbeV2: { ...amd, available: [] } }, 'g')).toBeNull()
    expect(usableCachedProbe({ encoderProbeV2: amd }, null)).toBe(amd)
  })
})
