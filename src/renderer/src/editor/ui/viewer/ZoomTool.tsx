import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { findItem } from '@shared/editor/ops'
import type { Ease } from '@shared/editor/project'
import { applyZoom, aspectRect, linkedRegionEffects, ZOOM_MAX_DUR_US, ZOOM_MIN_DUR_US, type ZoomRect } from '@shared/editor/zoom'
import { Select, Tip, Toggle } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { useViewerTool } from '../../state/viewerTool'
import { NumberField } from '../Inspector/NumberField'
import { hitTest, itemBoxes } from '../viewerGeometry'
import { editableMedia, type GestureCtx } from './ItemTransformHandles'
import { startViewerGesture } from './viewerGesture'

// Ferramenta "Zoom" (Z) do visualizador: arrastar um retângulo (sempre na proporção do quadro) sobre o clipe =
// enquadramento-alvo. Ao soltar, o clipe de mídia de cima sob o ponto onde o arraste começou ganha keyframes de
// escala/posição no playhead (shared/editor/zoom: o retângulo vai ao quadro inteiro em "duração", com o ease escolhido;
// opcionalmente volta ao normal depois de N s; "sem bordas pretas" prende a posição). Um passo de desfazer.
// Privacidade: clipe com efeitos vinculados → aviso (a região do efeito é do quadro e não acompanha o zoom). A ação
// "Ajustar efeitos ao movimento" chega com o Task 4 (followTransform); até lá o aviso leva ao efeito, cujo inspetor
// mostra transformedUnderEffect.

const EASES: { value: string; label: string; ease: Ease }[] = [
  { value: 'inOut', label: 'Suavizar ambos', ease: 'inOut' },
  { value: 'linear', label: 'Linear', ease: 'linear' },
  { value: 'in', label: 'Suavizar entrada', ease: 'in' },
  { value: 'out', label: 'Suavizar saída', ease: 'out' }
]

/** Ferramenta ligada: o arraste no quadro desenha o enquadramento-alvo (prévia) e aplica o zoom ao soltar. */
export function startZoomDraw(e: React.PointerEvent, ctx: GestureCtx, setPreview: (r: ZoomRect | null) => void): void {
  const st = useEditorStore.getState()
  const p = st.project
  if (!p) return
  e.preventDefault()
  const from = ctx.toCanvas(e)
  const tUs = st.playheadUs
  // caixas no playhead (o visualizador pode ter acabado de pausar: as do overlay ainda estariam vazias)
  const id = hitTest(itemBoxes(p, tUs), from.x, from.y)
  if (!id) {
    toast('Comece o retângulo sobre um clipe de vídeo ou imagem.')
    return
  }
  if (!editableMedia(p, id)) {
    toast('A faixa deste clipe está bloqueada.')
    return
  }
  const canvas = { w: p.canvas.width, h: p.canvas.height }
  let rect: ZoomRect | null = null
  startViewerGesture(e, {
    cursor: 'crosshair',
    thresholdPx: 4,
    move: (ev) => {
      rect = aspectRect(from, ctx.toCanvas(ev), canvas)
      setPreview(rect)
    },
    end: (commit, started) => {
      setPreview(null)
      if (commit && started && rect) applyZoomTool(id, rect, tUs)
    }
  })
}

/** Aplica o zoom com as opções da ferramenta (um passo de desfazer), seleciona o clipe e avisa sobre efeitos vinculados. */
function applyZoomTool(itemId: string, rect: ZoomRect, tUs: number): boolean {
  const z = useViewerTool.getState().zoom
  const st = useEditorStore.getState()
  const ok = st.apply((q) => applyZoom(q, itemId, rect, tUs, z.durUs, z.returnBack ? z.holdUs : null, z.ease, { clamp: z.clamp }))
  if (!ok) return false
  st.select([itemId])
  warnLinkedEffects(itemId)
  return true
}

/**
 * Zoom/pan/Ken Burns aplicado num clipe com efeitos de privacidade vinculados: a região do efeito fica parada no
 * quadro enquanto o conteúdo se move. Aviso com atalho para o efeito (o inspetor dele mostra o aviso e onde começa).
 */
export function warnLinkedEffects(itemId: string): void {
  const p = useEditorStore.getState().project
  const fx = p ? linkedRegionEffects(p, itemId) : []
  if (fx.length === 0) return
  toast.warning(fx.length === 1 ? 'Este clipe tem um efeito de privacidade vinculado' : `Este clipe tem ${fx.length} efeitos de privacidade vinculados`, {
    description: 'A região do efeito não acompanha o zoom: o conteúdo protegido pode sair de baixo dela. Confira o efeito antes de exportar.',
    duration: 10_000,
    action: {
      label: fx.length === 1 ? 'Ver efeito' : 'Ver efeitos',
      onClick: () => {
        const q = useEditorStore.getState().project
        const alive = q ? fx.filter((id) => findItem(q, id)) : []
        if (alive.length) useEditorStore.getState().select(alive)
      }
    }
  })
}

/** Retângulo-alvo durante o arraste (px do canvas × k = px de tela), com o fator de zoom. */
export function ZoomRectPreview({ rect, k, W, H }: { rect: ZoomRect; k: number; W: number; H: number }): React.JSX.Element {
  const w = rect.w * W * k
  const h = rect.h * H * k
  return (
    // escurece o resto do quadro (preso ao quadro: a sombra não vaza para o palco)
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div data-zoom-rect="" className="absolute border-2 border-accent bg-accent/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" style={{ left: rect.x * W * k - w / 2, top: rect.y * H * k - h / 2, width: w, height: h }}>
        <span className="absolute left-1 top-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">{(1 / Math.max(rect.w, rect.h)).toFixed(1).replace('.', ',')}×</span>
      </div>
    </div>
  )
}

/** Opções da ferramenta (popover ao lado da barra do visualizador). */
export function ZoomSettingsButton(): React.JSX.Element {
  const z = useViewerTool((s) => s.zoom)
  const set = useViewerTool.getState().setZoom
  const easeValue = EASES.find((o) => o.ease === z.ease)?.value ?? 'inOut'
  return (
    <Popover.Root>
      <Tip content="Opções do zoom" side="right">
        <Popover.Trigger asChild>
          <button type="button" aria-label="Opções do zoom" className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-white/6 hover:text-fg data-[state=open]:bg-surface-3 data-[state=open]:text-fg">
            <SlidersHorizontal className="h-4 w-4" />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          data-zoom-settings=""
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-[272px] space-y-2 rounded-xl border border-border-strong bg-surface-3 p-3 shadow-2xl animate-in fade-in-0 zoom-in-95"
        >
          <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Zoom</h3>
          <p className="text-[11px] leading-snug text-fg-2">Arraste no quadro o enquadramento desejado. O zoom começa no playhead.</p>
          <NumberField label="Duração" value={z.durUs / 1e6} min={ZOOM_MIN_DUR_US / 1e6} max={ZOOM_MAX_DUR_US / 1e6} step={0.1} precision={1} unit="s" onChange={(n) => set({ durUs: Math.round(n * 1e6) })} title="Tempo da aproximação (e da volta)" />
          <div className="flex min-h-7 items-center gap-2 text-[11px]">
            <span className="w-[74px] shrink-0 text-muted">Curva</span>
            <Select value={easeValue} onValueChange={(v) => set({ ease: EASES.find((o) => o.value === v)?.ease ?? 'inOut' })} options={EASES.map(({ value, label }) => ({ value, label }))} triggerClassName="h-7 rounded-lg px-2 text-[11px]" />
          </div>
          <label className="flex min-h-7 items-center justify-between gap-2 text-[11px] text-fg-2">
            Voltar ao normal depois
            <Toggle size="sm" checked={z.returnBack} onCheckedChange={(on) => set({ returnBack: on })} aria-label="Voltar ao normal depois" />
          </label>
          {z.returnBack ? <NumberField label="Depois de" value={z.holdUs / 1e6} min={0} max={60} step={0.1} precision={1} unit="s" onChange={(n) => set({ holdUs: Math.round(n * 1e6) })} title="Tempo parado no enquadramento antes de voltar" /> : null}
          <label className="flex min-h-7 items-center justify-between gap-2 text-[11px] text-fg-2">
            Sem bordas pretas
            <Toggle size="sm" checked={z.clamp} onCheckedChange={(on) => set({ clamp: on })} aria-label="Sem bordas pretas" />
          </label>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
