import { memo, useEffect, useRef, useState } from 'react'
import type { Marker, Us } from '@shared/editor/project'
import { snapDelta, snapPoints } from '@shared/editor/snap'
import type { PlaybackController } from '../../engine/PlaybackController'
import { useEditorStore } from '../../state/editorStore'
import { useSilencePreview } from '../../state/silencePreview'
import { seekTo } from '../editorActions'
import { RULER_H } from './layout'
import { pxToDurUs, pxToUs, rulerLabel, rulerTicks, SNAP_PX, usToPx } from '../../state/zoom'

// Régua: ticks e timecode desenhados num <canvas> (só a janela visível), faixa I/O destacada e
// marcadores (triângulos coloridos: clique vai até ele, duplo clique renomeia, botão direito abre
// o menu) e os cortes do "Remover silêncios" em pré-visualização (faixas vermelhas). Clicar/arrastar
// na régua move o playhead (seek); com o ímã ligado encaixa em bordas e marcadores a 8 px.

interface Props {
  viewW: number
  fps: number
  playback: PlaybackController | null
  onMarkerMenu: (marker: Marker, clientX: number, clientY: number) => void
}

function Ticks({ viewW, fps, pps, scrollUs }: { viewW: number; fps: number; pps: number; scrollUs: Us }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || viewW <= 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(viewW * dpr)
    c.height = Math.round(RULER_H * dpr)
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, viewW, RULER_H)
    const { majorUs, minorUs } = rulerTicks(pps, fps)
    const ratio = Math.max(1, Math.round(majorUs / minorUs))
    const k0 = Math.floor(scrollUs / minorUs)
    const k1 = Math.ceil((scrollUs + (viewW * 1e6) / pps) / minorUs)
    g.font = '500 9.5px "Azeret Mono Variable", Consolas, monospace'
    g.textBaseline = 'top'
    for (let k = k0; k <= k1; k++) {
      const t = k * minorUs
      const x = Math.round(usToPx(t, pps, scrollUs)) + 0.5
      const major = k % ratio === 0
      g.fillStyle = major ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.14)'
      g.fillRect(x, major ? RULER_H - 11 : RULER_H - 5, 1, major ? 11 : 5)
      if (major) {
        g.fillStyle = '#8a8f9e'
        g.fillText(rulerLabel(t, majorUs, fps), x + 4, 5)
      }
    }
  }, [viewW, fps, pps, scrollUs])
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 block" style={{ width: viewW, height: RULER_H }} />
}

function MarkerLabelEditor({ marker, x, onDone }: { marker: Marker; x: number; onDone: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState(marker.label)
  const cancel = useRef(false)
  return (
    <input
      autoFocus
      aria-label="Nome do marcador"
      placeholder="Marcador"
      className="absolute top-0.5 z-40 h-5 w-36 rounded border border-accent/60 bg-bg-2 px-1 text-[11px] text-fg outline-none"
      style={{ left: x + 6 }}
      value={draft}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancel.current = true
          e.currentTarget.blur()
        }
      }}
      onBlur={() => {
        const label = draft.trim()
        if (!cancel.current && label !== marker.label) {
          useEditorStore.getState().apply((p) => ({ ...p, markers: p.markers.map((m) => (m.id === marker.id ? { ...m, label } : m)) }))
        }
        onDone()
      }}
    />
  )
}

export const Ruler = memo(function Ruler({ viewW, fps, playback, onMarkerMenu }: Props): React.JSX.Element {
  const pps = useEditorStore((s) => s.zoomPxPerSec)
  const scrollUs = useEditorStore((s) => s.scrollUs)
  const inUs = useEditorStore((s) => s.inUs)
  const outUs = useEditorStore((s) => s.outUs)
  const markers = useEditorStore((s) => s.project?.markers)
  const silenceCuts = useSilencePreview((s) => s.cuts)
  const rootRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  // arraste em curso: listeners da janela saem também se a régua desmontar no meio
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const st = useEditorStore.getState
    const p = st().project
    if (!p) return
    // pontos do ímã: bordas e marcadores (não o próprio playhead)
    const points = snapPoints(p, 0, []).filter((pt) => pt.kind !== 'playhead')
    const seekAt = (clientX: number): void => {
      const r = rootRef.current?.getBoundingClientRect()
      if (!r) return
      const { zoomPxPerSec: z, scrollUs: s, snapping } = st()
      let us = pxToUs(clientX - r.left, z, s)
      if (snapping) us += snapDelta([us], points, pxToDurUs(SNAP_PX, z)).deltaUs
      seekTo(playback, us)
    }
    seekAt(e.clientX)
    const move = (ev: PointerEvent): void => seekAt(ev.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      dragCleanup.current = null
    }
    dragCleanup.current?.()
    dragCleanup.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const x = (us: Us): number => usToPx(us, pps, scrollUs)
  const ioL = inUs !== null ? x(inUs) : null
  const ioR = outUs !== null ? x(outUs) : null

  return (
    <div
      ref={rootRef}
      data-timeline-ruler=""
      aria-label="Régua da linha do tempo"
      className="relative min-w-0 flex-1 cursor-pointer overflow-hidden bg-surface/70"
      style={{ height: RULER_H }}
      onPointerDown={onPointerDown}
    >
      {ioL !== null || ioR !== null ? (
        <span
          className="pointer-events-none absolute inset-y-0 border-x border-accent/70 bg-accent/15"
          style={{ left: Math.max(-2, ioL ?? -2), width: Math.max(0, Math.min(viewW + 2, ioR ?? viewW + 2) - Math.max(-2, ioL ?? -2)) }}
        />
      ) : null}
      {silenceCuts.map((c) => {
        const l = x(c.fromUs), r = x(c.toUs)
        if (r < -2 || l > viewW + 2) return null
        return <span key={c.fromUs} data-silence-cut="" className="pointer-events-none absolute inset-y-0 border-x border-danger/80 bg-danger/35" style={{ left: l, width: Math.max(1, r - l) }} />
      })}
      <Ticks viewW={viewW} fps={fps} pps={pps} scrollUs={scrollUs} />
      {markers?.map((m) => {
        const mx = x(m.tUs)
        if (mx < -10 || mx > viewW + 10) return null
        return (
          <span key={m.id}>
            <button
              type="button"
              data-marker-id={m.id}
              title={m.label ? `${m.label} — duplo clique para renomear` : 'Marcador — duplo clique para renomear'}
              aria-label={m.label || 'Marcador'}
              className="absolute bottom-0 z-30 h-[11px] w-[12px] -translate-x-1/2 [clip-path:polygon(0_0,100%_0,50%_100%)] hover:brightness-125"
              style={{ left: mx, backgroundColor: m.color }}
              onPointerDown={(e) => {
                e.stopPropagation()
                if (e.button === 0) seekTo(playback, m.tUs)
              }}
              onDoubleClick={() => setEditing(m.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onMarkerMenu(m, e.clientX, e.clientY)
              }}
            />
            {m.label && editing !== m.id ? (
              <span className="pointer-events-none absolute top-[2px] z-30 max-w-[120px] truncate rounded-sm px-1 text-[9px] font-semibold leading-[11px] text-black" style={{ left: mx + 3, backgroundColor: m.color }}>
                {m.label}
              </span>
            ) : null}
            {editing === m.id ? <MarkerLabelEditor marker={m} x={mx} onDone={() => setEditing(null)} /> : null}
          </span>
        )
      })}
    </div>
  )
})
