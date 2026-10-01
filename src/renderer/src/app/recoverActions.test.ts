import { describe, expect, it, vi } from 'vitest'
import { discardRecoverable } from './recoverActions'

describe('discardRecoverable (diálogo de gravação interrompida → Excluir)', () => {
  it('excluiu: true e nenhum aviso', async () => {
    const deleteSession = vi.fn(async () => {})
    const notifyError = vi.fn()
    await expect(discardRecoverable('s1', { deleteSession, notifyError })).resolves.toBe(true)
    expect(deleteSession).toHaveBeenCalledWith('s1')
    expect(notifyError).not.toHaveBeenCalled()
  })
  it('sessão usada por projeto do editor: false e aviso em pt-BR sem o prefixo do IPC', async () => {
    const deleteSession = vi.fn(async () => {
      throw new Error("Error invoking remote method 'session:delete': Error: A gravação é usada por 1 projeto do editor (Aula). Exclua os projetos antes.")
    })
    const notifyError = vi.fn()
    await expect(discardRecoverable('s1', { deleteSession, notifyError })).resolves.toBe(false)
    expect(notifyError).toHaveBeenCalledWith('Não foi possível excluir: A gravação é usada por 1 projeto do editor (Aula). Exclua os projetos antes.')
  })
})
