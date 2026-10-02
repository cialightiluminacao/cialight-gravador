import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Popover from '@radix-ui/react-popover'
import { Headphones, Mic, Square } from 'lucide-react'
import { formatTimecodeUs } from '@shared/editor/time'
import { Button } from '@/components/ui/Button'
import { Kbd, RecDot, Select, Tip, Toggle, VuMeter } from '@/components/ui/primitives'
import { useAppStore } from '@/app/store'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'
import { useNarration } from '../state/narration'
import { beginNarration, cancelNarration, finishNarration } from './narrationFlow'

// "Gravar narração" na barra da linha do tempo: popover com o microfone (lista do app) e "ouvir o vídeo enquanto
// grava"; depois contagem 3-2-1 e a barra de gravação (tempo, VU ao vivo, Parar) por cima do editor. Espaço/Esc param
// (na contagem, desistem). Microfone e "ouvir" lembrados neste computador (localStorage).

const MIC_KEY = 'editor.narration.mic'
const MONITOR_KEY = 'editor.narration.monitor'

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}

export function NarrationButton({ playback }: { playback: PlaybackController | null }): React.JSX.Element {
  const mics = useAppStore((s) => s.devices.mics)
  const ready = useAppStore((s) => s.devices.ready)
  const settingsMic = useAppStore((s) => s.settings.devices.micId)
  const projectId = useEditorStore((s) => s.project?.id ?? null)
  const phase = useNarration((s) => s.phase)
  const [open, setOpen] = useState(false)
  const [micId, setMicId] = useState<string | null>(() => readPref(MIC_KEY))
  const [monitor, setMonitor] = useState(() => readPref(MONITOR_KEY) === '1')
  // escolhido aqui → o do Preparar → o primeiro
  const mic = mics.find((m) => m.deviceId === micId)?.deviceId ?? mics.find((m) => m.deviceId === settingsMic)?.deviceId ?? mics[0]?.deviceId ?? null
  const busy = phase !== 'idle'
  const start = (): void => {
    if (!playback || !projectId) return
    setOpen(false)
    void beginNarration(playback, projectId, { deviceId: mic, monitor })
  }
  return (
    <Popover.Root open={open && !busy} onOpenChange={setOpen}>
      <Tip content="Gravar narração no playhead">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Gravar narração"
            disabled={!playback || busy}
            className={cn('flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-35', open ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-white/6 hover:text-fg')}
          >
            <Mic className="h-4 w-4" /> Narração
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content data-narration-setup="" side="top" align="start" sideOffset={8} className="z-50 w-80 rounded-xl border border-border-strong bg-surface-3 p-3 shadow-2xl animate-in fade-in-0 zoom-in-95">
          <div className="mb-2 text-[13px] font-semibold text-fg">Gravar narração</div>
          <p className="mb-3 text-[11px] leading-snug text-muted">A gravação começa no playhead, depois de uma contagem de 3 segundos, com o vídeo tocando. Pare com Espaço ou Esc.</p>
          <label className="mb-1 block text-[11px] font-semibold text-fg-2">Microfone</label>
          <Select
            value={mic}
            onValueChange={(v) => {
              setMicId(v)
              writePref(MIC_KEY, v)
            }}
            options={mics.map((m, i) => ({ value: m.deviceId, label: m.label || `Microfone ${i + 1}` }))}
            placeholder={ready ? 'Nenhum microfone encontrado' : 'Procurando microfones…'}
            disabled={mics.length === 0}
            triggerClassName="h-9 text-[13px]"
          />
          <label className="mt-3 flex cursor-pointer items-start gap-2.5">
            <Toggle
              size="sm"
              checked={monitor}
              onCheckedChange={(v) => {
                setMonitor(v)
                writePref(MONITOR_KEY, v ? '1' : '0')
              }}
              aria-label="Ouvir o vídeo enquanto grava"
            />
            <span className="text-[12px] leading-snug text-fg-2">
              Ouvir o vídeo enquanto grava
              <span className="flex items-center gap-1 text-[11px] text-muted">
                <Headphones className="h-3 w-3" /> Use fone de ouvido: sem ele, o som do vídeo entra no microfone.
              </span>
            </span>
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" onClick={start} disabled={!mic}>
              <Mic className="h-4 w-4" /> Gravar
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Contagem e barra de gravação por cima do editor; Espaço/Esc param (na contagem, desistem). */
export function NarrationOverlay(): React.JSX.Element | null {
  const phase = useNarration((s) => s.phase)
  const count = useNarration((s) => s.count)
  const level = useNarration((s) => s.level)
  const recordedUs = useNarration((s) => s.recordedUs)
  const fps = useEditorStore((s) => s.project?.canvas.fps ?? 30)

  useEffect(() => {
    if (phase === 'idle') return
    // captura: antes dos atalhos do editor e dos controles focados. Espaço/Esc param (na contagem, desistem); qualquer
    // outra tecla fora da barra de gravação é engolida (Enter num botão do editor focado não pode editar no meio)
    const onKey = (e: KeyboardEvent): void => {
      const inBar = e.target instanceof Element && !!e.target.closest('[data-narration-bar]')
      if (e.key === ' ' || e.key === 'Escape' || e.code === 'Space') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!e.repeat) void finishNarration()
      } else if (!inBar) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase])

  if (phase === 'idle') return null
  return createPortal(
    <>
      {/* bloqueio: nada do editor (linha do tempo, visualizador, inspetor, barra de cima) responde enquanto grava */}
      <div
        data-narration-block=""
        className="fixed inset-0 z-40 cursor-not-allowed bg-black/15"
        onPointerDown={(e) => e.preventDefault()}
        onWheel={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <span data-narration-hint="" className="rounded-full border border-border-strong bg-surface-3/95 px-4 py-1.5 text-[12px] font-semibold text-fg-2 shadow-xl">
            {phase === 'countdown' ? 'Preparando a gravação da narração…' : 'Gravando narração — pare para editar'}
          </span>
        </div>
      </div>
      <div data-narration-bar={phase} className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
      {phase === 'countdown' ? (
        <div className="pointer-events-auto flex items-center gap-4 rounded-2xl border border-border-strong bg-surface-3/95 px-5 py-3 shadow-2xl">
          <span data-narration-count="" className="font-mono text-4xl font-bold text-accent tabular-nums">
            {count}
          </span>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-fg">Prepare-se para falar…</span>
            <VuMeter level={level} className="h-2.5 w-40" segments={20} />
          </div>
          <Button size="sm" variant="ghost" onClick={cancelNarration}>
            Cancelar <Kbd>Esc</Kbd>
          </Button>
        </div>
      ) : (
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-accent/50 bg-surface-3/95 px-4 py-2.5 shadow-2xl">
          <RecDot active={phase === 'recording'} />
          <span className="text-[12px] font-semibold text-fg">{phase === 'recording' ? 'Gravando narração' : 'Salvando narração…'}</span>
          <span data-narration-time="" className="font-mono text-[13px] text-fg tabular-nums">
            {formatTimecodeUs(recordedUs, fps)}
          </span>
          <VuMeter level={level} className="h-2.5 w-40" segments={20} />
          <Tip content="Parar e inserir na linha do tempo" shortcut="Espaço">
            <Button size="sm" variant="primary" onClick={() => void finishNarration()} disabled={phase !== 'recording'} aria-label="Parar narração">
              <Square className="h-3.5 w-3.5 fill-current" /> Parar
            </Button>
          </Tip>
        </div>
      )}
      </div>
    </>,
    document.body
  )
}
