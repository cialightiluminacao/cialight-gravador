import { memo, useMemo } from 'react'
import { getAnim, type AnimPath } from '@shared/editor/animPaths'
import type { Anim, Item } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { isKeySelected, useKeyframeSelection, type KeyframeSel } from '../../state/keyframeSelection'
import { keyframeMarkLefts } from './dragMath'
import { curveSegments, EASE_COLOR, EASE_LABEL, easeKind, PATH_LABEL } from './laneMath'
import { LANE_H, lanePaths } from './layout'

// Linhas de keyframes do item expandido (seta no item): uma por propriedade animada, abaixo da caixa do
// item, com a mini-curva do valor (trechos na cor do ease do key que os começa) e os losangos na cor do
// ease. Os gestos são do useTimelineDrag, por delegação: clique leva o playhead ao key e o seleciona
// (Shift/Ctrl soma), arrastar move os selecionados (uma transação), caixa no fundo seleciona vários,
// botão direito abre o editor de curvas; Delete e Ctrl+C/Ctrl+V ficam no editorActions.
// Só existe para itens expandidos e visíveis (o TrackLane já virtualiza os itens).
//
// Keys extras de corte exato: dividir/aparar/velocidade/colar em cima de uma bezier insere keys a mais
// (insertKeyExact) para o pedaço continuar exatamente com a mesma curva. Eles aparecem aqui como qualquer
// key, de propósito: são keys de verdade do modelo (mexer neles muda a curva, como em qualquer outro) e
// marcá-los exigiria guardar no projeto de onde cada key veio, sem nada que o usuário possa fazer de diferente.

const HIT = 13 // área de clique (px); o losango desenhado é menor
const SIZE = 8

interface Props {
  item: Item
  pxPerSec: number
  clipFrom: number
  visW: number
  /** Posição da parte visível do item na faixa (px) e topo das linhas (px, relativo à faixa). */
  left: number
  top: number
  locked: boolean
}

export const KeyframeLanes = memo(function KeyframeLanes({ item, pxPerSec, clipFrom, visW, left, top, locked }: Props): React.JSX.Element {
  const paths = useMemo(() => lanePaths(item), [item])
  const sel = useKeyframeSelection((s) => (s.sel?.itemId === item.id ? s.sel : null))
  return (
    <div
      data-lanes-item={item.id}
      className="absolute overflow-hidden rounded-b-[6px] border border-t-0 border-white/10 bg-black/35"
      style={{ left, top, width: visW, height: Math.max(1, paths.length) * LANE_H }}
    >
      {paths.length === 0 ? (
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center whitespace-nowrap text-[10px] text-muted">Sem keyframes — crie com ◇ no inspetor ou Alt+K</span>
      ) : (
        paths.map((pt, i) => <Lane key={pt} item={item} path={pt} anim={getAnim(item, pt)!} index={i} pxPerSec={pxPerSec} clipFrom={clipFrom} visW={visW} sel={sel} locked={locked} />)
      )}
    </div>
  )
})

function secLabel(us: number): string {
  return `${(us / 1e6).toFixed(2).replace('.', ',')} s`
}

interface LaneProps { item: Item; path: AnimPath; anim: Anim<number>; index: number; pxPerSec: number; clipFrom: number; visW: number; sel: KeyframeSel | null; locked: boolean }

const Lane = memo(function Lane({ item, path, anim, index, pxPerSec, clipFrom, visW, sel, locked }: LaneProps): React.JSX.Element {
  const segs = useMemo(() => curveSegments(anim, item.durationUs, pxPerSec, clipFrom, visW, LANE_H), [anim, item.durationUs, pxPerSec, clipFrom, visW])
  const keys = anim.keys ?? []
  const label = PATH_LABEL[path]
  return (
    <div data-lane-path={path} className="absolute inset-x-0 border-b border-white/[0.06]" style={{ top: index * LANE_H, height: LANE_H }}>
      <svg className="pointer-events-none absolute left-0 top-0" width={Math.max(1, visW)} height={LANE_H} aria-hidden>
        {segs.map((s, j) => (
          <path key={j} d={s.d} fill="none" stroke={EASE_COLOR[s.kind]} strokeWidth={1.4} strokeDasharray={s.kind === 'flat' ? '3 3' : undefined} />
        ))}
      </svg>
      <span className="pointer-events-none absolute left-1 top-[3px] z-[1] max-w-[45%] truncate rounded bg-black/60 px-1 text-[9px] font-semibold leading-[14px] text-white/85">{label}</span>
      {keyframeMarkLefts(keys.map((k) => k.tUs), pxPerSec, clipFrom, visW, HIT).map(({ tUs, left }, j) => {
        const k = keys.find((x) => x.tUs === tUs) ?? keys[j]
        const kind = easeKind(k.ease)
        const selected = isKeySelected(sel, item.id, path, tUs)
        return (
          <span
            key={tUs}
            data-lane-key={tUs}
            data-path={path}
            data-selected={selected || undefined}
            title={`${label} em ${secLabel(tUs)} — curva: ${EASE_LABEL[kind]}\n${locked ? 'Clique para ir até ele' : 'Clique: ir até ele (Shift soma à seleção) · arrastar: mover · botão direito: curva · Delete: remover'}`}
            className={cn('absolute z-[2] flex items-center justify-center', locked ? 'cursor-pointer' : 'cursor-ew-resize')}
            style={{ left, top: (LANE_H - HIT) / 2, width: HIT, height: HIT }}
          >
            <span
              className={cn('block rotate-45 border shadow', selected ? 'border-white ring-2 ring-accent' : 'border-black/60')}
              style={{ width: SIZE, height: SIZE, background: EASE_COLOR[kind] }}
            />
          </span>
        )
      })}
    </div>
  )
})
