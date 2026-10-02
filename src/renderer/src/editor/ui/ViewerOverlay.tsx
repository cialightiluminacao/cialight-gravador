import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../state/editorStore'
import { usePausedPlayhead } from '../state/pausedPlayhead'
import { useViewerTool } from '../state/viewerTool'
import { effectBoxes, hitTest, hitTestRegions, itemBoxes, type Guides, type Pt } from './viewerGeometry'
import { EffectRegionHandles, RegionOutline, selectedRegion, startRegionDraw, startRegionGesture } from './viewer/EffectRegionHandles'
import { editableMedia, ItemTransformHandles, startItemTransform, type GestureCtx } from './viewer/ItemTransformHandles'
import { cancelViewerGesture } from './viewer/viewerGesture'

// Manipulação direta no visualizador: clique seleciona (Ctrl/Shift alterna) — regiões de efeito
// primeiro (ficam sempre "por cima" para seleção), senão a mídia abaixo —, arrastar move; alças do
// selecionado (mídia: viewer/ItemTransformHandles; efeito: viewer/EffectRegionHandles). Com a
// ferramenta "Desenhar região" (B) ligada, arrastar no quadro cria um efeito. Guias do quadro durante
// os gestos; cada gesto é uma transação (viewer/viewerGesture).

const NO_GUIDES: Guides = { v: [], h: [] }

export function ViewerOverlay({ width, height, scale, onPause }: { width: number; height: number; scale: number; onPause: () => void }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  // alças só aparecem parado: tocando, nada aqui re-renderiza a cada quadro
  const playheadUs = usePausedPlayhead()
  const selection = useEditorStore((s) => s.selection)
  const playing = useEditorStore((s) => s.playing)
  const drawing = useViewerTool((s) => s.drawing)
  const [guides, setGuides] = useState<Guides>(NO_GUIDES)
  const rootRef = useRef<HTMLDivElement>(null)
  const boxes = useMemo(() => (project && !playing ? itemBoxes(project, playheadUs) : []), [project, playheadUs, playing])
  const regions = useMemo(() => (project && !playing ? effectBoxes(project, playheadUs) : []), [project, playheadUs, playing])
  // saindo da tela no meio de um gesto: cancela; a ferramenta não fica ligada para o próximo projeto
  useEffect(
    () => () => {
      cancelViewerGesture()
      useViewerTool.getState().setDrawing(false)
    },
    []
  )
  if (!project) return null
  const selId = selection.length === 1 && !playing ? selection[0] : null
  const selectedMedia = selId && !drawing ? boxes.find((b) => b.itemId === selId && editableMedia(project, b.itemId)) : undefined
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
    if (drawing) {
      if (useEditorStore.getState().playing) onPause()
      startRegionDraw(e, ctx)
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

  return (
    <div ref={rootRef} data-viewer-overlay className={cn('absolute inset-0', drawing && 'cursor-crosshair')} style={{ width, height }} onPointerDown={onBackgroundDown}>
      {guides.v.map((x) => (
        <div key={`v${x}`} data-guide="v" className="pointer-events-none absolute inset-y-0 w-px bg-accent/80" style={{ left: `calc(${x * 100}% - ${x}px)` }} />
      ))}
      {guides.h.map((y) => (
        <div key={`h${y}`} data-guide="h" className="pointer-events-none absolute inset-x-0 h-px bg-accent/80" style={{ top: `calc(${y * 100}% - ${y}px)` }} />
      ))}
      {regions.filter((b) => b.itemId !== selId).map((b) => (
        <RegionOutline key={b.itemId} box={b} k={scale} />
      ))}
      {selectedMedia ? <ItemTransformHandles box={selectedMedia} k={scale} onGesture={(e, box, g) => startItemTransform(e, box, g, ctx)} /> : null}
      {selectedFx && !playing ? (
        <EffectRegionHandles box={selectedFx.box} k={scale} locked={selectedFx.locked} inactive={selectedFx.inactive} keyed={selectedFx.keyed} drawing={drawing} onGesture={(e, g) => startRegionGesture(e, selectedFx.box.itemId, g, ctx)} />
      ) : null}
    </div>
  )
}
