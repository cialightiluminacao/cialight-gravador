import { describe, expect, it } from 'vitest'
import { applyMessage, BRAND_KIND_LABEL, BRAND_MODE_LABEL, brandModes, formatBrandDuration } from './brandInfo'

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
