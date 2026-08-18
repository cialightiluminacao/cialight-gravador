import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, CameraOff, Eraser, Mic, MicOff, MonitorUp, Pause, PenLine, PictureInPicture2, Play, Square, X } from 'lucide-react'
import { useAppStore } from '@/app/store'
import { engine, cancelRecording, clearAnnotations, cyclePip, pauseRecording, resumeRecording, setPip, stopRecording, toggleAnnotate, toggleCamera, toggleMic } from '@/app/recordingController'
import { Button } from '@/components/ui/Button'
import { Badge, Dialog, DialogContent, Kbd, RecDot, Section, Tip, VuMeter } from '@/components/ui/primitives'
import { formatClock, formatMB } from '@/lib/format'
import { estimateLiveMB } from '@shared/presets/sizeEstimate'
import { drawStrokes } from '@shared/compositor'
import { PipOverlay } from '@/screens/Prepare/PipOverlay'
import { cn } from '@/lib/cn'

// Tela "Gravando": preview ao vivo da composição (tela + PiP + traços), cronômetro,
// estimativa de tamanho, VUs e controles. A barra flutuante no monitor gravado
// espelha os controles principais.

function LivePreview(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pipDraft = useAppStore((s) => s.pipDraft)
  const settings = useAppStore((s) => s.settings)
  const phase = useAppStore((s) => s.phase)
  const prepared = engine.prepared
  const [pip, setLocalPip] = useState(() => engine.currentPip ?? pipDraft)

  useEffect(() => {
    if (videoRef.current && prepared?.screen) videoRef.current.srcObject = prepared.screen
  }, [prepared?.screen])

  // espelha os traços visíveis (mesmo drawStrokes da exportação) a ~30 fps
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    let last = 0
    const loop = (t: number): void => {
      raf = requestAnimationFrame(loop)
      if (t - last < 33) return
      last = t
      const rect = canvas.getBoundingClientRect()
      const W = Math.round(rect.width * (window.devicePixelRatio || 1))
      const H = Math.round(rect.height * (window.devicePixelRatio || 1))
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, W, H)
      const s = engine.session
      if (!s) return
      const fade = settings.annotations.autoFadeSec
      drawStrokes(ctx, W, H, { strokes: s.strokes, clearEvents: s.clearEvents }, engine.mediaTimeMs(), fade ? fade * 1000 : null)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [settings.annotations.autoFadeSec])

  const camOn = useAppStore((s) => s.live.camOn)
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border-strong bg-black shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
      <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-contain" />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {prepared?.cam && camOn ? (
        <PipOverlay
          pip={{ ...pip, visible: true }}
          camStream={prepared.cam}
          mirrored={settings.pip.mirrored}
          onToggleMirror={() => void window.api.settings.set({ pip: { ...settings.pip, mirrored: !settings.pip.mirrored } })}
          onChange={(k) => {
            setLocalPip({ ...k, tMs: 0 })
            setPip(k)
          }}
          interactive={phase === 'recording' || phase === 'paused' || phase === 'countdown'}
        />
      ) : null}
      {phase === 'countdown' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
          <div className="rounded-full border border-white/15 bg-black/60 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-white/90">Preparando… a contagem aparece no monitor gravado</div>
        </div>
      ) : null}
      {phase === 'stopping' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="rounded-full border border-white/15 bg-black/60 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-white/90">Finalizando arquivo…</div>
        </div>
      ) : null}
    </div>
  )
}

export function RecordingScreen(): React.JSX.Element {
  const phase = useAppStore((s) => s.phase)
  const live = useAppStore((s) => s.live)
  const settings = useAppStore((s) => s.settings)
  const warnings = useAppStore((s) => s.warnings)
  const selected = useAppStore((s) => s.selectedSource)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const paused = phase === 'paused'
  const recording = phase === 'recording'
  const est = estimateLiveMB(live.bytes, Math.max(1, live.elapsedMs))
  const hk = settings.hotkeys
  const prepared = engine.prepared
  const isWindow = selected?.kind === 'window'

  return (
    <div className="flex h-full min-h-0 gap-5 p-5">
      {/* palco */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="rise-in flex items-center gap-3">
          <RecDot active={recording} paused={paused} className="h-3 w-3" />
          <span className={cn('font-mono tnum text-3xl font-semibold tracking-tight', paused ? 'text-warn' : 'text-fg')}>{formatClock(live.elapsedMs)}</span>
          <Badge tone={paused ? 'warn' : recording ? 'accent' : 'neutral'}>{phase === 'countdown' ? 'contagem' : paused ? 'pausado' : phase === 'stopping' ? 'finalizando' : 'gravando'}</Badge>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted">
            <span className="font-mono tnum">{formatMB(est.mbSoFar)}</span>
            <span>·</span>
            <span className="font-mono tnum">{Math.round(est.kbps / 1000)} Mbps</span>
            <span>·</span>
            <span className="truncate max-w-[280px]" title={selected?.name}>{selected?.name}</span>
          </span>
        </div>
        <div className="rise-in rise-in-1 min-h-0 flex-1">
          <div className="mx-auto h-full max-h-full" style={{ maxWidth: 'calc((100vh - 260px) * 16 / 9)' }}>
            <LivePreview />
          </div>
        </div>
        <div className="rise-in rise-in-2 flex items-center justify-center gap-2">
          <Tip content={paused ? 'Retomar' : 'Pausar'} shortcut={hk.pauseResume}>
            <Button size="lg" variant="secondary" onClick={() => (paused ? resumeRecording() : pauseRecording())} disabled={!(recording || paused)}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} {paused ? 'Retomar' : 'Pausar'}
            </Button>
          </Tip>
          <Tip content="Parar e ir para a revisão" shortcut={hk.toggleRecord}>
            <Button size="lg" variant="primary" className={recording ? 'rec-pulse' : ''} onClick={() => void stopRecording()} disabled={phase === 'stopping'}>
              <Square className="h-4 w-4 fill-current" /> Parar
            </Button>
          </Tip>
          <span className="mx-1 h-6 w-px bg-border-strong" />
          <Tip content={live.micMuted ? 'Ativar microfone' : 'Silenciar microfone'} shortcut={hk.muteMic}>
            <Button size="lg" variant={live.micMuted ? 'danger' : 'ghost'} onClick={toggleMic} disabled={!prepared?.mic} aria-label="Microfone">
              {live.micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          </Tip>
          <Tip content={live.camOn ? 'Desligar câmera' : 'Ligar câmera'} shortcut={hk.toggleCamera}>
            <Button size="lg" variant={!live.camOn ? 'danger' : 'ghost'} onClick={toggleCamera} disabled={!prepared?.cam} aria-label="Câmera">
              {live.camOn ? <Camera className="h-4 w-4" /> : <CameraOff className="h-4 w-4" />}
            </Button>
          </Tip>
          <Tip content="Ciclar posição/tamanho da webcam">
            <Button size="lg" variant="ghost" onClick={cyclePip} disabled={!prepared?.cam} aria-label="Posição da webcam">
              <PictureInPicture2 className="h-4 w-4" />
            </Button>
          </Tip>
          <span className="mx-1 h-6 w-px bg-border-strong" />
          <Tip content={isWindow ? 'Anotações estão disponíveis ao gravar um monitor' : live.annotating ? 'Sair do modo anotação' : 'Anotar na tela (caneta)'} shortcut={hk.annotate}>
            <Button size="lg" variant={live.annotating ? 'success' : 'ghost'} onClick={() => toggleAnnotate('pen')} disabled={isWindow || !(recording || paused)}>
              <PenLine className="h-4 w-4" /> Anotar
            </Button>
          </Tip>
          <Tip content="Apagar todas as anotações" shortcut={hk.clearAnnotations}>
            <Button size="lg" variant="ghost" onClick={clearAnnotations} disabled={isWindow} aria-label="Apagar anotações">
              <Eraser className="h-4 w-4" />
            </Button>
          </Tip>
          <span className="mx-1 h-6 w-px bg-border-strong" />
          <Tip content="Cancelar e descartar" shortcut={hk.cancel}>
            <Button size="lg" variant="ghost" className="text-muted hover:text-danger" onClick={() => setConfirmCancel(true)} aria-label="Cancelar">
              <X className="h-4 w-4" />
            </Button>
          </Tip>
        </div>
      </div>

      {/* painel lateral */}
      <aside className="flex w-[300px] shrink-0 flex-col gap-4">
        <Section title="Níveis de áudio" className="rise-in rise-in-1">
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-fg-2">
                  <Mic className="h-3.5 w-3.5" /> Microfone
                </span>
                <span className="text-muted">{!prepared?.mic ? 'desligado' : live.micMuted ? 'silenciado' : ''}</span>
              </div>
              <VuMeter level={prepared?.mic && !live.micMuted ? live.micLevel : 0} className="h-2.5" segments={24} />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-fg-2">
                  <MonitorUp className="h-3.5 w-3.5" /> Áudio do sistema
                </span>
                <span className="text-muted">{!prepared?.systemAudioTrack ? 'desligado' : ''}</span>
              </div>
              <VuMeter level={prepared?.systemAudioTrack ? live.systemLevel : 0} className="h-2.5" segments={24} />
            </div>
          </div>
        </Section>
        <Section title="Atalhos" className="rise-in rise-in-2">
          <ul className="space-y-1.5 text-xs text-fg-2">
            {[
              ['Parar', hk.toggleRecord],
              ['Pausar / retomar', hk.pauseResume],
              ['Anotar (caneta)', hk.annotate],
              ['Anotar (seta)', hk.arrow],
              ['Apagar anotações', hk.clearAnnotations],
              ['Silenciar microfone', hk.muteMic],
              ['Câmera', hk.toggleCamera],
              ['Barra flutuante', hk.toggleBar],
              ['Cancelar', hk.cancel]
            ].map(([label, acc]) => (
              <li key={label} className="flex items-center justify-between gap-2">
                <span>{label}</span>
                {acc ? <Kbd>{acc}</Kbd> : <span className="text-muted-2">—</span>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            No modo anotação: <b>Shift</b> reta, <b>Ctrl+Shift</b> seta, <b>R/G/B/Y/W</b> cores, <b>[ ]</b> espessura, <b>Ctrl+Z</b> desfaz, <b>E</b> apaga tudo, <b>Esc</b> sai.
          </p>
        </Section>
        <Section title="Dica" className="rise-in rise-in-3">
          <p className="text-xs leading-relaxed text-muted">
            A barra flutuante está no monitor gravado e <b>não aparece no vídeo</b>. Esta janela também fica fora da gravação — você pode deixá-la no outro monitor para acompanhar a webcam.
          </p>
        </Section>
        {warnings.length ? (
          <div className="rise-in rise-in-4 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" /> Avisos
            </div>
            <ul className="list-disc space-y-1 pl-4">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>

      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent
          title="Cancelar a gravação?"
          description="O que foi gravado até agora será descartado (vai para a Lixeira). Para manter, use Parar."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                Continuar gravando
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmCancel(false)
                  void cancelRecording()
                }}
              >
                Cancelar e descartar
              </Button>
            </>
          }
        />
      </Dialog>
    </div>
  )
}
