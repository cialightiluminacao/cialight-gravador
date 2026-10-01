import { cn } from '@/lib/cn'

// Fades do item: rampa diagonal escurecendo o trecho de entrada/saída e alças arrastáveis nos cantos
// superiores (data-fade, tratadas pelo useTimelineDrag). Coordenadas locais à caixa visível do item:
// o início real do item fica em -clipFrom.

export const FADE_HANDLE = 10

interface Props {
  fadeInUs: number
  fadeOutUs: number
  pxPerSec: number
  /** Largura total do item (px) e recorte visível. */
  w: number
  clipFrom: number
  visW: number
  h: number
  /** Alças visíveis/arrastáveis (faixa desbloqueada e item largo o bastante). */
  editable: boolean
  selected: boolean
}

const sec = (us: number): string => `${(us / 1e6).toFixed(2).replace('.', ',')} s`

export function FadeHandles({ fadeInUs, fadeOutUs, pxPerSec, w, clipFrom, visW, h, editable, selected }: Props): React.JSX.Element | null {
  const fin = (fadeInUs * pxPerSec) / 1e6
  const fout = (fadeOutUs * pxPerSec) / 1e6
  const x0 = -clipFrom // início do item
  const x1 = w - clipFrom // fim do item
  const handle = (side: 'in' | 'out'): React.JSX.Element | null => {
    const fade = side === 'in' ? fin : fout
    const left = side === 'in' ? Math.min(x0 + Math.max(0, fade - FADE_HANDLE / 2), x1 - FADE_HANDLE) : Math.max(x1 - Math.max(FADE_HANDLE, fade + FADE_HANDLE / 2), x0)
    if (left + FADE_HANDLE < 0 || left > visW) return null
    const label = side === 'in' ? 'Fade de entrada' : 'Fade de saída'
    return (
      <span
        data-fade={side}
        title={`${label}: ${sec(side === 'in' ? fadeInUs : fadeOutUs)} — arraste para ajustar`}
        aria-label={label}
        className={cn(
          'absolute top-0 z-[3] block cursor-ew-resize rounded-b-[3px] border border-black/40 bg-white shadow transition-opacity',
          fade > 0 || selected ? 'opacity-90' : 'opacity-0 group-hover:opacity-80'
        )}
        style={{ left, width: FADE_HANDLE, height: FADE_HANDLE }}
      />
    )
  }
  if (!editable && fin <= 0 && fout <= 0) return null
  return (
    <>
      {fin > 0 || fout > 0 ? (
        <svg className="pointer-events-none absolute inset-0 z-[1]" width={visW} height={h} aria-hidden>
          {fin > 0 ? (
            <>
              <polygon points={`${x0},0 ${x0 + fin},0 ${x0},${h}`} fill="rgba(0,0,0,0.55)" />
              <line x1={x0} y1={h} x2={x0 + fin} y2={0} stroke="rgba(255,255,255,0.85)" strokeWidth={1.5} />
            </>
          ) : null}
          {fout > 0 ? (
            <>
              <polygon points={`${x1 - fout},0 ${x1},0 ${x1},${h}`} fill="rgba(0,0,0,0.55)" />
              <line x1={x1 - fout} y1={0} x2={x1} y2={h} stroke="rgba(255,255,255,0.85)" strokeWidth={1.5} />
            </>
          ) : null}
        </svg>
      ) : null}
      {editable ? handle('in') : null}
      {editable ? handle('out') : null}
    </>
  )
}
