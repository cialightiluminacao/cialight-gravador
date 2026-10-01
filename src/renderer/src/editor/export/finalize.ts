// Etapa final da exportação (remux faststart no main) com cancelamento sem brecha: o pedido de cancelar
// pode chegar entre o fim da codificação e o finalize, ou durante o remux.
import type { IpcApi } from '@shared/ipc'

export class EditorExportCancelled extends Error {
  constructor() {
    super('Exportação cancelada')
    this.name = 'EditorExportCancelled'
  }
}

type Api = Pick<IpcApi['editorExport'], 'finalize' | 'cancel'>
export type Finalized = Awaited<ReturnType<Api['finalize']>>

/**
 * Finaliza o job. Já cancelado (a codificação acabou depois do pedido) → apaga o parcial e não finaliza;
 * cancelado durante o remux → o main interrompe o ffmpeg e apaga parcial/saída. Ambos lançam EditorExportCancelled.
 */
export async function finalizeOrCancel(api: Api, jobId: string, opts: Parameters<Api['finalize']>[1], signal: AbortSignal): Promise<Finalized> {
  const cancelJob = (): Promise<void> => api.cancel(jobId).catch(() => {})
  if (signal.aborted) {
    await cancelJob()
    throw new EditorExportCancelled()
  }
  const onAbort = (): void => void cancelJob()
  signal.addEventListener('abort', onAbort)
  try {
    // checado de novo já com o ouvinte no lugar: nenhum abort fica sem efeito
    if (signal.aborted) {
      await cancelJob()
      throw new EditorExportCancelled()
    }
    try {
      return await api.finalize(jobId, opts)
    } catch (e) {
      if (signal.aborted) throw new EditorExportCancelled()
      throw e
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
