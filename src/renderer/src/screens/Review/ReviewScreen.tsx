import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, Clapperboard, LoaderCircle, Monitor, Pause, Play, RefreshCw, Scissors, SkipBack, Video, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import type { ExportOptions, ExportPresetId, Session } from '@shared/types'
import { PRESETS } from '@shared/presets/presets'
import { estimateOutputMB } from '@shared/presets/sizeEstimate'
import { defaultOutputName, sanitizeFileName } from '@shared/filenames'
import { useAppStore } from '@/app/store'
import { Button } from '@/components/ui/Button'
import { Badge, Kbd, Progress, Section, Tip } from '@/components/ui/primitives'
import { formatBytes, formatClock, formatDate, formatMB, formatTimecode } from '@/lib/format'
import { cn } from '@/lib/cn'
import { ReviewPlayer, type ReviewPlayerHandle } from './ReviewPlayer'
import { MIN_TRIM_GAP_MS, Timeline } from './Timeline'
import { PresetCards } from './PresetCards'
import { ExportOptionsPanel } from './ExportOptionsPanel'
import { pipOverrideFor, type PipChoice } from './pipChoice'
import { ExportProgress, type ExportSummary } from './ExportProgress'
import { ExportDone } from './ExportDone'
import { cancelExport, resetExport, startExport, useExportRunner, type ExportResult } from './exportRunner'

// Tela de Revisão (spec §4.3): prepara os assets (proxy/webcam/miniaturas/onda), player com
// composição idêntica à exportação, timeline com corte, presets + opções, exportação com
// progresso (composição no Worker → ffmpeg no main, via exportRunner) e estado concluído.

declare global {
  interface Window {
    /** QA: dispara a exportação com webcam + anotações no preset dado (mais overrides opcionais, ex.: trimStartMs) e devolve o resultado. */
    __qaExport?: (presetId: ExportPresetId, overrides?: Partial<ExportOptions>) => Promise<{ outputs: string[]; error?: string }>
  }
}

type AssetsState =
  | { status: 'loading'; percent: number }
  | { status: 'ready'; proxyUrl: string; webcamUrl: string | null; thumbs: string[]; waveformUrl: string | null }
  | { status: 'error'; message: string }

const pad3 = (n: number): string => String(n).padStart(3, '0')

/** Quantidade de miniaturas que buildReviewAssets gera (fps=1/max(1, dur/40)). */
function expectedThumbCount(durationMs: number): number {
  const sec = durationMs / 1000
  const every = Math.max(1, sec / 40)
  return Math.max(1, Math.round(sec / every))
}

function initialOptions(session: Session, outputDir: string): ExportOptions {
  const hasMic = session.tracks.mic !== undefined
  const hasSystem = session.tracks.system !== undefined
  return {
    presetId: 'high',
    trimStartMs: 0,
    trimEndMs: null,
    includeWebcam: session.tracks.webcam !== undefined,
    includeAnnotations: session.strokes.length > 0,
    audioMode: hasMic && hasSystem ? 'mix' : hasMic ? 'micOnly' : hasSystem ? 'systemOnly' : 'mix',
    micOffsetMs: 0,
    targetSizeMB: null,
    reels: false,
    outputDir,
    // Sem extensão: o main acrescenta .mp4/.wav conforme o preset (o painel mostra o sufixo).
    fileName: defaultOutputName(new Date(session.createdAt), ''),
    pipOverride: null
  }
}

/** Resumo legível das opções efetivamente usadas na exportação em andamento. */
function exportSummary(session: Session, opts: ExportOptions, durationMs: number): ExportSummary {
  const p = PRESETS[opts.presetId]
  const end = opts.trimEndMs ?? durationMs
  return {
    preset: `${p.title} — ${p.subtitle}`,
    range: `${formatTimecode(opts.trimStartMs)} → ${formatTimecode(end)} (${formatTimecode(Math.max(0, end - opts.trimStartMs))})`,
    fileName: opts.fileName,
    outputDir: opts.outputDir,
    extras: [
      opts.includeWebcam && !p.copyVideo && session.tracks.webcam !== undefined ? 'webcam' : null,
      opts.includeAnnotations && !p.copyVideo && session.strokes.length ? 'anotações' : null,
      p.supportsTargetSize && opts.targetSizeMB ? `alvo ${opts.targetSizeMB} MB` : null,
      p.supportsReels && opts.reels ? 'Reels 9:16' : null,
      opts.audioMode !== 'mix' ? AUDIO_SUMMARY[opts.audioMode] : null
    ].filter((x): x is string => x !== null)
  }
}

const AUDIO_SUMMARY: Record<ExportOptions['audioMode'], string> = { mix: 'áudio mixado', micOnly: 'só microfone', systemOnly: 'só áudio do sistema', separate: 'áudios separados' }

export function ReviewScreen(): React.JSX.Element {
  const session = useAppStore((s) => s.reviewSession)
  if (!session) return <NoSession />
  return <ReviewBody key={session.id} session={session} />
}

function NoSession(): React.JSX.Element {
  const setScreen = useAppStore((s) => s.setScreen)
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="card max-w-sm p-6 text-center">
        <Clapperboard className="mx-auto h-8 w-8 text-muted" />
        <div className="mt-3 text-sm font-semibold">Nenhuma gravação em revisão</div>
        <p className="mt-1 text-xs text-muted">Grave algo novo ou abra uma gravação do histórico.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="secondary" onClick={() => setScreen('history')}>
            Histórico
          </Button>
          <Button variant="primary" onClick={() => setScreen('prepare')}>
            Nova gravação
          </Button>
        </div>
      </div>
    </div>
  )
}

function ReviewBody({ session }: { session: Session }): React.JSX.Element {
  const api = window.api
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const setReviewSession = useAppStore((s) => s.setReviewSession)
  const setScreen = useAppStore((s) => s.setScreen)
  const setStorePhase = useAppStore((s) => s.setPhase)
  const outputDir = settings.outputDir ?? appInfo?.paths.output ?? ''
  const autoFadeMs = settings.annotations.autoFadeSec ? settings.annotations.autoFadeSec * 1000 : null

  const playerRef = useRef<ReviewPlayerHandle>(null)
  const [assets, setAssets] = useState<AssetsState>({ status: 'loading', percent: 0 })
  const forceRegenRef = useRef(false)
  const [regen, setRegen] = useState(0)
  const [openingEditor, setOpeningEditor] = useState(false)
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null)
  const durationMs = session.durationMs ?? videoDurationMs ?? 0
  const [currentMs, setCurrentMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEndState, setTrimEnd] = useState<number | null>(null)
  const trimEnd = trimEndState ?? durationMs
  const [options, setOptions] = useState<ExportOptions>(() => initialOptions(session, outputDir))
  const [pipChoice, setPipChoice] = useState<PipChoice>({ mode: 'original' })
  const { phase, busyElsewhere } = useExportRunner(session.id)

  const pipOverride = useMemo(() => pipOverrideFor(pipChoice, session.video.width, session.video.height, session.pip), [pipChoice, session.video.width, session.video.height, session.pip])
  const effectiveMs = Math.max(0, trimEnd - trimStart)
  const measuredKbps = session.bytes && durationMs > 0 ? (session.bytes * 8) / durationMs : null
  const preset = PRESETS[options.presetId]
  const estimateMB = estimateOutputMB(preset, effectiveMs, session.video.height, session.video.fps, measuredKbps)

  // ---- assets da revisão (proxy, webcam, miniaturas, onda) ----
  useEffect(() => {
    let alive = true
    const id = session.id
    const url = (name: string): string => api.session.fileUrl(id, name)
    const ready = (thumbCount: number, hasWebcam: boolean, hasWave: boolean): void =>
      setAssets({
        status: 'ready',
        proxyUrl: url('preview.mp4'),
        webcamUrl: hasWebcam ? url('webcam.mp4') : null,
        thumbs: Array.from({ length: thumbCount }, (_, i) => url(`thumbs/${pad3(i + 1)}.jpg`)),
        waveformUrl: hasWave ? url('wave.png') : null
      })
    const off = api.export.onReviewAssetsProgress((p) => {
      if (alive && p.sessionId === id) setAssets((prev) => (prev.status === 'loading' ? { status: 'loading', percent: p.percent } : prev))
    })
    const cached = !forceRegenRef.current && session.files.proxy && session.files.thumbs && session.durationMs
    forceRegenRef.current = false
    if (cached) {
      ready(expectedThumbCount(session.durationMs ?? 0), !!session.files.webcam, !!session.files.waveform)
    } else {
      setAssets({ status: 'loading', percent: 0 })
      api.export
        .reviewAssets(id)
        .then(async (a) => {
          if (!alive) return
          ready(a.thumbs.length, !!a.webcam, !!a.waveform)
          const fresh = await api.session.get(id)
          if (fresh && alive) setReviewSession(fresh)
        })
        .catch((e: unknown) => {
          if (alive) setAssets({ status: 'error', message: e instanceof Error ? e.message : String(e) })
        })
    }
    return () => {
      alive = false
      off()
    }
    // Depende só de session.id + regen: os demais campos da sessão são lidos no disparo.
  }, [session.id, regen])

  // Preset que não suporta algo → normaliza opções dependentes.
  const selectPreset = useCallback(
    (presetId: ExportPresetId): void => {
      setOptions((o) => {
        const p = PRESETS[presetId]
        const hasAudio = session.tracks.mic !== undefined || session.tracks.system !== undefined
        return {
          ...o,
          presetId,
          targetSizeMB: p.supportsTargetSize ? (o.targetSizeMB ?? 64) : null,
          reels: p.supportsReels ? o.reels : false,
          // "Edição posterior" já entra com áudios separados; ao sair dele, volta a mixar.
          audioMode: presetId === 'separate' && hasAudio ? 'separate' : o.audioMode === 'separate' ? 'mix' : o.audioMode
        }
      })
    },
    [session.tracks.mic, session.tracks.system]
  )

  const patchOptions = useCallback((patch: Partial<ExportOptions>): void => setOptions((o) => ({ ...o, ...patch })), [])

  const onTrimChange = useCallback((s: number, e: number): void => {
    setTrimStart(Math.max(0, s))
    setTrimEnd(Math.min(durationMs || e, e))
  }, [durationMs])

  const seek = useCallback((ms: number): void => playerRef.current?.seek(ms), [])
  const onTime = useCallback((ms: number): void => setCurrentMs(ms), [])
  const onDuration = useCallback((ms: number): void => setVideoDurationMs(ms), [])
  const onPlayerError = useCallback((message: string): void => setAssets({ status: 'error', message }), [])

  const markIn = useCallback((): void => {
    const v = Math.min(currentMs, trimEnd - MIN_TRIM_GAP_MS)
    if (v >= 0) setTrimStart(Math.round(v))
  }, [currentMs, trimEnd])
  const markOut = useCallback((): void => {
    const v = Math.max(currentMs, trimStart + MIN_TRIM_GAP_MS)
    if (v <= durationMs) setTrimEnd(Math.round(v))
  }, [currentMs, trimStart, durationMs])

  const pickFolder = useCallback(async (): Promise<void> => {
    const dir = await api.settings.pickFolder(outputDir || null)
    if (dir) await api.settings.set({ outputDir: dir })
  }, [api, outputDir])

  const goPrepare = useCallback((): void => {
    setReviewSession(null)
    setStorePhase('idle')
    void api.recording.setPhase('idle')
    setScreen('prepare')
  }, [api, setReviewSession, setStorePhase, setScreen])

  const deleteRaw = useCallback(async (): Promise<void> => {
    // Solta preview.mp4/webcam.mp4 dos <video> antes de mover a pasta para a Lixeira (Windows trava arquivos abertos).
    playerRef.current?.release()
    try {
      await api.session.delete(session.id)
    } catch (e) {
      toast.error(`Não foi possível excluir: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    toast('Gravação bruta enviada à Lixeira.')
    goPrepare()
  }, [api, session.id, goPrepare])

  // ---- exportação (estado no exportRunner: sobrevive à navegação e a remontagens) ----
  const runExport = useCallback(
    (overrides?: Partial<ExportOptions>): Promise<ExportResult> => {
      playerRef.current?.pause()
      const fileName = sanitizeFileName(options.fileName.trim()) || defaultOutputName(new Date(session.createdAt), '')
      const opts: ExportOptions = {
        ...options,
        trimStartMs: Math.round(trimStart),
        trimEndMs: trimEnd < durationMs - 1 ? Math.round(trimEnd) : null,
        outputDir,
        fileName,
        pipOverride,
        ...overrides
      }
      return startExport({ session, options: opts, durationMs, autoFadeMs })
    },
    [options, session, trimStart, trimEnd, durationMs, outputDir, pipOverride, autoFadeMs]
  )
  const backToOptions = useCallback((): void => resetExport(session.id), [session.id])

  // QA (só fora do pacote): window.__qaExport(presetId) exporta com webcam + anotações.
  useEffect(() => {
    if (appInfo?.isPackaged) return
    window.__qaExport = (presetId, overrides) => runExport({ presetId, includeWebcam: true, includeAnnotations: true, ...overrides })
    return () => {
      delete window.__qaExport
    }
  }, [runExport, appInfo?.isPackaged])

  // ---- atalhos de teclado ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"]')) return
      if (phase.kind !== 'idle' && e.key !== ' ') return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          playerRef.current?.toggle()
          break
        case 'i':
        case 'I':
          markIn()
          break
        case 'o':
        case 'O':
          markOut()
          break
        case 'Home':
          seek(trimStart)
          break
        case 'End':
          seek(trimEnd)
          break
        case 'ArrowLeft':
          e.preventDefault()
          seek(currentMs - (e.shiftKey ? 5000 : 1000))
          break
        case 'ArrowRight':
          e.preventDefault()
          seek(currentMs + (e.shiftKey ? 5000 : 1000))
          break
        case 'Enter':
          if (e.ctrlKey && phase.kind === 'idle' && assets.status === 'ready') void runExport()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [markIn, markOut, seek, trimStart, trimEnd, currentMs, phase.kind, assets.status, runExport])

  const toggleMute = (): void => {
    const m = !muted
    setMuted(m)
    playerRef.current?.setMuted(m)
  }

  const openInEditor = async (): Promise<void> => {
    setOpeningEditor(true)
    try {
      playerRef.current?.pause()
      const project = await api.project.fromSession(session.id)
      useAppStore.getState().openEditor(project.id)
    } catch (e) {
      toast.error(`Não foi possível abrir no editor: ${e instanceof Error ? e.message : String(e)}`)
      setOpeningEditor(false)
    }
  }

  const canExport = assets.status === 'ready' && durationMs > 0 && phase.kind === 'idle' && !busyElsewhere
  const SourceIcon = session.source.kind === 'window' ? AppWindow : Monitor

  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      {/* ---------------- coluna esquerda: player + timeline ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 rise-in">
        <header className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[15px] font-bold tracking-tight">Gravação de {formatDate(session.createdAt)}</h1>
              {session.state === 'recording' ? <Badge tone="warn">Recuperada</Badge> : session.state === 'finalized' ? <Badge tone="ok">Exportada</Badge> : null}
              {session.engine === 'mediarecorder' ? <Badge tone="info">Compatibilidade</Badge> : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
              <span className="flex items-center gap-1 truncate">
                <SourceIcon className="h-3 w-3" /> {session.source.name}
              </span>
              <span className="font-mono tnum">
                {session.video.width}×{session.video.height} · {session.video.fps} fps
              </span>
              <span className="font-mono tnum">{formatClock(durationMs)}</span>
              {session.bytes ? <span className="font-mono tnum">{formatBytes(session.bytes)}</span> : null}
              {session.tracks.webcam !== undefined ? <span>webcam</span> : null}
              {session.strokes.length ? (
                <span>
                  <span className="font-mono tnum">{session.strokes.length}</span> {session.strokes.length === 1 ? 'anotação' : 'anotações'}
                </span>
              ) : null}
            </div>
          </div>
          <Tip content="Criar um projeto no editor com esta gravação (cortes, faixas, efeitos)">
            <Button variant="outline" size="sm" onClick={() => void openInEditor()} disabled={phase.kind === 'running' || openingEditor || !session.durationMs}>
              {openingEditor ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />} Abrir no editor
            </Button>
          </Tip>
          <Tip content="Manter esta gravação no histórico e voltar para gravar outra">
            <Button variant="ghost" size="sm" onClick={goPrepare} disabled={phase.kind === 'running'}>
              <Video className="h-3.5 w-3.5" /> Nova gravação
            </Button>
          </Tip>
        </header>

        <FitBox aspect={session.video.width / Math.max(1, session.video.height)}>
            {assets.status === 'ready' ? (
              <ReviewPlayer
                ref={playerRef}
                session={session}
                proxyUrl={assets.proxyUrl}
                webcamUrl={assets.webcamUrl}
                draw={{ includeWebcam: options.includeWebcam && !preset.copyVideo, includeAnnotations: options.includeAnnotations && !preset.copyVideo, autoFadeMs, pipOverride }}
                trimStartMs={trimStart}
                trimEndMs={trimEnd}
                onTime={onTime}
                onPlaying={setPlaying}
                onDuration={onDuration}
                onError={onPlayerError}
              />
            ) : (
              <AssetsPlaceholder
                state={assets}
                onRetry={() => {
                  forceRegenRef.current = true
                  setRegen((n) => n + 1)
                }}
              />
            )}
        </FitBox>

        <div className="flex items-center gap-2">
          <Tip content={playing ? 'Pausar' : 'Reproduzir'} shortcut="Espaço">
            <Button variant="secondary" size="md" className="w-24" onClick={() => playerRef.current?.toggle()} disabled={assets.status !== 'ready'}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {playing ? 'Pausar' : 'Tocar'}
            </Button>
          </Tip>
          <Tip content="Ir para o início do corte" shortcut="Home">
            <Button variant="ghost" size="md" className="px-2.5" onClick={() => seek(trimStart)} disabled={assets.status !== 'ready'} aria-label="Início do corte">
              <SkipBack className="h-4 w-4" />
            </Button>
          </Tip>
          <span className="font-mono tnum ml-1 text-sm text-fg">
            {formatTimecode(currentMs)} <span className="text-muted">/ {formatTimecode(durationMs)}</span>
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Tip content="Definir início do corte no instante atual" shortcut="I">
              <Button variant="outline" size="sm" onClick={markIn} disabled={assets.status !== 'ready'}>
                [ Início
              </Button>
            </Tip>
            <Tip content="Definir fim do corte no instante atual" shortcut="O">
              <Button variant="outline" size="sm" onClick={markOut} disabled={assets.status !== 'ready'}>
                Fim ]
              </Button>
            </Tip>
            <Tip content={muted ? 'Ativar som' : 'Silenciar prévia'}>
              <Button variant="ghost" size="sm" className="px-2" onClick={toggleMute} disabled={assets.status !== 'ready'} aria-label="Som">
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </Button>
            </Tip>
          </div>
        </div>

        <Timeline
          durationMs={durationMs}
          currentMs={currentMs}
          trimStartMs={trimStart}
          trimEndMs={trimEnd}
          thumbs={assets.status === 'ready' ? assets.thumbs : []}
          waveformUrl={assets.status === 'ready' ? assets.waveformUrl : null}
          markers={session.markers}
          onSeek={seek}
          onTrimChange={onTrimChange}
        />
      </div>

      {/* ---------------- painel direito: exportação ---------------- */}
      <aside className="flex w-[360px] shrink-0 flex-col rise-in rise-in-1">
        {phase.kind === 'running' ? (
          <ExportProgress state={phase.progress} summary={exportSummary(session, phase.opts, durationMs)} onCancel={cancelExport} onRetry={() => void runExport()} onBack={backToOptions} />
        ) : phase.kind === 'done' ? (
          <ExportDone outputs={phase.outputs} warning={phase.warning} onReexport={backToOptions} onNewRecording={goPrepare} onDeleteRaw={deleteRaw} />
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden pr-1">
              <Section title="Preset" className="p-3">
                <PresetCards selected={options.presetId} onSelect={selectPreset} durationMs={effectiveMs} srcHeight={session.video.height} srcFps={session.video.fps} measuredKbps={measuredKbps} />
              </Section>
              <Section title="Opções" className="p-3 pt-3">
                <ExportOptionsPanel
                  session={session}
                  options={options}
                  onChange={patchOptions}
                  pipChoice={pipChoice}
                  onPipChoice={setPipChoice}
                  outputDir={outputDir}
                  onPickFolder={() => void pickFolder()}
                  targetHint={{ estimateMB, durationMs: effectiveMs, srcHeight: session.video.height }}
                />
              </Section>
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
                <span>
                  {preset.title} <span className="text-muted-2">— {preset.subtitle}</span>
                </span>
                <span className="font-mono tnum">
                  {formatTimecode(effectiveMs)} · ≈ {formatMB(estimateMB)}
                </span>
              </div>
              <Button variant="primary" size="xl" className="w-full" disabled={!canExport} onClick={() => void runExport()}>
                Exportar
                <Kbd className="ml-1 border-white/30 bg-white/15 text-white">Ctrl+Enter</Kbd>
              </Button>
              {busyElsewhere ? <p className="mt-2 text-center text-[11px] text-warn">Outra gravação está sendo exportada — aguarde terminar.</p> : null}
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

/** Caixa centralizada com a proporção do vídeo, limitada pela largura E pela altura disponíveis. */
function FitBox({ aspect, children }: { aspect: number; children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect()
      const w = Math.floor(Math.min(width, height * aspect))
      const h = Math.floor(Math.min(height, width / aspect))
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])
  return (
    <div ref={ref} className="flex min-h-0 flex-1 items-center justify-center">
      <div style={size ? { width: size.w, height: size.h } : { width: '100%', aspectRatio: String(aspect) }}>{children}</div>
    </div>
  )
}

function AssetsPlaceholder({ state, onRetry }: { state: AssetsState; onRetry: () => void }): React.JSX.Element {
  const percent = state.status === 'loading' ? state.percent : 0
  return (
    <div className={cn('relative h-full w-full overflow-hidden rounded-2xl border border-border-strong bg-surface', state.status === 'loading' && 'animate-pulse')}>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        {state.status === 'error' ? (
          <>
            <div className="text-sm font-semibold text-danger">Não foi possível preparar a prévia</div>
            <p className="max-w-sm select-text text-xs text-muted">{state.message}</p>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" /> Gerar prévia novamente
            </Button>
          </>
        ) : (
          <>
            <LoaderCircle className="h-6 w-6 animate-spin text-muted" />
            <div className="text-sm font-semibold">Preparando a prévia da gravação…</div>
            <p className="text-xs text-muted">Gerando proxy, miniaturas e forma de onda com o ffmpeg.</p>
            <div className="w-64">
              <Progress value={percent} tone="info" />
            </div>
            <span className="font-mono tnum text-xs text-muted">{Math.round(percent)}%</span>
          </>
        )}
      </div>
    </div>
  )
}
