// Etapa final da exportação (remux faststart no main, ou o fim de uma saída por pipe) com cancelamento sem
// brecha: o pedido de cancelar pode chegar entre o fim da codificação e o finalize, ou durante ele.
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
 * Roda a etapa final `run`. Já cancelado (a codificação acabou depois do pedido) → `cancel` (apaga o parcial)
 * sem rodar; cancelado durante → `cancel` (o main interrompe o ffmpeg e apaga parcial/saída). Ambos lançam
 * EditorExportCancelled.
 */
export async function settleOrCancel<T>(run: () => Promise<T>, cancel: () => Promise<void>, signal: AbortSignal): Promise<T> {
  const cancelJob = (): Promise<void> => cancel().catch(() => {})
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
      return await run()
    } catch (e) {
      if (signal.aborted) throw new EditorExportCancelled()
      throw e
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Finaliza o job MP4 (remux faststart) com cancelamento sem brecha (ver settleOrCancel). */
export function finalizeOrCancel(api: Api, jobId: string, opts: Parameters<Api['finalize']>[1], signal: AbortSignal): Promise<Finalized> {
  return settleOrCancel(() => api.finalize(jobId, opts), () => api.cancel(jobId), signal)
}
