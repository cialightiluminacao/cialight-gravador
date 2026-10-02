import { createContext, useContext } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getAnim, toggleKeyframe, type AnimPath } from '@shared/editor/ops'
import type { Item } from '@shared/editor/project'
import { frameDurUs, itemEndUs } from '@shared/editor/time'
import { Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../../engine/PlaybackController'
import { useEditorStore } from '../../state/editorStore'
import { useCurveEditor } from '../../state/keyframeLanes'
import { usePausedPlayhead } from '../../state/pausedPlayhead'
import { seekTo } from '../editorActions'
import { curveKeyFor } from './curveMath'

// Botão de keyframe genérico de uma propriedade animável (AnimPath): ◀ vai ao key anterior, ◇ liga/
// desliga o key no playhead (cheio = há key aqui; contorno âmbar = propriedade animada), ▶ vai ao
// próximo. Usado no efeito (região/intensidade), na transformação/opacidade do vídeo e no volume.
// Botão direito no ◇ abre o editor de curvas do key no playhead (senão o do trecho em que ele está).

/** Controle de reprodução para os saltos de keyframe (o inspetor não recebe o motor por props). */
export const InspectorPlayback = createContext<PlaybackController | null>(null)

const btn = 'flex h-6 w-5 items-center justify-center rounded text-muted hover:bg-white/5 hover:text-fg disabled:pointer-events-none disabled:opacity-25'

/** disabled: faixa bloqueada (nada de criar/remover keys; navegar continua valendo). */
export function KeyframeButton({ item, path, label, disabled }: { item: Item; path: AnimPath; label: string; disabled?: boolean }): React.JSX.Element | null {
  const playback = useContext(InspectorPlayback)
  const playheadUs = usePausedPlayhead()
  const fps = useEditorStore((s) => s.project?.canvas.fps ?? 30)
  const anim = getAnim(item, path)
  if (!anim) return null
  const keys = (anim.keys ?? []).map((k) => item.startUs + k.tUs)
  const tol = frameDurUs(fps) / 2
  // fim exclusivo (como o visualizador e o Alt+K): no fim do item já vale o próximo
  const inside = playheadUs >= item.startUs && playheadUs < itemEndUs(item)
  const here = keys.some((t) => Math.abs(t - playheadUs) <= tol)
  const prev = keys.filter((t) => t < playheadUs - tol).at(-1) ?? null
  const next = keys.find((t) => t > playheadUs + tol) ?? null
  const animated = keys.length > 0
  const go = (t: number | null): void => {
    if (t === null) return
    if (useEditorStore.getState().playing) playback?.pause()
    seekTo(playback, t)
  }
  const toggle = (): void => {
    const s = useEditorStore.getState()
    s.apply((p) => toggleKeyframe(p, item.id, path, s.playheadUs))
  }
  const openCurve = (e: React.MouseEvent): void => {
    e.preventDefault()
    const k = curveKeyFor(anim, playheadUs - item.startUs, tol)
    if (!k) {
      toast('Crie um keyframe (◇) para editar a curva.')
      return
    }
    useCurveEditor.getState().open({ itemId: item.id, path, tUs: k.tUs, x: e.clientX, y: e.clientY })
  }
  return (
    <div className="flex shrink-0 items-center" data-kf-path={path}>
      <Tip content={`Keyframe anterior (${label})`}>
        <button type="button" data-kf="prev" aria-label={`Keyframe anterior de ${label}`} className={btn} disabled={prev === null} onClick={() => go(prev)}>
          <ChevronLeft className="h-3 w-3" />
        </button>
      </Tip>
      <Tip content={<>{here ? `Remover keyframe de ${label}` : `Adicionar keyframe de ${label}`}{animated ? <span className="block text-muted">Botão direito: curva</span> : null}</>}>
        <button type="button" data-kf="toggle" aria-label={here ? `Remover keyframe de ${label}` : `Adicionar keyframe de ${label}`} aria-pressed={here} className={btn} disabled={!inside || disabled} onClick={toggle} onContextMenu={openCurve}>
          <span className={cn('block h-2 w-2 rotate-45 border', here ? 'border-black/50 bg-warn' : animated ? 'border-warn' : 'border-muted')} />
        </button>
      </Tip>
      <Tip content={`Próximo keyframe (${label})`}>
        <button type="button" data-kf="next" aria-label={`Próximo keyframe de ${label}`} className={btn} disabled={next === null} onClick={() => go(next)}>
          <ChevronRight className="h-3 w-3" />
        </button>
      </Tip>
    </div>
  )
}
