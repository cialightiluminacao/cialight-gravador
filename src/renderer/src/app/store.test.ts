import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './store'

describe('navegação do editor', () => {
  beforeEach(() => useAppStore.setState({ screen: 'prepare', returnScreen: 'prepare', editorProjectId: null }))

  it('Projetos (barra de título) a partir do editor fecha o editor: voltar não reabre o editor', () => {
    const s = useAppStore.getState
    s().setScreen('projects')
    s().openEditor('p1')
    s().setScreen('projects')
    expect(s().screen).toBe('projects')
    expect(s().editorProjectId).toBeNull()
    s().goBack()
    expect(s().screen).toBe('prepare')
  })

  it('Histórico/Configurações a partir do editor voltam ao editor', () => {
    const s = useAppStore.getState
    s().openEditor('p1')
    s().setScreen('settings')
    s().goBack()
    expect(s().screen).toBe('editor')
    expect(s().editorProjectId).toBe('p1')
  })
})
