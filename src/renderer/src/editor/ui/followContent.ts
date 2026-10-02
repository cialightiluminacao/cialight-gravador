import { create } from 'zustand'
import { toast } from 'sonner'
import { applyTrackedRegion, EditError, findItem } from '@shared/editor/ops'
import type { EffectItem } from '@shared/editor/project'
import { lossMessage, trackingBlocker } from '@shared/editor/track'
import { runContentTracking, TrackingCancelled } from '../engine/contentTracking'
import { useEditorStore } from '../state/editorStore'
import { useTrackStrips } from '../state/trackStrips'

// "Seguir conteúdo" (F6) do efeito selecionado: roda o rastreamento (engine/contentTracking: worker próprio) a partir
// do playhead até o fim do efeito e aplica a região com keys como UMA edição (um passo de desfazer). Fica fora do
// painel (o inspetor pode trocar de item no meio): o progresso vive em useTrackJobs. Um por vez. Cancelar = nada
// aplicado. Se o projeto mudou durante a análise, nada é aplicado (os quadros analisados podem não valer mais).

export interface TrackJob { frame: number; total: number; abort: AbortController }

export const useTrackJobs = create<{ jobs: Record<string, TrackJob> }>()(() => ({ jobs: {} }))

const setJob = (id: string, job: TrackJob | null): void =>
  useTrackJobs.setState((s) => {
    const jobs = { ...s.jobs }
    if (job) jobs[id] = job
    else delete jobs[id]
    return { jobs }
  })

export function cancelFollow(itemId: string): void {
  useTrackJobs.getState().jobs[itemId]?.abort.abort()
}

export async function followContent(itemId: string): Promise<void> {
  const st = useEditorStore.getState()
  const p0 = st.project
  if (!p0) return
  if (Object.keys(useTrackJobs.getState().jobs).length) {
    toast.info('Já há um rastreamento em andamento', { description: 'Espere ele terminar ou cancele-o.' })
    return
  }
  const blocked = trackingBlocker(p0, itemId)
  if (blocked) {
    toast.error(blocked)
    return
  }
  const abort = new AbortController()
  setJob(itemId, { frame: 0, total: 0, abort })
  try {
    const out = await runContentTracking(
      { project: p0, effectItemId: itemId, fromUs: st.playheadUs },
      { signal: abort.signal, onProgress: ({ frame, total }) => setJob(itemId, { frame, total, abort }) }
    )
    const now = useEditorStore.getState()
    if (now.project !== p0) {
      toast.warning('O projeto mudou durante o rastreamento: nada foi aplicado', { description: 'Rode “Seguir conteúdo” de novo.' })
      return
    }
    if (!now.apply((p) => applyTrackedRegion(p, itemId, out.region))) return
    const fx = findItem(useEditorStore.getState().project!, itemId)?.item as EffectItem | undefined
    if (fx) useTrackStrips.getState().set(itemId, { region: fx.region, samples: out.samples })
    const keys = out.results.length
    const invert = !!fx?.invert
    if (out.lost.length) {
      const first = out.lost[0]
      toast.warning(lossMessage(first, invert), {
        description: `${out.lost.length > 1 ? `${out.lost.length} perdas no total. ` : ''}${invert ? 'Fechado, o buraco esconde o quadro inteiro.' : 'Ampliada, a região esconde mais do que o conteúdo.'} A faixa vermelha no item mostra onde. Ctrl+Z desfaz.`,
        duration: 12_000,
        action: { label: 'Ir para', onClick: () => useEditorStore.getState().setPlayhead(first.tUs) }
      })
    } else {
      toast.success('Conteúdo seguido', { description: `${keys === 1 ? '1 quadro analisado' : `${keys} quadros analisados`}: keyframes de posição e tamanho criados — edite-os como quiser. Ctrl+Z desfaz.` })
    }
  } catch (e) {
    if (e instanceof TrackingCancelled) toast.info('Rastreamento cancelado: nada foi aplicado')
    else if (e instanceof EditError) toast.error(e.message)
    else toast.error('Não foi possível seguir o conteúdo', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    setJob(itemId, null)
  }
}
