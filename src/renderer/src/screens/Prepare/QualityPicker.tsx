import type { CountdownSec, Fps, Quality } from '@shared/types'
import { Segmented, Tip } from '@/components/ui/primitives'

// Qualidade da gravação: resolução, taxa de quadros e contagem regressiva.

export interface QualityPickerProps {
  quality: Quality
  fps: Fps
  countdownSec: CountdownSec
  onQuality: (q: Quality) => void
  onFps: (f: Fps) => void
  onCountdown: (c: CountdownSec) => void
}

const QUALITY_OPTIONS: { value: Quality; label: string; title: string }[] = [
  { value: '720p', label: '720p', title: 'HD — arquivos menores, ideal para WhatsApp' },
  { value: '1080p', label: '1080p', title: 'Full HD — recomendado' },
  { value: '1440p', label: '1440p', title: '2K — mais nítido, arquivos maiores' },
  { value: 'native', label: 'Nativa', title: 'Resolução original da fonte' }
]

const FPS_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: '30', label: '30 fps', title: 'Padrão — suave e leve' },
  { value: '60', label: '60 fps', title: 'Movimento mais fluido (arquivo maior)' }
]

const COUNTDOWN_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: '0', label: 'Sem', title: 'Começa imediatamente' },
  { value: '3', label: '3 s', title: 'Contagem de 3 segundos' },
  { value: '5', label: '5 s', title: 'Contagem de 5 segundos' }
]

function Row({ label, tip, children }: { label: string; tip: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <Tip content={tip} side="top">
        <span className="w-[62px] shrink-0 cursor-default text-[11px] font-semibold text-muted">{label}</span>
      </Tip>
      {children}
    </div>
  )
}

export function QualityPicker({ quality, fps, countdownSec, onQuality, onFps, onCountdown }: QualityPickerProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Row label="Resolução" tip="Tamanho do vídeo gravado">
        <Segmented size="sm" value={quality} onValueChange={onQuality} options={QUALITY_OPTIONS} />
      </Row>
      <Row label="Quadros" tip="Quadros por segundo">
        <Segmented size="sm" value={String(fps)} onValueChange={(v) => onFps(Number(v) as Fps)} options={FPS_OPTIONS} />
      </Row>
      <Row label="Contagem" tip="Contagem regressiva antes de começar a gravar">
        <Segmented size="sm" value={String(countdownSec)} onValueChange={(v) => onCountdown(Number(v) as CountdownSec)} options={COUNTDOWN_OPTIONS} />
      </Row>
    </div>
  )
}
