import { useEffect, useState } from 'react'
import { Camera, CameraOff, Eraser, Maximize2, Mic, MicOff, Pause, PenLine, PictureInPicture2, Play, Square } from 'lucide-react'
import type { BarState } from '@shared/ipc'
import type { RecorderCommand } from '@shared/types'
import { formatClock, formatBytes } from '@/lib/format'
import { cn } from '@/lib/cn'
import { TooltipProvider, Tip } from '@/components/ui/primitives'

// Barra flutuante de controles (janela própria, sempre no topo, excluída da captura).
// Recebe BarState do main a cada ~500 ms; envia comandos de volta.

const cmd = (c: RecorderCommand): void => window.api.recording.sendCommand(c)

export function BarApp(): React.JSX.Element {
  const [s, setS] = useState<BarState | null>(null)
  useEffect(() => window.api.bar.onState(setS), [])
  const paused = s?.phase === 'paused'
  const recording = s?.phase === 'recording'
  const btn = 'no-drag flex h-9 w-9 items-center justify-center rounded-xl text-white/85 transition-colors hover:bg-white/10 hover:text-white active:scale-95 disabled:opacity-35 disabled:hover:bg-transparent'
  return (
    <TooltipProvider>
      <div className="drag-region flex h-full w-full items-center justify-center p-1" style={{ background: 'transparent' }}>
        <div className="flex h-[52px] items-center gap-0.5 rounded-2xl border border-white/12 bg-[rgba(12,14,20,0.86)] px-2 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md">
          {/* estado */}
          <div className="no-drag mr-1 flex items-center gap-2 rounded-xl px-2 py-1">
            <span className={cn('h-2.5 w-2.5 rounded-full', paused ? 'bg-warn' : recording ? 'bg-accent rec-pulse' : 'bg-white/40')} />
            <span className="font-mono tnum text-[15px] font-semibold text-white">{formatClock(s?.elapsedMs ?? 0)}</span>
            <span className="font-mono whitespace-nowrap text-[10px] text-white/45">{formatBytes(s?.bytes ?? 0)}</span>
          </div>
          <span className="mx-1 h-6 w-px bg-white/12" />
          <Tip content={paused ? 'Retomar' : 'Pausar'} shortcut="Ctrl+Shift+F10" side="bottom">
            <button className={btn} onClick={() => cmd('pauseResume')} disabled={!s || s.phase === 'stopping'} aria-label={paused ? 'Retomar' : 'Pausar'}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
          </Tip>
          <Tip content="Parar e revisar" shortcut="Ctrl+Shift+F9" side="bottom">
            <button className={cn(btn, 'bg-accent/90 text-white hover:bg-accent')} onClick={() => cmd('stop')} aria-label="Parar">
              <Square className="h-4 w-4 fill-current" />
            </button>
          </Tip>
          <span className="mx-1 h-6 w-px bg-white/12" />
          <Tip content={s?.micMuted ? 'Ativar microfone' : 'Silenciar microfone'} shortcut="Ctrl+Shift+F1" side="bottom">
            <button className={cn(btn, s?.micMuted && 'text-warn')} onClick={() => cmd('muteMic')} disabled={!s?.hasMic} aria-label="Microfone">
              {s?.micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
          </Tip>
          <Tip content={s?.camOn ? 'Desligar câmera' : 'Ligar câmera'} shortcut="Ctrl+Shift+F2" side="bottom">
            <button className={cn(btn, s && !s.camOn && 'text-warn')} onClick={() => cmd('toggleCamera')} disabled={!s?.hasCam} aria-label="Câmera">
              {s?.camOn ? <Camera className="h-4 w-4" /> : <CameraOff className="h-4 w-4" />}
            </button>
          </Tip>
          <Tip content="Posição da webcam (cicla cantos e tamanhos)" side="bottom">
            <button className={btn} onClick={() => cmd('cyclePip')} disabled={!s?.hasCam} aria-label="Posição da webcam">
              <PictureInPicture2 className="h-4 w-4" />
            </button>
          </Tip>
          <span className="mx-1 h-6 w-px bg-white/12" />
          <Tip content={s?.annotating ? 'Sair do modo anotação' : 'Anotar na tela'} shortcut="Ctrl+Shift+F5" side="bottom">
            <button className={cn(btn, s?.annotating && 'bg-white/15 text-white')} onClick={() => cmd('annotate')} aria-label="Anotar">
              <PenLine className="h-4 w-4" />
            </button>
          </Tip>
          <Tip content="Apagar anotações" shortcut="Ctrl+Shift+F7" side="bottom">
            <button className={btn} onClick={() => cmd('clearAnnotations')} aria-label="Apagar anotações">
              <Eraser className="h-4 w-4" />
            </button>
          </Tip>
          <span className="mx-1 h-6 w-px bg-white/12" />
          <Tip content="Mostrar janela do gravador" side="bottom">
            <button className={btn} onClick={() => cmd('showRecorder')} aria-label="Mostrar gravador">
              <Maximize2 className="h-4 w-4" />
            </button>
          </Tip>
        </div>
      </div>
    </TooltipProvider>
  )
}
