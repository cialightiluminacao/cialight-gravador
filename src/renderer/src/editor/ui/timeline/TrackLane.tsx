import { memo } from 'react'
import type { Asset, Track } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { ITEM_MARGIN_PX, ItemView } from './ItemView'
import { visibleItems } from './layout'
import { TransitionMark } from './TransitionMark'
import { visibleTransitions } from './transitionMath'

// Área de uma faixa: só renderiza os itens que cruzam a janela visível (+ margem). Os gestos
// (mover, trim, seleção por caixa, menu) são tratados por delegação no Timeline/useTimelineDrag.

interface Props {
  track: Track
  rowH: number
  projectId: string
  assets: Map<string, Asset>
  pxPerSec: number
  scrollUs: number
  viewW: number
  selection: string[]
  /** Transição selecionada (id do clipe B). */
  selectedTransition: string | null
  /** Itens expandidos (linhas de keyframes) e o topo das linhas (px, relativo à faixa). */
  expanded: ReadonlySet<string>
  lanesTop: number
}

export const TrackLane = memo(function TrackLane({ track, rowH, projectId, assets, pxPerSec, scrollUs, viewW, selection, selectedTransition, expanded, lanesTop }: Props): React.JSX.Element {
  const marginUs = (ITEM_MARGIN_PX * 1e6) / pxPerSec
  const fromUs = scrollUs - marginUs
  const toUs = scrollUs + (viewW * 1e6) / pxPerSec + marginUs
  return (
    <div data-track-id={track.id} data-lane="" className={cn('relative h-full min-w-0 flex-1 overflow-hidden', track.kind === 'video' ? 'bg-white/[0.015]' : 'bg-white/[0.025]')}>
      {visibleItems(track.items, fromUs, toUs).map((it) => (
        <ItemView
          key={it.id}
          item={it}
          asset={it.type === 'media' ? assets.get(it.assetId) : undefined}
          projectId={projectId}
          kind={track.kind}
          rowH={rowH}
          locked={track.locked}
          dimmed={track.hidden || (track.kind === 'audio' && track.muted)}
          pxPerSec={pxPerSec}
          scrollUs={scrollUs}
          viewW={viewW}
          selected={selection.includes(it.id)}
          trackVolume={track.volume}
          expanded={expanded.has(it.id)}
          lanesTop={lanesTop}
        />
      ))}
      {/* ícones das transições: irmãos dos itens (o ItemView corta com overflow-hidden) */}
      {visibleTransitions(track, fromUs, toUs).map((w) => (
        <TransitionMark key={w.toId} w={w} pxPerSec={pxPerSec} scrollUs={scrollUs} rowH={rowH} selected={selectedTransition === w.toId} locked={track.locked} />
      ))}
    </div>
  )
})
