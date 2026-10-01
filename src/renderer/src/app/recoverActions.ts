// Ações do diálogo de gravação interrompida, separadas da UI para teste.
import { ipcErrorMessage } from '@/lib/ipcError'

/**
 * Exclui a sessão interrompida. A exclusão falha (no main) quando um projeto do editor usa a gravação:
 * avisa o motivo e devolve false — a sessão continua na lista para ser recuperada.
 */
export async function discardRecoverable(
  id: string,
  deps: { deleteSession: (id: string) => Promise<unknown>; notifyError: (message: string) => void }
): Promise<boolean> {
  try {
    await deps.deleteSession(id)
    return true
  } catch (e) {
    deps.notifyError(`Não foi possível excluir: ${ipcErrorMessage(e)}`)
    return false
  }
}
