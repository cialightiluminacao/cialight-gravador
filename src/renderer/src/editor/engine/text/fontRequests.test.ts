import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTextItem } from '@shared/editor/factory'
import { fontFamilyOf, projectFontRequests } from './fontRequests'

describe('projectFontRequests', () => {
  it('uma requisição por fonte (estilo/peso/família), com os caracteres dos textos', () => {
    const p = createEmptyProject('f')
    const a = { ...createTextItem('title', 0), text: 'Olá' }
    const b = { ...createTextItem('title', 5_000_000), text: 'ação' }
    const c = { ...createTextItem('subtitle', 10_000_000), text: 'x', style: { ...createTextItem('subtitle', 0).style, font: 'Arial', italic: true } }
    p.tracks[0].items = [a, b, c]
    const r = projectFontRequests(p)
    expect(r).toHaveLength(2)
    expect(r[0].font).toBe(`normal ${a.style.weight} 16px "Manrope Variable", sans-serif`)
    expect([...r[0].text].sort().join('')).toBe([...new Set('Oláação')].sort().join(''))
    expect(r[1]).toEqual({ font: `italic ${c.style.weight} 16px "Arial", sans-serif`, text: 'x' })
  })
  it('contagem: dígitos e sinal; projeto sem texto: nada', () => {
    const p = createEmptyProject('f')
    expect(projectFontRequests(p)).toEqual([])
    p.tracks[0].items = [createTextItem('countdown', 0)]
    expect(projectFontRequests(p)[0].text).toBe('-0123456789')
  })
  it('fontFamilyOf: família da fonte CSS (aviso de fonte que não carregou)', () => {
    expect(fontFamilyOf('normal 800 16px "Manrope Variable", sans-serif')).toBe('Manrope Variable')
    expect(fontFamilyOf('italic 400 16px "Arial", sans-serif')).toBe('Arial')
  })
})
