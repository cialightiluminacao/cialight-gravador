import { memo } from 'react'
import { useEditorStore } from '../../state/editorStore'
import { usToPx } from '../../state/zoom'

// Playhead: linha vertical sobre a régua e as faixas, com a cabeça na régua. Assina só o que
// precisa (playhead/zoom/scroll): durante a reprodução só este componente re-renderiza a 60 Hz.

export const Playhead = memo(function Playhead({ viewW }: { viewW: number }): React.JSX.Element | null {
  const playheadUs = useEditorStore((s) => s.playheadUs)
  const pps = useEditorStore((s) => s.zoomPxPerSec)
  const scrollUs = useEditorStore((s) => s.scrollUs)
  const x = usToPx(playheadUs, pps, scrollUs)
  if (x < -8 || x > viewW + 8) return null
  return (
    <div data-playhead="" className="pointer-events-none absolute inset-y-0 z-20 w-0" style={{ transform: `translateX(${Math.round(x)}px)` }}>
      <span className="absolute inset-y-0 -left-px w-[2px] bg-accent shadow-[0_0_6px_rgba(255,77,79,0.6)]" />
      <span className="absolute -left-[6px] top-0 h-[14px] w-[12px] rounded-b-[3px] bg-accent [clip-path:polygon(0_0,100%_0,100%_60%,50%_100%,0_60%)]" />
    </div>
  )
})
