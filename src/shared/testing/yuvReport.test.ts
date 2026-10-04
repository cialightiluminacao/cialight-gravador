import { describe, expect, it } from 'vitest'
import { colorEdgeMask, refDiffMax, rgbDiffStats } from './yuvReport'

describe('rgbDiffStats (paridade caminho antigo × YUV)', () => {
  it('máximo e p99 da diferença por canal RGB (alfa ignorado), contagem acima do limite', () => {
    const n = 200
    const a = new Uint8Array(n * 4)
    const b = new Uint8Array(n * 4)
    for (let i = 0; i < n; i++) {
      a[i * 4] = 100
      b[i * 4] = i < 2 ? 105 : i < 10 ? 101 : 100 // 2 px com 5, 8 px com 1, o resto igual
      a[i * 4 + 3] = 0
      b[i * 4 + 3] = 255 // alfa: não conta
    }
    expect(rgbDiffStats(a, b, 2)).toEqual({ max: 5, p99: 1, over: 2, n: 600 })
  })

  it('imagens iguais: tudo zero', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rgbDiffStats(a, a.slice(), 2)).toEqual({ max: 0, p99: 0, over: 0, n: 6 })
  })
})

describe('colorEdgeMask (exceção de 1 px nas bordas de croma)', () => {
  // 4×1 px: preto, preto, branco, branco (borda entre x=1 e x=2)
  const img = (vals: number[]): Uint8Array => new Uint8Array(vals.flatMap((v) => [v, v, v, 255]))

  it('marca só os 2 pixels (1 px de cada lado) de um salto > limite presente nas DUAS imagens', () => {
    const a = img([0, 0, 255, 255])
    expect([...colorEdgeMask(a, a, 4, 1, 16)]).toEqual([0, 1, 1, 0])
    const b = img([0, 0, 0, 10]) // salto pequeno em b
    expect([...colorEdgeMask(b, b, 4, 1, 16)]).toEqual([0, 0, 0, 0])
    expect([...colorEdgeMask(b, a, 4, 1, 16)]).toEqual([0, 0, 0, 0]) // borda só numa delas: não é borda da fonte
  })

  it('um erro que cria a própria borda NÃO é mascarado', () => {
    const a = img([50, 50, 50, 50, 50])
    const b = img([50, 50, 170, 50, 50]) // pixel errado em b: saltos só em b
    const mask = colorEdgeMask(a, b, 5, 1, 16)
    expect([...mask]).toEqual([0, 0, 0, 0, 0])
    expect(rgbDiffStats(a, b, 2, mask).max).toBe(120)
  })

  it('vertical também: borda entre linhas presente nas duas imagens; última linha errada só numa delas não é borda', () => {
    const a = new Uint8Array([10, 10, 10, 255, 10, 10, 10, 255, 200, 10, 10, 255]) // 1×3
    expect([...colorEdgeMask(a, a, 1, 3, 16)]).toEqual([0, 1, 1])
    const b = new Uint8Array([10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255])
    expect([...colorEdgeMask(a, b, 1, 3, 16)]).toEqual([0, 0, 0])
  })

  it('rgbDiffStats com máscara ignora os pixels marcados', () => {
    const a = img([0, 0, 255, 255])
    const b = img([0, 0, 100, 255]) // borda 1|2 nas duas (pixels 1 e 2 fora); 2|3 só em b (não mascara)
    expect(rgbDiffStats(a, b, 2, colorEdgeMask(a, b, 4, 1, 16))).toEqual({ max: 0, p99: 0, over: 0, n: 6 })
  })
})

describe('refDiffMax (oráculo: conta de referência da matriz)', () => {
  it('maior diferença por canal RGB contra a referência, só onde ela existe e fora da máscara', () => {
    const a = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 255, 50, 50, 50, 255])
    const ref = (x: number): [number, number, number] | null => (x === 0 ? [12, 20, 30] : x === 1 ? null : [0, 0, 0])
    expect(refDiffMax(a, ref, 3, 1)).toBe(50)
    expect(refDiffMax(a, ref, 3, 1, new Uint8Array([0, 0, 1]))).toBe(2)
  })
})
