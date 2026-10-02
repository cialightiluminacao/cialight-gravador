// Uma exportação do editor por vez (vídeo, GIF, PNG, só áudio): trava do renderer, antes do main (que também
// recusa um segundo job). A fila (Task 4) roda os pedidos em sequência através dela.

let running = false

/** Há uma exportação do editor em andamento. */
export function editorExportRunning(): boolean {
  return running
}

/** Roda `fn` com a trava; com outra exportação em andamento, lança. */
export async function withExportLock<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw new Error('Já existe uma exportação em andamento')
  running = true
  try {
    return await fn()
  } finally {
    running = false
  }
}
