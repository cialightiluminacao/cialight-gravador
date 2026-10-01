import { describe, expect, it } from 'vitest'
import { parseColor } from './color'

describe('parseColor', () => {
  it('hex #rgb, #rrggbb e #rrggbbaa', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1])
    expect(parseColor('#000000')).toEqual([0, 0, 0, 1])
    expect(parseColor('#ffffff80')[3]).toBeCloseTo(128 / 255, 5)
  })
  it('rgb() e rgba()', () => {
    expect(parseColor('rgb(255, 0, 51)')).toEqual([1, 0, 0.2, 1])
    expect(parseColor('rgba(255,255,255,0.85)')).toEqual([1, 1, 1, 0.85])
  })
  it('inválida → preto opaco', () => {
    expect(parseColor('azul')).toEqual([0, 0, 0, 1])
  })
})
