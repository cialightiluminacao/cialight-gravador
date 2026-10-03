// A fila de exportações do app (uma por janela): o ExportQueue ligado aos executores reais (os mesmos da
// exportação direta), ao main (estado para a confirmação de saída), à pausa da reprodução do editor e aos avisos
// (toast com o resumo quando a fila esvazia). Sobrevive à troca de projeto no editor (cada item leva o seu).
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { ipcErrorMessage } from '@/lib/ipcError'
import { showOutputInFolder } from '@/screens/Review/outputActions'
import { editorExportRunning } from './exportLock'
import { EditorExportCancelled, runEditorExport } from './editorExport'
import { runAudioExport, runGifExport } from './formatExport'
import { ExportQueue, queueSummary, type QueueBatchSummary, type QueueItem } from './exportQueue'

let beforeItem: (() => void) | null = null

/** A tela do editor registra a pausa da reprodução (vale ao começar cada item). Devolve o "desregistrar". */
export function setQueueBeforeItem(fn: () => void): () => void {
  beforeItem = fn
  return () => {
    if (beforeItem === fn) beforeItem = null
  }
}

const fileOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Resumo quando a fila esvazia: 1 item → o resultado dele; vários → "3 concluídas, 1 com erro". */
function announce(s: QueueBatchSummary): void {
  if (s.items.length === 1) {
    const it = s.items[0]
    if (it.state === 'done' && it.result) {
      const path = it.result.path
      toast.success(`Exportação concluída: ${fileOf(path)}`, { action: { label: 'Abrir pasta', onClick: () => showOutputInFolder(path) } })
    } else if (it.state === 'error') toast.error('A exportação falhou', { description: `${it.label}: ${it.message ?? ''}` })
    else toast('Exportação cancelada', { description: it.label })
    return
  }
  const text = queueSummary(s)
  const last = [...s.items].reverse().find((i) => i.state === 'done' && i.result)?.result?.path
  const action = last ? { label: 'Abrir pasta', onClick: () => showOutputInFolder(last) } : undefined
  if (s.error) toast.warning(`Fila de exportações: ${text}`, { description: 'Veja os detalhes em “Exportações”.', action })
  else if (s.done) toast.success(`Fila de exportações: ${text}`, { action })
  else toast(`Fila de exportações: ${text}`)
}

export const exportQueue = new ExportQueue({
  run: (job, opts) => (job.kind === 'video' ? runEditorExport(job.request, opts) : job.kind === 'gif' ? runGifExport(job.request, opts) : runAudioExport(job.request, opts)),
  isCancelled: (e) => e instanceof EditorExportCancelled,
  errorMessage: ipcErrorMessage,
  reportState: (s) => void window.api.editorExport.setQueueState(s).catch(() => {}),
  beforeItem: () => beforeItem?.(),
  isBusy: editorExportRunning,
  onIdle: announce
})

const subscribe = (fn: () => void): (() => void) => exportQueue.subscribe(fn)
const getItems = (): readonly QueueItem[] => exportQueue.items

/** Itens da fila (re-renderiza a cada mudança, inclusive progresso). */
export function useExportQueue(): readonly QueueItem[] {
  return useSyncExternalStore(subscribe, getItems)
}

/** Um item (re-renderiza só quando ELE muda; id null → nada). */
export function useQueueItem(id: string | null): QueueItem | undefined {
  return useSyncExternalStore(subscribe, () => (id ? exportQueue.items.find((i) => i.id === id) : undefined))
}

/** Há item rodando ou esperando na fila. */
export function useQueueActive(): boolean {
  return useSyncExternalStore(subscribe, () => exportQueue.active())
}
