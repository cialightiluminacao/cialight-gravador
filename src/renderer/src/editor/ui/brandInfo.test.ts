import { describe, expect, it } from 'vitest'
import { applyMessage, marksAfterApply, marksMetaForApply, BRAND_KIND_LABEL, BRAND_MODE_LABEL, brandModes, formatBrandDuration } from './brandInfo'

describe('brandInfo', () => {
  it('marca d’água só nos tipos marca d’água e sobreposição', () => {
    expect(brandModes('watermark')).toContain('watermark')
    expect(brandModes('overlay')).toContain('watermark')
    expect(brandModes('intro')).toEqual(['playhead', 'intro', 'outro'])
    expect(brandModes('outro')).toEqual(['playhead', 'intro', 'outro'])
  })
  it('rótulos pt-BR das ações e tipos', () => {
    expect(Object.values(BRAND_MODE_LABEL)).toEqual(['Aplicar no playhead', 'Usar como abertura', 'Usar como encerramento', "Aplicar como marca d'água"])
    expect(Object.values(BRAND_KIND_LABEL)).toEqual(['Sobreposição', 'Abertura', 'Encerramento', "Marca d'água"])
  })
  it('duração', () => {
    expect(formatBrandDuration(3_000_000)).toBe('3 s')
    expect(formatBrandDuration(2_540_000)).toBe('2,5 s')
    expect(formatBrandDuration(65_000_000)).toBe('1 min 05 s')
    expect(formatBrandDuration(119_600_000)).toBe('2 min 00 s')
    expect(formatBrandDuration(59_960_000)).toBe('1 min 00 s')
  })
  it('mensagem da abertura diz quanto o projeto andou', () => {
    expect(applyMessage('intro', { name: 'Vinheta', durationUs: 3_000_000 }).description).toMatch(/^O projeto foi para a frente 3 s/)
  })
})

describe('marksAfterApply', () => {
  it('abertura: Entrada/Saída e playhead andam junto com o projeto; marcas vazias continuam vazias', () => {
    expect(marksAfterApply('intro', 2_000_000, { inUs: 1_000_000, outUs: 5_000_000, playheadUs: 3_000_000 })).toEqual({ inUs: 3_000_000, outUs: 7_000_000, playheadUs: 5_000_000 })
    expect(marksAfterApply('intro', 2_000_000, { inUs: null, outUs: 5_000_000, playheadUs: 0 })).toEqual({ inUs: null, outUs: 7_000_000, playheadUs: 2_000_000 })
  })
  it('outros modos não mexem', () => {
    const m = { inUs: 1, outUs: 2, playheadUs: 3 }
    for (const mode of ['playhead', 'outro', 'watermark'] as const) expect(marksAfterApply(mode, 2_000_000, m)).toBe(m)
  })
})

describe('marksMetaForApply', () => {
  const m = { inUs: 1_000_000, outUs: 3_000_000, playheadUs: 2_000_000 }
  it('abertura leva before/after', () => {
    expect(marksMetaForApply('intro', 2_000_000, m)).toEqual({ before: m, after: { inUs: 3_000_000, outUs: 5_000_000, playheadUs: 4_000_000 } })
  })
  it('outros modos e duração 0 não levam meta', () => {
    for (const mode of ['overlay', 'outro', 'watermark'] as const) expect(marksMetaForApply(mode as never, 2_000_000, m)).toBeUndefined()
    expect(marksMetaForApply('intro', 0, m)).toBeUndefined()
  })
})
