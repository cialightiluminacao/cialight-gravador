import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { attachEffects, effectsOverClip } from '@shared/editor/followTransform'
import { findItem } from '@shared/editor/ops'
import type { Ease, Project } from '@shared/editor/project'
import { applyZoom, aspectRect, ZOOM_MAX_DUR_US, ZOOM_MIN_DUR_US, type ZoomEdit, type ZoomRect } from '@shared/editor/zoom'
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
// Privacidade: efeitos sem âncora sobre o clipe → aviso (a região é do quadro e não acompanha o zoom) com "Ancorar
// efeitos ao clipe" (vinculados) / "Vincular e ancorar" (soltos) e "Ver efeito" (warnLinkedEffects).

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
  // só clipes de mídia têm conteúdo a enquadrar: texto e forma por cima não contam
  const id = hitTest(itemBoxes(p, tUs).filter((b) => findItem(p, b.itemId)?.item.type === 'media'), from.x, from.y)
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

/** Aplica o zoom com as opções da ferramenta (um passo de desfazer) e seleciona o clipe. */
function applyZoomTool(itemId: string, rect: ZoomRect, tUs: number): void {
  const z = useViewerTool.getState().zoom
  if (runZoomEdit(itemId, (q) => applyZoom(q, itemId, rect, tUs, z.durUs, z.returnBack ? z.holdUs : null, z.ease, { clamp: z.clamp }))) useEditorStore.getState().select([itemId])
}

/**
 * Zoom/Ken Burns como um passo de desfazer; depois avisa quantos keyframes existentes foram substituídos e se o clipe
 * tem efeitos de privacidade vinculados (warnLinkedEffects). false = não aplicou (o store já mostrou o erro).
 */
export function runZoomEdit(itemId: string, edit: (p: Project) => ZoomEdit): boolean {
  let replaced = 0
  const ok = useEditorStore.getState().apply((q) => {
    const r = edit(q)
    replaced = r.replaced
    return r.project
  })
  if (!ok) return false
  if (replaced > 0) toast(replaced === 1 ? '1 keyframe substituído' : `${replaced} keyframes substituídos`, { description: 'Os keyframes que já existiam no trecho do movimento foram trocados. Ctrl+Z desfaz.' })
  warnLinkedEffects(itemId)
  return true
}

/**
 * Zoom/pan/Ken Burns (ou animação de entrada/saída com movimento — `motion` nomeia o movimento no texto) aplicado num
 * clipe com efeitos de privacidade por cima: a região de um efeito sem âncora fica
 * parada no quadro enquanto o conteúdo se move. Efeitos do grupo de vínculo cuja região encosta no clipe →
 * "Ancorar efeitos ao clipe" (só esses; a região passa a acompanhar o conteúdo, inclusive edições futuras); efeitos
 * soltos sobre o clipe → "Vincular e ancorar" (todos eles); "Ver efeito(s)" seleciona. Os já ancorados acompanham sozinhos.
 */
export function warnLinkedEffects(itemId: string, motion = 'o zoom'): void {
  const p = useEditorStore.getState().project
  if (!p) return
  let over: { linked: string[]; unlinked: string[] }
  try {
    over = effectsOverClip(p, itemId)
  } catch {
    return
  }
  const ids = [...over.linked, ...over.unlinked]
  if (ids.length === 0) return
  const alive = (list: string[]): string[] => {
    const q = useEditorStore.getState().project
    return q ? list.filter((id) => findItem(q, id)) : []
  }
  // ações embaixo do texto (com botões lado a lado o sonner espreme o texto numa coluna estreita)
  let toastId: string | number = 0
  const run = (fn: () => void) => () => {
    toast.dismiss(toastId)
    fn()
  }
  const view = run(() => {
    const live = alive(ids)
    if (live.length) useEditorStore.getState().select(live)
  })
  const anchor = run(() => {
    const live = alive(over.linked)
    if (live.length && useEditorStore.getState().apply((r) => attachEffects(r, itemId, live))) toast.success(live.length === 1 ? 'Efeito ancorado ao clipe' : 'Efeitos ancorados ao clipe')
  })
  const linkAnchor = run(() => {
    const live = alive(over.unlinked)
    if (live.length && useEditorStore.getState().apply((r) => attachEffects(r, itemId, live))) toast.success(live.length === 1 ? 'Efeito vinculado e ancorado ao clipe' : 'Efeitos vinculados e ancorados ao clipe')
  })
  const one = ids.length === 1
  const title = one ? 'Há um efeito de privacidade sobre este clipe' : `Há ${ids.length} efeitos de privacidade sobre este clipe`
  const text = over.unlinked.length
    ? `A região não acompanha ${motion}: o conteúdo protegido pode sair de baixo dela. Vincule e ancore o efeito ao clipe para ele seguir o movimento.`
    : `A região não acompanha ${motion}: o conteúdo protegido pode sair de baixo dela. Ancore o efeito ao clipe para ele seguir o movimento.`
  const btn = 'h-7 rounded-md px-2.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-3'
  toastId = toast.warning(title, {
    duration: 15_000,
    description: (
      <div className="space-y-2">
        <p>{text}</p>
        <div className="flex flex-wrap gap-1.5">
          {over.linked.length ? (
            <button type="button" data-follow-toast="anchor" className={`${btn} bg-accent font-semibold text-white hover:brightness-110`} onClick={anchor}>
              {over.linked.length === 1 ? 'Ancorar efeito ao clipe' : 'Ancorar efeitos ao clipe'}
            </button>
          ) : null}
          {over.unlinked.length ? (
            <button type="button" data-follow-toast="link" className={`${btn} ${over.linked.length ? 'border border-accent text-fg' : 'bg-accent text-white'} font-semibold hover:brightness-110`} onClick={linkAnchor}>
              Vincular e ancorar
            </button>
          ) : null}
          <button type="button" className={`${btn} border border-border-strong font-medium text-fg-2 hover:text-fg`} onClick={view}>
            {one ? 'Ver efeito' : 'Ver efeitos'}
          </button>
        </div>
      </div>
    )
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
          {z.returnBack ? <NumberField label="Depois de" value={z.holdUs / 1e6} min={0} max={60} step={0.1} precision={1} unit="s" onChange={(n) => set({ holdUs: Math.round(n * 1e6) })} title="Tempo parado no enquadramento antes de voltar (0 = volta logo depois de chegar)" /> : null}
          <label className="flex min-h-7 items-center justify-between gap-2 text-[11px] text-fg-2">
            Sem bordas pretas
            <Toggle size="sm" checked={z.clamp} onCheckedChange={(on) => set({ clamp: on })} aria-label="Sem bordas pretas" />
          </label>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
