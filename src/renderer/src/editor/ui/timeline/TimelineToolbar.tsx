import { memo } from 'react'
import { Bookmark, Eraser, Magnet, Maximize2, Redo2, Scissors, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { formatTimecodeUs } from '@shared/editor/time'
import { Slider, Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../../engine/PlaybackController'
import { SHORTCUT_LABELS, type ShortcutAction } from '../../shortcuts'
import { useEditorStore } from '../../state/editorStore'
import { runShortcut } from '../editorActions'
import { ZOOM_MAX, ZOOM_MIN } from './zoom'

// Barra da linha do tempo: dividir, apagar, desfazer/refazer, ímã, marcador, entrada/saída e
// "Apagar trecho I–O", zoom (−, slider logarítmico, +, ajustar). Tudo passa por runShortcut,
// o mesmo caminho dos atalhos de teclado.

const LOG_RANGE = Math.log(ZOOM_MAX / ZOOM_MIN)
const zoomToSlider = (z: number): number => (Math.log(z / ZOOM_MIN) / LOG_RANGE) * 1000
const sliderToZoom = (v: number): number => ZOOM_MIN * Math.exp((v / 1000) * LOG_RANGE)

function Btn({ label, action, playback, icon: Icon, active, disabled, text }: { label: string; action: ShortcutAction; playback: PlaybackController | null; icon?: React.ComponentType<{ className?: string }>; active?: boolean; disabled?: boolean; text?: string }): React.JSX.Element {
  return (
    <Tip content={label} shortcut={SHORTCUT_LABELS[action] ?? null}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={() => runShortcut(action, playback)}
        className={cn(
          'flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-35',
          active ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-white/6 hover:text-fg'
        )}
      >
        {Icon ? <Icon className="h-4 w-4" /> : null}
        {text ? <span className="font-mono">{text}</span> : null}
      </button>
    </Tip>
  )
}

const Sep = (): React.JSX.Element => <span className="mx-1 h-4 w-px bg-border-strong" />

export const TimelineToolbar = memo(function TimelineToolbar({ playback, onZoom }: { playback: PlaybackController | null; onZoom: (pxPerSec: number) => void }): React.JSX.Element {
  const canUndo = useEditorStore((s) => s.canUndo)
  const canRedo = useEditorStore((s) => s.canRedo)
  const hasSelection = useEditorStore((s) => s.selection.length > 0)
  const snapping = useEditorStore((s) => s.snapping)
  const zoom = useEditorStore((s) => s.zoomPxPerSec)
  const inUs = useEditorStore((s) => s.inUs)
  const outUs = useEditorStore((s) => s.outUs)
  const fps = useEditorStore((s) => s.project?.canvas.fps ?? 30)
  const range = inUs !== null && outUs !== null && outUs > inUs
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-surface/80 px-2" role="toolbar" aria-label="Ferramentas da linha do tempo">
      <Btn label="Dividir no playhead" action="split" playback={playback} icon={Scissors} />
      <Btn label="Excluir seleção" action="delete" playback={playback} icon={Trash2} disabled={!hasSelection} />
      <Sep />
      <Btn label="Desfazer" action="undo" playback={playback} icon={Undo2} disabled={!canUndo} />
      <Btn label="Refazer" action="redo" playback={playback} icon={Redo2} disabled={!canRedo} />
      <Sep />
      <Btn label={snapping ? 'Ímã ligado' : 'Ímã desligado'} action="toggleSnap" playback={playback} icon={Magnet} active={snapping} />
      <Btn label="Adicionar marcador" action="marker" playback={playback} icon={Bookmark} />
      <Sep />
      <Btn label="Marcar entrada" action="markIn" playback={playback} text="I" active={inUs !== null} />
      <Btn label="Marcar saída" action="markOut" playback={playback} text="O" active={outUs !== null} />
      <Btn label="Apagar trecho I–O" action="deleteRange" playback={playback} icon={Eraser} disabled={!range} />
      {range ? (
        <span className="ml-1 font-mono text-[10px] text-muted">
          {formatTimecodeUs(inUs, fps)} – {formatTimecodeUs(outUs, fps)}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        <Btn label="Diminuir zoom" action="zoomOut" playback={playback} icon={ZoomOut} />
        <Slider
          aria-label="Zoom da linha do tempo"
          className="w-28"
          min={0}
          max={1000}
          step={1}
          value={[zoomToSlider(zoom)]}
          onValueChange={([v]) => onZoom(sliderToZoom(v))}
        />
        <Btn label="Aumentar zoom" action="zoomIn" playback={playback} icon={ZoomIn} />
        <Btn label="Ajustar tudo" action="zoomFit" playback={playback} icon={Maximize2} />
      </div>
    </div>
  )
})
