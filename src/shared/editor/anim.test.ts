import { describe, expect, it } from 'vitest'
import { evalAnim, easeValue, setKey, removeKey, sliceKeys, setValue } from './anim'
const a = (keys: [number, number][]) => ({ value: 0, keys: keys.map(([tUs, value]) => ({ tUs, value, ease: 'linear' as const })) })
describe('anim', () => {
  it('constante sem keys', () => expect(evalAnim({ value: 3 }, 999)).toBe(3))
  it('clamp antes/depois', () => { const x = a([[100, 1], [200, 2]]); expect(evalAnim(x, 0)).toBe(1); expect(evalAnim(x, 500)).toBe(2) })
  it('linear no meio', () => expect(evalAnim(a([[0, 0], [100, 10]]), 25)).toBeCloseTo(2.5))
  it('hold segura até o próximo key', () => expect(evalAnim({ value: 0, keys: [{ tUs: 0, value: 1, ease: 'hold' }, { tUs: 100, value: 5, ease: 'linear' }] }, 99)).toBe(1))
  it('inOut é simétrico', () => { expect(easeValue('inOut', 0.5)).toBeCloseTo(0.5); expect(easeValue('inOut', 0.25)).toBeLessThan(0.25) })
  it('bezier linear equivale a linear', () => expect(easeValue({ bezier: [0, 0, 1, 1] }, 0.3)).toBeCloseTo(0.3, 3))
  it('setKey substitui e ordena', () => { const x = setKey(setKey({ value: 0 }, 200, 2), 100, 1); expect(x.keys!.map((k) => k.tUs)).toEqual([100, 200]); expect(setKey(x, 100, 9).keys![0].value).toBe(9) })
  it('removeKey do último devolve constante', () => { const x = removeKey(setKey({ value: 0 }, 50, 7), 50); expect(x.keys).toBeUndefined(); expect(x.value).toBe(7) })
  it('setValue sem keys altera value', () => expect(setValue({ value: 1 }, 10, 4)).toEqual({ value: 4 }))
  it('sliceKeys reancora e cria bordas', () => {
    const s = sliceKeys(a([[0, 0], [100, 10]]), 50, 100)
    expect(s.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 5], [50, 10]])
  })
})
