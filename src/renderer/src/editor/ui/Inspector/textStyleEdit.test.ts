import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFontOptions, CURATED_FONTS, joinColor, loadSystemFonts, resetSystemFontsCache, splitColor, weightOptions } from './textStyleEdit'

describe('cores com opacidade', () => {
  it('splitColor: #rgb, #rrggbb, #rrggbbaa; inválida/none = preto opaco', () => {
    expect(splitColor('#fff')).toEqual({ hex: '#ffffff', alpha: 1 })
    expect(splitColor('#FF3B30')).toEqual({ hex: '#ff3b30', alpha: 1 })
    expect(splitColor('#000000a6')).toEqual({ hex: '#000000', alpha: 0.65 })
    expect(splitColor('none')).toEqual({ hex: '#000000', alpha: 1 })
    expect(splitColor(undefined)).toEqual({ hex: '#000000', alpha: 1 })
  })
  it('joinColor: opacidade 1 vira #rrggbb; senão #rrggbbaa; idempotente com split', () => {
    expect(joinColor('#ff0000', 1)).toBe('#ff0000')
    expect(joinColor('#ff0000', 0.5)).toBe('#ff000080')
    expect(joinColor('#ff0000', 0)).toBe('#ff000000')
    expect(joinColor('#fff', 2)).toBe('#ffffff')
    const c = '#112233b3'
    const s = splitColor(c)
    expect(joinColor(s.hex, s.alpha)).toBe(c)
  })
})

describe('lista de fontes', () => {
  it('app, curada e do sistema sem repetir (maiúsculas ignoradas); fonte atual desconhecida entra no topo', () => {
    const o = buildFontOptions('Manrope Variable', ['Zapfino', 'arial', 'Agency FB'])
    const names = o.map((x) => x.value)
    expect(names[0]).toBe('Manrope Variable')
    for (const f of CURATED_FONTS) expect(names).toContain(f)
    expect(names.filter((n) => n.toLowerCase() === 'arial')).toHaveLength(1)
    expect(names.indexOf('Agency FB')).toBeLessThan(names.indexOf('Zapfino'))
    const custom = buildFontOptions('Minha Fonte', [])
    expect(custom[0]).toMatchObject({ value: 'Minha Fonte', hint: 'do projeto' })
  })
  it('as 13 fontes curadas do brief', () => {
    expect(CURATED_FONTS).toEqual(['Arial', 'Segoe UI', 'Calibri', 'Cambria', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Consolas', 'Courier New', 'Comic Sans MS'])
  })
  it('pesos: valor fora da lista aparece como personalizado', () => {
    expect(weightOptions(700)).toHaveLength(7)
    expect(weightOptions(350)[0]).toEqual({ value: '350', label: 'Personalizado (350)' })
  })
})

describe('loadSystemFonts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetSystemFontsCache()
  })
  it('sem a API: [] sem erro', async () => {
    vi.stubGlobal('queryLocalFonts', undefined)
    expect(await loadSystemFonts()).toEqual([])
  })
  it('permissão negada (a promessa rejeita): [] sem erro, e uma nova tentativa é possível', async () => {
    const q = vi.fn().mockRejectedValueOnce(new DOMException('negado', 'NotAllowedError')).mockResolvedValueOnce([{ family: 'Agency FB' }])
    vi.stubGlobal('queryLocalFonts', q)
    expect(await loadSystemFonts()).toEqual([])
    await Promise.resolve()
    expect(await loadSystemFonts()).toEqual(['Agency FB'])
    expect(q).toHaveBeenCalledTimes(2)
  })
  it('com a API: famílias únicas, em cache', async () => {
    const q = vi.fn().mockResolvedValue([{ family: 'A' }, { family: 'A' }, { family: 'B' }])
    vi.stubGlobal('queryLocalFonts', q)
    expect(await loadSystemFonts()).toEqual(['A', 'B'])
    expect(await loadSystemFonts()).toEqual(['A', 'B'])
    expect(q).toHaveBeenCalledTimes(1)
  })
})
