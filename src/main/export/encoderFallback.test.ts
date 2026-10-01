import { describe, expect, it } from 'vitest'
import type { HwEncoder } from '@shared/types'
import { runWithEncoderFallback } from './encoderFallback'

class EncFail extends Error {}

describe('runWithEncoderFallback', () => {
  it('falha do encoder → tenta o próximo da lista até dar certo', async () => {
    const tried: HwEncoder[] = []
    const switched: string[] = []
    const r = await runWithEncoderFallback(['h264_amf', 'h264_mf', 'libx264'], async (enc) => {
      tried.push(enc)
      if (enc !== 'libx264') throw new EncFail(`${enc} quebrou`)
      return 'ok'
    }, { retryable: (e) => e instanceof EncFail, onFallback: (from, to) => switched.push(`${from}→${to}`) })
    expect(r).toEqual({ value: 'ok', encoder: 'libx264' })
    expect(tried).toEqual(['h264_amf', 'h264_mf', 'libx264'])
    expect(switched).toEqual(['h264_amf→h264_mf', 'h264_mf→libx264'])
  })
  it('erro que não é do encoder (cancelamento, disco) não troca de encoder', async () => {
    const tried: HwEncoder[] = []
    await expect(runWithEncoderFallback(['h264_qsv', 'libx264'], async (enc) => {
      tried.push(enc)
      throw new Error('cancelado')
    }, { retryable: (e) => e instanceof EncFail })).rejects.toThrow('cancelado')
    expect(tried).toEqual(['h264_qsv'])
  })
  it('todos falham → lança o erro do último', async () => {
    await expect(runWithEncoderFallback(['h264_qsv', 'libx264'], async (enc) => {
      throw new EncFail(enc)
    }, { retryable: () => true })).rejects.toThrow('libx264')
  })
})
