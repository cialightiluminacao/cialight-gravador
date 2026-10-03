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
import { ExportQueue, queueSummary, type ParkedEntry, type QueueBatchSummary, type QueueItem } from './exportQueue'
import { fromPersisted, toPersisted } from './exportQueuePersist'

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

// ---- persistência (export-queue.json, só o main grava) ----

export const exportQueue = new ExportQueue({
  run: (job, opts) => (job.kind === 'video' ? runEditorExport(job.request, opts) : job.kind === 'gif' ? runGifExport(job.request, opts) : runAudioExport(job.request, opts)),
  isCancelled: (e) => e instanceof EditorExportCancelled,
  errorMessage: ipcErrorMessage,
  reportState: (s) => void window.api.editorExport.setQueueState(s).catch(() => {}),
  beforeItem: () => beforeItem?.(),
  isBusy: editorExportRunning,
  onIdle: announce,
  persist: (entries) => void window.api.exportQueue.save(entries.map(toPersisted)).catch((e) => console.error('fila de exportações: falha ao salvar', e))
})

let hydrating: Promise<void> | null = null

/**
 * Lê o arquivo da sessão anterior (uma vez por janela): os itens ficam guardados, a persistência passa a valer e a
 * oferta de retomar aparece. Falha na leitura: a persistência fica desligada (não sobrescreve o que não foi lido).
 */
export function hydrateExportQueue(): Promise<void> {
  hydrating ??= window.api.exportQueue
    .load()
    .then((items) => {
      exportQueue.hydrate(items.map(fromPersisted).filter((e): e is ParkedEntry => e !== null))
      offerResume()
    })
    .catch((e) => console.error('fila de exportações: não foi possível ler o arquivo salvo', e))
  return hydrating
}

const RESUME_TOAST = 'export-queue-resume'

/** "Retomar 2 exportações pendentes" / "Retomar 1 exportação pendente". */
export function resumeText(n: number): string {
  return `Retomar ${n} ${n === 1 ? 'exportação pendente' : 'exportações pendentes'}`
}

/**
 * Oferta de retomar (toast fixo, sem duplicar): há itens guardados que não estão na fila viva. Retomar: apaga os .part
 * antigos (no main, pelos itens do próprio arquivo) e enfileira todos do zero — os executores não dependem do editor
 * montado (só o pedido congelado de cada item), então não navega. Descartar: apaga os .part e esvazia o arquivo.
 */
export function offerResume(): void {
  const n = exportQueue.parkedCount
  if (n <= 0) {
    toast.dismiss(RESUME_TOAST)
    return
  }
  toast(resumeText(n), {
    id: RESUME_TOAST,
    duration: Infinity,
    description: 'A fila estava salva da última vez. Itens que estavam rodando recomeçam do início.',
    action: {
      label: 'Retomar',
      onClick: () => {
        void window.api.exportQueue
          .cleanParts()
          .catch(() => {})
          .finally(() => exportQueue.resume())
      }
    },
    cancel: {
      label: 'Descartar',
      onClick: () => {
        // primeiro os .part (o main lê os itens do arquivo), depois o conjunto novo é salvo
        void window.api.exportQueue
          .cleanParts()
          .catch(() => {})
          .finally(() => exportQueue.discardParked())
      }
    }
  })
}

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
