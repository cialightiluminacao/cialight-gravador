import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useEditorStore } from '../state/editorStore'
import { redrawStill, type EditorEngine } from './editorEngine'
import { Transport } from './Transport'
import { ViewerOverlay } from './ViewerOverlay'
import { TOOLBAR_GUTTER, ViewerToolbar } from './viewer/ViewerToolbar'

// Visualizador: o canvas do compositor (criado pelo motor e transferido ao worker uma única vez; o watchdog
// do motor pode trocá-lo por outro no mesmo lugar do DOM — por isso sempre `engine.canvas`) é
// encaixado no palco mantendo a proporção do projeto (letterbox); ResizeObserver redimensiona o
// render. Por cima, a camada de manipulação direta e a barra de ferramentas; embaixo, o transporte.

const PAD = 16

export function Viewer({ engine }: { engine: EditorEngine | null }): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const canvasW = useEditorStore((s) => s.project?.canvas.width ?? 1920)
  const canvasH = useEditorStore((s) => s.project?.canvas.height ?? 1080)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [fullscreen, setFullscreen] = useState(false)

  // tamanho exibido: maior retângulo com a proporção do projeto que cabe no palco
  const aspect = canvasW / Math.max(1, canvasH)
  // margens laterais reservadas para a barra de ferramentas vertical (simétricas: o quadro fica centrado)
  const availW = Math.max(0, stage.w - (PAD + TOOLBAR_GUTTER) * 2)
  const availH = Math.max(0, stage.h - PAD * 2)
  const dispW = Math.max(1, Math.floor(Math.min(availW, availH * aspect)))
  const dispH = Math.max(1, Math.floor(dispW / aspect))

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setStage({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (!engine || !frame) return
    engine.canvas.style.width = '100%'
    engine.canvas.style.height = '100%'
    frame.prepend(engine.canvas)
    return () => engine.canvas.remove()
  }, [engine])

  useEffect(() => {
    if (!engine || stage.w === 0) return
    engine.render.resize(dispW, dispH)
    redrawStill(engine)
  }, [engine, dispW, dispH, stage.w])

  useEffect(() => {
    const on = (): void => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen().catch(() => {})
  }

  return (
    <section ref={rootRef} className="flex min-h-0 min-w-0 flex-col bg-bg" aria-label="Visualizador">
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#07080b]"
        onPointerDown={(e) => {
          // clique no letterbox (fora do quadro) limpa a seleção
          if (e.target === e.currentTarget) useEditorStore.getState().select([])
        }}
      >
        {engine ? <ViewerToolbar /> : null}
        <div ref={frameRef} className="relative shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_12px_40px_rgba(0,0,0,0.5)]" style={{ width: dispW, height: dispH }}>
          {engine ? <ViewerOverlay width={dispW} height={dispH} scale={dispW / canvasW} onPause={() => engine.playback.pause()} /> : null}
          {!engine ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted">
              <LoaderCircle className="h-5 w-5 animate-spin" />
            </div>
          ) : null}
        </div>
      </div>
      <Transport playback={engine?.playback ?? null} fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
    </section>
  )
}
