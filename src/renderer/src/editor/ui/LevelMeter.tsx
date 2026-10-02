import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../state/editorStore'
import { METER_FLOOR_DB, METER_ZERO, meterStep, peakToFraction, type MeterState } from './meter'

// Medidor de nível (VU com pico): `read()` devolve o pico linear de cada barra (master: L/R; faixa: uma). Só anima
// enquanto o editor toca (requestAnimationFrame mexendo direto no estilo, sem render do React); parado, zera.
// Escala em dB (−60…0): verde até −12 dB, amarelo até −3 dB, vermelho acima; o traço é o pico segurado.

const GRADIENT_H = `linear-gradient(to right, var(--ok) 0%, var(--ok) ${pct(-12)}%, var(--warn) ${pct(-12)}%, var(--warn) ${pct(-3)}%, var(--danger) ${pct(-3)}%)`
const GRADIENT_V = GRADIENT_H.replace('to right', 'to top')

function pct(db: number): number {
  return Math.round(((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 1000) / 10
}

interface Props {
  read: () => readonly number[]
  bars: number
  vertical?: boolean
  className?: string
  label: string
}

export function LevelMeter({ read, bars, vertical, className, label }: Props): React.JSX.Element {
  const playing = useEditorStore((s) => s.playing)
  const covers = useRef<(HTMLSpanElement | null)[]>([])
  const ticks = useRef<(HTMLSpanElement | null)[]>([])
  const readRef = useRef(read)
  readRef.current = read

  useEffect(() => {
    const paint = (states: MeterState[]): void => {
      states.forEach((s, i) => {
        const c = covers.current[i]
        const t = ticks.current[i]
        // a capa escura cobre a parte apagada da barra; o traço marca o pico segurado
        if (c) c.style[vertical ? 'height' : 'width'] = `${(1 - s.level) * 100}%`
        if (t) {
          t.style[vertical ? 'bottom' : 'left'] = `calc(${s.peak * 100}% - 1px)`
          t.style.opacity = s.peak > 0.01 ? '1' : '0'
        }
      })
    }
    let states: MeterState[] = Array.from({ length: bars }, () => METER_ZERO)
    paint(states)
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (): void => {
      const now = performance.now()
      const v = readRef.current()
      states = states.map((s, i) => meterStep(s, peakToFraction(v[i] ?? 0), now, now - last))
      last = now
      paint(states)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      paint(Array.from({ length: bars }, () => METER_ZERO))
    }
  }, [playing, bars, vertical])

  return (
    <span role="meter" aria-label={label} aria-valuemin={METER_FLOOR_DB} aria-valuemax={0} className={cn('flex shrink-0 gap-[2px]', vertical ? 'flex-row' : 'flex-col', className)} data-level-meter="">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className="relative block flex-1 overflow-hidden rounded-[2px] bg-white/5" style={{ backgroundImage: vertical ? GRADIENT_V : GRADIENT_H }}>
          <span ref={(e) => void (covers.current[i] = e)} className={cn('absolute block bg-bg-2/90', vertical ? 'inset-x-0 top-0' : 'inset-y-0 right-0')} style={vertical ? { height: '100%' } : { width: '100%' }} />
          <span ref={(e) => void (ticks.current[i] = e)} className={cn('absolute block bg-white/90 opacity-0', vertical ? 'inset-x-0 h-[2px]' : 'inset-y-0 w-[2px]')} />
        </span>
      ))}
    </span>
  )
}
