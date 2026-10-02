import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MousePointerClick } from 'lucide-react'
import { toast } from 'sonner'
import { TEXT_PRESETS, type ShapePresetId, type TextPresetId } from '@shared/editor/factory'
import { projectDurationUs } from '@shared/editor/ops'
import type { Marker } from '@shared/editor/project'
import { snapDelta, snapPoints } from '@shared/editor/snap'
import { formatTimecodeUs } from '@shared/editor/time'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../../engine/PlaybackController'
import { useEditorStore } from '../../state/editorStore'
import { useExpandedItems } from '../../state/keyframeLanes'
import { useSilencePreview } from '../../state/silencePreview'
import { addAssetAt, addEffectAt, addShapeAt, addTextAt, addTransitionTo, registerZoomFit, seekTo } from '../editorActions'
import { effectFromDrag, isEffectDrag } from '../EffectLibrary'
import { ASSET_MIME } from '../MediaCard'
import { isShapeDrag, isTextDrag, shapeFromDrag, textFromDrag } from '../TextLibrary'
import { isTransitionDrag, transitionFromDrag } from '../TransitionLibrary'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { HScrollbar } from './HScrollbar'
import { dropTarget, effectDropTrack, overlayDropTrack } from './dragMath'
import { CUT_HIT_PX, transitionDropReason, transitionDropTarget } from './transitionMath'
import { transitionMenuEntries } from './transitionMenu'
import { itemMenuEntries, markerMenuEntries } from './itemMenu'
import { buildLayout, displayNeighborIndex, HEADER_W, RULER_H, SEP_H, zoneAt } from './layout'
import { Playhead } from './Playhead'
import { Ruler } from './Ruler'
import { TimelineToolbar } from './TimelineToolbar'
import { TrackHeader } from './TrackHeader'
import { TrackLane } from './TrackLane'
import { cancelActiveGesture, NO_OVERLAY, useTimelineDrag, type DragOverlay } from './useTimelineDrag'
import { fitZoom, maxScrollUs, pxToDurUs, pxToUs, SNAP_PX, usToPx } from '../../state/zoom'

// Linha do tempo multifaixa (spec §9). Rolagem horizontal virtual (scrollUs no store) e vertical
// nativa; roda = rolar na horizontal, Ctrl+roda = zoom ancorado no mouse, Shift+roda = vertical.
// Na reprodução a vista acompanha o playhead página a página. Soltar mídia da biblioteca adiciona
// no ponto/faixa sob o ponteiro; soltar um efeito, no ponto e na faixa de vídeo livre sob ele (ou na "Efeitos").

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const SCROLLBAR_H = 11
const NO_ENTRIES: MenuEntry[] = []
/** Duração com que uma forma solta da biblioteca ocupa a linha do tempo (3 s). */
const SHAPE_DROP_US = 3_000_000

/** Corte-alvo realçado durante o arraste de uma transição (ok = vai entrar; senão, a regra recusa). */
interface CutHover { toId: string; cutUs: number; y: number; h: number; ok: boolean }

function PlayheadTimecode(): React.JSX.Element {
  const t = useEditorStore((s) => s.playheadUs)
  const fps = useEditorStore((s) => s.project?.canvas.fps ?? 30)
  return <span className="font-mono text-[11px] font-semibold tabular-nums text-fg">{formatTimecodeUs(t, fps)}</span>
}

export function Timeline({ playback }: { playback: PlaybackController | null }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const pps = useEditorStore((s) => s.zoomPxPerSec)
  const scrollUs = useEditorStore((s) => s.scrollUs)
  const selection = useEditorStore((s) => s.selection)
  const selectedTransition = useEditorStore((s) => s.selectedTransition)
  const inUs = useEditorStore((s) => s.inUs)
  const outUs = useEditorStore((s) => s.outUs)
  const silenceCuts = useSilencePreview((s) => s.cuts)
  const expanded = useExpandedItems((s) => s.ids)
  const [viewW, setViewW] = useState(0)
  const [overlay, setOverlay] = useState<DragOverlay>(NO_OVERLAY)
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [dropHover, setDropHover] = useState(false)
  const [cutHover, setCutHover] = useState<CutHover | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rulerBoxRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const viewWRef = useRef(0)
  viewWRef.current = viewW

  const tracks = project?.tracks
  const layout = useMemo(() => buildLayout(tracks ?? [], expanded), [tracks, expanded])
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const assetList = project?.assets
  const assets = useMemo(() => new Map((assetList ?? []).map((a) => [a.id, a])), [assetList])
  const durationUs = useMemo(() => (project ? projectDurationUs(project) : 0), [project])

  // ---- largura visível da área das faixas
  useEffect(() => {
    const el = rulerBoxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setViewW(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- zoom
  const zoomTo = useCallback((z: number, anchorPx: number) => {
    const s = st()
    s.setZoom(z, pxToUs(anchorPx, s.zoomPxPerSec, s.scrollUs))
  }, [])
  const zoomFit = useCallback(() => {
    const p = st().project
    if (!p || viewWRef.current <= 0) return
    st().setZoom(fitZoom(projectDurationUs(p), viewWRef.current))
    st().setScroll(0)
  }, [])
  const onSliderZoom = useCallback(
    (z: number) => {
      const s = st()
      const ph = usToPx(s.playheadUs, s.zoomPxPerSec, s.scrollUs)
      zoomTo(z, ph >= 0 && ph <= viewWRef.current ? ph : viewWRef.current / 2)
    },
    [zoomTo]
  )
  useEffect(() => {
    registerZoomFit(zoomFit)
    return () => registerZoomFit(null)
  }, [zoomFit])
  // ao abrir: o projeto inteiro na tela
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || viewW <= 0 || !project) return
    fitted.current = true
    if (projectDurationUs(project) > 0) zoomFit()
  }, [viewW, project, zoomFit])

  // ---- roda do mouse (listener nativo não passivo para poder impedir a rolagem da página)
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const onWheel = (e: WheelEvent): void => {
      const s = st()
      const scroller = scrollerRef.current
      const laneX = e.clientX - body.getBoundingClientRect().left - HEADER_W
      const unit = e.deltaMode === 1 ? 16 : 1
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomTo(s.zoomPxPerSec * Math.exp(-e.deltaY * unit * 0.0015), Math.min(viewWRef.current, Math.max(0, laneX)))
        return
      }
      if (e.shiftKey || laneX < 0) {
        // vertical (Shift, ou sobre os cabeçalhos)
        if (!scroller) return
        e.preventDefault()
        scroller.scrollTop += (e.deltaY || e.deltaX) * unit
        return
      }
      e.preventDefault()
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit
      const p = s.project
      const max = Math.max(s.scrollUs, p ? maxScrollUs(projectDurationUs(p), viewWRef.current, s.zoomPxPerSec) : 0)
      s.setScroll(Math.min(max, Math.max(0, s.scrollUs + pxToDurUs(d, s.zoomPxPerSec))))
    }
    body.addEventListener('wheel', onWheel, { passive: false })
    return () => body.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // ---- a vista acompanha o playhead (página a página na reprodução)
  useEffect(
    () =>
      useEditorStore.subscribe((s, prev) => {
        if (s.playheadUs === prev.playheadUs || viewWRef.current <= 0) return
        const span = (viewWRef.current * 1e6) / s.zoomPxPerSec
        const x = s.playheadUs - s.scrollUs
        if (x >= 0 && x <= span) return
        const at = x < 0 || s.playing ? 0.05 : 0.9
        s.setScroll(Math.max(0, s.playheadUs - span * at))
      }),
    []
  )

  useEffect(() => () => cancelActiveGesture(), [])

  const onItemMenu = useCallback(
    (itemId: string, x: number, y: number) => {
      const p = st().project
      if (p) setMenu({ x, y, entries: itemMenuEntries(p, itemId, playback) })
    },
    [playback]
  )
  const onTransitionMenu = useCallback((toId: string, x: number, y: number) => {
    const p = st().project
    if (p) setMenu({ x, y, entries: transitionMenuEntries(p, toId) })
  }, [])
  const onMarkerMenu = useCallback((m: Marker, x: number, y: number) => setMenu({ x, y, entries: markerMenuEntries(m, playback) }), [playback])
  const closeMenu = useCallback(() => setMenu(null), [])
  const onSeek = useCallback((us: number) => seekTo(playback, us), [playback])
  const drag = useTimelineDrag({ scrollerRef, layoutRef, setOverlay, onItemMenu, onTransitionMenu, onSeek })

  /** Instante sob o ponteiro (µs) e a zona de faixa; `snap` só para mídia/efeito/texto/forma (a transição não gruda). */
  const pointerAt = (e: React.DragEvent, snap: boolean): { atUs: number; zone: ReturnType<typeof zoneAt> } | null => {
    const scroller = scrollerRef.current
    if (!scroller) return null
    const s = st()
    const r = scroller.getBoundingClientRect()
    let atUs = Math.max(0, pxToUs(Math.max(0, e.clientX - r.left - HEADER_W), s.zoomPxPerSec, s.scrollUs))
    if (snap && s.snapping && s.project) atUs += snapDelta([atUs], snapPoints(s.project, s.playheadUs, []), pxToDurUs(SNAP_PX, s.zoomPxPerSec)).deltaUs
    return { atUs: Math.max(0, atUs), zone: zoneAt(layoutRef.current, e.clientY - r.top + scroller.scrollTop) }
  }

  /** Corte (ou clipe) sob o ponteiro durante o arraste de uma transição. */
  const cutUnder = (e: React.DragEvent): CutHover | null => {
    const s = st()
    const at = pointerAt(e, false)
    if (!s.project || !at || at.zone?.kind !== 'track') return null
    const zone = at.zone
    const track = s.project.tracks.find((t) => t.id === zone.trackId)
    if (!track) return null
    const tgt = transitionDropTarget(track, at.atUs, pxToDurUs(CUT_HIT_PX, s.zoomPxPerSec))
    const row = layoutRef.current.rows.find((r) => r.track.id === track.id)
    const b = tgt ? track.items.find((i) => i.id === tgt.toId) : undefined
    if (!tgt || !b || !row) return null
    return { toId: b.id, cutUs: b.startUs, y: row.y, h: row.h, ok: transitionDropReason(s.project, track.id, b.id) === null }
  }

  // ---- soltar mídia/efeito/texto/forma/transição da biblioteca no ponto/faixa sob o ponteiro
  const onDrop = (e: React.DragEvent): void => {
    setDropHover(false)
    setCutHover(null)
    const assetId = e.dataTransfer.getData(ASSET_MIME)
    const preset = effectFromDrag(e)
    const textPreset = textFromDrag(e)
    const shapePreset = shapeFromDrag(e)
    const tKind = transitionFromDrag(e)
    if (!assetId && !preset && !textPreset && !shapePreset && !tKind) return
    e.preventDefault()
    const s = st()
    const at = pointerAt(e, !tKind)
    if (!at) return
    const { atUs, zone } = at
    if (tKind) {
      const track = s.project && zone?.kind === 'track' ? s.project.tracks.find((t) => t.id === zone.trackId) : undefined
      const tgt = track ? transitionDropTarget(track, atUs, pxToDurUs(CUT_HIT_PX, s.zoomPxPerSec)) : null
      if (!tgt) toast('Solte a transição sobre o corte entre dois clipes encostados, ou sobre um clipe.')
      else addTransitionTo(tgt.toId, tKind)
    } else if (textPreset) {
      const trackId = s.project ? overlayDropTrack(s.project, zone, atUs, TEXT_PRESETS[textPreset as TextPresetId].durationUs, 'text') : undefined
      addTextAt(textPreset, atUs, trackId ? { trackId } : undefined)
    } else if (shapePreset) {
      const trackId = s.project ? overlayDropTrack(s.project, zone, atUs, SHAPE_DROP_US, 'shape') : undefined
      addShapeAt(shapePreset as ShapePresetId, atUs, trackId ? { trackId } : undefined)
    } else if (preset) {
      const trackId = s.project ? effectDropTrack(s.project, zone, atUs) : undefined
      addEffectAt(preset, atUs, trackId ? { trackId } : undefined)
    } else addAssetAt(assetId, atUs, s.project ? dropTarget(s.project, assetId, zone) : undefined)
  }

  if (!project) return null
  const x = (us: number): number => usToPx(us, pps, scrollUs)
  const ghost = overlay.ghost
  const box = overlay.box
  const empty = project.tracks.every((t) => t.items.length === 0)

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-2"
      aria-label="Linha do tempo"
      onDragOver={(e) => {
        const transition = isTransitionDrag(e)
        if (!Array.from(e.dataTransfer.types).includes(ASSET_MIME) && !isEffectDrag(e) && !isTextDrag(e) && !isShapeDrag(e) && !transition) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropHover) setDropHover(true)
        // transição: realça o corte-alvo (acento = entra; vermelho = a regra recusa)
        if (transition) {
          const c = cutUnder(e)
          setCutHover((prev) => (prev?.toId === c?.toId && prev?.ok === c?.ok && prev?.y === c?.y ? prev : c))
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropHover(false)
          setCutHover(null)
        }
      }}
      onDrop={onDrop}
    >
      <TimelineToolbar playback={playback} onZoom={onSliderZoom} />
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 border-b border-border" style={{ height: RULER_H }}>
          <div className="flex shrink-0 items-center border-r border-border bg-surface px-3" style={{ width: HEADER_W }}>
            <PlayheadTimecode />
          </div>
          <div ref={rulerBoxRef} className="relative flex min-w-0 flex-1">
            <Ruler viewW={viewW} fps={project.canvas.fps} playback={playback} onMarkerMenu={onMarkerMenu} />
          </div>
        </div>
        <div
          ref={scrollerRef}
          data-timeline-lanes=""
          className={cn('relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden', dropHover && 'bg-accent/[0.04]')}
          onPointerDown={drag.onPointerDown}
          onContextMenu={drag.onContextMenu}
        >
          <div className="relative" style={{ height: layout.height }}>
            <div className="absolute inset-y-0 left-0 border-r border-border bg-surface/60" style={{ width: HEADER_W }} />
            {layout.rows.map((row) => (
              <div key={row.track.id} className="absolute inset-x-0 flex border-b border-border/70" style={{ top: row.y, height: row.h }}>
                <TrackHeader playback={playback} track={row.track} rowH={row.h - 1} up={displayNeighborIndex(project.tracks, row.track.id, 'up')} down={displayNeighborIndex(project.tracks, row.track.id, 'down')} />
                <TrackLane track={row.track} rowH={row.itemH - 1} expanded={expanded} lanesTop={row.itemH} projectId={project.id} assets={assets} pxPerSec={pps} scrollUs={scrollUs} viewW={viewW} selection={selection} selectedTransition={selectedTransition} />
              </div>
            ))}
            {layout.sepY !== null ? <div className="absolute inset-x-0 border-b border-border-strong bg-bg" style={{ top: layout.sepY, height: SEP_H }} /> : null}
            {cutHover ? (
              <div
                data-cut-highlight={cutHover.ok ? 'ok' : 'invalid'}
                className={cn('pointer-events-none absolute z-20 w-1 rounded-full shadow-[0_0_6px_currentColor]', cutHover.ok ? 'bg-accent text-accent' : 'bg-danger text-danger')}
                style={{ left: HEADER_W + x(cutHover.cutUs) - 2, top: cutHover.y + 2, height: cutHover.h - 4 }}
              />
            ) : null}
            {ghost ? (
              <div
                className={cn('pointer-events-none absolute z-10 flex items-center rounded-[6px] border-2 px-2 text-[10px] font-semibold', ghost.tone === 'invalid' ? 'border-danger bg-danger/25 text-danger' : 'border-dashed border-accent bg-accent/15 text-accent')}
                style={{ top: ghost.y, height: ghost.h, left: HEADER_W + Math.max(-4, x(ghost.startUs)), width: Math.max(6, (ghost.durationUs * pps) / 1e6) }}
              >
                {ghost.tone === 'new' && ghost.h >= 20 ? 'Nova faixa' : null}
              </div>
            ) : null}
            {overlay.label ? (
              <div
                data-drag-label=""
                className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md border border-border-strong bg-surface-3 px-2 py-0.5 font-mono text-[10px] text-fg shadow-lg"
                style={{ left: HEADER_W + Math.max(4, x(overlay.label.us) + 8), top: Math.max(0, overlay.label.y - 20) }}
              >
                {overlay.label.text}
              </div>
            ) : null}
            {box ? (
              <div
                className="pointer-events-none absolute z-10 border border-accent/80 bg-accent/10"
                style={{ left: HEADER_W + Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
              />
            ) : null}
            {empty ? (
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-center gap-2 text-[12px] text-muted" style={{ left: HEADER_W }}>
                <MousePointerClick className="h-4 w-4" /> Arraste mídias da biblioteca para cá
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 border-t border-border bg-surface/40">
          <div className="shrink-0" style={{ width: HEADER_W }} />
          <HScrollbar viewW={viewW} durationUs={durationUs} />
        </div>
        {/* sobreposições que não rolam na vertical: faixa I/O, cortes do "Remover silêncios", linha guia do ímã e playhead */}
        <div className="pointer-events-none absolute right-0 top-0 overflow-hidden" style={{ left: HEADER_W, bottom: SCROLLBAR_H }}>
          {inUs !== null || outUs !== null ? (
            <span className="absolute bottom-0 bg-accent/[0.06]" style={{ top: RULER_H, left: Math.max(0, inUs !== null ? x(inUs) : 0), right: outUs !== null ? Math.max(0, viewW - x(outUs)) : 0 }} />
          ) : null}
          {silenceCuts.map((c) => (
            <span key={c.fromUs} className="absolute bottom-0 bg-danger/[0.16]" style={{ top: RULER_H, left: x(c.fromUs), width: Math.max(1, x(c.toUs) - x(c.fromUs)) }} />
          ))}
          {overlay.guideUs !== null ? <span data-snap-guide="" className="absolute inset-y-0 z-30 w-px bg-warn shadow-[0_0_4px_var(--warn)]" style={{ left: Math.round(x(overlay.guideUs)) }} /> : null}
          <Playhead viewW={viewW} />
        </div>
      </div>
      <ContextMenu at={menu} entries={menu?.entries ?? NO_ENTRIES} onClose={closeMenu} />
    </div>
  )
}
