import { memo, useEffect, useRef } from 'react'
import type { MediaItem } from '@shared/editor/project'
import { waveColumns, waveGains } from './itemMedia'

// Forma de onda do item num <canvas> do tamanho só da parte visível (clipFromPx..clipToPx, px
// relativos ao início do item). A altura reflete o volume (faixa × item, com keyframes; áudio desligado fica
// apagado). Redesenha quando o item, o volume, o zoom ou o recorte mudam.

interface Props {
  peaks: Int8Array
  item: MediaItem
  pxPerSec: number
  clipFromPx: number
  clipToPx: number
  height: number
  color: string
  /** Volume da faixa (multiplica o do item). */
  trackVolume: number
}

export const Waveform = memo(function Waveform({ peaks, item, pxPerSec, clipFromPx, clipToPx, height, color, trackVolume }: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const w = Math.max(1, Math.round(clipToPx - clipFromPx))
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(w * dpr)
    c.height = Math.round(height * dpr)
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, height)
    const cols = waveColumns(peaks, item, pxPerSec, clipFromPx, clipFromPx + w)
    const gains = waveGains(item, trackVolume, pxPerSec, clipFromPx, w)
    const mid = height / 2
    g.fillStyle = color
    for (let x = 0; x < w; x++) {
      const scale = (height / 2 / 127) * Math.min(4, Math.max(0, gains[x]))
      const top = Math.max(0, mid - cols[x * 2 + 1] * scale)
      const bottom = Math.min(height, mid - cols[x * 2] * scale)
      g.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
    // o item muda de referência ao ser movido; só o que afeta a forma de onda redesenha
  }, [peaks, item.inUs, item.speed, item.reverse, item.durationUs, item.audio.enabled, item.audio.volume, pxPerSec, clipFromPx, w, height, color, trackVolume])
  return <canvas ref={ref} className="pointer-events-none absolute left-0 block" style={{ width: w, height, bottom: 0 }} />
})
