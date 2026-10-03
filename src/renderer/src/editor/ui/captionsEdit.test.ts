import { describe, expect, it } from 'vitest'
import { nextCaptionAt, planTimeEdit, warningsSummary } from './captionsEdit'

const S = 1_000_000
const item = { startUs: 2 * S, durationUs: 2 * S } // [2, 4)

describe('planTimeEdit', () => {
  it('igual (no ms) → same; mudança → novo intervalo mantendo o outro lado', () => {
    expect(planTimeEdit(item, 'start', '00:02,000')).toEqual({ kind: 'same' })
    expect(planTimeEdit(item, 'end', '0:04')).toEqual({ kind: 'same' })
    expect(planTimeEdit(item, 'start', '00:01,500')).toEqual({ kind: 'change', startUs: 1.5 * S, endUs: 4 * S })
    expect(planTimeEdit(item, 'end', '00:05,250')).toEqual({ kind: 'change', startUs: 2 * S, endUs: 5.25 * S })
  })
  it('ilegível ou invertido → invalid com mensagem em pt-BR', () => {
    expect(planTimeEdit(item, 'start', 'abc')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/Tempo inválido/) })
    expect(planTimeEdit(item, 'start', '00:04,000')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/início/) })
    expect(planTimeEdit(item, 'end', '00:01,000')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/fim/) })
  })
})

describe('nextCaptionAt', () => {
  it('no playhead; dentro/antes do fim da última → logo depois dela', () => {
    expect(nextCaptionAt(5 * S, null)).toBe(5 * S)
    expect(nextCaptionAt(5 * S, item)).toBe(5 * S)
    expect(nextCaptionAt(2 * S, item)).toBe(4 * S)
    expect(nextCaptionAt(0, item)).toBe(4 * S)
  })
})

describe('warningsSummary', () => {
  it('até 3 e "… e mais N"', () => {
    expect(warningsSummary([])).toBe('')
    expect(warningsSummary(['a', 'b'])).toBe('a\nb')
    expect(warningsSummary(['a', 'b', 'c', 'd'])).toBe('a\nb\nc\n… e mais 1 aviso')
    expect(warningsSummary(['a', 'b', 'c', 'd', 'e'])).toBe('a\nb\nc\n… e mais 2 avisos')
  })
})
