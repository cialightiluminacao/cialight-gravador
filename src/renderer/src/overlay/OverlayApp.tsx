import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverlayModePayload } from '@shared/ipc'
import type { Stroke, StrokeTool } from '@shared/types'
import { Countdown } from './Countdown'
import { RecBorder } from './RecBorder'
import { DrawSurface, type DrawSettings } from './DrawSurface'
import { DrawPalette } from './DrawPalette'

// App da overlay transparente (uma por monitor gravado). Recebe o modo do main:
// countdown → número gigante; idle → borda "gravando" (+ pausado); drawing → superfície de desenho.
// Excluída da captura; os traços viram vetores enviados ao gravador.

const params = new URLSearchParams(location.search)
const displayId = params.get('displayId') ?? ''

export function OverlayApp(): React.JSX.Element | null {
  const [mode, setMode] = useState<OverlayModePayload>({ mode: 'hidden' })
  const [draw, setDraw] = useState<DrawSettings>({ tool: 'pen', color: '#ff3b30', width: 6 })
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [autoFadeSec, setAutoFadeSec] = useState<number | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  strokesRef.current = strokes

  useEffect(() => {
    const offMode = window.api.overlay.onMode((p) => {
      setMode(p)
      if (p.mode === 'drawing') {
        setDraw((d) => ({ tool: p.tool ?? d.tool, color: p.color ?? d.color, width: p.width ?? d.width }))
        setAutoFadeSec(p.autoFadeSec ?? null)
      }
      if (p.mode === 'hidden') setStrokes([])
    })
    const offSync = window.api.overlay.onSyncStrokes((s) => {
      // o gravador é a fonte de verdade após desfazer/apagar: mantemos só os ids que ele considera visíveis
      const ids = new Set(s.map((x) => x.id))
      setStrokes((cur) => cur.filter((x) => ids.has(x.id)))
    })
    return () => {
      offMode()
      offSync()
    }
  }, [])

  const setTool = useCallback((tool: StrokeTool) => {
    setDraw((d) => ({ ...d, tool }))
    window.api.overlay.emitAction({ action: 'setTool', tool })
  }, [])

  const undo = useCallback(() => window.api.overlay.emitAction({ action: 'undo' }), [])
  const clear = useCallback(() => {
    setStrokes([])
    window.api.overlay.emitAction({ action: 'clear' })
  }, [])
  const exit = useCallback(() => window.api.overlay.emitAction({ action: 'exit' }), [])

  // atalhos dentro do modo desenho
  useEffect(() => {
    if (mode.mode !== 'drawing') return
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') {
        e.preventDefault()
        exit()
      } else if (k === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        undo()
      } else if (k === 'e' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        clear()
      } else if (k === 'r') setDraw((d) => ({ ...d, color: '#ff3b30' }))
      else if (k === 'g') setDraw((d) => ({ ...d, color: '#3ddc97' }))
      else if (k === 'b') setDraw((d) => ({ ...d, color: '#4d8dff' }))
      else if (k === 'y') setDraw((d) => ({ ...d, color: '#ffd23f' }))
      else if (k === 'w') setDraw((d) => ({ ...d, color: '#ffffff' }))
      else if (e.key === '[') setDraw((d) => ({ ...d, width: Math.max(2, d.width - 2) }))
      else if (e.key === ']') setDraw((d) => ({ ...d, width: Math.min(24, d.width + 2) }))
      else if (k === 'p') setTool('pen')
      else if (k === 'l') setTool('line')
      else if (k === 'a') setTool('arrow')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mode.mode, exit, undo, clear, setTool])

  if (mode.mode === 'hidden') return null
  const rect = mode.targetRect ?? null

  return (
    <div className="fixed inset-0 select-none" style={{ background: 'transparent', cursor: mode.mode === 'drawing' ? 'crosshair' : 'default' }}>
      {mode.mode === 'countdown' ? <Countdown count={mode.count ?? 3} /> : null}
      {(mode.mode === 'idle' || mode.mode === 'drawing') && <RecBorder paused={!!mode.paused} rect={rect} drawing={mode.mode === 'drawing'} windowMode={mode.sourceKind === 'window'} sourceName={mode.sourceName} />}
      {mode.mode === 'drawing' ? (
        <>
          <DrawSurface
            displayId={displayId}
            settings={draw}
            strokes={strokes}
            autoFadeSec={autoFadeSec}
            onStrokesChange={setStrokes}
          />
          <DrawPalette settings={draw} onChange={setDraw} onTool={setTool} onUndo={undo} onClear={clear} onExit={exit} />
        </>
      ) : strokes.length ? (
        // fora do modo desenho os traços continuam visíveis (até apagar / auto-sumir)
        <DrawSurface displayId={displayId} settings={draw} strokes={strokes} autoFadeSec={autoFadeSec} onStrokesChange={setStrokes} readOnly />
      ) : null}
    </div>
  )
}
