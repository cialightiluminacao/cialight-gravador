// Mensagem de erro para a UI: o Electron embrulha erros lançados no main como
// "Error invoking remote method 'canal': Error: <mensagem>" — o prefixo em inglês não vai para o usuário.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(IPC_PREFIX, '')
}
