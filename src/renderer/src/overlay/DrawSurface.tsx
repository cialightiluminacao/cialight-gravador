import { useEffect, useRef } from 'react'
import type { Stroke, StrokeTool } from '@shared/types'
import { drawStrokes } from '@shared/compositor'

// Superfície de desenho em tela cheia. Coordenadas normalizadas (0–1) do display;
// tMs = epoch ms de alta resolução (comparável entre janelas); o gravador converte para tempo de mídia.
// Renderização local usa o MESMO drawStrokes da exportação (paridade visual).

export interface DrawSettings {
  tool: StrokeTool
  color: string
  width: number
}

interface Props {
  displayId: string
  settings: DrawSettings
  strokes: Stroke[]
  autoFadeSec: number | null
  onStrokesChange: (s: Stroke[]) => void
  readOnly?: boolean
}

let seq = 0
const EMIT_INTERVAL_MS = 33
/** Relógio comparável entre janelas (epoch ms com sub-ms). */
export const nowEpoch = (): number => performance.timeOrigin + performance.now()

export function DrawSurface({ displayId, settings, strokes, autoFadeSec, onStrokesChange, readOnly }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const current = useRef<Stroke | null>(null)
  const lastEmit = useRef(0)
  const raf = useRef(0)

  // loop de render (só enquanto houver traços; auto-fade exige repintar)
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const fit = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
    }
    fit()
    window.addEventListener('resize', fit)
    const loop = (): void => {
      const W = canvas.width
      const H = canvas.height
      ctx.clearRect(0, 0, W, H)
      const all = current.current ? [...strokesRef.current, current.current] : strokesRef.current
      if (all.length) drawStrokes(ctx, W, H, { strokes: all, clearEvents: [] }, nowEpoch(), autoFadeSec ? autoFadeSec * 1000 : null)
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf.current)
      window.removeEventListener('resize', fit)
    }
  }, [autoFadeSec])

  useEffect(() => {
    if (readOnly) return
    const canvas = canvasRef.current!
    const norm = (e: PointerEvent): { x: number; y: number } => ({ x: Math.min(1, Math.max(0, e.clientX / window.innerWidth)), y: Math.min(1, Math.max(0, e.clientY / window.innerHeight)) })
    const emit = (final: boolean): void => {
      const s = current.current
      if (!s) return
      const now = performance.now()
      if (!final && now - lastEmit.current < EMIT_INTERVAL_MS) return
      lastEmit.current = now
      window.api.overlay.emitStroke({ displayId, stroke: { ...s, points: [...s.points] }, final, atPerfMs: now })
    }
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return
      canvas.setPointerCapture(e.pointerId)
      const st = settingsRef.current
      // Shift = linha reta; Ctrl+Shift = seta (estilo ZoomIt); senão a ferramenta selecionada
      const tool: StrokeTool = e.ctrlKey && e.shiftKey ? 'arrow' : e.shiftKey ? 'line' : st.tool
      const p = norm(e)
      const t = nowEpoch()
      current.current = { id: `${displayId}-${t.toFixed(0)}-${seq++}`, tMs: t, tool, points: [{ ...p, tMs: t }], color: st.color, width: st.width }
      emit(false)
    }
    const move = (e: PointerEvent): void => {
      const s = current.current
      if (!s) return
      const p = norm(e)
      const t = nowEpoch()
      if (s.tool === 'pen') {
        const last = s.points[s.points.length - 1]
        if (Math.hypot(p.x - last.x, p.y - last.y) < 0.0015) return
        s.points.push({ ...p, tMs: t })
      } else {
        // linha/seta: só o ponto final se move
        if (s.points.length === 1) s.points.push({ ...p, tMs: t })
        else s.points[1] = { ...p, tMs: t }
      }
      emit(false)
    }
    const up = (e: PointerEvent): void => {
      const s = current.current
      if (!s) return
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* ok */
      }
      const p = norm(e)
      const t = nowEpoch()
      if (s.tool === 'pen') {
        s.points.push({ ...p, tMs: t })
      } else if (s.points.length === 1) s.points.push({ ...p, tMs: t })
      else s.points[1] = { ...p, tMs: t }
      current.current = null
      onStrokesChange([...strokesRef.current, s])
      lastEmit.current = 0
      current.current = s
      emit(true)
      current.current = null
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
    }
  }, [displayId, onStrokesChange, readOnly])

  return <canvas ref={canvasRef} className="fixed inset-0" style={{ pointerEvents: readOnly ? 'none' : 'auto', touchAction: 'none' }} />
}
