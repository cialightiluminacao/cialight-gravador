import { Plus } from 'lucide-react'
import { SHAPE_PRESETS, TEXT_PRESETS, type ShapePresetId, type TextPresetId } from '@shared/editor/factory'
import type { TextStyle } from '@shared/editor/project'
import { Tip } from '@/components/ui/primitives'
import { useEditorStore } from '../state/editorStore'
import { addShapeAt, addTextAt } from './editorActions'

// Aba "Texto" da biblioteca: modelos de texto (TEXT_PRESETS) e de forma (SHAPE_PRESETS). Arrastar o cartão para a
// linha do tempo (no ponto/faixa do ponteiro) ou para o visualizador (no playhead); duplo clique, Enter ou "+"
// adicionam no playhead. A prévia do texto usa o estilo do modelo e a animação de entrada ao passar o ponteiro (CSS;
// parada com "reduzir movimento").

export const TEXT_MIME = 'application/x-cialight-text'
export const SHAPE_MIME = 'application/x-cialight-shape'

export const TEXT_PRESET_IDS = Object.keys(TEXT_PRESETS) as TextPresetId[]
export const SHAPE_PRESET_IDS = Object.keys(SHAPE_PRESETS) as ShapePresetId[]

const TEXT_HINTS: Record<TextPresetId, string> = {
  title: 'Título grande no centro, com sombra',
  subtitle: 'Linha de apoio abaixo do título',
  lowerThird: 'Nome e cargo no canto inferior, sobre uma tarja',
  caption: 'Legenda na base do quadro, sobre fundo escuro',
  quote: 'Citação em itálico no centro',
  countdown: 'Número grande que conta de 3 até 0'
}
const SHAPE_HINTS: Record<ShapePresetId, string> = {
  rect: 'Retângulo preenchido',
  ellipse: 'Elipse só com contorno, para circular algo',
  arrow: 'Seta para apontar algo',
  highlight: 'Moldura amarela de cantos arredondados para destacar',
  spotlight: 'Escurece tudo fora de uma elipse'
}

/** Modelo de texto de um arraste (null se o arraste não é de texto). */
export function textFromDrag(e: React.DragEvent): TextPresetId | null {
  const v = e.dataTransfer.getData(TEXT_MIME)
  return TEXT_PRESET_IDS.includes(v as TextPresetId) ? (v as TextPresetId) : null
}
export function shapeFromDrag(e: React.DragEvent): ShapePresetId | null {
  const v = e.dataTransfer.getData(SHAPE_MIME)
  return SHAPE_PRESET_IDS.includes(v as ShapePresetId) ? (v as ShapePresetId) : null
}
export const isTextDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes(TEXT_MIME)
export const isShapeDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes(SHAPE_MIME)

const playhead = (): number => useEditorStore.getState().playheadUs

/** Estilo CSS da prévia a partir do estilo do modelo (tamanho reduzido para caber no cartão). */
export function previewTextCss(style: TextStyle, size: number): React.CSSProperties {
  const sh = style.shadowStyle
  return {
    fontFamily: `"${style.font}", "Segoe UI", sans-serif`,
    fontSize: size,
    fontWeight: style.weight,
    fontStyle: style.italic ? 'italic' : 'normal',
    lineHeight: style.lineHeight,
    color: style.color,
    textAlign: style.align,
    whiteSpace: 'pre-line',
    ...(style.background ? { background: style.background, padding: `${style.padding ?? 0.3}em`, borderRadius: `${style.backgroundRadius ?? 0}em` } : {}),
    ...(sh ? { textShadow: `${sh.dx}em ${sh.dy}em ${sh.blur}em ${sh.color}` } : {}),
    ...(style.stroke && style.stroke.width > 0 ? { WebkitTextStroke: `${Math.max(0.5, style.stroke.width / 20)}px ${style.stroke.color}` } : {})
  }
}

function Card({ id, kind, label, hint, onAdd, onDragStart, children }: { id: string; kind: 'text' | 'shape'; label: string; hint: string; onAdd: () => void; onDragStart: (e: React.DragEvent) => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-text-preset={kind === 'text' ? id : undefined}
      data-shape-preset={kind === 'shape' ? id : undefined}
      className="ct-card group relative flex min-w-0 cursor-grab flex-col gap-1 rounded-lg p-1 outline-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:cursor-grabbing"
      draggable
      tabIndex={0}
      role="button"
      aria-label={`${label}. Enter ou duplo clique adiciona no playhead`}
      title={hint}
      onDragStart={onDragStart}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget || !(e.target as HTMLElement).closest('button')) onAdd() // duplo clique no "+" já adicionou pelos cliques
      }}
      onKeyDown={(e) => {
        // só o cartão em foco: Enter/Espaço no botão "+" interno já adicionam pelo clique
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault()
          onAdd()
        }
      }}
    >
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border bg-gradient-to-br from-[#1b2130] to-[#0d1017]">
        {children}
        <Tip content="Adicionar no playhead">
          <button
            type="button"
            aria-label={`Adicionar ${label} no playhead`}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-accent text-white opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onAdd()
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </div>
      <span className="truncate px-0.5 text-[11px] leading-4 text-fg-2">{label}</span>
    </div>
  )
}

function ShapePreview({ id }: { id: ShapePresetId }): React.JSX.Element {
  const c = SHAPE_PRESETS[id]
  const none = (v: string): string => (v === 'none' ? 'transparent' : v)
  const sw = Math.max(1.5, c.strokeWidth / 4)
  if (c.shape === 'arrow') {
    return (
      <svg viewBox="0 0 60 24" className="h-7 w-16" aria-hidden>
        <path d="M2 12 H42 M34 3 L50 12 L34 21 Z" fill={none(c.fill)} stroke={none(c.stroke)} strokeWidth={2} strokeLinejoin="round" />
      </svg>
    )
  }
  if (c.spotlight) {
    return <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse 28% 42% at 50% 50%, transparent 98%, rgba(0,0,0,0.72) 100%)' }} aria-hidden />
  }
  return (
    <div
      aria-hidden
      className="h-8 w-16"
      style={{ background: none(c.fill), border: c.stroke === 'none' ? 'none' : `${sw}px solid ${c.stroke}`, borderRadius: c.shape === 'ellipse' ? '50%' : `${(c.cornerRadius ?? 0) * 100}%` }}
    />
  )
}

export function TextLibrary(): React.JSX.Element {
  return (
    <div className="p-2">
      <h3 className="px-1 pb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Textos</h3>
      <div className="grid grid-cols-2 gap-1.5">
        {TEXT_PRESET_IDS.map((id) => {
          const c = TEXT_PRESETS[id]
          const size = Math.min(20, Math.max(9, c.style.size.value * 0.11))
          return (
            <Card
              key={id}
              id={id}
              kind="text"
              label={c.label}
              hint={TEXT_HINTS[id]}
              onAdd={() => addTextAt(id, playhead())}
              onDragStart={(e) => {
                e.dataTransfer.setData(TEXT_MIME, id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <span className="ct-prev max-w-full" data-in={c.animIn ? '' : undefined} style={{ ...previewTextCss(c.style, size), ['--ct-anim' as string]: c.animIn ? `ct-${c.animIn.preset}` : 'none' }}>
                {c.counter ? String(c.counter.from) : c.text}
              </span>
            </Card>
          )
        })}
      </div>
      <h3 className="px-1 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Formas</h3>
      <div className="grid grid-cols-2 gap-1.5">
        {SHAPE_PRESET_IDS.map((id) => (
          <Card
            key={id}
            id={id}
            kind="shape"
            label={SHAPE_PRESETS[id].label}
            hint={SHAPE_HINTS[id]}
            onAdd={() => addShapeAt(id, playhead())}
            onDragStart={(e) => {
              e.dataTransfer.setData(SHAPE_MIME, id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <ShapePreview id={id} />
          </Card>
        ))}
      </div>
      <p className="px-1 pt-2 text-[10.5px] leading-relaxed text-muted">Arraste para a linha do tempo ou para o visualizador. Dê dois cliques no texto do visualizador para editá-lo.</p>
    </div>
  )
}
