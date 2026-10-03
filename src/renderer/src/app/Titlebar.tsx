import { Clock3, Settings2, ChevronLeft, Clapperboard } from 'lucide-react'
import { useAppStore } from './store'
import { cn } from '@/lib/cn'
import { RecDot, Tip } from '@/components/ui/primitives'
import { formatClock } from '@/lib/format'
import { requestLeaveEditor } from '@/editor/ui/ExportQueuePanel'

// Barra de título custom (a janela usa titleBarStyle 'hidden' + overlay nativo do Windows).
// A área toda é arrastável; botões são no-drag. O overlay nativo ocupa a direita.

const STATUS: Partial<Record<string, string>> = { review: 'Revisão', editor: 'Editor', projects: 'Projetos' }

export function Titlebar(): React.JSX.Element {
  const screen = useAppStore((s) => s.screen)
  const phase = useAppStore((s) => s.phase)
  const elapsed = useAppStore((s) => s.live.elapsedMs)
  const setScreen = useAppStore((s) => s.setScreen)
  const goBack = useAppStore((s) => s.goBack)
  const version = useAppStore((s) => s.appInfo?.version)
  const isSub = screen === 'settings' || screen === 'history' || screen === 'projects'
  const busy = phase === 'recording' || phase === 'paused' || phase === 'countdown' || phase === 'stopping'
  return (
    <header className="drag-region relative z-10 flex h-10 shrink-0 items-center gap-2 border-b border-border bg-bg/60 pl-3 pr-[150px] backdrop-blur">
      {isSub ? (
        <button className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-white/5 hover:text-fg" onClick={goBack} aria-label="Voltar">
          <ChevronLeft className="h-4 w-4" />
        </button>
      ) : (
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 ring-1 ring-accent/30">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
      )}
      <span className="text-[13px] font-bold tracking-tight">CiaLight Gravador</span>
      {version ? <span className="font-mono text-[10px] text-muted-2">v{version}</span> : null}
      <div className="mx-3 h-4 w-px bg-border-strong" />
      <div className={cn('flex items-center gap-2 text-xs', busy ? 'text-fg' : 'text-muted')}>
        <RecDot active={phase === 'recording'} paused={phase === 'paused'} />
        <span className="font-mono tnum">{busy ? formatClock(elapsed) : (STATUS[screen] ?? 'Pronto')}</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Tip content="Projetos do editor">
          <button
            className={cn('no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold hover:bg-white/5 disabled:pointer-events-none disabled:opacity-40', screen === 'projects' || screen === 'editor' ? 'text-fg' : 'text-muted hover:text-fg')}
            onClick={() => (screen === 'editor' ? requestLeaveEditor(() => setScreen('projects')) : setScreen(screen === 'projects' ? useAppStore.getState().returnScreen : 'projects'))}
            disabled={busy}
            aria-label="Projetos"
          >
            <Clapperboard className="h-4 w-4" />
            Projetos
          </button>
        </Tip>
        <Tip content="Histórico de gravações">
          <button
            className={cn('no-drag flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/5', screen === 'history' ? 'text-fg' : 'text-muted hover:text-fg')}
            onClick={() => setScreen(screen === 'history' ? useAppStore.getState().returnScreen : 'history')}
            aria-label="Histórico"
          >
            <Clock3 className="h-4 w-4" />
          </button>
        </Tip>
        <Tip content="Configurações">
          <button
            className={cn('no-drag flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/5', screen === 'settings' ? 'text-fg' : 'text-muted hover:text-fg')}
            onClick={() => setScreen(screen === 'settings' ? useAppStore.getState().returnScreen : 'settings')}
            aria-label="Configurações"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </Tip>
      </div>
    </header>
  )
}
