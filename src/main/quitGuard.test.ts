import { describe, expect, it } from 'vitest'
import { createQuitGuard, exportQuitText, ExportQueueStates, type QuitReason } from './quitGuard'

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

describe('exportQuitText (confirmação de saída com a fila)', () => {
  it('conta a exportação em andamento e as da fila', () => {
    expect(exportQuitText({ running: 1, pending: 2 })).toEqual({ message: 'Há 1 exportação em andamento e 2 na fila.', detail: 'Sair cancela todas (a fila não é salva).' })
    expect(exportQuitText({ running: 1, pending: 1 })).toEqual({ message: 'Há 1 exportação em andamento e 1 na fila.', detail: 'Sair cancela todas (a fila não é salva).' })
    expect(exportQuitText({ running: 1, pending: 0 })).toEqual({ message: 'Há 1 exportação em andamento.', detail: 'Sair cancela a exportação e apaga o arquivo parcial.' })
    expect(exportQuitText({ running: 0, pending: 3 })).toEqual({ message: 'Há 3 exportações na fila.', detail: 'Sair cancela todas (a fila não é salva).' })
    expect(exportQuitText({ running: 0, pending: 1 })).toEqual({ message: 'Há 1 exportação na fila.', detail: 'Sair cancela todas (a fila não é salva).' })
  })
})

describe('ExportQueueStates (estado da fila informado pelo renderer)', () => {
  it('soma janelas, junta com o job do main e esquece a janela fechada', () => {
    const q = new ExportQueueStates()
    expect(q.counts(false)).toEqual({ running: 0, pending: 0 })
    expect(q.counts(true)).toEqual({ running: 1, pending: 0 })
    q.set(1, { running: true, pending: 2 })
    expect(q.counts(false)).toEqual({ running: 1, pending: 2 })
    // o job do main e a fila do renderer são a mesma exportação (1, não 2)
    expect(q.counts(true)).toEqual({ running: 1, pending: 2 })
    // entre dois itens: nada rodando, mas há fila → ainda ocupado
    q.set(1, { running: false, pending: 1 })
    expect(q.counts(false)).toEqual({ running: 0, pending: 1 })
    q.drop(1)
    expect(q.counts(false)).toEqual({ running: 0, pending: 0 })
  })
  it('valores inválidos viram zero (o renderer não é confiável)', () => {
    const q = new ExportQueueStates()
    q.set(2, { running: 'sim', pending: -4 } as unknown as { running: boolean; pending: number })
    expect(q.counts(false)).toEqual({ running: 0, pending: 0 })
    q.set(2, { running: true, pending: 2.7 })
    expect(q.counts(false)).toEqual({ running: 1, pending: 2 })
    q.set(2, null as unknown as { running: boolean; pending: number })
    expect(q.counts(false)).toEqual({ running: 0, pending: 0 })
  })
})
