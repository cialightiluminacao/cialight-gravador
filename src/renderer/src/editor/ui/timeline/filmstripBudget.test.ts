import { describe, expect, it } from 'vitest'
import { FILMSTRIP_BUDGET_BYTES, FilmstripBudget, filmstripBytes } from './filmstripBudget'

const MB = 2 ** 20

describe('filmstripBytes / constantes', () => {
  it('orçamento de 200 MiB (spec §13) e bytes decodificados = (quadros·tileW)·tileH·4', () => {
    expect(FILMSTRIP_BUDGET_BYTES).toBe(200 * MB)
    expect(filmstripBytes({ frames: 300, tileW: 114, tileH: 64 })).toBe(300 * 114 * 64 * 4)
  })
})

describe('FilmstripBudget', () => {
  it('admite sprites montados enquanto cabem; a mesma sprite em vários itens conta uma vez', () => {
    const b = new FilmstripBudget(10 * MB)
    b.acquire('a', 4 * MB)
    b.acquire('a', 4 * MB)
    b.acquire('b', 4 * MB)
    expect(b.admitted('a')).toBe(true)
    expect(b.admitted('b')).toBe(true)
    expect(b.stats()).toEqual({ bytes: 8 * MB, count: 2, evictions: 0, denied: 0 })
  })

  it('acima do orçamento descarta primeiro as não montadas, da menos recentemente visível para a mais', () => {
    const b = new FilmstripBudget(10 * MB)
    b.acquire('a', 4 * MB)
    b.acquire('b', 4 * MB)
    b.release('a') // a sai da tela antes de b
    b.release('b')
    b.acquire('c', 4 * MB) // cabe (12 > 10?): 8 + 4 = 12 > 10 → sai a (a menos recente fora da tela)
    expect(b.admitted('a')).toBe(false)
    expect(b.admitted('b')).toBe(true)
    expect(b.admitted('c')).toBe(true)
    expect(b.stats()).toMatchObject({ bytes: 8 * MB, count: 2, evictions: 1, denied: 0 })
  })

  it('só montadas acima do orçamento: as pedidas há mais tempo ficam sem sprite até haver espaço', () => {
    const b = new FilmstripBudget(10 * MB)
    const seen: string[] = []
    b.subscribe('a', () => seen.push('a'))
    b.acquire('a', 4 * MB)
    b.acquire('b', 4 * MB)
    b.acquire('c', 4 * MB) // nada fora da tela: a (o pedido mais antigo) cede
    expect([b.admitted('a'), b.admitted('b'), b.admitted('c')]).toEqual([false, true, true])
    expect(seen).toContain('a') // a ItemView de `a` re-renderiza sem a sprite
    expect(b.stats()).toMatchObject({ bytes: 8 * MB, count: 2, evictions: 1, denied: 1 })
    b.release('b') // b sai da tela: pode ser descartada para a, que espera
    expect(b.admitted('a')).toBe(true)
    expect(b.admitted('b')).toBe(false)
    expect(b.stats()).toMatchObject({ bytes: 8 * MB, count: 2, evictions: 2 })
  })

  it('sprite maior que o orçamento inteiro: negada (sem descartar nada)', () => {
    const b = new FilmstripBudget(10 * MB)
    b.acquire('a', 4 * MB)
    b.acquire('big', 11 * MB)
    expect(b.admitted('big')).toBe(false)
    expect(b.admitted('a')).toBe(true)
    expect(b.stats()).toMatchObject({ bytes: 4 * MB, count: 1, evictions: 0, denied: 1 })
  })

  it('negada que sai da tela é esquecida; montada de novo pede admissão outra vez', () => {
    const b = new FilmstripBudget(10 * MB)
    b.acquire('a', 6 * MB)
    b.acquire('b', 6 * MB) // a cede
    b.release('a') // a sai sem sprite: esquecida
    expect(b.admitted('a')).toBe(false)
    expect(b.canShow('a', 6 * MB)).toBe(false) // 6 + 6 > 10
    b.release('b')
    expect(b.canShow('a', 6 * MB)).toBe(false) // b fora da tela ainda conta
    b.acquire('a', 6 * MB) // descarta b (fora da tela)
    expect(b.admitted('a')).toBe(true)
    expect(b.stats()).toMatchObject({ bytes: 6 * MB, count: 1 })
  })

  it('canShow (1º render, antes do efeito): admitida, ou desconhecida que cabe sem descartar', () => {
    const b = new FilmstripBudget(10 * MB)
    expect(b.canShow('a', 4 * MB)).toBe(true)
    b.acquire('a', 4 * MB)
    expect(b.canShow('a', 4 * MB)).toBe(true)
    expect(b.canShow('x', 7 * MB)).toBe(false)
  })

  it('montar/desmontar de novo (StrictMode, rolagem) não duplica bytes e reordena a recência', () => {
    const b = new FilmstripBudget(10 * MB)
    b.acquire('a', 4 * MB)
    b.release('a')
    b.acquire('a', 4 * MB)
    b.acquire('b', 4 * MB)
    b.release('b')
    b.release('a') // a fica mais recente que b fora da tela
    b.acquire('c', 4 * MB) // sai b
    expect([b.admitted('a'), b.admitted('b'), b.admitted('c')]).toEqual([true, false, true])
    expect(b.stats()).toMatchObject({ bytes: 8 * MB, count: 2 })
  })

  it('subscribe por chave: só os ouvintes da sprite que mudou são chamados; unsubscribe remove', () => {
    const b = new FilmstripBudget(10 * MB)
    let a = 0
    let c = 0
    const offA = b.subscribe('a', () => a++)
    b.subscribe('c', () => c++)
    b.acquire('a', 6 * MB)
    b.release('a')
    const before = a
    b.acquire('c', 6 * MB) // descarta a
    expect(a).toBe(before + 1)
    expect(c).toBeGreaterThanOrEqual(0)
    offA()
    b.acquire('a', 6 * MB)
    expect(a).toBe(before + 1)
  })

  it('custo por montagem independe do número de sprites (O(1) amortizado)', () => {
    const b = new FilmstripBudget(FILMSTRIP_BUDGET_BYTES)
    for (let i = 0; i < 5000; i++) b.acquire(`s${i}`, 100 * 1024) // ~488 MiB pedidos: metade cede
    const t0 = performance.now()
    for (let i = 0; i < 20_000; i++) {
      b.release(`s${i % 5000}`)
      b.acquire(`s${i % 5000}`, 100 * 1024)
    }
    expect(performance.now() - t0).toBeLessThan(200)
    expect(b.stats().bytes).toBeLessThanOrEqual(FILMSTRIP_BUDGET_BYTES)
  })
})
