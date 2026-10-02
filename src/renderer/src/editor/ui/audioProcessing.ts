import { toast } from 'sonner'
import { pendingAudioProcessing } from '@shared/editor/audioPlan'
import { audioSourceKey } from '@shared/editor/audioProcess'
import { ipcErrorMessage } from '@/lib/ipcError'
import { useEditorStore } from '../state/editorStore'

// Redução de ruído / normalização no editor: sempre que o projeto pede um pré-processamento que não está pronto
// (flag ligada agora, ou projeto aberto em outro PC sem o cache em generated/), pede ao main (media.processAudio).
// Enquanto isso o mixer toca o original; pronto, a chave entra em asset.processedAudio e o plano passa a ler o
// arquivo processado. Uma falha não é repetida sozinha: vale de novo quando o pedido some e volta (desligar e
// religar a opção) ou por retryAudioProcessing ("Tentar de novo" no inspetor).

const inflight = new Set<string>()
const failed = new Set<string>()

function sync(projectId: string): void {
  const p = useEditorStore.getState().project
  if (!p || p.id !== projectId) return
  const wanted = pendingAudioProcessing(p)
  const ids = new Set(wanted.map((w) => audioSourceKey(w.assetId, w.key)))
  for (const id of failed) {
    if (!ids.has(id)) {
      failed.delete(id)
      useEditorStore.getState().setAudioJob(id, null)
    }
  }
  for (const w of wanted) {
    const id = audioSourceKey(w.assetId, w.key)
    if (inflight.has(id) || failed.has(id)) continue
    inflight.add(id)
    useEditorStore.getState().setAudioJob(id, { percent: 0 })
    window.api.media
      .processAudio(projectId, w.assetId, w.opts)
      .then(({ key }) => {
        const st = useEditorStore.getState()
        st.setAudioJob(id, null)
        if (st.project?.id === projectId) st.markAudioProcessed(w.assetId, key)
      })
      .catch((e: unknown) => {
        const message = ipcErrorMessage(e)
        // projeto fechado/trocado: o cancelamento não é falha
        if (useEditorStore.getState().project?.id !== projectId || /cancelado/.test(message)) {
          useEditorStore.getState().setAudioJob(id, null)
          return
        }
        failed.add(id)
        useEditorStore.getState().setAudioJob(id, { error: message })
        const name = useEditorStore.getState().project?.assets.find((a) => a.id === w.assetId)?.name ?? 'mídia'
        toast.error(`Não foi possível processar o áudio de “${name}”`, { description: message })
      })
      .finally(() => {
        inflight.delete(id)
        sync(projectId)
      })
  }
}

/** Acompanha o projeto aberto e pede os pré-processamentos pendentes; devolve a função que para. */
export function startAudioProcessing(projectId: string): () => void {
  inflight.clear()
  failed.clear()
  sync(projectId)
  const unsub = useEditorStore.subscribe((s, prev) => {
    if (s.project !== prev.project) sync(projectId)
  })
  return () => {
    unsub()
    failed.clear()
  }
}

/** "Tentar de novo" depois de uma falha. */
export function retryAudioProcessing(projectId: string, id: string): void {
  failed.delete(id)
  useEditorStore.getState().setAudioJob(id, null)
  sync(projectId)
}
