import { useEffect, useState } from 'react'
import { ChevronFirst, ChevronLast, FastForward, Maximize, Minimize, Pause, Play, Rewind, StepBack, StepForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import { projectDurationUs } from '@shared/editor/ops'
import { formatTimecodeUs } from '@shared/editor/time'
import { Slider, Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'
import { seekTo, stepFrames, togglePlay } from './editorActions'

// Barra de transporte do visualizador: timecode (+ taxa do shuttle J/L), ⏮ ◀quadro ▶/❚❚ quadro▶ ⏭, volume master e tela cheia.

const VOLUME_KEY = 'editor.previewVolume'

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(v) && localStorage.getItem(VOLUME_KEY) !== null ? Math.min(1, Math.max(0, v)) : 1
  } catch {
    return 1
  }
}

function IconBtn({ label, shortcut, onClick, children, primary, disabled }: { label: string; shortcut?: string; onClick: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean }): React.JSX.Element {
  return (
    <Tip content={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex items-center justify-center rounded-lg transition-colors disabled:opacity-40',
          primary ? 'h-9 w-9 bg-fg text-bg hover:bg-white' : 'h-8 w-8 text-fg-2 hover:bg-white/6 hover:text-fg'
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

export function Transport({ playback, fullscreen, onToggleFullscreen }: { playback: PlaybackController | null; fullscreen: boolean; onToggleFullscreen: () => void }): React.JSX.Element {
  const playing = useEditorStore((s) => s.playing)
  const playRate = useEditorStore((s) => s.playRate)
  const playheadUs = useEditorStore((s) => s.playheadUs)
  const fps = useEditorStore((s) => s.project?.canvas.fps ?? 30)
  const totalUs = useEditorStore((s) => (s.project ? projectDurationUs(s.project) : 0))
  const [volume, setVolume] = useState(readVolume)
  useEffect(() => playback?.setVolume(volume), [playback, volume])
  const [beforeMute, setBeforeMute] = useState(1)
  const changeVolume = (v: number): void => {
    setVolume(v)
    try {
      localStorage.setItem(VOLUME_KEY, String(v))
    } catch {
      // preferência só desta máquina: sem armazenamento, segue com o valor em memória
    }
  }
  const VolIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const empty = totalUs === 0

  return (
    <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-border bg-surface/50 px-3">
      <div className="font-mono tnum flex min-w-0 items-baseline gap-1.5 text-[13px]">
        <span className="text-fg" aria-label="Tempo atual">
          {formatTimecodeUs(playheadUs, fps)}
        </span>
        <span className="truncate text-[11px] text-muted" aria-label="Duração total">
          / {formatTimecodeUs(totalUs, fps)}
        </span>
        {playing && playRate !== 1 ? (
          <span className="flex shrink-0 items-center gap-0.5 self-center rounded bg-warn/90 px-1 font-mono text-[10px] font-semibold leading-[14px] text-black" aria-label={`Reproduzindo ${playRate < 0 ? 'para trás ' : ''}a ${Math.abs(playRate)}×`}>
            {playRate < 0 ? <Rewind className="h-2.5 w-2.5 fill-current" /> : null}
            {Math.abs(playRate)}×
            {playRate > 0 ? <FastForward className="h-2.5 w-2.5 fill-current" /> : null}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5">
        <IconBtn label="Ir para o início" shortcut="Home" onClick={() => seekTo(playback, 0)} disabled={empty}>
          <ChevronFirst className="h-4 w-4" />
        </IconBtn>
        <IconBtn label="Quadro anterior" shortcut="←" onClick={() => stepFrames(playback, -1)} disabled={empty}>
          <StepBack className="h-4 w-4" />
        </IconBtn>
        <IconBtn label={playing ? 'Pausar' : 'Reproduzir'} shortcut="Espaço" onClick={() => togglePlay(playback)} primary disabled={empty}>
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
        </IconBtn>
        <IconBtn label="Próximo quadro" shortcut="→" onClick={() => stepFrames(playback, 1)} disabled={empty}>
          <StepForward className="h-4 w-4" />
        </IconBtn>
        <IconBtn label="Ir para o fim" shortcut="End" onClick={() => seekTo(playback, totalUs)} disabled={empty}>
          <ChevronLast className="h-4 w-4" />
        </IconBtn>
      </div>
      <div className="flex items-center justify-end gap-1">
        <IconBtn
          label={volume === 0 ? 'Ativar som da prévia' : 'Silenciar prévia'}
          onClick={() => {
            if (volume === 0) changeVolume(beforeMute || 1)
            else {
              setBeforeMute(volume)
              changeVolume(0)
            }
          }}
        >
          <VolIcon className="h-4 w-4" />
        </IconBtn>
        <Slider aria-label="Volume da prévia" className="w-20" min={0} max={1} step={0.01} value={[volume]} onValueChange={([v]) => changeVolume(v)} />
        <IconBtn label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} onClick={onToggleFullscreen}>
          {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </IconBtn>
      </div>
    </div>
  )
}
