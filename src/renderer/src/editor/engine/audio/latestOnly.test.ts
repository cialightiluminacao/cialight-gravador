import { describe, expect, it } from 'vitest'
import { LatestOnly } from './latestOnly'

// Revisão final (M1): o audio worker aplica só o projeto mais recente; os que chegaram antes e ainda não foram
// aplicados são descartados (um arrasto longo não deixa uma fila de planos velhos à frente dos blocos).
function setup(): { applied: number[]; timers: (() => void)[]; l: LatestOnly<number> } {
  const applied: number[] = []
  const timers: (() => void)[] = []
  const l = new LatestOnly<number>((v) => applied.push(v), (fn) => timers.push(fn))
  return { applied, timers, l }
}

describe('LatestOnly', () => {
  it('vários projetos antes do agendamento: aplica só o último, uma vez', () => {
    const { applied, timers, l } = setup()
    for (const v of [1, 2, 3, 4]) l.push(v)
    expect(applied).toEqual([])
    expect(timers).toHaveLength(1)
    timers[0]()
    expect(applied).toEqual([4])
  })
  it('flush (pedido de bloco) aplica o pendente na hora; o agendado depois não reaplica', () => {
    const { applied, timers, l } = setup()
    l.push(1)
    l.push(2)
    l.flush()
    expect(applied).toEqual([2])
    timers[0]()
    l.flush()
    expect(applied).toEqual([2])
    // novo projeto depois: agenda de novo
    l.push(3)
    expect(timers).toHaveLength(2)
    timers[1]()
    expect(applied).toEqual([2, 3])
  })
  it('drop descarta o pendente (dispose)', () => {
    const { applied, timers, l } = setup()
    l.push(1)
    l.drop()
    timers[0]()
    expect(applied).toEqual([])
  })
})
