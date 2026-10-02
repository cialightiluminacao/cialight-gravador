import { describe, expect, it } from 'vitest'
import { evalAnim, easeValue, setKey, removeKey, sliceKeys, setValue, setEase, easeAt, copyKeys, pasteKeys, subEase, insertKeyExact } from './anim'
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

describe('ease por key (F4)', () => {
  const k3 = (e: import('./project').Ease) => ({ value: 0, keys: [{ tUs: 0, value: 0, ease: e }, { tUs: 1000, value: 100, ease: 'linear' as const }] })
  it('ease do key muda a interpolação', () => {
    expect(evalAnim(k3('linear'), 500)).toBeCloseTo(50)
    expect(evalAnim(k3('in'), 500)).toBeCloseTo(12.5)
    expect(evalAnim(k3('out'), 500)).toBeCloseTo(87.5)
    expect(evalAnim(k3('hold'), 999)).toBe(0)
    // overshoot: y livre no bezier
    expect(evalAnim(k3({ bezier: [0.3, 1.6, 0.6, 1.6] }), 600)).toBeGreaterThan(100)
  })
  it('setEase troca o ease do key a ±1 µs; sem key não muda', () => {
    const a = setEase(k3('linear'), 1, 'in')
    expect(a.keys![0].ease).toBe('in')
    expect(evalAnim(a, 500)).toBeCloseTo(12.5)
    const b = k3('linear')
    expect(setEase(b, 400, 'in')).toBe(b)
  })
  it('easeAt: key no instante → o dele; no meio de um trecho → o do trecho; fora → null', () => {
    const a = { value: 0, keys: [{ tUs: 100, value: 0, ease: 'in' as const }, { tUs: 200, value: 1, ease: 'out' as const }] }
    expect(easeAt(a, 100)).toBe('in')
    expect(easeAt(a, 150)).toBe('in')
    expect(easeAt(a, 201)).toBe('out')
    expect(easeAt(a, 50)).toBeNull()
    expect(easeAt(a, 300)).toBeNull()
    expect(easeAt({ value: 1 }, 0)).toBeNull()
  })
  it('copyKeys: keys do intervalo com tempo relativo ao início', () => {
    const a = { value: 0, keys: [{ tUs: 100, value: 1, ease: 'in' as const }, { tUs: 300, value: 2, ease: 'linear' as const }, { tUs: 900, value: 3, ease: 'linear' as const }] }
    expect(copyKeys(a, 100, 500)).toEqual([{ tUs: 0, value: 1, ease: 'in' }, { tUs: 200, value: 2, ease: 'linear' }])
    expect(copyKeys({ value: 1 }, 0, 10)).toEqual([])
  })
  it('pasteKeys: tempos relativos preservados a partir de at; substitui os keys do trecho colado', () => {
    const a = { value: 0, keys: [{ tUs: 0, value: 5, ease: 'linear' as const }, { tUs: 500, value: 6, ease: 'linear' as const }, { tUs: 2000, value: 7, ease: 'linear' as const }] }
    const clip = [{ tUs: 0, value: 1, ease: 'in' as const }, { tUs: 400, value: 2, ease: 'linear' as const }]
    const r = pasteKeys(a, clip, 300, 3000)
    expect(r.keys!.map((k) => [k.tUs, k.value, k.ease])).toEqual([[0, 5, 'linear'], [300, 1, 'in'], [700, 2, 'linear'], [2000, 7, 'linear']])
  })
  it('pasteKeys: o que passa da duração é cortado com key de borda no valor da curva colada (sem salto)', () => {
    const clip = [{ tUs: 0, value: 0, ease: 'linear' as const }, { tUs: 1000, value: 100, ease: 'linear' as const }, { tUs: 2000, value: 0, ease: 'linear' as const }]
    const r = pasteKeys({ value: 9 }, clip, 500, 1000)
    expect(r.keys!.map((k) => [k.tUs, k.value])).toEqual([[500, 0], [1000, 50]])
    // curva não linear: a borda reproduz o pedaço exato
    const c2 = [{ tUs: 0, value: 0, ease: 'in' as const }, { tUs: 1000, value: 100, ease: 'linear' as const }]
    const r2 = pasteKeys({ value: 0 }, c2, 0, 600)
    for (const t of [0, 100, 250, 400, 600]) expect(evalAnim(r2, t)).toBeCloseTo(evalAnim({ value: 0, keys: c2 }, t), 6)
    expect(pasteKeys({ value: 3 }, [], 0, 10)).toEqual({ value: 3 })
  })
})

describe('corte exato de curvas (subEase / insertKeyExact)', () => {
  const eases: import('./project').Ease[] = ['linear', 'hold', 'in', 'out', 'inOut', { bezier: [0.25, 0.1, 0.25, 1] }, { bezier: [0.3, -0.4, 0.6, 1.6] }]
  const curve = (e: import('./project').Ease) => ({ value: 0, keys: [{ tUs: 0, value: 10, ease: e }, { tUs: 10_000, value: 110, ease: 'linear' as const }] })
  it('subEase reproduz o trecho [p0,p1] do ease', () => {
    for (const e of eases.filter((x) => x !== 'inOut')) {
      for (const [p0, p1] of [[0, 0.3], [0.3, 1], [0.2, 0.7]]) {
        const s = subEase(e, p0, p1)
        const y0 = easeValue(e, p0), y1 = easeValue(e, p1)
        if (e === 'hold') continue
        for (const q of [0.1, 0.35, 0.5, 0.8]) expect(y0 + (y1 - y0) * easeValue(s, q)).toBeCloseTo(easeValue(e, p0 + (p1 - p0) * q), 5)
      }
    }
  })
  it('insertKeyExact não muda a curva (nenhum ease)', () => {
    for (const e of eases) {
      const a = curve(e)
      for (const at of [1, 2_500, 5_000, 7_300, 9_999]) {
        const b = insertKeyExact(a, at)
        expect(b.keys!.some((k) => k.tUs === at)).toBe(true)
        for (let t = 0; t <= 10_000; t += 250) expect(evalAnim(b, t)).toBeCloseTo(evalAnim(a, t), 4)
      }
    }
  })
  it('sliceKeys mantém a forma da curva nos dois pedaços (split invisível)', () => {
    for (const e of eases) {
      const a = curve(e)
      const L = sliceKeys(a, 0, 3_700), R = sliceKeys(a, 3_700, 10_000)
      for (let t = 0; t <= 3_700; t += 100) expect(evalAnim(L, t)).toBeCloseTo(evalAnim(a, t), 4)
      for (let t = 3_700; t <= 10_000; t += 100) expect(evalAnim(R, t - 3_700)).toBeCloseTo(evalAnim(a, t), 4)
      const M = sliceKeys(a, 2_000, 6_000) // corte dos dois lados no mesmo trecho
      for (let t = 2_000; t <= 6_000; t += 100) expect(evalAnim(M, t - 2_000)).toBeCloseTo(evalAnim(a, t), 4)
    }
  })
})
