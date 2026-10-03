import { Crosshair, Play, SkipBack, X } from 'lucide-react'
import type { EffectItem, Project } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'
import { formatTrackTime, trackingBlocker } from '@shared/editor/track'
import { Button } from '@/components/ui/Button'
import { Progress, Tip } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { liveLossUs, useTrackStrips } from '../../state/trackStrips'
import { cancelFollow, continueFrom, followContent, useTrackJobs } from '../followContent'
import { PanelSection } from './common'

// "Seguir conteúdo" (F6) no inspetor do efeito: o botão, o progresso com "Cancelar" e a legenda da faixa de confiança
// que aparece no item depois do rastreamento. Ancorado / faixa bloqueada: botão desativado com o motivo (dica e texto).
// Depois de uma perda não recuperada (G4): "Continuar daqui" (playhead no instante da perda) e, com o playhead na perda
// ou depois dela (dentro do efeito), "Continuar rastreamento" — a passada a partir do playhead com a região ajustada ali.

export function TrackPanel({ project, item }: { project: Project; item: EffectItem }): React.JSX.Element {
  const job = useTrackJobs((s) => s.jobs[item.id])
  const busy = useTrackJobs((s) => Object.keys(s.jobs).length > 0)
  const strip = useTrackStrips((s) => s.strips[item.id])
  const blocked = trackingBlocker(project, item.id)
  const pct = job && job.total > 0 ? (job.frame / job.total) * 100 : 0
  const showLegend = !!strip && strip.region === item.region
  // do estado atual (G4): some se o rastreamento foi desfeito; acompanha o efeito movido
  const lossUs = useEditorStore((s) => liveLossUs(strip, s.project, s.history.past, item.id))
  const end = itemEndUs(item)
  const lossInside = lossUs !== null
  const atLoss = useEditorStore((s) => lossInside && s.playheadUs >= lossUs! && s.playheadUs < end)
  const disabledTip = blocked ?? (busy ? 'Já há um rastreamento em andamento' : null)

  return (
    <PanelSection title="Seguir conteúdo">
      <div className="space-y-2" data-follow-content-panel="">
        <p className="text-[10.5px] leading-snug text-muted">
          Ponha a região sobre o conteúdo no quadro do playhead: o movimento é acompanhado até o fim do efeito e vira keyframes editáveis. Se o conteúdo for coberto por pouco tempo (até 1 s, como o cursor passando), ele é reencontrado sozinho; na dúvida (conteúdo repetido ou parecido na tela, movimento estranho, cobertura longa), a região é ampliada{item.invert ? ' (invertido: o buraco é fechado)' : ''} até o fim do efeito — para continuar, ajuste a região e use “Continuar rastreamento”.
        </p>
        {job ? (
          <div className="space-y-1.5" role="status" aria-live="polite">
            <Progress value={pct} />
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="tabular-nums text-fg-2">{job.total ? `Analisando ${job.frame} de ${job.total} quadros…` : 'Preparando…'}</span>
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => cancelFollow(item.id)}>
                <X className="h-3.5 w-3.5" /> Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <>
            {lossInside ? (
              <div className="space-y-1.5 rounded-md border border-warn/30 bg-warn/10 p-2" data-follow-loss="">
                <p className="text-[10.5px] leading-snug text-warn" role="status">
                  Rastreamento perdido em {formatTrackTime(lossUs!)}: {item.invert ? 'buraco fechado' : 'região ampliada'} daí até o fim do efeito.
                </p>
                <Button size="sm" variant="ghost" className="h-7 w-full px-2" data-follow-continue-from="" onClick={() => continueFrom(item.id)}>
                  <SkipBack className="h-3.5 w-3.5" /> Continuar daqui
                </Button>
                {atLoss ? (
                  <Tip content={disabledTip ?? 'Segue o conteúdo do playhead até o fim do efeito com a região ajustada aqui; os keyframes de antes ficam (um passo de desfazer)'}>
                    <span className="flex">
                      <Button size="sm" variant="primary" className="w-full" data-follow-resume="" disabled={!!disabledTip} onClick={() => void followContent(item.id, { resume: true })}>
                        <Play className="h-3.5 w-3.5" /> Continuar rastreamento
                      </Button>
                    </span>
                  </Tip>
                ) : null}
              </div>
            ) : null}
            <Tip content={disabledTip ?? 'Acompanha o conteúdo do playhead até o fim do efeito (um passo de desfazer)'}>
              <span className="flex">
                <Button size="sm" variant="secondary" className="w-full" data-follow-content="" disabled={!!disabledTip} onClick={() => void followContent(item.id)}>
                  <Crosshair className="h-3.5 w-3.5" /> Seguir conteúdo
                </Button>
              </span>
            </Tip>
          </>
        )}
        {blocked ? <p data-follow-content-reason="" className="text-[10.5px] leading-snug text-warn" role="status">{blocked}</p> : null}
        {showLegend ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted">
            <span>Faixa no item:</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-ok" aria-hidden />confiante</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-warn" aria-hidden />incerto (perda)</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-danger" aria-hidden />perdido</span>
          </p>
        ) : null}
      </div>
    </PanelSection>
  )
}
