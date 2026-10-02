import { useMemo } from 'react'
import type { Item } from '@shared/editor/project'
import { formatTrackTime } from '@shared/editor/track'
import { cn } from '@/lib/cn'
import { stripRuns, useTrackStrips } from '../../state/trackStrips'

// Faixa de confiança do "Seguir conteúdo" (F6) embaixo do item de efeito: verde = confiante, âmbar = incerto (aceito
// com folga extra), vermelho = perdido (região ampliada / buraco fechado). Só enquanto a região do item é a que o
// rastreamento gravou (state/trackStrips). Coordenadas locais à caixa visível do item.

const TONE = { ok: 'bg-ok', weak: 'bg-warn', lost: 'bg-danger' } as const

export function TrackStripView({ item, pxPerSec, clipFrom, visW }: { item: Item; pxPerSec: number; clipFrom: number; visW: number }): React.JSX.Element | null {
  const strip = useTrackStrips((s) => s.strips[item.id])
  const live = !!strip && item.type === 'effect' && strip.region === item.region
  const runs = useMemo(() => (live ? stripRuns(strip!.samples, item.durationUs) : []), [live, strip, item.durationUs])
  if (!live || runs.length === 0) return null
  const total = runs.reduce((a, r) => a + r.toUs - r.fromUs, 0)
  const okShare = Math.round((100 * runs.filter((r) => r.state === 'ok').reduce((a, r) => a + r.toUs - r.fromUs, 0)) / Math.max(1, total))
  const lost = runs.filter((r) => r.state === 'lost').map((r) => formatTrackTime(item.startUs + r.fromUs))
  const label = `Confiança do rastreamento: ${okShare} % confiante${lost.length ? `; perdido em ${lost.join(', ')}` : ''}`
  return (
    <span data-track-strip="" role="img" aria-label={label} title={label} className="absolute inset-x-0 bottom-0 z-[2] block h-[3px] bg-black/40">
      {runs.map((r) => {
        const l = Math.max(0, (r.fromUs * pxPerSec) / 1e6 - clipFrom)
        const rr = Math.min(visW, (r.toUs * pxPerSec) / 1e6 - clipFrom)
        if (rr <= l) return null
        return <span key={r.fromUs} data-state={r.state} className={cn('absolute inset-y-0 block', TONE[r.state])} style={{ left: l, width: rr - l }} />
      })}
    </span>
  )
}
