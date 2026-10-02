import { toast } from 'sonner'
import { mainClipAt, reframeWindow } from '@shared/editor/reframe'
import type { Project, Us } from '@shared/editor/project'
import { useEditorStore } from '../../state/editorStore'
import { reframePreview, useReframe } from '../../state/reframe'
import type { Pt } from '../viewerGeometry'

// Visualizador com o painel "Reenquadrar" aberto: o quadro novo desenhado sobre o atual (o resto escurecido) no
// instante do playhead, os pontos de foco do clipe principal e o clique que marca um ponto (instante do playhead,
// ponto clicado no quadro atual).

/** Meio quadro: o ponto "deste instante" (marcado no playhead atual). */
const near = (a: Us, b: Us, fps: number): boolean => Math.abs(a - b) < 5e5 / Math.max(1, fps)

/** Clique no quadro com o painel aberto: marca o ponto de foco do clipe principal no playhead. */
export function markFocusPoint(p: Project, pt: Pt): void {
  const rf = useReframe.getState()
  if (rf.mode !== 'cover') {
    toast('Os pontos de foco valem no modo Preencher.')
    return
  }
  const tUs = useEditorStore.getState().playheadUs
  const m = mainClipAt(p, tUs)
  if (!m) {
    toast('Não há clipe principal neste instante.')
    return
  }
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  rf.addPoint(m.id, { tUs, x: clamp01(pt.x / p.canvas.width), y: clamp01(pt.y / p.canvas.height) })
}

export function ReframeOverlay({ project, playheadUs, width, height }: { project: Project; playheadUs: Us; width: number; height: number }): React.JSX.Element | null {
  const aspect = useReframe((s) => s.aspect)
  const mode = useReframe((s) => s.mode)
  const points = useReframe((s) => s.points)
  const m = mainClipAt(project, playheadUs)
  const after = reframePreview(project, { aspect, mode, points }).project
  const win = m ? reframeWindow(project, after, m.id, playheadUs) : null
  const list = m && mode === 'cover' ? (points[m.id] ?? []) : []
  const poly = win?.map((c) => `${c.x * width},${c.y * height}`).join(' ')
  return (
    <svg data-reframe-overlay="" className="pointer-events-none absolute inset-0" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {poly ? (
        <>
          <path d={`M0,0H${width}V${height}H0Z M${poly.split(' ').join(' L')} Z`} fillRule="evenodd" fill="rgba(0,0,0,0.55)" />
          <polygon data-reframe-window="" points={poly} fill="none" stroke="var(--color-accent, #ff4d4f)" strokeWidth={2} />
        </>
      ) : null}
      {list.map((pt) => {
        const here = near(pt.tUs, playheadUs, project.canvas.fps)
        return (
          <g key={pt.tUs} data-focus-marker={here ? 'here' : 'other'} transform={`translate(${pt.x * width},${pt.y * height})`} opacity={here ? 1 : 0.55}>
            <circle r={here ? 9 : 6} fill={here ? 'rgba(255,77,79,0.35)' : 'none'} stroke="#fff" strokeWidth={2} />
            <path d="M-14,0H-5M5,0H14M0,-14V-5M0,5V14" stroke="#fff" strokeWidth={2} />
          </g>
        )
      })}
    </svg>
  )
}
