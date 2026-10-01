import { memo, useEffect, useRef } from 'react'
import type { Us } from '@shared/editor/project'
import { useEditorStore } from '../../state/editorStore'
import { maxScrollUs } from '../../state/zoom'

// Barra de rolagem horizontal da linha do tempo (a rolagem é virtual: scrollUs no store).
// Arrastar o polegar rola; clicar no trilho avança uma página.

export const HScrollbar = memo(function HScrollbar({ viewW, durationUs }: { viewW: number; durationUs: Us }): React.JSX.Element {
  const pps = useEditorStore((s) => s.zoomPxPerSec)
  const scrollUs = useEditorStore((s) => s.scrollUs)
  const spanUs = (viewW * 1e6) / pps
  const maxUs = Math.max(maxScrollUs(durationUs, viewW, pps), scrollUs)
  const totalUs = maxUs + spanUs
  const thumbFrac = totalUs > 0 ? Math.min(1, spanUs / totalUs) : 1
  const posFrac = maxUs > 0 ? scrollUs / maxUs : 0
  const thumbW = Math.max(28, thumbFrac * viewW)
  const thumbX = posFrac * Math.max(0, viewW - thumbW)
  const setScroll = useEditorStore((s) => s.setScroll)
  // arraste do polegar em curso: listeners da janela saem também ao desmontar
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const onTrack = (e: React.PointerEvent): void => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    const r = e.currentTarget.getBoundingClientRect()
    setScroll(Math.min(maxUs, Math.max(0, scrollUs + (e.clientX - r.left < thumbX ? -spanUs : spanUs) * 0.9)))
  }
  const onThumb = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const s0 = scrollUs
    const free = Math.max(1, viewW - thumbW)
    const move = (ev: PointerEvent): void => setScroll(Math.min(maxUs, Math.max(0, s0 + ((ev.clientX - x0) / free) * maxUs)))
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

  return (
    <div className="relative h-2.5 shrink-0" style={{ width: viewW }} onPointerDown={onTrack} aria-hidden>
      {thumbFrac < 1 ? <span className="absolute top-0.5 h-1.5 rounded-full bg-white/15 hover:bg-white/30" style={{ left: thumbX, width: thumbW }} onPointerDown={onThumb} /> : null}
    </div>
  )
})
