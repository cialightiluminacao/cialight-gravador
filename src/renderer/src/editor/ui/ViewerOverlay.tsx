import { useEffect, useMemo, useRef, useState } from 'react'
import type { ZoomRect } from '@shared/editor/zoom'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../state/editorStore'
import { usePausedPlayhead } from '../state/pausedPlayhead'
import { useViewerTool } from '../state/viewerTool'
import { addEffectAt } from './editorActions'
import { effectFromDrag, isEffectDrag } from './EffectLibrary'
import { effectBoxes, hitTest, hitTestRegions, itemBoxes, type Guides, type Pt } from './viewerGeometry'
import { EffectRegionHandles, RegionOutline, selectedRegion, startRegionDraw, startRegionGesture } from './viewer/EffectRegionHandles'
import { editableMedia, ItemTransformHandles, startItemTransform, type GestureCtx } from './viewer/ItemTransformHandles'
import { cancelViewerGesture } from './viewer/viewerGesture'
import { startZoomDraw, ZoomRectPreview } from './viewer/ZoomTool'
import { markFocusPoint, ReframeOverlay } from './viewer/ReframeOverlay'
import { useReframe } from '../state/reframe'

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
  const rootRef = useRef<HTMLDivElement>(null)
  const clearHover = (): void => {
    if (rootRef.current) rootRef.current.style.cursor = ''
  }
  const boxes = useMemo(() => (project && !playing ? itemBoxes(project, playheadUs) : []), [project, playheadUs, playing])
  const regions = useMemo(() => (project && !playing ? effectBoxes(project, playheadUs) : []), [project, playheadUs, playing])
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
  const selectedMedia = selId && !drawing && !zooming && !reframing ? boxes.find((b) => b.itemId === selId && editableMedia(project, b.itemId)) : undefined
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
      if (box) startItemTransform(e, box, { kind: 'move' }, ctx)
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

  const onDrop = (e: React.DragEvent): void => {
    setDropHover(false)
    const preset = effectFromDrag(e)
    if (!preset) return
    e.preventDefault()
    if (useEditorStore.getState().playing) onPause()
    const pt = ctx.toCanvas(e)
    const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
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
      onDragOver={(e) => {
        if (!isEffectDrag(e)) return
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
      {reframing ? <ReframeOverlay project={project} playheadUs={playheadUs} width={width} height={height} /> : null}
      {zoomRect ? <ZoomRectPreview rect={zoomRect} k={scale} W={project.canvas.width} H={project.canvas.height} /> : null}
    </div>
  )
}
