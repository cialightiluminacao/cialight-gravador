import { useEffect, useRef } from 'react'
import { AlertTriangle, Camera, CameraOff, Circle, Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import type { CountdownSec, Fps, MicMode, Quality } from '@shared/types'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Badge, Kbd, Segmented, Select, Tip, Toggle, VuMeter } from '@/components/ui/primitives'
import { QualityPicker } from './QualityPicker'

// Rodapé do Preparar: câmera · microfone · áudio do sistema · qualidade · Gravar.

export interface DevicePanelProps {
  cameras: MediaDeviceInfo[]
  mics: MediaDeviceInfo[]
  devicesReady: boolean
  cameraId: string | null
  cameraOn: boolean
  micId: string | null
  micOn: boolean
  micMode: MicMode
  systemAudioOn: boolean
  camStream: MediaStream | null
  camError: string | null
  mirrored: boolean
  micLevel: number
  micError: string | null
  quality: Quality
  fps: Fps
  countdownSec: CountdownSec
  hotkey: string | null
  hotkeyProblem: string | null
  canRecord: boolean
  busy: boolean
  onCameraId: (id: string) => void
  onCameraOn: (on: boolean) => void
  onMicId: (id: string) => void
  onMicOn: (on: boolean) => void
  onMicMode: (m: MicMode) => void
  onSystemAudioOn: (on: boolean) => void
  onQuality: (q: Quality) => void
  onFps: (f: Fps) => void
  onCountdown: (c: CountdownSec) => void
  onRecord: () => void
}

function deviceOptions(list: MediaDeviceInfo[], fallback: string): { value: string; label: string }[] {
  return list.map((d, i) => ({ value: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))
}

function GroupHeader({ icon, label, right }: { icon: React.ReactNode; label: string; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-6 items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">
        {icon}
        {label}
      </span>
      {right}
    </div>
  )
}

function CameraBubble({ stream, on, error, mirrored }: { stream: MediaStream | null; on: boolean; error: string | null; mirrored: boolean }): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream
    if (stream) void v.play().catch(() => {})
  }, [stream])
  const off = !on || !stream
  return (
    <div
      className={cn('relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-full bg-surface-3 ring-2', on && stream ? 'ring-ok/70' : error ? 'ring-warn/60' : 'ring-border-strong')}
      title={error ?? undefined}
    >
      <video ref={ref} autoPlay muted playsInline className={cn('h-full w-full object-cover', off && 'hidden')} style={{ transform: mirrored ? 'scaleX(-1)' : undefined }} />
      {off ? (
        <div className="flex h-full w-full items-center justify-center text-muted">
          {error ? <AlertTriangle className="h-4 w-4 text-warn" /> : on ? <Camera className="h-4 w-4 animate-pulse" /> : <CameraOff className="h-4 w-4" />}
        </div>
      ) : null}
    </div>
  )
}

const MIC_MODE_OPTIONS: { value: MicMode; label: string; title: string }[] = [
  { value: 'headset', label: 'Headset', title: 'Fone com microfone: sem cancelamento de eco (som mais natural)' },
  { value: 'speakers', label: 'Caixas de som', title: 'Alto-falantes: ativa cancelamento de eco' }
]

export function DevicePanel(p: DevicePanelProps): React.JSX.Element {
  const noCam = p.devicesReady && p.cameras.length === 0
  const noMic = p.devicesReady && p.mics.length === 0
  const camValue = p.cameras.some((c) => c.deviceId === p.cameraId) ? p.cameraId : (p.cameras[0]?.deviceId ?? null)
  const micValue = p.mics.some((m) => m.deviceId === p.micId) ? p.micId : (p.mics[0]?.deviceId ?? null)
  const camIcon = p.cameraOn ? <Camera className="h-3.5 w-3.5" /> : <CameraOff className="h-3.5 w-3.5" />
  const micIcon = p.micOn ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />
  const sysIcon = p.systemAudioOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />

  return (
    <footer className="card @container flex flex-wrap items-stretch gap-x-2.5 gap-y-3 px-4 py-3">
      {/* Câmera */}
      <div className="flex w-[204px] shrink-0 flex-col gap-2">
        <GroupHeader icon={camIcon} label="Câmera" right={<Toggle size="sm" checked={p.cameraOn && !noCam} onCheckedChange={p.onCameraOn} disabled={noCam} aria-label="Ligar câmera" />} />
        <div className="flex items-center gap-2.5">
          <CameraBubble stream={p.camStream} on={p.cameraOn && !noCam} error={p.camError} mirrored={p.mirrored} />
          <div className="min-w-0 flex-1">
            <Select
              value={camValue}
              onValueChange={p.onCameraId}
              options={deviceOptions(p.cameras, 'Câmera')}
              placeholder={noCam ? 'Nenhuma câmera encontrada' : 'Detectando…'}
              disabled={noCam || !p.devicesReady}
              triggerClassName="h-9 text-xs"
            />
            <div className={cn('mt-1 truncate text-[10.5px] leading-tight', p.camError ? 'text-warn' : 'text-muted-2')}>
              {p.camError ?? (noCam ? 'Conecte uma câmera e atualize.' : p.cameraOn ? 'Entra como PiP na gravação.' : 'Desligada nesta gravação.')}
            </div>
          </div>
        </div>
      </div>

      <div className="w-px shrink-0 self-stretch bg-border @max-[1060px]:hidden" />

      {/* Microfone */}
      <div className="flex min-w-[236px] flex-1 flex-col gap-2">
        <GroupHeader icon={micIcon} label="Microfone" right={<Toggle size="sm" checked={p.micOn && !noMic} onCheckedChange={p.onMicOn} disabled={noMic} aria-label="Ligar microfone" />} />
        <Select
          value={micValue}
          onValueChange={p.onMicId}
          options={deviceOptions(p.mics, 'Microfone')}
          placeholder={noMic ? 'Nenhum microfone encontrado' : 'Detectando…'}
          disabled={noMic || !p.devicesReady}
          triggerClassName="h-9 text-xs"
        />
        <div className="flex h-6 items-center rounded-lg border border-border bg-bg-2 px-2" title={p.micError ?? 'Nível do microfone'}>
          {p.micError ? (
            <span className="truncate text-[10.5px] text-warn">{p.micError}</span>
          ) : (
            <VuMeter level={p.micOn && !noMic ? p.micLevel : 0} className="h-2 w-full [&>span]:flex-1" segments={24} />
          )}
        </div>
        <Segmented size="sm" value={p.micMode} onValueChange={p.onMicMode} options={MIC_MODE_OPTIONS} className="grid grid-cols-2" />
      </div>

      <div className="w-px shrink-0 self-stretch bg-border @max-[1060px]:hidden" />

      {/* Áudio do sistema */}
      <div className="flex w-[118px] shrink-0 flex-col gap-2">
        <GroupHeader icon={sysIcon} label="Sistema" right={<Toggle size="sm" checked={p.systemAudioOn} onCheckedChange={p.onSystemAudioOn} aria-label="Gravar áudio do sistema" />} />
        <div className="text-[11px] leading-snug text-fg-2">Áudio do computador</div>
        <div className="text-[10.5px] leading-snug text-muted-2">{p.systemAudioOn ? 'Sons que tocam no PC entram na gravação.' : 'Só o microfone será gravado.'}</div>
      </div>

      <div className="w-px shrink-0 self-stretch bg-border @max-[1060px]:hidden" />

      {/* Qualidade */}
      <div className="flex shrink-0 flex-col gap-2">
        <GroupHeader icon={<Circle className="h-3 w-3" />} label="Qualidade" />
        <QualityPicker quality={p.quality} fps={p.fps} countdownSec={p.countdownSec} onQuality={p.onQuality} onFps={p.onFps} onCountdown={p.onCountdown} />
      </div>

      <div className="w-px shrink-0 self-stretch bg-border @max-[1060px]:hidden" />

      {/* Gravar */}
      <div className="flex w-[164px] shrink-0 flex-col items-stretch justify-center gap-2">
        <Button variant="primary" size="xl" className={cn('w-full gap-3 px-4', !p.busy && p.canRecord && 'rec-pulse')} onClick={p.onRecord} disabled={p.busy} aria-label="Iniciar gravação">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-2 ring-white/80">
            <span className="h-2.5 w-2.5 rounded-full bg-white" />
          </span>
          Gravar
        </Button>
        {p.hotkeyProblem ? (
          <Tip content={p.hotkeyProblem} side="top">
            <span className="flex justify-center">
              <Badge tone="warn" className="cursor-help normal-case tracking-normal">
                <AlertTriangle className="h-3 w-3" />
                Atalho não registrado
              </Badge>
            </span>
          </Tip>
        ) : (
          <div className="flex flex-col items-center gap-1 text-[10.5px] text-muted-2">
            {p.hotkey ? <Kbd>{p.hotkey}</Kbd> : null}
            <span className="truncate">{!p.canRecord ? 'Escolha uma fonte para gravar' : p.countdownSec > 0 ? `Começa após ${p.countdownSec} s de contagem` : 'Começa imediatamente'}</span>
          </div>
        )}
      </div>
    </footer>
  )
}
