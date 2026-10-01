import { useRef } from 'react'
import { Construction } from 'lucide-react'
import { projectDurationUs } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../engine/PlaybackController'
import { useEditorStore } from '../state/editorStore'
import { addAssetAtPlayhead, seekTo } from './editorActions'
import { ASSET_MIME } from './MediaCard'
import { itemLabel } from './itemLabel'

// ==== PROVISÓRIO — substituído pela Timeline da Task 11 ====
// Régua mínima para testar reprodução e seek (arrastar move o playhead) e uma visão só-leitura das
// faixas (clique seleciona; Ctrl/Shift alterna). Soltar um cartão da biblioteca adiciona no playhead.

const NO_TRACKS: Project['tracks'] = []

export function TimelinePlaceholder({ playback }: { playback: PlaybackController | null }): React.JSX.Element {
  const project = useEditorStore((s) => s.project)
  const playheadUs = useEditorStore((s) => s.playheadUs)
  const selection = useEditorStore((s) => s.selection)
  const inUs = useEditorStore((s) => s.inUs)
  const outUs = useEditorStore((s) => s.outUs)
  const barRef = useRef<HTMLDivElement>(null)
  const total = project ? projectDurationUs(project) : 0
  // a régua mostra um pouco além do fim (mínimo 10 s) para dar onde soltar/arrastar
  const span = Math.max(10_000_000, Math.round(total * 1.1))
  const pct = (us: number): string => `${(us / span) * 100}%`
  const tracks = project?.tracks ?? NO_TRACKS

  const seekAt = (clientX: number): void => {
    const r = barRef.current?.getBoundingClientRect()
    if (!r) return
    seekTo(playback, (Math.min(Math.max(0, clientX - r.left), r.width) / r.width) * span)
  }
  const onScrub = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    seekAt(e.clientX)
    const move = (ev: PointerEvent): void => seekAt(ev.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-2"
      aria-label="Linha do tempo"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes(ASSET_MIME)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(ASSET_MIME)
        if (!id) return
        e.preventDefault()
        addAssetAtPlayhead(id)
      }}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[11px] text-muted">
        <Construction className="h-3.5 w-3.5 text-warn" />
        <span className="font-semibold text-fg-2">Linha do tempo</span>
        <span>— versão provisória: arraste na régua para navegar; a edição completa chega na próxima etapa.</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[120px] shrink-0 border-r border-border pt-6">
          {tracks.map((t) => (
            <div key={t.id} className="flex h-8 items-center truncate px-3 text-[11px] text-fg-2">
              {t.name}
            </div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div ref={barRef} className="relative h-6 cursor-ew-resize border-b border-border bg-surface/60" onPointerDown={onScrub} role="slider" aria-label="Posição de reprodução" aria-valuemin={0} aria-valuemax={total} aria-valuenow={playheadUs}>
            {Array.from({ length: Math.floor(span / 1e6) + 1 }, (_, s) => (
              <span key={s} className={cn('absolute bottom-0 w-px bg-white/15', s % 5 === 0 ? 'h-3' : 'h-1.5')} style={{ left: pct(s * 1e6) }} />
            ))}
            {inUs !== null || outUs !== null ? <span className="absolute inset-y-0 bg-accent/15" style={{ left: pct(inUs ?? 0), right: `${100 - ((outUs ?? total) / span) * 100}%` }} /> : null}
            {project?.markers.map((m) => <span key={m.id} className="absolute top-0 h-2 w-2 -translate-x-1/2 rotate-45 bg-warn" style={{ left: pct(m.tUs) }} title={m.label} />)}
          </div>
          {tracks.map((t) => (
            <div key={t.id} className="relative h-8 border-b border-border/60">
              {t.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={cn(
                    'absolute inset-y-1 truncate rounded-[5px] border px-1.5 text-left text-[10px] leading-5',
                    t.kind === 'video' ? 'border-info/40 bg-info/20 text-info' : 'border-ok/40 bg-ok/15 text-ok',
                    selection.includes(it.id) && 'border-accent bg-accent/25 text-fg ring-1 ring-accent'
                  )}
                  style={{ left: pct(it.startUs), width: pct(it.durationUs) }}
                  onClick={(e) => useEditorStore.getState().select([it.id], e.ctrlKey || e.shiftKey ? 'toggle' : 'set')}
                >
                  {project ? itemLabel(project, it) : null}
                </button>
              ))}
            </div>
          ))}
          <div className="pointer-events-none absolute inset-y-0 w-px bg-accent" style={{ left: pct(playheadUs) }}>
            <span className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-accent" />
          </div>
        </div>
      </div>
    </div>
  )
}
