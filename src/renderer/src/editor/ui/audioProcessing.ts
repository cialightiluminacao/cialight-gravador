import { toast } from 'sonner'
import { audioProcessPending, pendingAudioProcessing, planAudio } from '@shared/editor/audioPlan'
import type { Project, Us } from '@shared/editor/project'
import { audioSourceKey } from '@shared/editor/audioProcess'
import { ipcErrorMessage } from '@/lib/ipcError'
import { useEditorStore, type AudioJobState } from '../state/editorStore'

// Redução de ruído / normalização no editor: sempre que o projeto pede um pré-processamento que não está pronto
// (flag ligada agora, ou projeto aberto em outro PC sem o cache em generated/), pede ao main (media.processAudio).
// Enquanto isso o mixer toca o original; pronto, chave → impressão da fonte entra em asset.processedAudio e o plano
// passa a ler o arquivo processado. Resultado de um pedido cuja fonte mudou no meio (relink) é descartado (o pedido
// sai de novo para a fonte nova). Uma falha não é repetida sozinha: vale de novo quando o pedido some e volta (desligar e
// religar a opção) ou por retryAudioProcessing ("Tentar de novo" no inspetor).

const inflight = new Set<string>()

/** Fonte atual do asset (para descartar o resultado de um pedido feito antes de um relink). */
function sourceOf(projectId: string, assetId: string): string | null {
  const p = useEditorStore.getState().project
  const a = p?.id === projectId ? p.assets.find((x) => x.id === assetId) : undefined
  return a ? JSON.stringify(a.source) : null
}
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
    // fonte do pedido: se o asset for reapontado (relink) antes do resultado, o resultado é de outra mídia
    const source = sourceOf(projectId, w.assetId)
    window.api.media
      .processAudio(projectId, w.assetId, w.opts)
      .then(({ key, fingerprint }) => {
        const st = useEditorStore.getState()
        st.setAudioJob(id, null)
        if (st.project?.id === projectId && sourceOf(projectId, w.assetId) === source) st.markAudioProcessed(w.assetId, key, fingerprint)
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

export type VoiceProcessStatus = 'ready' | 'error' | 'processing' | 'inactive' | 'waiting'

/**
 * Estado do tratamento de voz de um item no inspetor. `active`: o item soa no plano (áudio ligado, item ativo, faixa
 * não muda) — senão nada é pedido e o painel não fala em "aguardando". `assetReady`: a mídia terminou a ingestão.
 */
export function voiceProcessStatus(o: { ready: boolean; job: AudioJobState | undefined; active: boolean; assetReady: boolean }): VoiceProcessStatus {
  if (o.ready) return 'ready'
  if (o.job && 'error' in o.job) return 'error'
  if (o.job) return 'processing'
  if (!o.active) return 'inactive'
  return o.assetReady ? 'processing' : 'waiting'
}

/**
 * Trechos de [fromUs, toUs) que sairiam na exportação com o áudio original porque o tratamento pedido ainda está
 * processando (`pending`) ou falhou (`failed`): nomes das mídias, sem repetição.
 */
export function audioProcessIssues(p: Project, jobs: Record<string, AudioJobState>, fromUs: Us, toUs: Us): { pending: string[]; failed: string[] } {
  const pending = new Set<string>()
  const failed = new Set<string>()
  for (const s of planAudio(p)) {
    if (s.mode === 'mute' || !audioProcessPending(s) || s.startUs >= toUs || s.startUs + s.durationUs <= fromUs) continue
    const name = p.assets.find((a) => a.id === s.assetId)?.name ?? s.assetId
    const job = jobs[audioSourceKey(s.assetId, s.processKey)]
    if (job && 'error' in job) failed.add(name)
    else pending.add(name)
  }
  return { pending: [...pending], failed: [...failed] }
}
