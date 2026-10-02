import { Circle, Droplets, Grid3x3, RectangleHorizontal, Square, SquareDashed, ZoomIn } from 'lucide-react'
import { Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import { SHORTCUT_LABELS } from '../../shortcuts'
import { useViewerTool, type DrawEffect, type DrawShape } from '../../state/viewerTool'
import { ZoomSettingsButton } from './ZoomTool'

// Barra do visualizador (vertical, na margem esquerda do palco — o Viewer reserva essa margem para
// ela nunca cobrir o quadro): ferramenta "Desenhar região" (B) e, com ela ligada, o tipo do efeito
// (Blur, Pixelizar, Tarja) e a forma (Retângulo, Elipse); ferramenta "Zoom" (Z) e, com ela ligada, as opções.

export const TOOLBAR_GUTTER = 48

const EFFECTS: { value: DrawEffect; label: string; icon: React.ReactNode }[] = [
  { value: 'blur', label: 'Blur (desfoque)', icon: <Droplets className="h-4 w-4" /> },
  { value: 'pixelate', label: 'Pixelizar', icon: <Grid3x3 className="h-4 w-4" /> },
  { value: 'solid', label: 'Tarja sólida (cobre totalmente)', icon: <RectangleHorizontal className="h-4 w-4 fill-current" /> }
]
const SHAPES: { value: DrawShape; label: string; icon: React.ReactNode }[] = [
  { value: 'rect', label: 'Retângulo', icon: <Square className="h-4 w-4" /> },
  { value: 'ellipse', label: 'Elipse (ou segure Shift ao desenhar)', icon: <Circle className="h-4 w-4" /> }
]

function ToolButton({ label, shortcut, pressed, onClick, children, tone = 'option' }: { label: string; shortcut?: string; pressed: boolean; onClick: () => void; children: React.ReactNode; tone?: 'tool' | 'option' }): React.JSX.Element {
  return (
    <Tip content={label} shortcut={shortcut} side="right">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
          pressed ? (tone === 'tool' ? 'bg-accent text-white' : 'bg-surface-3 text-fg shadow') : 'text-fg-2 hover:bg-white/6 hover:text-fg'
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

export function ViewerToolbar(): React.JSX.Element {
  const drawing = useViewerTool((s) => s.drawing)
  const effect = useViewerTool((s) => s.effect)
  const shape = useViewerTool((s) => s.shape)
  const zooming = useViewerTool((s) => s.zooming)
  const tool = useViewerTool.getState()
  return (
    <div data-viewer-toolbar role="toolbar" aria-orientation="vertical" aria-label="Ferramentas do visualizador" className="absolute left-2 top-2 z-10 flex flex-col items-center gap-1 rounded-xl border border-border bg-surface/90 p-1 shadow-lg backdrop-blur">
      <ToolButton tone="tool" label={drawing ? 'Sair de Desenhar região' : 'Desenhar região (arraste no quadro · Shift: elipse · Alt: do centro)'} shortcut={SHORTCUT_LABELS.drawRegion} pressed={drawing} onClick={() => tool.setDrawing(!drawing)}>
        <SquareDashed className="h-4 w-4" />
      </ToolButton>
      {drawing ? (
        <>
          <div className="my-0.5 h-px w-6 bg-border-strong" />
          {EFFECTS.map((o) => (
            <ToolButton key={o.value} label={o.label} pressed={effect === o.value} onClick={() => tool.setEffect(o.value)}>
              {o.icon}
            </ToolButton>
          ))}
          <div className="my-0.5 h-px w-6 bg-border-strong" />
          {SHAPES.map((o) => (
            <ToolButton key={o.value} label={o.label} pressed={shape === o.value} onClick={() => tool.setShape(o.value)}>
              {o.icon}
            </ToolButton>
          ))}
        </>
      ) : null}
      <div className="my-0.5 h-px w-6 bg-border-strong" />
      <ToolButton tone="tool" label={zooming ? 'Sair do Zoom' : 'Zoom (arraste no quadro o enquadramento-alvo)'} shortcut={SHORTCUT_LABELS.zoomTool} pressed={zooming} onClick={() => tool.setZooming(!zooming)}>
        <ZoomIn className="h-4 w-4" />
      </ToolButton>
      {zooming ? <ZoomSettingsButton /> : null}
    </div>
  )
}
