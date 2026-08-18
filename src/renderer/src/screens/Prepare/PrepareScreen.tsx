import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { CaptureSource, CountdownSec, Fps, MicMode, PipKeyframe, Quality, Settings } from '@shared/types'
import { buildRecordingConfig, useAppStore } from '@/app/store'
import { startRecording } from '@/app/recordingController'
import { refreshSources, useSources } from '@/hooks/useSources'
import { useCameraPreview, useMicPreview } from '@/hooks/useMediaPreview'
import { usePageVisible } from '@/hooks/usePageVisible'
import { useVu } from '@/hooks/useVu'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { SourcePicker } from './SourcePicker'
import { PreviewStage } from './PreviewStage'
import { DevicePanel } from './DevicePanel'

// Tela Preparar (spec §4.1/§8): fonte à esquerda, palco com PiP no centro,
// dispositivos + qualidade + Gravar no rodapé. Toda escolha vai para settings.

type PrivacyKind = 'camera' | 'microphone'

const PRIVACY_URL: Record<PrivacyKind, string> = {
  camera: 'ms-settings:privacy-webcam',
  microphone: 'ms-settings:privacy-microphone'
}

const PIP_SAVE_DEBOUNCE_MS = 400
const PERMISSION_DENIED = 'NotAllowedError'

type PipGeom = Omit<PipKeyframe, 'tMs'>
type SettingsKey = keyof Settings

function reportSaveError(e: Error): void {
  toast.error(`Não foi possível salvar a configuração: ${e.message}`)
}

/**
 * Aplica um patch de settings de forma otimista no store e persiste no main.
 * Enquanto houver patches em voo, o `settings:changed` de um patch anterior não
 * reverte os seguintes (as chaves pendentes são reaplicadas sobre o que chegar).
 * Antes de settings carregarem, só persiste (o store recebe o resultado do main).
 */
function usePatchSettings(): (patch: Partial<Settings>) => void {
  const pendingRef = useRef<Partial<Settings>>({})
  const inflightRef = useRef(new Map<SettingsKey, number>())

  useEffect(
    () =>
      useAppStore.subscribe((s, prev) => {
        if (s.settings === prev.settings) return
        const pending = pendingRef.current
        const keys = Object.keys(pending) as SettingsKey[]
        if (keys.length === 0) return
        if (keys.every((k) => Object.is(s.settings[k], pending[k]))) return
        s.setSettings({ ...s.settings, ...pending })
      }),
    []
  )

  return useCallback((patch: Partial<Settings>) => {
    const st = useAppStore.getState()
    if (!st.settingsLoaded) {
      void window.api.settings.set(patch).catch(reportSaveError)
      return
    }
    const keys = Object.keys(patch) as SettingsKey[]
    const inflight = inflightRef.current
    Object.assign(pendingRef.current, patch)
    for (const k of keys) inflight.set(k, (inflight.get(k) ?? 0) + 1)
    st.setSettings({ ...st.settings, ...patch })
    void window.api.settings
      .set(patch)
      .catch(reportSaveError)
      .finally(() => {
        for (const k of keys) {
          const n = (inflight.get(k) ?? 1) - 1
          if (n > 0) inflight.set(k, n)
          else {
            inflight.delete(k)
            delete pendingRef.current[k]
          }
        }
      })
  }, [])
}

export function PrepareScreen(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const settingsLoaded = useAppStore((s) => s.settingsLoaded)
  const sources = useAppStore((s) => s.sources)
  const sourcesLoading = useAppStore((s) => s.sourcesLoading)
  const selectedSource = useAppStore((s) => s.selectedSource)
  const setSelectedSource = useAppStore((s) => s.setSelectedSource)
  const devices = useAppStore((s) => s.devices)
  const pipDraft = useAppStore((s) => s.pipDraft)
  const setPipDraft = useAppStore((s) => s.setPipDraft)
  const phase = useAppStore((s) => s.phase)
  const hotkeyStatus = useAppStore((s) => s.hotkeyStatus)
  const patch = usePatchSettings()

  // lista de fontes só enquanto a janela está visível (minimizada/oculta: pausa)
  const pageVisible = usePageVisible()
  useSources(pageVisible)

  // restaura a última fonte usada quando settings chegam depois da primeira listagem
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || !settingsLoaded || !sources) return
    restoredRef.current = true
    const last = settings.lastSource
    if (!last) return
    const all = [...sources.screens, ...sources.windows]
    const found = all.find((s) => s.id === last.id) ?? (last.kind === 'window' ? sources.windows.find((w) => w.name === last.name) : undefined)
    if (found && found.id !== useAppStore.getState().selectedSource?.id) setSelectedSource(found)
  }, [settingsLoaded, sources, settings.lastSource, setSelectedSource])

  // enquanto o gravador abre os streams, soltamos os previews (mesma câmera/mic)
  const [starting, setStarting] = useState(false)
  const busy = starting || (phase !== 'idle' && phase !== 'review')

  // dispositivos efetivos (mesma regra do buildRecordingConfig: escolhido ou o primeiro)
  const noCam = devices.ready && devices.cameras.length === 0
  const noMic = devices.ready && devices.mics.length === 0
  const camId = devices.cameras.find((c) => c.deviceId === settings.devices.cameraId)?.deviceId ?? devices.cameras[0]?.deviceId ?? null
  const micId = devices.mics.find((m) => m.deviceId === settings.devices.micId)?.deviceId ?? devices.mics[0]?.deviceId ?? null
  const cameraOn = settings.devices.cameraOn && !noCam
  const micOn = settings.devices.micOn && !noMic

  const { stream: camStream, error: camError, errorName: camErrorName } = useCameraPreview(camId, cameraOn && !busy)
  const { stream: micStream, error: micError, errorName: micErrorName } = useMicPreview(micId, micOn && !busy, settings.devices.micMode === 'speakers')
  const micLevel = useVu(micStream, micOn && !busy)

  // permissão negada (NotAllowedError) → diálogo com atalho para as configurações de privacidade
  const [privacy, setPrivacy] = useState<PrivacyKind | null>(null)
  const askedRef = useRef<Record<PrivacyKind, boolean>>({ camera: false, microphone: false })
  useEffect(() => {
    if (camErrorName === PERMISSION_DENIED && !askedRef.current.camera) {
      askedRef.current.camera = true
      setPrivacy('camera')
    }
  }, [camErrorName])
  useEffect(() => {
    if (micErrorName === PERMISSION_DENIED && !askedRef.current.microphone) {
      askedRef.current.microphone = true
      setPrivacy((cur) => cur ?? 'microphone')
    }
  }, [micErrorName])

  const display = useMemo(() => (selectedSource?.displayId ? sources?.displays.find((d) => d.id === selectedSource.displayId) : undefined), [sources, selectedSource])

  const selectSource = useCallback(
    (s: CaptureSource) => {
      setSelectedSource(s)
      patch({ lastSource: { kind: s.kind, id: s.id, name: s.name } })
    },
    [setSelectedSource, patch]
  )

  // PiP: store imediato; settings com debounce (arrasto emite a ~16 Hz).
  // Ao sair da tela (ex.: Gravar logo após arrastar) o último valor é gravado na hora.
  const pipSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pipPendingRef = useRef<PipGeom | null>(null)
  const flushPip = useCallback(() => {
    if (pipSaveTimer.current) clearTimeout(pipSaveTimer.current)
    pipSaveTimer.current = null
    const k = pipPendingRef.current
    if (!k) return
    pipPendingRef.current = null
    const cur = useAppStore.getState().settings.pip
    patch({ pip: { ...cur, x: k.x, y: k.y, w: k.w, h: k.h, shape: k.shape } })
  }, [patch])
  const onPipChange = useCallback(
    (k: PipGeom) => {
      setPipDraft({ ...k, tMs: 0 })
      pipPendingRef.current = k
      if (pipSaveTimer.current) clearTimeout(pipSaveTimer.current)
      pipSaveTimer.current = setTimeout(flushPip, PIP_SAVE_DEBOUNCE_MS)
    },
    [setPipDraft, flushPip]
  )
  useEffect(() => flushPip, [flushPip])
  const toggleMirror = useCallback(() => {
    const cur = useAppStore.getState().settings.pip
    patch({ pip: { ...cur, mirrored: !cur.mirrored } })
  }, [patch])

  const setDevices = useCallback((d: Partial<Settings['devices']>) => patch({ devices: { ...useAppStore.getState().settings.devices, ...d } }), [patch])

  const toggleHotkey = hotkeyStatus.find((h) => h.action === 'toggleRecord')
  const hotkeyProblem = toggleHotkey && toggleHotkey.accelerator && !toggleHotkey.registered ? (toggleHotkey.problems[0] ?? 'O atalho global não pôde ser registrado (outro programa deve estar usando). Altere-o em Configurações › Atalhos.') : null

  const canRecord = !!selectedSource

  const onRecord = useCallback(async () => {
    const cfg = buildRecordingConfig(useAppStore.getState())
    if (!cfg) {
      toast.error('Escolha um monitor ou uma janela para gravar.')
      return
    }
    setStarting(true)
    // dá um quadro para os previews fecharem a câmera/microfone antes do engine abri-los
    await new Promise((r) => setTimeout(r, 60))
    try {
      await startRecording(cfg)
    } finally {
      setStarting(false)
    }
  }, [])

  const pipForStage = useMemo<PipKeyframe>(() => ({ ...pipDraft, visible: true }), [pipDraft])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-3">
        <div className="rise-in flex min-h-0 flex-col">
          <SourcePicker sources={sources} loading={sourcesLoading} selected={selectedSource} onSelect={selectSource} onRefresh={refreshSources} />
        </div>
        <div className="rise-in rise-in-1 flex min-h-0 flex-col">
          <PreviewStage
            source={selectedSource}
            display={display}
            quality={settings.quality}
            fps={settings.fps}
            cameraOn={cameraOn}
            camStream={camStream}
            pip={pipForStage}
            onPipChange={onPipChange}
            mirrored={settings.pip.mirrored}
            onToggleMirror={toggleMirror}
            active={!busy}
          />
        </div>
      </div>
      <div className="rise-in rise-in-2 shrink-0">
        <DevicePanel
          cameras={devices.cameras}
          mics={devices.mics}
          devicesReady={devices.ready}
          cameraId={camId}
          cameraOn={settings.devices.cameraOn}
          micId={micId}
          micOn={settings.devices.micOn}
          micMode={settings.devices.micMode}
          systemAudioOn={settings.devices.systemAudioOn}
          camStream={camStream}
          camError={camError}
          mirrored={settings.pip.mirrored}
          micLevel={micLevel}
          micError={micError}
          quality={settings.quality}
          fps={settings.fps}
          countdownSec={settings.countdownSec}
          hotkey={settings.hotkeys.toggleRecord}
          hotkeyProblem={hotkeyProblem}
          canRecord={canRecord}
          busy={busy}
          onCameraId={(id) => setDevices({ cameraId: id })}
          onCameraOn={(on) => setDevices({ cameraOn: on })}
          onMicId={(id) => setDevices({ micId: id })}
          onMicOn={(on) => setDevices({ micOn: on })}
          onMicMode={(m: MicMode) => setDevices({ micMode: m })}
          onSystemAudioOn={(on) => setDevices({ systemAudioOn: on })}
          onQuality={(q: Quality) => patch({ quality: q })}
          onFps={(f: Fps) => patch({ fps: f })}
          onCountdown={(c: CountdownSec) => patch({ countdownSec: c })}
          onRecord={() => void onRecord()}
        />
      </div>

      <Dialog open={privacy !== null} onOpenChange={(o) => !o && setPrivacy(null)}>
        {privacy ? (
          <DialogContent
            title="Permissão necessária"
            description={
              privacy === 'camera'
                ? 'O Windows está bloqueando o acesso à câmera para este aplicativo. Libere em Privacidade › Câmera e volte aqui.'
                : 'O Windows está bloqueando o acesso ao microfone para este aplicativo. Libere em Privacidade › Microfone e volte aqui.'
            }
            footer={
              <>
                <Button variant="ghost" onClick={() => setPrivacy(null)}>
                  Agora não
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    void window.api.app.openExternal(PRIVACY_URL[privacy])
                    setPrivacy(null)
                  }}
                >
                  <ExternalLink className="h-4 w-4" />
                  Abrir configurações de privacidade
                </Button>
              </>
            }
          >
            <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-fg-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <span>Depois de liberar, o dispositivo é detectado automaticamente. Se preferir, desligue-o no painel abaixo para gravar sem ele.</span>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}
