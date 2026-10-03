import { create } from 'zustand'
import { toast } from 'sonner'
import { applyTrackedRegion, EditError, findItem } from '@shared/editor/ops'
import type { EffectItem, Us } from '@shared/editor/project'
import { formatTrackTime, lossMessage, trackingBlocker } from '@shared/editor/track'
import { runContentTracking, TrackingCancelled } from '../engine/contentTracking'
import { useEditorStore } from '../state/editorStore'
import { mergeStripSamples, useTrackStrips } from '../state/trackStrips'

// "Seguir conteúdo" (F6) do efeito selecionado: roda o rastreamento (engine/contentTracking: worker próprio) a partir
// do playhead até o fim do efeito e aplica a região com keys como UMA edição (um passo de desfazer). Fica fora do
// painel (o inspetor pode trocar de item no meio): o progresso vive em useTrackJobs. Um por vez. Cancelar = nada
// aplicado. Se o projeto mudou durante a análise, nada é aplicado (os quadros analisados podem não valer mais).
// "Continuar rastreamento" (G4) é a mesma passada a partir do playhead depois de uma perda (o usuário reposicionou a
// região ali: uma edição normal, com o seu passo de desfazer); os keys de antes do playhead ficam (trackToKeys) e a
// faixa de confiança em memória junta as amostras de antes com as da nova passada.

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

/** Texto da dica de "Continuar daqui" (G4). */
export const CONTINUE_HINT = 'Ajuste a região sobre o conteúdo e clique em “Continuar rastreamento”.'

/** "Continuar daqui" (G4): playhead no instante da perda, o efeito selecionado e a dica do próximo passo. */
export function continueFrom(itemId: string, lossUs: Us): void {
  const st = useEditorStore.getState()
  if (!st.project || !findItem(st.project, itemId)) return
  st.setPlayhead(lossUs)
  st.select([itemId])
  toast.info(CONTINUE_HINT)
}

export async function followContent(itemId: string, o: { resume?: boolean } = {}): Promise<void> {
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
      toast.warning('O projeto mudou durante o rastreamento: nada foi aplicado', { description: `Rode “${o.resume ? 'Continuar rastreamento' : 'Seguir conteúdo'}” de novo.` })
      return
    }
    const prevStrip = useTrackStrips.getState().strips[itemId]
    if (!now.apply((p) => applyTrackedRegion(p, itemId, out.region))) return
    const fx = findItem(useEditorStore.getState().project!, itemId)?.item as EffectItem | undefined
    if (fx) {
      const samples = o.resume && prevStrip ? mergeStripSamples(prevStrip.samples, out.samples, out.fromUs - fx.startUs) : out.samples
      useTrackStrips.getState().set(itemId, { region: fx.region, samples, lossUs: out.lost[0]?.tUs ?? null })
    }
    const keys = out.results.length
    const invert = !!fx?.invert
    // perdas breves recuperadas pela redetecção (G4): sem toast de perda para elas; a faixa mostra o trecho
    const rec = out.recovered
    const recNote = rec.length
      ? ` ${rec.length === 1 ? 'Uma perda breve foi recuperada' : `${rec.length} perdas breves foram recuperadas`} automaticamente (${rec.map((g) => formatTrackTime(g.fromUs)).join(', ')}): ali ${invert ? 'o buraco ficou fechado' : 'a região ficou ampliada'} até o conteúdo ser reencontrado (faixa âmbar/vermelha no item).`
      : ''
    if (out.lost.length) {
      const first = out.lost[0]
      toast.warning(lossMessage(first, invert), {
        description: `${invert ? 'Fechado, o buraco esconde o quadro inteiro' : 'Ampliada, a região esconde mais do que o conteúdo'} daí até o fim do efeito (faixa vermelha no item). Para voltar a seguir, use “Continuar daqui”: ajuste a região sobre o conteúdo (ali ou num quadro posterior em que ele apareça) e clique em “Continuar rastreamento” — os keyframes de antes ficam.${recNote} Ctrl+Z desfaz.`,
        duration: 12_000,
        action: { label: 'Continuar daqui', onClick: () => continueFrom(itemId, first.tUs) }
      })
    } else {
      toast.success('Conteúdo seguido', { description: `${keys === 1 ? '1 quadro analisado' : `${keys} quadros analisados`}: keyframes de posição e tamanho criados — edite-os como quiser.${recNote} Se depois mudar o tempo ou a velocidade do clipe (deslizar o conteúdo, velocidade, mover só o clipe ou só o efeito), rode “Seguir conteúdo” de novo: a região não acompanha essas mudanças. Ctrl+Z desfaz.` })
    }
  } catch (e) {
    if (e instanceof TrackingCancelled) toast.info('Rastreamento cancelado: nada foi aplicado')
    else if (e instanceof EditError) toast.error(e.message)
    else toast.error('Não foi possível seguir o conteúdo', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    setJob(itemId, null)
  }
}
