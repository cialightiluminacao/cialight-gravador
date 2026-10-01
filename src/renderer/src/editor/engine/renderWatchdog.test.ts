import { describe, expect, it } from 'vitest'
import { RenderWatchdog } from './renderWatchdog'

describe('RenderWatchdog (spec §13: sem quadro em 5 s tocando → reinicia)', () => {
  const make = (): { wd: RenderWatchdog; clock: { t: number } } => {
    const clock = { t: 0 }
    return { wd: new RenderWatchdog(5000, () => clock.t), clock }
  }
  it('parado nunca dispara', () => {
    const { wd, clock } = make()
    clock.t = 60_000
    expect(wd.check(false, true)).toBe(false)
  })
  it('tocando: dispara após 5 s sem rendered, não antes', () => {
    const { wd, clock } = make()
    expect(wd.check(true, true)).toBe(false) // começou a tocar agora
    clock.t = 4999
    expect(wd.check(true, true)).toBe(false)
    clock.t = 5000
    expect(wd.check(true, true)).toBe(true)
  })
  it('cada rendered renova o prazo', () => {
    const { wd, clock } = make()
    wd.check(true, true)
    clock.t = 4000
    wd.rendered()
    clock.t = 8999
    expect(wd.check(true, true)).toBe(false)
    clock.t = 9000
    expect(wd.check(true, true)).toBe(true)
  })
  it('depois de disparar, o worker novo ganha outro prazo inteiro; pausar e voltar a tocar zera o prazo', () => {
    const { wd, clock } = make()
    wd.check(true, true)
    clock.t = 5000
    expect(wd.check(true, true)).toBe(true)
    clock.t = 9000
    expect(wd.check(true, true)).toBe(false)
    clock.t = 10_000
    expect(wd.check(true, true)).toBe(true)
    clock.t = 20_000
    expect(wd.check(false, true)).toBe(false)
    clock.t = 30_000
    expect(wd.check(true, true)).toBe(false) // voltou a tocar: prazo a partir de agora
  })
  it('sem pedido de quadro pendente (rAF suspenso, janela minimizada) não dispara nem conta prazo', () => {
    const { wd, clock } = make()
    expect(wd.check(true, false)).toBe(false)
    clock.t = 60_000
    expect(wd.check(true, false)).toBe(false) // tocando há 1 min sem pedir quadros: não é travamento
    expect(wd.check(true, true)).toBe(false) // pedido novo: prazo começa agora
    clock.t = 64_999
    expect(wd.check(true, true)).toBe(false)
    clock.t = 65_000
    expect(wd.check(true, true)).toBe(true)
  })
  it('pedido respondido e nenhum outro pendente desarma; o próximo pedido ganha prazo inteiro', () => {
    const { wd, clock } = make()
    wd.check(true, true)
    clock.t = 4000
    expect(wd.check(true, false)).toBe(false)
    clock.t = 7000
    expect(wd.check(true, true)).toBe(false)
    clock.t = 11_999
    expect(wd.check(true, true)).toBe(false)
    clock.t = 12_000
    expect(wd.check(true, true)).toBe(true)
  })
})
