import { toast } from 'sonner'
import { focusFromScreen, focusToScreen, mainClipAt, reframeWindow } from '@shared/editor/reframe'
import type { Project, Us } from '@shared/editor/project'
import { useEditorStore } from '../../state/editorStore'
import { useReframe, useReframePreview } from '../../state/reframe'
import type { Pt } from '../viewerGeometry'

// Visualizador com o painel "Reenquadrar" aberto: o quadro novo desenhado sobre o atual (o resto escurecido) no
// instante do playhead, os pontos de foco do clipe principal (cada um onde o conteúdo dele aparece no instante dele) e
// o clique que marca um ponto (o conteúdo do clipe sob o clique, no playhead).

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
  const f = focusFromScreen(p, m, tUs, pt.x / p.canvas.width, pt.y / p.canvas.height)
  if (!f) {
    toast('O clipe está invisível neste instante.')
    return
  }
  rf.addPoint(m.id, f)
}

export function ReframeOverlay({ project, playheadUs, width, height }: { project: Project; playheadUs: Us; width: number; height: number }): React.JSX.Element | null {
  const aspect = useReframe((s) => s.aspect)
  const mode = useReframe((s) => s.mode)
  const points = useReframe((s) => s.points)
  const m = mainClipAt(project, playheadUs)
  // a última prévia pronta (a conta é agendada: o clique que marca o ponto não espera por ela)
  const after = useReframePreview(project, { aspect, mode, points }).result?.project ?? null
  const win = m && after ? reframeWindow(project, after, m.id, playheadUs) : null
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
      {list.map((f) => {
        const pt = m ? focusToScreen(project, m, f) : null
        if (!pt) return null
        const here = near(pt.tUs, playheadUs, project.canvas.fps)
        return (
          <g key={f.localUs} data-focus-marker={here ? 'here' : 'other'} transform={`translate(${pt.x * width},${pt.y * height})`} opacity={here ? 1 : 0.55}>
            <circle r={here ? 9 : 6} fill={here ? 'rgba(255,77,79,0.35)' : 'none'} stroke="#fff" strokeWidth={2} />
            <path d="M-14,0H-5M5,0H14M0,-14V-5M0,5V14" stroke="#fff" strokeWidth={2} />
          </g>
        )
      })}
    </svg>
  )
}
