import { describe, expect, it } from 'vitest'
import { TEXTURE_BUDGET_BYTES, TEXTURE_IDLE_FRAMES, TextureCache, type TexOps } from './textureCache'

interface FakeTex { id: number; deleted: boolean }

function fakeOps(): TexOps<FakeTex> & { created: number; uploads: { id: number; sub: boolean }[]; deleted: number[] } {
  let next = 0
  const ops = {
    created: 0,
    uploads: [] as { id: number; sub: boolean }[],
    deleted: [] as number[],
    create(): FakeTex {
      ops.created++
      return { id: ++next, deleted: false }
    },
    upload(tex: FakeTex, _src: unknown, sub: boolean): void {
      expect(tex.deleted).toBe(false)
      ops.uploads.push({ id: tex.id, sub })
    },
    delete(tex: FakeTex): void {
      tex.deleted = true
      ops.deleted.push(tex.id)
    }
  }
  return ops
}

const MB = 2 ** 20
// fonte de w×h px: 1 MiB = 512×512
const src = (): object => ({})

/** Um quadro desenhando as chaves dadas (cada uma 512×512 = 1 MiB; fonte nova = não imutável). */
function frame(c: TextureCache<FakeTex>, keys: string[], size = 512): void {
  c.beginFrame()
  for (const k of keys) c.use(k, src(), size, size, false)
  c.endFrame()
}

describe('TextureCache', () => {
  it('constantes da spec §13', () => {
    expect(TEXTURE_BUDGET_BYTES).toBe(512 * MB)
    expect(TEXTURE_IDLE_FRAMES).toBe(120)
  })

  it('mantém texturas de quadros anteriores enquanto cabem no orçamento (bytes = w·h·4)', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops, { budgetBytes: 4 * MB })
    frame(c, ['a'])
    frame(c, ['b'])
    frame(c, ['c'])
    expect(c.stats()).toEqual({ textureBytes: 3 * MB, textureCount: 3, evictions: 0, overBudgetFrames: 0 })
    expect(ops.deleted).toEqual([])
  })

  it('acima do orçamento descarta as menos usadas recentemente, na ordem do último uso', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops, { budgetBytes: 3 * MB })
    frame(c, ['a']) // tex 1
    frame(c, ['b']) // tex 2
    frame(c, ['c']) // tex 3
    frame(c, ['a']) // a volta a ser a mais recente (reenvio na mesma textura)
    frame(c, ['d']) // 4 MiB > 3: sai b (a usada há mais tempo), não a
    expect(ops.deleted).toEqual([2])
    frame(c, ['e']) // sai c
    expect(ops.deleted).toEqual([2, 3])
    expect(c.stats()).toMatchObject({ textureBytes: 3 * MB, textureCount: 3, evictions: 2 })
  })

  it('nunca descarta textura em uso no quadro atual; quadro sozinho acima do orçamento conta overBudgetFrames', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops, { budgetBytes: 2 * MB })
    frame(c, ['x'])
    frame(c, ['a', 'b', 'c']) // 3 MiB em uso > 2: x sai, a/b/c ficam
    expect(ops.deleted).toEqual([1])
    expect(c.stats()).toEqual({ textureBytes: 3 * MB, textureCount: 3, evictions: 1, overBudgetFrames: 1 })
    frame(c, ['a']) // b (a menos recente fora do quadro) sai até caber: a + c = 2 MiB
    expect(c.stats()).toMatchObject({ textureBytes: 2 * MB, textureCount: 2, evictions: 2, overBudgetFrames: 1 })
    expect(ops.deleted).toEqual([1, 3])
  })

  it(`descarta o que ficou sem uso por mais de ${TEXTURE_IDLE_FRAMES} quadros desenhados, mesmo dentro do orçamento`, () => {
    const ops = fakeOps()
    const c = new TextureCache(ops, { budgetBytes: 100 * MB, idleFrames: 3 })
    frame(c, ['old', 'keep'])
    frame(c, ['keep'])
    frame(c, ['keep'])
    frame(c, ['keep'])
    expect(c.stats().textureCount).toBe(2) // 3 quadros sem uso: ainda não
    frame(c, ['keep'])
    expect(c.stats()).toMatchObject({ textureCount: 1, evictions: 1 })
    expect(ops.deleted).toEqual([1])
  })

  it('reaproveita a textura: mesma chave e dimensões → envio parcial (sub) sem criar/apagar; dimensões novas → reenvio completo', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops)
    frame(c, ['v'], 512)
    frame(c, ['v'], 512)
    frame(c, ['v'], 256)
    expect(ops.created).toBe(1)
    expect(ops.deleted).toEqual([])
    expect(ops.uploads).toEqual([{ id: 1, sub: false }, { id: 1, sub: true }, { id: 1, sub: false }])
    expect(c.stats().textureBytes).toBe(256 * 256 * 4)
  })

  it('fonte imutável (ImageBitmap) igual à última enviada não é reenviada, também em quadros seguintes', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops)
    const bmp = {}
    for (let i = 0; i < 3; i++) {
      c.beginFrame()
      const t = c.use('img', bmp, 100, 50, true)
      expect(t.id).toBe(1)
      c.endFrame()
    }
    expect(ops.uploads).toHaveLength(1)
    c.beginFrame()
    c.use('img', {}, 100, 50, true) // bitmap novo
    c.endFrame()
    expect(ops.uploads).toEqual([{ id: 1, sub: false }, { id: 1, sub: true }])
  })

  it('textura descartada e pedida de novo: textura nova com envio completo', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops, { budgetBytes: MB })
    const bmp = {}
    c.beginFrame()
    c.use('a', bmp, 512, 512, true)
    c.endFrame()
    frame(c, ['b']) // a sai
    c.beginFrame()
    const t = c.use('a', bmp, 512, 512, true) // mesma fonte, mas a textura antiga sumiu: reenvia
    c.endFrame()
    expect(t.id).toBe(3)
    expect(ops.uploads.at(-1)).toEqual({ id: 3, sub: false })
  })

  it('setBudget (testes) reduz o orçamento; null volta ao padrão; clear apaga tudo', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops)
    frame(c, ['a'])
    frame(c, ['b'])
    c.setBudget(MB)
    frame(c, ['c'])
    expect(c.stats()).toMatchObject({ textureCount: 1, evictions: 2 })
    c.setBudget(null)
    frame(c, ['d'])
    expect(c.stats().textureCount).toBe(2)
    c.clear()
    expect(c.stats()).toMatchObject({ textureBytes: 0, textureCount: 0 })
    expect(ops.deleted).toHaveLength(4)
  })

  it('descarte é O(descartadas): 2000 entradas no orçamento não são percorridas por quadro', () => {
    const ops = fakeOps()
    const c = new TextureCache(ops, { budgetBytes: 10_000 * MB })
    c.beginFrame()
    for (let i = 0; i < 2000; i++) c.use(`k${i}`, src(), 512, 512, false)
    c.endFrame()
    // a 1ª entrada (a mais antiga) está dentro do orçamento e não ociosa: o laço para nela
    const t0 = performance.now()
    for (let f = 0; f < 100; f++) frame(c, ['hot'])
    expect(performance.now() - t0).toBeLessThan(50)
    expect(c.stats().textureCount).toBe(2001)
  })
})
