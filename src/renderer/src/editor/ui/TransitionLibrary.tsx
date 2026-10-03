import { Plus } from 'lucide-react'
import type { TransitionKind } from '@shared/editor/project'
import { Tip } from '@/components/ui/primitives'
import { addTransitionNearPlayhead } from './editorActions'
import { TRANSITION_HINTS, TRANSITION_KINDS, transitionLabel } from './transitionInfo'

// Aba "Transições" da biblioteca: um cartão por tipo, com miniatura animada em CSS (dois blocos de cor; roda com o
// ponteiro/foco no cartão e para com "reduzir movimento"). Arrastar para um corte (ou um clipe) da linha do tempo;
// duplo clique, Enter ou "+" aplicam no corte mais próximo do playhead.

export const TRANSITION_MIME = 'application/x-cialight-transition'

/** Tipo de transição de um arraste (null se o arraste não é de transição). */
export function transitionFromDrag(e: React.DragEvent): TransitionKind | null {
  const v = e.dataTransfer.getData(TRANSITION_MIME)
  return TRANSITION_KINDS.includes(v as TransitionKind) ? (v as TransitionKind) : null
}
export const isTransitionDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes(TRANSITION_MIME)

export function TransitionLibrary(): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-1.5 p-2">
      {TRANSITION_KINDS.map((k) => (
        <div
          key={k}
          data-transition-kind={k}
          className="ct-card group relative flex min-w-0 cursor-grab flex-col gap-1 rounded-lg p-1 outline-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:cursor-grabbing"
          draggable
          tabIndex={0}
          role="button"
          aria-label={`${transitionLabel(k)}. Enter ou duplo clique aplica no corte mais próximo do playhead`}
          title={TRANSITION_HINTS[k]}
          onDragStart={(e) => {
            e.dataTransfer.setData(TRANSITION_MIME, k)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest('button')) addTransitionNearPlayhead(k)
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
              e.preventDefault()
              addTransitionNearPlayhead(k)
            }
          }}
        >
          <div className="relative">
            <div className="tr-thumb relative aspect-video overflow-hidden rounded-md border border-border" data-tr={k} aria-hidden>
              <div className="tr-a bg-[#3b82f6]" />
              <div className="tr-b bg-[#f59e0b]" />
            </div>
            <Tip content="Aplicar no corte mais próximo do playhead">
              <button
                type="button"
                aria-label={`Aplicar ${transitionLabel(k)} no corte mais próximo do playhead`}
                className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-md bg-accent text-white opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  addTransitionNearPlayhead(k)
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
          <span className="truncate px-0.5 text-[11px] leading-4 text-fg-2">{transitionLabel(k)}</span>
        </div>
      ))}
      <p className="col-span-2 px-1 pt-1 text-[10.5px] leading-relaxed text-muted">Arraste para o corte entre dois clipes encostados (ou para um clipe: a transição entra nele). Na linha do tempo, arraste as bordas do ícone para mudar a duração.</p>
    </div>
  )
}
