import { useMemo } from 'react'
import { ANIM_PATHS, getAnim } from '@shared/editor/animPaths'
import { keyframeTimesUs } from '@shared/editor/ops'
import type { Item } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { isKeySelected, useKeyframeSelection } from '../../state/keyframeSelection'
import { keyframeMarkLefts } from './dragMath'

// Losangos dos keyframes do item (qualquer propriedade; keys no mesmo instante viram um losango só),
// na linha do meio da caixa. Clicar leva o playhead ao key e o seleciona (Shift/Ctrl soma; Delete remove),
// arrastar muda o instante (data-keyframe, tratado pelo useTimelineDrag). Coordenadas locais à caixa visível.
// Com o item expandido, as linhas por propriedade (KeyframeLanes) mostram o detalhe.

const HIT = 13 // área de clique (px); o losango desenhado é menor
const SIZE = 9

interface Props {
  item: Item
  pxPerSec: number
  clipFrom: number
  visW: number
  h: number
  locked: boolean
}

export function KeyframeMarks({ item, pxPerSec, clipFrom, visW, h, locked }: Props): React.JSX.Element | null {
  // só refaz quando alguma curva muda (mover o item no tempo não muda as anims: o immer mantém os objetos)
  const anims = ANIM_PATHS.map((pt) => getAnim(item, pt))
  const times = useMemo(() => keyframeTimesUs(item), anims)
  const sel = useKeyframeSelection((s) => (s.sel?.itemId === item.id ? s.sel : null))
  if (times.length === 0) return null
  return (
    <>
      {keyframeMarkLefts(times, pxPerSec, clipFrom, visW, HIT, sel ? (t) => isKeySelected(sel, item.id, null, t) : undefined).map(({ tUs, left }) => {
        const selected = isKeySelected(sel, item.id, null, tUs)
        return (
          <span
            key={tUs}
            data-keyframe={tUs}
            title={locked ? 'Keyframe — clique para ir até ele' : 'Keyframe — clique para ir até ele (Shift soma à seleção); arraste para mudar o instante; Delete remove'}
            className={cn('absolute z-[3] flex items-center justify-center', locked ? 'cursor-pointer' : 'cursor-ew-resize')}
            style={{ left, top: (h - HIT) / 2, width: HIT, height: HIT }}
          >
            <span
              className={cn('block rotate-45 border shadow', selected ? 'border-white bg-accent ring-1 ring-accent' : 'border-black/60 bg-warn')}
              style={{ width: SIZE, height: SIZE }}
            />
          </span>
        )
      })}
    </>
  )
}
