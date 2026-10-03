import { useEffect, useMemo, useRef, useState } from 'react'
import type { ZoomRect } from '@shared/editor/zoom'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../state/editorStore'
import { usePausedPlayhead } from '../state/pausedPlayhead'
import { useViewerTool } from '../state/viewerTool'
import { toast } from 'sonner'
import type { TextItem } from '@shared/editor/project'
import { findItem } from '@shared/editor/ops'
import { addEffectAt, addShapeAt, addTextAt } from './editorActions'
import { effectFromDrag, isEffectDrag } from './EffectLibrary'
import { isShapeDrag, isTextDrag, shapeFromDrag, textFromDrag } from './TextLibrary'
import { effectBoxes, hitTest, hitTestRegions, itemBoxes, type Guides, type Pt } from './viewerGeometry'
import { EffectRegionHandles, RegionOutline, selectedRegion, startRegionDraw, startRegionGesture } from './viewer/EffectRegionHandles'
import { editableItem, ItemTransformHandles, startItemTransform, type GestureCtx } from './viewer/ItemTransformHandles'
import { cancelViewerGesture } from './viewer/viewerGesture'
import { TextEditor } from './viewer/TextEditor'
import { startZoomDraw, ZoomRectPreview } from './viewer/ZoomTool'
import { markFocusPoint, ReframeOverlay } from './viewer/ReframeOverlay'
import { useReframe } from '../state/reframe'
import { useTextEditRequest } from '../state/textEditRequest'
import { resolveTextEditRequest, TEXT_EDIT_FAILED } from './viewer/textEditEntry'

// Manipulação direta no visualizador: clique seleciona (Ctrl/Shift alterna) — regiões de efeito
// primeiro (ficam sempre "por cima" para seleção), senão a mídia abaixo —, arrastar move; alças do
// selecionado (mídia: viewer/ItemTransformHandles; efeito: viewer/EffectRegionHandles). Com a
// ferramenta "Desenhar região" (B) ligada, arrastar no quadro cria um efeito; com a ferramenta "Zoom" (Z), o
// arraste desenha o enquadramento-alvo do clipe sob o cursor (viewer/ZoomTool). Guias do quadro durante
// os gestos; cada gesto é uma transação (viewer/viewerGesture). Soltar um efeito da biblioteca o cria no
// playhead com a região centrada no ponto solto. Com o painel "Reenquadrar" aberto, o quadro novo aparece por cima e o
// clique marca um ponto de foco (viewer/ReframeOverlay) — sem seleção nem alças.

const NO_GUIDES: Guides = { v: [], h: [] }

export function ViewerOverlay({ width, height, scale, onPause }: { width: number; height: number; scale: number; onPause: () => void }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  // alças só aparecem parado: tocando, nada aqui re-renderiza a cada quadro
  const playheadUs = usePausedPlayhead()
  const selection = useEditorStore((s) => s.selection)
  const playing = useEditorStore((s) => s.playing)
  const drawing = useViewerTool((s) => s.drawing)
  const zooming = useViewerTool((s) => s.zooming)
  const reframing = useReframe((s) => s.open)
  const [zoomRect, setZoomRect] = useState<ZoomRect | null>(null)
  const [guides, setGuides] = useState<Guides>(NO_GUIDES)
  const [dropHover, setDropHover] = useState(false)
  /** Texto em edição direta (duplo clique). */
  const [editingId, setEditingId] = useState<string | null>(null)
  // fonte que terminou de carregar muda a caixa do texto: mede de novo
  const [fontTick, setFontTick] = useState(0)
  useEffect(() => {
    const set = document.fonts
    if (!set) return
    const on = (): void => setFontTick((n) => n + 1)
    set.addEventListener('loadingdone', on)
    return () => set.removeEventListener('loadingdone', on)
  }, [])
  const rootRef = useRef<HTMLDivElement>(null)
  const clearHover = (): void => {
    if (rootRef.current) rootRef.current.style.cursor = ''
  }
  const boxes = useMemo(() => (project && !playing ? itemBoxes(project, playheadUs) : []), [project, playheadUs, playing, fontTick])
  const regions = useMemo(() => (project && !playing ? effectBoxes(project, playheadUs) : []), [project, playheadUs, playing])
  // a caixa do texto em edição sumiu (o playhead saiu do item, o texto foi apagado): encerra com aviso, sem perder em silêncio
  useEffect(() => {
    if (editingId && !boxes.some((b) => b.itemId === editingId)) {
      setEditingId(null)
      toast('A edição do texto foi encerrada: o texto saiu do quadro. O que foi digitado não foi aplicado.')
    }
  }, [editingId, boxes])
  // Enter/F2 (editorActions.editText): o pedido é resolvido no primeiro ciclo depois dele (o seek já aconteceu, a
  // caixa do texto já foi medida): abre, ou é descartado com o motivo (resolveTextEditRequest) — nunca fica pendente
  const editRequest = useTextEditRequest((s) => s.itemId)
  useEffect(() => {
    if (!editRequest || !project) return
    useTextEditRequest.getState().request(null)
    const found = findItem(project, editRequest)
    const r = resolveTextEditRequest({
      exists: !!found,
      playing,
      playheadInside: !!found && playheadUs >= found.item.startUs && playheadUs < found.item.startUs + found.item.durationUs,
      hasBox: boxes.some((b) => b.itemId === editRequest),
      tool: drawing ? 'drawing' : zooming ? 'zooming' : reframing ? 'reframing' : null
    })
    if (r.kind === 'open') setEditingId(editRequest)
    else toast(TEXT_EDIT_FAILED, { description: r.why })
  }, [editRequest, project, boxes, playing, playheadUs, drawing, zooming, reframing])
  // desmontado (editor fechado): nenhum pedido sobra para o próximo projeto
  useEffect(() => () => useTextEditRequest.getState().request(null), [])
  // saindo da tela no meio de um gesto: cancela; a ferramenta não fica ligada para o próximo projeto
  useEffect(
    () => () => {
      cancelViewerGesture()
      useViewerTool.getState().setDrawing(false)
      useViewerTool.getState().setZooming(false)
      useReframe.getState().close()
    },
    []
  )
  // seleção ou ferramenta mudou sem o ponteiro andar: o cursor de mover pode ter ficado velho
  useEffect(() => clearHover(), [selection, drawing, zooming, playheadUs])
  if (!project) return null
  const selId = selection.length === 1 && !playing ? selection[0] : null
  const selectedMedia = selId && !drawing && !zooming && !reframing && !editingId ? boxes.find((b) => b.itemId === selId && editableItem(project, b.itemId)) : undefined
  const editingBox = editingId ? boxes.find((b) => b.itemId === editingId) : undefined
  const selectedFx = selId ? selectedRegion(project, selId, playheadUs) : null

  const ctx: GestureCtx = {
    toCanvas: (e: { clientX: number; clientY: number }): Pt => {
      const r = rootRef.current!.getBoundingClientRect()
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
    },
    scale,
    setGuides
  }

  const onBackgroundDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    if (reframing) {
      if (useEditorStore.getState().playing) onPause()
      markFocusPoint(project, ctx.toCanvas(e))
      return
    }
    if (drawing) {
      if (useEditorStore.getState().playing) onPause()
      startRegionDraw(e, ctx)
      return
    }
    if (zooming) {
      if (useEditorStore.getState().playing) onPause()
      startZoomDraw(e, ctx, setZoomRect)
      return
    }
    const pt = ctx.toCanvas(e)
    const st = useEditorStore.getState()
    const region = hitTestRegions(regions, pt.x, pt.y)
    const hit = region ?? hitTest(boxes, pt.x, pt.y)
    if (!hit) {
      if (!e.ctrlKey && !e.shiftKey) st.select([])
      return
    }
    if (e.ctrlKey || e.shiftKey) {
      st.select([hit], 'toggle')
      return
    }
    st.select([hit])
    if (playing) return
    if (region) startRegionGesture(e, region, { kind: 'move' }, ctx)
    else {
      const box = boxes.find((b) => b.itemId === hit)
      if (box && !editingId) startItemTransform(e, box, { kind: 'move' }, ctx)
    }
  }

  // cursor de mover sobre a mídia selecionada (o corpo das alças não captura o ponteiro: quem decide é o
  // hit-test, com as regiões de efeito por cima). Direto no estilo: sem re-render a cada movimento.
  const onHover = (e: React.PointerEvent): void => {
    const root = rootRef.current
    if (!root) return
    let cursor = ''
    if (!drawing && selectedMedia && e.buttons === 0) {
      const pt = ctx.toCanvas(e)
      if (!hitTestRegions(regions, pt.x, pt.y) && hitTest(boxes, pt.x, pt.y) === selectedMedia.itemId) cursor = 'move'
    }
    if (root.style.cursor !== cursor) root.style.cursor = cursor
  }

  // duplo clique num texto: edição direta (a contagem não: o conteúdo dela vem de "de/até" no inspetor)
  const onDoubleClick = (e: React.MouseEvent): void => {
    if (playing || drawing || zooming || reframing) return
    const pt = ctx.toCanvas(e)
    if (hitTestRegions(regions, pt.x, pt.y)) return
    const hit = hitTest(boxes, pt.x, pt.y)
    const found = hit ? findItem(project, hit) : null
    if (!found || found.item.type !== 'text') return
    if (found.track.locked) {
      toast(`A faixa "${found.track.name}" está bloqueada: desbloqueie para editar o texto.`)
      return
    }
    if ((found.item as TextItem).counter) {
      toast('Este texto é uma contagem: ajuste “De” e “Até” no inspetor.')
      return
    }
    useEditorStore.getState().select([hit!])
    setEditingId(hit)
  }

  const onDrop = (e: React.DragEvent): void => {
    setDropHover(false)
    const preset = effectFromDrag(e)
    const textPreset = textFromDrag(e)
    const shapePreset = shapeFromDrag(e)
    if (!preset && !textPreset && !shapePreset) return
    e.preventDefault()
    if (useEditorStore.getState().playing) onPause()
    const pt = ctx.toCanvas(e)
    const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
    // texto/forma: no playhead, centrados onde soltou (um passo de desfazer só)
    const at = { x: clamp01(pt.x / project.canvas.width), y: clamp01(pt.y / project.canvas.height) }
    if (textPreset) return void addTextAt(textPreset, useEditorStore.getState().playheadUs, { at })
    if (shapePreset) return void addShapeAt(shapePreset, useEditorStore.getState().playheadUs, { at })
    if (!preset) return
    addEffectAt(preset, useEditorStore.getState().playheadUs, { region: { x: clamp01(pt.x / project.canvas.width), y: clamp01(pt.y / project.canvas.height) } })
  }

  return (
    <div
      ref={rootRef}
      data-viewer-overlay
      className={cn('absolute inset-0', (drawing || zooming || reframing) && 'cursor-crosshair', dropHover && 'ring-2 ring-inset ring-accent/70')}
      style={{ width, height }}
      onPointerDown={onBackgroundDown}
      onPointerMove={onHover}
      onPointerLeave={clearHover}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        if (!isEffectDrag(e) && !isTextDrag(e) && !isShapeDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropHover) setDropHover(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHover(false)
      }}
      onDrop={onDrop}
    >
      {guides.v.map((x) => (
        <div key={`v${x}`} data-guide="v" className="pointer-events-none absolute inset-y-0 w-px bg-accent/80" style={{ left: `calc(${x * 100}% - ${x}px)` }} />
      ))}
      {guides.h.map((y) => (
        <div key={`h${y}`} data-guide="h" className="pointer-events-none absolute inset-x-0 h-px bg-accent/80" style={{ top: `calc(${y * 100}% - ${y}px)` }} />
      ))}
      {regions.filter((b) => b.itemId !== selId || zooming || reframing).map((b) => (
        <RegionOutline key={b.itemId} box={b} k={scale} />
      ))}
      {selectedMedia ? <ItemTransformHandles box={selectedMedia} k={scale} onGesture={(e, box, g) => startItemTransform(e, box, g, ctx)} /> : null}
      {selectedFx && !playing && !zooming && !reframing ? (
        <EffectRegionHandles box={selectedFx.box} k={scale} locked={selectedFx.locked} inactive={selectedFx.inactive} keyed={selectedFx.keyed} drawing={drawing} onGesture={(e, g) => startRegionGesture(e, selectedFx.box.itemId, g, ctx)} />
      ) : null}
      {editingId && editingBox ? <TextEditor itemId={editingId} box={editingBox} k={scale} onClose={() => setEditingId(null)} /> : null}
      {reframing ? <ReframeOverlay project={project} playheadUs={playheadUs} width={width} height={height} /> : null}
      {zoomRect ? <ZoomRectPreview rect={zoomRect} k={scale} W={project.canvas.width} H={project.canvas.height} /> : null}
    </div>
  )
}
