import type { MediaItem, Project, Us } from '@shared/editor/project'
import { toScreen } from '@shared/editor/contentPose'
import { findItem } from '@shared/editor/ops'
import { clipFrameAt } from '@shared/editor/resolve'
import { useSensitiveScan } from '../../state/sensitiveScan'

// Contorno da ocorrência em foco na revisão do "Procurar dados sensíveis" (G3): a caixa (fonte, 0–1) levada ao quadro
// pela mesma geometria do resolve (clipFrameAt + toScreen: transformação, corte, giro, espelho). Só com o playhead no
// instante da linha (parado).

export function SensitiveOutline({ project, playheadUs, k }: { project: Project; playheadUs: Us; k: number }): React.JSX.Element | null {
  const hover = useSensitiveScan((s) => s.hover)
  if (!hover || hover.tUs !== playheadUs) return null
  const m = findItem(project, hover.itemId)?.item
  if (m?.type !== 'media') return null
  const cf = clipFrameAt(project, m as MediaItem, playheadUs)
  if (!cf) return null
  const b = hover.box
  const pts = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h]
  ].map(([x, y]) => toScreen(cf, x * cf.g.dw, y * cf.g.dh))
  const points = pts.map((p) => `${(p.x * k).toFixed(1)},${(p.y * k).toFixed(1)}`).join(' ')
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-sensitive-outline={hover.itemId} aria-hidden>
      <polygon points={points} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={4} />
      <polygon points={points} fill="rgba(255,77,79,0.12)" stroke="#ff4d4f" strokeWidth={2} />
    </svg>
  )
}
