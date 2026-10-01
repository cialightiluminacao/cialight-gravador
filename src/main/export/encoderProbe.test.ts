import { describe, expect, it } from 'vitest'
import type { EncoderProbe } from '@shared/types'
import { encoderFallbackChain, PROBE_ARGS_VERSION, usableCachedProbe, v1ProbeProjection } from '@shared/encoderCache'
import { gpuVendorOrder, PROBE_CANDIDATES, validationArgSets } from './encoderProbe'

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
  const amd: EncoderProbe = { gpuKey: 'g', probedAt: 'x', available: ['h264_amf', 'h264_mf', 'libx264'], preferred: 'h264_amf', argsVersion: PROBE_ARGS_VERSION }
  it('projeção v1: sem AMF nem campos novos, preferido = primeiro não-AMF', () => {
    const v1 = { gpuKey: 'g', probedAt: 'x' }
    expect(v1ProbeProjection(amd)).toStrictEqual({ ...v1, available: ['h264_mf', 'libx264'], preferred: 'h264_mf' })
    expect(v1ProbeProjection({ ...amd, available: ['h264_amf', 'libx264'] })).toStrictEqual({ ...v1, available: ['libx264'], preferred: 'libx264' })
    const intel: EncoderProbe = { ...v1, available: ['h264_qsv', 'libx264'], preferred: 'h264_qsv' }
    expect(v1ProbeProjection(intel)).toStrictEqual(intel)
  })
  it('só confia no encoderProbeV2: instalação antiga (só lastEncoderProbe) refaz o probe', () => {
    expect(usableCachedProbe({ encoderProbeV2: null }, 'g')).toBeNull()
    expect(usableCachedProbe({ encoderProbeV2: amd }, 'g')).toBe(amd)
    expect(usableCachedProbe({ encoderProbeV2: amd }, 'outra-gpu')).toBeNull()
    expect(usableCachedProbe({ encoderProbeV2: { ...amd, available: [] } }, 'g')).toBeNull()
    expect(usableCachedProbe({ encoderProbeV2: amd }, null)).toBe(amd)
  })
  it('cache validado com argumentos antigos (antes da validação com os argumentos reais) não vale: refaz o probe', () => {
    const { argsVersion: _drop, ...old } = amd
    void _drop
    expect(usableCachedProbe({ encoderProbeV2: old }, 'g')).toBeNull()
    expect(usableCachedProbe({ encoderProbeV2: { ...amd, argsVersion: PROBE_ARGS_VERSION - 1 } }, null)).toBeNull()
  })
})

describe('encoderFallbackChain', () => {
  const probe: EncoderProbe = { gpuKey: 'g', probedAt: 'x', available: ['h264_qsv', 'h264_amf', 'h264_mf', 'libx264'], preferred: 'h264_qsv' }
  it('preferido, depois os outros disponíveis na ordem do probe, e sempre libx264 no fim', () => {
    expect(encoderFallbackChain(probe)).toEqual(['h264_qsv', 'h264_amf', 'h264_mf', 'libx264'])
    expect(encoderFallbackChain(probe, 'h264_amf')).toEqual(['h264_amf', 'h264_qsv', 'h264_mf', 'libx264'])
    expect(encoderFallbackChain({ ...probe, available: ['h264_nvenc'], preferred: 'h264_nvenc' })).toEqual(['h264_nvenc', 'libx264'])
  })
  it('sem probe: libx264 (ou o pedido, depois libx264)', () => {
    expect(encoderFallbackChain(null)).toEqual(['libx264'])
    expect(encoderFallbackChain(null, 'h264_amf')).toEqual(['h264_amf', 'libx264'])
  })
})

describe('validationArgSets (probe com os argumentos reais)', () => {
  const has = (args: string[], flag: string, value: string): boolean => args.some((a, i) => a === flag && args[i + 1] === value)
  it('AMF: exporta com -rc cqp, -bf do preset e -profile:v; proxy/intermediário também entram', () => {
    const sets = validationArgSets('h264_amf')
    expect(sets.every((s) => has(s, '-c:v', 'h264_amf'))).toBe(true)
    expect(sets.some((s) => has(s, '-rc', 'cqp') && has(s, '-bf', '2') && has(s, '-profile:v', 'high'))).toBe(true) // preset Alta/Máxima
    expect(sets.some((s) => has(s, '-profile:v', 'main') && has(s, '-bf', '0'))).toBe(true) // WhatsApp
    expect(sets.some((s) => has(s, '-quality', 'speed'))).toBe(true) // proxy
    expect(sets.some((s) => has(s, '-quality', 'quality') && !s.includes('-profile:v'))).toBe(true) // intermediário
    expect(new Set(sets.map((s) => s.join(' '))).size).toBe(sets.length) // sem repetição
  })
  it('cada conjunto é um encode curto para o null muxer', () => {
    for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_mf'] as const) {
      for (const s of validationArgSets(enc)) {
        expect(s.slice(-3)).toEqual(['-f', 'null', '-'])
        expect(s).toContain('-frames:v')
      }
    }
  })
})
