import { describe, expect, it } from 'vitest'
import { singleFlight } from './singleFlight'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('singleFlight (probe de encoders: exportação v1 reaproveita o probe em andamento)', () => {
  it('chamada sem force durante uma em andamento reaproveita a mesma promessa', async () => {
    const runs: { force: boolean; d: ReturnType<typeof deferred<number>> }[] = []
    const run = singleFlight((force: boolean) => {
      const d = deferred<number>()
      runs.push({ force, d })
      return d.promise
    })
    const a = run(false)
    const b = run(false)
    expect(runs).toHaveLength(1)
    runs[0].d.resolve(7)
    await expect(a).resolves.toBe(7)
    await expect(b).resolves.toBe(7)
    // terminou: a próxima chamada roda de novo
    const c = run(false)
    expect(runs).toHaveLength(2)
    runs[1].d.resolve(8)
    await expect(c).resolves.toBe(8)
  })
  it('force espera a em andamento e roda depois (nunca dois ao mesmo tempo)', async () => {
    const runs: { force: boolean; d: ReturnType<typeof deferred<number>> }[] = []
    const run = singleFlight((force: boolean) => {
      const d = deferred<number>()
      runs.push({ force, d })
      return d.promise
    })
    const a = run(false)
    const f = run(true)
    await Promise.resolve()
    expect(runs).toHaveLength(1)
    runs[0].d.resolve(1)
    await a
    await new Promise((r) => setTimeout(r, 0))
    expect(runs.map((r) => r.force)).toEqual([false, true])
    // sem force durante o forçado: reaproveita o forçado
    const b = run(false)
    runs[1].d.resolve(2)
    await expect(f).resolves.toBe(2)
    await expect(b).resolves.toBe(2)
    expect(runs).toHaveLength(2)
  })
  it('falha libera a vaga para a próxima chamada', async () => {
    let n = 0
    const run = singleFlight(async () => {
      n++
      if (n === 1) throw new Error('falhou')
      return n
    })
    await expect(run(false)).rejects.toThrow('falhou')
    await expect(run(false)).resolves.toBe(2)
  })
})
