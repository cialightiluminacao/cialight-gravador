import { memo } from 'react'
import type { Asset, Track } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { ITEM_MARGIN_PX, ItemView } from './ItemView'
import { visibleItems } from './layout'

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
}

export const TrackLane = memo(function TrackLane({ track, rowH, projectId, assets, pxPerSec, scrollUs, viewW, selection }: Props): React.JSX.Element {
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
        />
      ))}
    </div>
  )
})
