import { describe, expect, it } from 'vitest'
import { createQuitGuard, type QuitReason } from './quitGuard'

function setup(state: { recording?: boolean; exporting?: boolean; answer?: boolean }) {
  const asked: QuitReason[] = []
  const guard = createQuitGuard({
    isRecording: () => !!state.recording,
    isExporting: () => !!state.exporting,
    ask: (r) => {
      asked.push(r)
      return state.answer ?? true
    },
    enabled: () => true
  })
  return { guard, asked }
}

describe('createQuitGuard', () => {
  it('gravando + editor aberto: a saída passa duas vezes pelo before-quit (flush do editor) e pergunta uma só', () => {
    const { guard, asked } = setup({ recording: true })
    expect(guard.confirm()).toBe(true) // 1º before-quit: usuário escolhe sair
    expect(guard.confirm()).toBe(true) // app.quit() depois do flush do editor
    expect(guard.confirm()).toBe(true) // will-quit da exportação → app.quit() de novo
    expect(asked).toEqual(['recording'])
  })
  it('exportação do editor em andamento: pergunta; "continuar" cancela a saída e volta a perguntar na próxima', () => {
    const { guard, asked } = setup({ exporting: true, answer: false })
    expect(guard.confirm()).toBe(false)
    expect(guard.confirm()).toBe(false)
    expect(asked).toEqual(['export', 'export'])
  })
  it('gravação tem precedência na pergunta; nada em andamento não pergunta', () => {
    expect(setup({ recording: true, exporting: true }).guard.confirm()).toBe(true)
    const a = setup({ recording: true, exporting: true })
    a.guard.confirm()
    expect(a.asked).toEqual(['recording'])
    const idle = setup({})
    expect(idle.guard.confirm()).toBe(true)
    expect(idle.asked).toEqual([])
  })
  it('desativado (testes de integração): nunca pergunta', () => {
    const asked: QuitReason[] = []
    const g = createQuitGuard({ isRecording: () => true, isExporting: () => true, ask: (r) => (asked.push(r), false), enabled: () => false })
    expect(g.confirm()).toBe(true)
    expect(asked).toEqual([])
  })
})
