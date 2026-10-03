import { memo } from 'react'
import { Blend, Droplets, Moon, MoveDown, MoveLeft, MoveRight, MoveUp, PanelLeft, PanelRight, Sun, ZoomIn, type LucideIcon } from 'lucide-react'
import type { TransitionWindow } from '@shared/editor/transitions'
import type { TransitionKind } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'
import { transitionAria } from '../transitionInfo'
import { DURATION_EDGE_PX, ICON_SIZE, ICON_TOP, markGeometry } from './transitionMath'

// O ícone fica no TOPO da faixa (18 px) e não cobre as alças de aparar do corte (A.fim e B.início, ItemView EDGE_W): abaixo
// dele o ponteiro cai nelas, e as bordas da janela (alças de duração) ficam fora delas (transitionMath.markRects/trimRects).
// Ícone da transição no corte: irmão dos itens em TrackLane (o ItemView corta com overflow-hidden). Mostra a largura
// da janela em escala; o ícone seleciona (clique) e as bordas mudam a duração (arrastar) — os gestos são delegados ao
// useTimelineDrag por data-attr: [data-transition-id] (id de B), [data-tedge] (start|end).

export const TRANSITION_ICONS: Record<TransitionKind, LucideIcon> = {
  crossfade: Blend,
  dipBlack: Moon,
  dipWhite: Sun,
  slideL: MoveLeft,
  slideR: MoveRight,
  slideU: MoveUp,
  slideD: MoveDown,
  wipeL: PanelLeft,
  wipeR: PanelRight,
  zoomIn: ZoomIn,
  blur: Droplets
}

interface Props {
  w: TransitionWindow
  pxPerSec: number
  scrollUs: number
  rowH: number
  selected: boolean
  locked: boolean
}

export const TransitionMark = memo(function TransitionMark({ w, pxPerSec, scrollUs, rowH, selected, locked }: Props): React.JSX.Element {
  const g = markGeometry(w, pxPerSec, scrollUs)
  const Icon = TRANSITION_ICONS[w.kind]
  return (
    <div data-transition-id={w.toId} className="pointer-events-none absolute top-0 z-[6]" style={{ left: g.left, width: g.width, height: rowH }}>
      <div className={cn('absolute inset-x-0 inset-y-[3px] rounded-[5px] border', selected ? 'border-accent bg-accent/25' : 'border-white/35 bg-white/15')} />
      <span data-tedge="start" aria-hidden style={{ left: -DURATION_EDGE_PX / 2, width: DURATION_EDGE_PX }} className={cn('pointer-events-auto absolute inset-y-[3px] rounded-sm', locked ? 'cursor-not-allowed' : 'cursor-ew-resize hover:bg-white/40')} />
      <span data-tedge="end" aria-hidden style={{ right: -DURATION_EDGE_PX / 2, width: DURATION_EDGE_PX }} className={cn('pointer-events-auto absolute inset-y-[3px] rounded-sm', locked ? 'cursor-not-allowed' : 'cursor-ew-resize hover:bg-white/40')} />
      <div
        role="button"
        tabIndex={0}
        data-transition-icon=""
        aria-label={transitionAria(w.kind, w.durationUs)}
        aria-pressed={selected}
        onKeyDown={(e) => {
          // Enter/Espaço selecionam (Espaço não pode tocar/pausar); Delete segue para o atalho global
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            useEditorStore.getState().selectTransition(w.toId)
          }
        }}
        title={transitionAria(w.kind, w.durationUs)}
        style={{ top: ICON_TOP, width: ICON_SIZE, height: ICON_SIZE }}
        className={cn(
          'pointer-events-auto absolute left-1/2 flex -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border text-fg shadow-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
          selected ? 'border-accent bg-accent text-white' : 'border-white/50 bg-surface-3'
        )}
      >
        <Icon className="h-3 w-3" aria-hidden />
      </div>
    </div>
  )
})
