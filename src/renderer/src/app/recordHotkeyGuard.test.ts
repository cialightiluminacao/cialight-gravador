import { describe, expect, it } from 'vitest'
import { decideRecordHotkey } from './recordHotkeyGuard'

describe('decideRecordHotkey', () => {
  it('fora do editor grava como sempre', () => {
    expect(decideRecordHotkey({ screen: 'prepare', editorProjectId: null, queueActive: false })).toBe('start')
    expect(decideRecordHotkey({ screen: 'prepare', editorProjectId: null, queueActive: true })).toBe('start')
  })
  it('no editor sem fila ativa: recusa (comportamento anterior)', () => {
    expect(decideRecordHotkey({ screen: 'editor', editorProjectId: 'p1', queueActive: false })).toBe('refuse-in-editor')
  })
  it('no editor com fila ativa: pergunta antes de sair', () => {
    expect(decideRecordHotkey({ screen: 'editor', editorProjectId: 'p1', queueActive: true })).toBe('confirm-leave')
  })
  it('editor aberto por baixo de Histórico/Configurações com fila ativa: também pergunta', () => {
    expect(decideRecordHotkey({ screen: 'history', editorProjectId: 'p1', queueActive: true })).toBe('confirm-leave')
    expect(decideRecordHotkey({ screen: 'settings', editorProjectId: 'p1', queueActive: false })).toBe('start')
  })
})
