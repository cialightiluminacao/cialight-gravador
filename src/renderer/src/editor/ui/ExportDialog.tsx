import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Captions, ChevronDown, CircleCheckBig, Copy, FolderOpen, ListPlus, LoaderCircle, ShieldAlert, SlidersHorizontal, TriangleAlert, Upload, X } from 'lucide-react'
import { fileNameFromTitle, sanitizeFileName } from '@shared/filenames'
import { captionCues, contentEndUs, findItem, isCaptionsTrack } from '@shared/editor/ops'
import { privacyWarnings, type PrivacyWarning } from '@shared/editor/privacy'
import { planAudio } from '@shared/editor/audioPlan'
import type { Project } from '@shared/editor/project'
import { audioProcessIssues } from './audioProcessing'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Progress, Segmented, Select } from '@/components/ui/primitives'
import { PathField } from '@/components/ui/PathField'
import { useAppStore } from '@/app/store'
import { formatBytes, formatClock, formatTimecode } from '@/lib/format'
import { cn } from '@/lib/cn'
import { ipcErrorMessage } from '@/lib/ipcError'
import { copyOutputFile, showOutputInFolder } from '@/screens/Review/outputActions'
import { isFontInstalled } from '../engine/text/fontInstalled'
import { missingFontFamilies } from '@shared/editor/fontMissing'
import { replaceProjectFont } from './fontActions'
import { MissingFontNotice } from './MissingFontNotice'
import { ChaptersSection } from './ChaptersSection'
import { useEditorStore } from '../state/editorStore'
import { EditorExportCancelled, editorExportRunning, type EditorExportProgress, type EditorExportResult } from '../export/editorExport'
import { exportMediaIssues, exportRange, hasInOut, type ExportMediaIssue } from '../export/exportPlan'
import {
  EXPORT_PRESETS,
  estimateFor,
  exportRequestFor,
  fpsChoices,
  outputFileName,
  presetAvailability,
  basePreset,
  settingsForPreset,
  sizeForHeight,
  sizeForWidth,
  validateExport,
  videoBitrateFor,
  type ExportPresetId,
  type ExportSettings,
  type VideoCodecChoice
} from '../export/exportPresets'
import { probeHevc } from '../export/hevcSupport'
import {
  AUDIO_FORMATS,
  audioEstimateBytes,
  audioOnlyBlocker,
  GIF_DEFAULT_FPS,
  GIF_DEFAULT_WIDTH,
  GIF_FPS,
  gifDiskBytes,
  gifEstimateBytes,
  gifSize,
  gifWidthOptions,
  stillFileName,
  validateGif,
  type AudioFormat,
  type ExportFormat
} from '../export/formatPlan'
import { exportStill, type FormatExportResult } from '../export/formatExport'
import { EFFECT_LABEL, privacyLine } from '../export/stillNotice'
import type { EnqueueInput, QueueItem } from '../export/exportQueue'
import { exportQueue, useQueueActive, useQueueItem } from '../export/exportQueueStore'
import { defaultExportFolder } from './frameExport'

// Diálogo de exportação do editor. Formato: Vídeo, GIF, Quadro (PNG) ou Só áudio.
// Vídeo: preset (cartões com o motivo quando indisponível), "Personalizar" (resolução na proporção do projeto,
// fps, qualidade por taxa ou tamanho alvo, codec H.264/HEVC — HEVC só quando o hardware confirma).
// GIF: largura (até a do projeto), fps, até 30 s, estimativa aproximada. Quadro: o do cursor, no tamanho do
// projeto. Só áudio: WAV/MP3/M4A. Todos: intervalo (tudo / I–O; o quadro não tem), nome (a extensão segue o
// formato) e pasta, estimativa e avisos; um bloqueio desativa Exportar com o motivo. Depois: progresso (%,
// velocidade × tempo real, tempo restante, cancelar) e o resultado (abrir pasta / copiar arquivo). A exportação
// usa workers próprios: o preview continua vivo (pausado ao começar). Avisos de privacidade com "Revisar".
// Vídeo, GIF e só áudio passam pela fila de exportações (exportQueue): "Exportar" com a fila parada mostra o
// progresso aqui (o diálogo pode fechar: a exportação continua e aparece em "Exportações"); com a fila ocupada, entra
// nela ("Adicionado à fila (posição N)") e o diálogo fecha. "Adicionar à fila" enfileira e mantém o diálogo aberto.
// Cada item leva um instantâneo do projeto e os avisos de privacidade do momento. O quadro PNG é direto (sem fila).

type Done = { kind: 'video'; result: EditorExportResult } | { kind: 'format'; result: FormatExportResult }
type Phase =
  | { kind: 'form' }
  | { kind: 'running'; progress: EditorExportProgress | null; cancelling: boolean }
  | { kind: 'queued'; id: string; cancelling: boolean }
  | { kind: 'done'; done: Done }
  | { kind: 'error'; message: string }

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: 'video', label: 'Vídeo' },
  { value: 'gif', label: 'GIF' },
  { value: 'png', label: 'Quadro (PNG)' },
  { value: 'audio', label: 'Só áudio' }
]
const FORMAT_TITLE: Record<ExportFormat, [string, string]> = {
  video: ['Exportar vídeo', 'Vídeo exportado'],
  gif: ['Exportar GIF', 'GIF exportado'],
  png: ['Exportar quadro (PNG)', 'Quadro exportado'],
  audio: ['Exportar áudio', 'Áudio exportado']
}
const AUDIO_DONE_LABEL: Record<AudioFormat, string> = { wav: 'WAV · PCM 16 bits', mp3: 'MP3 · 192 kbps', m4a: 'M4A · AAC 192 kbps' }
const AUDIO_QUEUE_LABEL: Record<AudioFormat, string> = { wav: 'WAV', mp3: 'MP3 192 kbps', m4a: 'M4A (AAC)' }
const formatExt = (f: ExportFormat, audio: AudioFormat): 'mp4' | 'gif' | 'png' | AudioFormat => (f === 'video' ? 'mp4' : f === 'audio' ? audio : f)

const DEFAULT_PRESET: ExportPresetId = 'youtube1080'
const formatMbps = (bps: number): string => `${(bps / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps`
const formatFps = (fps: number): string => `${fps.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} fps`
const CODEC_LABEL: Record<VideoCodecChoice, string> = { h264: 'H.264', hevc: 'HEVC' }
const ISSUE_LABEL: Record<ExportMediaIssue['status'], string> = { missing: 'ausente', processing: 'ainda processando', error: 'com erro' }
const canvasKey = (c: Project['canvas']): string => `${c.width}x${c.height}@${c.fps}`

/** Item da fila concluído → tela de concluído do diálogo. */
function doneOf(it: QueueItem): Done | null {
  if (!it.result) return null
  return it.job.kind === 'video' ? { kind: 'video', result: it.result as EditorExportResult } : { kind: 'format', result: it.result as FormatExportResult }
}

/** Nome padrão do formato: "<projeto>.<ext>"; o quadro leva o instante ("<projeto> - 00m12s.png"). */
function defaultName(p: Project, f: ExportFormat, audio: AudioFormat, tUs: number): string {
  return f === 'png' ? stillFileName(p.name, tUs) : outputFileName(fileNameFromTitle(p.name) || 'Vídeo', formatExt(f, audio))
}
/** Última escolha das legendas (só nesta sessão do app): queimar ligado e .srt desligado por padrão. */
let captionChoice = { burn: true, srtBeside: false }

export function ExportDialog({ open, onOpenChange, onBeforeExport, onSeek }: { open: boolean; onOpenChange: (open: boolean) => void; onBeforeExport: () => void; onSeek: (us: number) => void }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const inUs = useEditorStore((s) => s.inUs)
  const outUs = useEditorStore((s) => s.outUs)
  const audioJobs = useEditorStore((s) => s.audioJobs)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  // preset de base (disponibilidade, HEVC permitido) + configurações (a verdade); qualquer ajuste → "Personalizado"
  const [exp, setExp] = useState<{ settings: ExportSettings; canvas: string } | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [hevc, setHevc] = useState<{ key: string; ok: boolean } | null>(null)
  const [rangeMode, setRangeMode] = useState<'all' | 'inout'>('all')
  const [format, setFormat] = useState<ExportFormat>('video')
  const [gifOpts, setGifOpts] = useState<{ width: number; fps: number }>({ width: GIF_DEFAULT_WIDTH, fps: GIF_DEFAULT_FPS })
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('mp3')
  const [fileName, setFileName] = useState('')
  // nome digitado pelo usuário: trocar o formato só troca a extensão; senão vale o nome padrão do formato
  const [nameTouched, setNameTouched] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  // quadro (PNG): o instante do cursor; lido só com o diálogo aberto (fechado não re-renderiza a cada quadro)
  const playheadUs = useEditorStore((s) => (open ? s.playheadUs : 0))
  const [captions, setCaptionsState] = useState(captionChoice)
  const setCaptions = (patch: Partial<typeof captionChoice>): void => {
    captionChoice = { ...captionChoice, ...patch }
    setCaptionsState(captionChoice)
  }
  const abortRef = useRef<AbortController | null>(null)
  const ids = useId()
  // item da fila acompanhado aqui ("Exportar" com a fila parada) e se a fila está ocupada
  const watched = useQueueItem(phase.kind === 'queued' ? phase.id : null)
  const queueActive = useQueueActive()

  // fim do conteúdo (sem efeitos e itens desativados): um efeito depois da mídia não estica "Tudo" com preto
  const totalUs = project ? contentEndUs(project) : 0
  const inOutUsable = hasInOut(totalUs, inUs, outUs)
  const isPng = format === 'png'
  const range = exportRange(totalUs, inUs, outUs, rangeMode)
  const durationUs = range.toUs - range.fromUs
  // intervalo verificado (mídia, privacidade, voz): o quadro do cursor, ou o trecho
  const checkFrom = isPng ? playheadUs : range.fromUs
  const checkTo = isPng ? playheadUs + 1 : range.toUs
  // avisos de privacidade: só quando o projeto, o formato ou o intervalo mudam — não a cada renderização (o
  // progresso da exportação re-renderiza várias vezes por segundo; em 1 h a conta passa de 100 ms)
  const privacy = useMemo(
    () => (open && project && format !== 'audio' && (isPng || durationUs > 0) ? privacyWarnings(project, checkFrom, checkTo) : []),
    [open, project, format, isPng, durationUs, checkFrom, checkTo]
  )

  // ao abrir (fora de uma exportação): formulário com os padrões do projeto; ajustes personalizados valem
  // enquanto o quadro do projeto não muda (senão, volta ao preset — ou ao padrão, se ele deixou de servir)
  useEffect(() => {
    if (!open || !project || phase.kind === 'running') return
    setPhase({ kind: 'form' })
    setNameTouched(false)
    setFileName(defaultName(project, format, audioFormat, useEditorStore.getState().playheadUs))
    const range0 = hasInOut(contentEndUs(project), useEditorStore.getState().inUs, useEditorStore.getState().outUs)
    setRangeMode(range0 ? 'inout' : 'all')
    const key = canvasKey(project.canvas)
    setExp((cur) => {
      if (cur && cur.settings.customized && cur.canvas === key) return cur
      const base = cur?.settings.presetId ?? DEFAULT_PRESET
      const id = presetAvailability(base, project.canvas, contentEndUs(project)).ok ? base : DEFAULT_PRESET
      return { settings: settingsForPreset(id, project.canvas), canvas: key }
    })
    setCaptionsState(captionChoice)
  }, [open])

  // diálogo desmontado (editor fechado) no meio do quadro PNG: cancela (a fila segue sozinha)
  useEffect(() => () => abortRef.current?.abort(), [])

  // item acompanhado terminou: concluído/erro aqui; cancelado (ou limpo da fila) volta ao formulário
  const watchedState = watched?.state
  useEffect(() => {
    if (phase.kind !== 'queued') return
    if (!watched || watched.state === 'cancelled') setPhase({ kind: 'form' })
    else if (watched.state === 'done') {
      const done = doneOf(watched)
      setPhase(done ? { kind: 'done', done } : { kind: 'form' })
      if (done?.kind === 'video') {
        if (done.result.srtPath) toast.success('Legendas salvas ao lado do vídeo', { description: done.result.srtPath })
        else if (done.result.srtWarning) toast.warning('O arquivo .srt não foi gravado', { description: done.result.srtWarning })
      }
    } else if (watched.state === 'error') setPhase({ kind: 'error', message: watched.message ?? 'Falha desconhecida' })
  }, [phase.kind, watchedState])

  // suporte a HEVC na resolução/fps de saída (cache por w×h@fps no hevcSupport)
  const s = exp?.settings
  const probeKey = s ? `${s.width}x${s.height}@${s.fps}` : ''
  useEffect(() => {
    if (!open || !s) return
    let alive = true
    void probeHevc(s.width, s.height, s.fps).then((ok) => {
      if (alive) setHevc({ key: probeKey, ok })
    })
    return () => {
      alive = false
    }
  }, [open, probeKey])

  if (!project || !exp || !s) return null
  const missingFonts = format === 'audio' ? [] : missingFontFamilies(project, isFontInstalled)
  const canvas = project.canvas
  const hasAudio = planAudio(project).some((x) => x.mode !== 'mute')
  // redução de ruído/normalização ainda processando ou que falhou: a exportação sairia com o original nesses trechos
  const voiceIssues = format === 'video' || format === 'audio' ? audioProcessIssues(project, audioJobs, range.fromUs, range.toUs) : { failed: [], pending: [] }
  const base = basePreset(s.presetId)
  const customized = !!s.customized
  const hevcState: 'checking' | 'ok' | 'no' = hevc?.key === probeKey ? (hevc.ok ? 'ok' : 'no') : 'checking'
  // verificando: o bloqueio é o "Verificando…" abaixo, não "não suportado"
  const validation = validateExport(s, canvas, durationUs, hevcState !== 'no')
  const videoBps = videoBitrateFor(s, durationUs)
  const estimate = estimateFor(s, durationUs, hasAudio)
  const gif = gifSize(gifOpts.width, canvas)
  const gifCheck = validateGif(gif.width, gif.height, gifOpts.fps, durationUs)
  const gifEstimate = gifEstimateBytes(gif.width, gif.height, gifOpts.fps, durationUs)
  const audioBlocker = format === 'audio' ? (audioOnlyBlocker(project) ?? (durationUs > 0 ? null : 'A linha do tempo está vazia.')) : null
  const audioEstimate = audioEstimateBytes(audioFormat, durationUs)
  // pré-checagem: mídia do intervalo que sairia como "mídia indisponível" exige confirmação explícita
  const issues = checkTo > checkFrom && (isPng || durationUs > 0) ? exportMediaIssues(project, checkFrom, checkTo) : []
  // legendas habilitadas (o projeto tem legendas: mostra "Queimar no vídeo" / "Salvar arquivo .srt ao lado")
  const hasCaptions = captionCues(project).length > 0
  // faixa Legendas oculta: nada seria queimado — a opção fica desligada e explicada (o .srt continua com as legendas)
  const captionsHidden = !!project.tracks.find(isCaptionsTrack)?.hidden
  // "Revisar": seleciona o efeito, leva o playhead ao instante do aviso (o mais fraco, o início da mídia por
  // cima…, sempre dentro do intervalo) e fecha o diálogo
  const review = (w: PrivacyWarning): void => {
    if (!findItem(project, w.itemId)) return
    useEditorStore.getState().select([w.itemId])
    onSeek(Math.min(Math.max(w.tUs, checkFrom), Math.max(checkFrom, checkTo - 1)))
    onOpenChange(false)
  }
  // QA (só fora do pacote): window.__qaEditor.exportDir troca a pasta padrão (o QA nunca grava na pasta real)
  const defaultFolder = defaultExportFolder(settings, appInfo)
  const targetFolder = folder ?? defaultFolder
  const name = sanitizeFileName(fileName.trim())
  const running = phase.kind === 'running'
  const codecBlocked = s.codec === 'hevc' && hevcState === 'checking' ? 'Verificando o suporte a HEVC…' : null
  const pngBlocker = queueActive ? 'Espere a fila de exportações terminar para exportar o quadro.' : null
  const formatBlocker = format === 'video' ? (validation.blocker ?? codecBlocked) : format === 'gif' ? gifCheck.blocker : format === 'audio' ? audioBlocker : pngBlocker
  const formatWarnings = format === 'video' ? validation.warnings : format === 'gif' ? gifCheck.warnings : []
  const blocker = formatBlocker ?? (!targetFolder ? 'Escolha a pasta de destino.' : !name ? 'Dê um nome ao arquivo.' : null)

  const pickPreset = (id: ExportPresetId): void => setExp({ settings: settingsForPreset(id, canvas), canvas: canvasKey(canvas) })
  const edit = (patch: Partial<ExportSettings>): void => setExp((cur) => (cur ? { ...cur, settings: { ...cur.settings, ...patch, customized: true } } : cur))
  // HEVC desativado só sem suporte (ou verificando); preset "só H.264" sem ajustes: escolher HEVC personaliza
  const hevcTitle = hevcState === 'checking' ? 'Verificando o suporte a HEVC…' : hevcState === 'no' ? 'HEVC não suportado neste computador' : undefined
  const hevcNote = hevcTitle ?? (!base.allowHevc && !customized ? `O preset “${base.label}” usa H.264 (compatibilidade); escolher HEVC personaliza o preset.` : undefined)
  const fpsOptions = fpsChoices(canvas.fps).map((f) => ({ value: String(f), label: formatFps(f), hint: f === canvas.fps ? 'do projeto' : undefined }))
  // trocar o formato: nome padrão do formato, ou só a extensão de um nome digitado
  const pickFormat = (f: ExportFormat, audio = audioFormat): void => {
    setFormat(f)
    setAudioFormat(audio)
    setFileName((cur) => (nameTouched ? outputFileName(cur.trim() || fileNameFromTitle(project.name) || 'Vídeo', formatExt(f, audio)) : defaultName(project, f, audio, playheadUs)))
  }

  // pedido da fila: instantâneo do projeto do editor agora (imutável), trecho, nome, pasta, configurações e os
  // avisos de privacidade deste momento
  const queueInput = (): EnqueueInput | null => {
    if (!targetFolder || blocker || isPng) return null
    const snapshot = useEditorStore.getState().project ?? project
    const common = { project: snapshot, outputDir: targetFolder, fileName: name, fromUs: range.fromUs, toUs: range.toUs }
    const presetLabel = format === 'video' ? `${base.label}${customized ? ' (personalizado)' : ''}` : format === 'gif' ? `GIF ${gif.width}×${gif.height}, ${gifOpts.fps} fps` : AUDIO_QUEUE_LABEL[audioFormat]
    const job: EnqueueInput['job'] =
      format === 'video'
        ? {
            kind: 'video',
            request: {
              ...common,
              ...exportRequestFor(s, durationUs),
              estimateBytes: estimate,
              // legendas: queimar (desligado com a faixa oculta) e/ou .srt ao lado do arquivo final (também pela fila)
              ...(captionCues(snapshot).length ? { captions: { ...captions, burn: captions.burn && !snapshot.tracks.find(isCaptionsTrack)?.hidden } } : {})
            }
          }
        : format === 'gif'
          ? { kind: 'gif', request: { ...common, ...gif, fps: gifOpts.fps, estimateBytes: gifDiskBytes(gif.width, gif.height, gifOpts.fps, range.fromUs, range.toUs) } }
          : { kind: 'audio', request: { ...common, format: audioFormat, estimateBytes: audioEstimate } }
    const warnings = format === 'audio' ? [] : privacyWarnings(snapshot, range.fromUs, range.toUs)
    return { job, label: `${name} · ${presetLabel} · ${formatClock(durationUs / 1000, false)}`, durationUs, privacy: warnings.map((w) => privacyLine(snapshot, w)) }
  }

  /** "Adicionar à fila": enfileira e mantém o diálogo aberto (para enfileirar outra variação). */
  const addToQueue = (): void => {
    const input = queueInput()
    if (!input) return
    const { position } = exportQueue.enqueue(input)
    toast.success(`Adicionado à fila (posição ${position})`, { description: input.label })
  }

  const start = async (): Promise<void> => {
    if (!targetFolder || blocker) return
    if (!isPng) {
      const input = queueInput()
      if (!input) return
      // fila ocupada: entra nela e o diálogo fecha; parada: começa já e o progresso aparece aqui
      const busy = exportQueue.active()
      const { id, position } = exportQueue.enqueue(input)
      if (busy) {
        toast.success(`Adicionado à fila (posição ${position})`, { description: input.label })
        onOpenChange(false)
      } else setPhase({ kind: 'queued', id, cancelling: false })
      return
    }
    if (editorExportRunning()) return
    onBeforeExport()
    const snapshot = useEditorStore.getState().project ?? project
    const ac = new AbortController()
    abortRef.current = ac
    setPhase({ kind: 'running', progress: null, cancelling: false })
    try {
      const result = await exportStill({ project: snapshot, outputDir: targetFolder, fileName: name, tUs: useEditorStore.getState().playheadUs }, { signal: ac.signal })
      setPhase({ kind: 'done', done: { kind: 'format', result } })
    } catch (e) {
      if (e instanceof EditorExportCancelled) setPhase({ kind: 'form' })
      else setPhase({ kind: 'error', message: ipcErrorMessage(e) })
    } finally {
      if (abortRef.current === ac) abortRef.current = null
    }
  }

  const cancel = (): void => {
    if (phase.kind === 'queued') {
      exportQueue.cancel(phase.id)
      setPhase({ ...phase, cancelling: true })
      return
    }
    abortRef.current?.abort()
    setPhase((p) => (p.kind === 'running' ? { ...p, cancelling: true } : p))
  }

  const [formTitle, doneTitle] = FORMAT_TITLE[format]
  const title = phase.kind === 'done' ? doneTitle : phase.kind === 'running' || phase.kind === 'queued' ? 'Exportando…' : phase.kind === 'error' ? 'A exportação falhou' : formTitle
  const label = (id: string): string => `${ids}-${id}`

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent title={title} hideClose={running} className="w-[min(680px,94vw)]">
        {phase.kind === 'form' ? (
          <div className="flex max-h-[min(78vh,760px)] flex-col gap-4 overflow-y-auto pr-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-medium text-fg-2">Formato</span>
              <Segmented size="sm" ariaLabel="Formato da exportação" value={format} onValueChange={(f) => pickFormat(f)} options={FORMAT_OPTIONS} />
            </div>

            {format === 'video' ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span id={label('presets')} className="text-[12px] font-medium text-fg-2">
                    Preset
                  </span>
                  {customized ? (
                    <span className="text-[11px] text-accent-2" data-export-custom="">
                      Personalizado (a partir de {base.label})
                    </span>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={label('presets')}>
                  {EXPORT_PRESETS.map((p) => {
                    const av = presetAvailability(p.id, canvas, durationUs)
                    const selected = s.presetId === p.id
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={!av.ok}
                        disabled={!av.ok}
                        title={av.ok ? p.hint : av.reason}
                        data-preset={p.id}
                        onClick={() => pickPreset(p.id)}
                        className={cn(
                          'rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55',
                          selected ? 'border-accent/70 bg-accent/10' : 'border-border-strong bg-bg-2 enabled:hover:border-white/20'
                        )}
                      >
                        <span className="block text-[13px] font-semibold text-fg">
                          {p.label}
                          {selected && customized ? <span className="ml-1.5 text-[11px] font-medium text-accent-2">· Personalizado</span> : null}
                        </span>
                        <span className={cn('block text-[11px]', av.ok ? 'text-muted' : 'text-warn')}>{av.ok ? p.hint : av.reason}</span>
                      </button>
                    )
                  })}
                </div>

                <div className="rounded-xl border border-border">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-fg-2 hover:text-fg"
                    aria-expanded={customOpen}
                    aria-controls={label('custom')}
                    onClick={() => setCustomOpen((v) => !v)}
                    data-export-customize=""
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Personalizar
                    <span className="ml-auto text-[11px] font-normal text-muted">
                      {s.width}×{s.height} · {formatFps(s.fps)} · {s.quality.kind === 'bitrate' ? formatMbps(s.quality.bps) : `alvo ${s.quality.mb.toLocaleString('pt-BR')} MB`} · {CODEC_LABEL[s.codec]}
                    </span>
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', customOpen && 'rotate-180')} />
                  </button>
                  {customOpen ? (
                    <div id={label('custom')} className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5 border-t border-border px-3 py-3" data-export-custom-panel="">
                      <span className="text-[12px] text-fg-2">Resolução</span>
                      <div className="flex items-center gap-2">
                        <NumberField
                          id={label('w')}
                          ariaLabel="Largura (pixels)"
                          value={s.width}
                          step={2}
                          commitOnBlur
                          onCommit={(v) => edit(sizeForWidth(v, canvas))}
                        />
                        <span className="text-muted">×</span>
                        <NumberField
                          id={label('h')}
                          ariaLabel="Altura (pixels)"
                          value={s.height}
                          step={2}
                          commitOnBlur
                          onCommit={(v) => edit(sizeForHeight(v, canvas))}
                        />
                        <span className="text-[11px] text-muted">proporção do projeto mantida</span>
                      </div>

                      <label htmlFor={label('fps')} className="text-[12px] text-fg-2">
                        Quadros por segundo
                      </label>
                      <Select id={label('fps')} ariaLabel="Quadros por segundo" triggerClassName="h-8 w-40" value={String(s.fps)} options={fpsOptions} onValueChange={(v) => edit({ fps: Number(v) })} />

                      <span className="text-[12px] text-fg-2">Qualidade</span>
                      <div className="flex items-center gap-2">
                        <Segmented
                          size="sm"
                          ariaLabel="Tipo de qualidade"
                          value={s.quality.kind}
                          onValueChange={(k) =>
                            edit({ quality: k === 'bitrate' ? { kind: 'bitrate', bps: Math.round(videoBps / 100_000) * 100_000 } : { kind: 'target', mb: Math.max(1, Math.round(estimate / (1024 * 1024))) } })
                          }
                          options={[
                            { value: 'bitrate', label: 'Taxa (Mbps)' },
                            { value: 'target', label: 'Tamanho alvo (MB)' }
                          ]}
                        />
                        {s.quality.kind === 'bitrate' ? (
                          <NumberField id={label('bps')} ariaLabel="Taxa de vídeo em Mbps" value={s.quality.bps / 1e6} step={0.5} onCommit={(v) => edit({ quality: { kind: 'bitrate', bps: Math.round(v * 1e6) } })} />
                        ) : (
                          <NumberField id={label('mb')} ariaLabel="Tamanho alvo em MB" value={s.quality.mb} step={1} onCommit={(v) => edit({ quality: { kind: 'target', mb: v } })} />
                        )}
                      </div>

                      <span className="text-[12px] text-fg-2">Codec</span>
                      <div className="flex items-center gap-2" title={hevcTitle}>
                        <Segmented
                          size="sm"
                          ariaLabel="Codec de vídeo"
                          value={s.codec}
                          onValueChange={(c) => edit({ codec: c })}
                          options={[
                            { value: 'h264', label: 'H.264' },
                            { value: 'hevc', label: 'HEVC', disabled: !!hevcTitle && s.codec !== 'hevc', title: hevcTitle }
                          ]}
                        />
                        {hevcNote ? (
                          <span className="text-[11px] text-muted" data-hevc-note="">
                            {hevcNote}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted">HEVC: arquivo menor; nem todo aparelho reproduz</span>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {format === 'gif' ? (
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5 rounded-xl border border-border px-3 py-3" data-export-gif="">
                <span className="text-[12px] text-fg-2">Largura</span>
                <Segmented
                  size="sm"
                  ariaLabel="Largura do GIF"
                  value={String(gif.width)}
                  onValueChange={(v) => setGifOpts((o) => ({ ...o, width: Number(v) }))}
                  options={gifWidthOptions(canvas).map((w) => ({ value: String(w), label: `${w} px` }))}
                />
                <span className="text-[12px] text-fg-2">Quadros por segundo</span>
                <Segmented
                  size="sm"
                  ariaLabel="Quadros por segundo do GIF"
                  value={String(gifOpts.fps)}
                  onValueChange={(v) => setGifOpts((o) => ({ ...o, fps: Number(v) }))}
                  options={GIF_FPS.map((f) => ({ value: String(f), label: `${f} fps` }))}
                />
                <span className="col-span-2 text-[11px] text-muted">Sem áudio · repete sem parar · até 30 s (use I–O para escolher o trecho)</span>
              </div>
            ) : null}

            {format === 'audio' ? (
              <div className="flex items-center justify-between gap-3" data-export-audio="">
                <label htmlFor={label('afmt')} className="text-[12px] font-medium text-fg-2">
                  Formato do áudio
                </label>
                <Select
                  id={label('afmt')}
                  ariaLabel="Formato do áudio"
                  triggerClassName="h-8 w-56"
                  value={audioFormat}
                  options={AUDIO_FORMATS.map((f) => ({ value: f.id, label: f.label, hint: f.hint }))}
                  onValueChange={(v) => pickFormat('audio', v as AudioFormat)}
                />
              </div>
            ) : null}

            {isPng ? (
              <div className="rounded-xl border border-border px-3 py-2.5 text-[12px] text-fg-2" data-export-png="">
                Quadro na posição do cursor (<span className="font-mono tabular-nums text-fg">{formatTimecode(playheadUs / 1000)}</span>), no tamanho do projeto ({canvas.width}×{canvas.height}). Atalho no editor: Ctrl+Shift+E.
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-medium text-fg-2">Intervalo</span>
                <Segmented
                  size="sm"
                  ariaLabel="Intervalo exportado"
                  value={rangeMode}
                  onValueChange={setRangeMode}
                  options={[
                    { value: 'all', label: 'Tudo' },
                    { value: 'inout', label: 'Entrada–Saída (I–O)', disabled: !inOutUsable, title: inOutUsable ? undefined : 'Marque a entrada (I) e/ou a saída (O) na linha do tempo' }
                  ]}
                />
              </div>
            )}

            {!isPng ? <ChaptersSection markers={project.markers} fromUs={range.fromUs} toUs={range.toUs} projectName={project.name} folder={targetFolder} /> : null}

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-fg-2">Nome do arquivo</span>
              <input
                className="h-10 rounded-xl border border-border-strong bg-bg-2 px-3 text-[13px] text-fg outline-none focus:border-accent/60"
                value={fileName}
                onChange={(e) => {
                  setFileName(e.target.value)
                  setNameTouched(true)
                }}
                onKeyDown={(e) => {
                  // com mídia indisponível, só o botão "Exportar mesmo assim" confirma
                  if (e.key === 'Enter' && !blocker && !issues.length) void start()
                }}
                spellCheck={false}
                data-export-name=""
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-fg-2">Pasta</span>
              <PathField value={folder} defaultPath={defaultFolder} onChange={setFolder} />
            </div>

            <div className="rounded-xl border border-border bg-bg-2/60 px-3 py-2.5 text-[12px] text-fg-2" data-export-estimate="" aria-live="polite">
              {format === 'video' && durationUs > 0 ? (
                <>
                  <span className="block">
                    <span className="font-semibold text-fg">≈ {formatBytes(estimate)}</span> · {s.width}×{s.height} · {formatFps(s.fps)} · {CODEC_LABEL[s.codec]}
                  </span>
                  <span className="block text-[11px] text-muted">
                    {formatClock(durationUs / 1000, false)} · vídeo {formatMbps(videoBps)}
                    {hasAudio ? ` + áudio ${s.audioKbps} kbps` : ' · sem áudio'}
                    {s.quality.kind === 'target' ? ` · alvo ${s.quality.mb.toLocaleString('pt-BR')} MB (refeito se passar)` : ''}
                  </span>
                </>
              ) : null}
              {format === 'gif' && durationUs > 0 ? (
                <>
                  <span className="block">
                    <span className="font-semibold text-fg">≈ {formatBytes(gifEstimate)}</span> (estimativa aproximada) · GIF {gif.width}×{gif.height} · {gifOpts.fps} fps
                  </span>
                  <span className="block text-[11px] text-muted">{formatClock(durationUs / 1000, false)} · sem áudio · repete sem parar</span>
                </>
              ) : null}
              {format === 'audio' && durationUs > 0 ? (
                <>
                  <span className="block">
                    <span className="font-semibold text-fg">≈ {formatBytes(audioEstimate)}</span> · {AUDIO_DONE_LABEL[audioFormat]} · 48 kHz estéreo
                  </span>
                  <span className="block text-[11px] text-muted">{formatClock(durationUs / 1000, false)} · o mesmo áudio da exportação de vídeo</span>
                </>
              ) : null}
              {isPng ? (
                <span className="block">
                  PNG {canvas.width}×{canvas.height} · sem perdas · em {formatTimecode(playheadUs / 1000)}
                </span>
              ) : null}
              {formatWarnings.length ? (
                <ul className="mt-1.5 flex flex-col gap-0.5 text-warn" data-export-warnings="">
                  {formatWarnings.map((w) => (
                    <li key={w} className="flex items-start gap-1.5">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              ) : null}
              {blocker ? (
                <span className="mt-1.5 flex items-start gap-1.5 text-warn" role="alert" data-export-blocker="">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {blocker}
                </span>
              ) : null}
            </div>

            {issues.length ? (
              <div className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12px] text-warn" role="alert">
                <span className="flex items-start gap-1.5 font-semibold">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {issues.length === 1 ? 'Uma mídia deste trecho não está disponível' : `${issues.length} mídias deste trecho não estão disponíveis`} e vai sair como “mídia indisponível” (ou em silêncio):
                </span>
                <ul className="mt-1.5 flex max-h-28 flex-col gap-0.5 overflow-y-auto pl-5">
                  {issues.map((i) => (
                    <li key={i.assetId} className="truncate" title={i.name}>
                      {i.name} — {ISSUE_LABEL[i.status]}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {missingFonts.map((f) => (
              <MissingFontNotice key={f} family={f} onReplace={() => replaceProjectFont(f)} />
            ))}

            {voiceIssues.failed.length ? (
              <div className="flex items-start gap-1.5 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12px] text-warn" role="alert" data-audio-failed="">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  O tratamento de voz (redução de ruído/normalização) falhou em {voiceIssues.failed.map((n) => `“${n}”`).join(', ')}: esses trechos saem com o áudio original. Use “Tentar de novo” no inspetor de áudio.
                </span>
              </div>
            ) : null}
            {voiceIssues.pending.length ? (
              <div className="flex items-start gap-1.5 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12px] text-warn" role="status" data-audio-pending="">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  O tratamento de voz de {voiceIssues.pending.map((n) => `“${n}”`).join(', ')} ainda está sendo processado. Exportando agora, esses trechos saem com o áudio original.
                </span>
              </div>
            ) : null}

            {format === 'video' && hasCaptions ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" role="group" aria-label="Legendas" data-export-captions="">
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
                  <Captions className="h-3.5 w-3.5" /> Legendas
                </span>
                <label className={cn('flex items-center gap-1.5 text-[12px] text-fg', captionsHidden ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')} title={captionsHidden ? 'A faixa Legendas está oculta: mostre-a para queimar as legendas no vídeo' : undefined}>
                  <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={captions.burn && !captionsHidden} disabled={captionsHidden} onChange={(e) => setCaptions({ burn: e.target.checked })} data-caption-burn="" aria-describedby={captionsHidden ? 'caption-burn-hint' : undefined} />
                  Queimar no vídeo
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={captions.srtBeside} onChange={(e) => setCaptions({ srtBeside: e.target.checked })} data-caption-srt="" />
                  Salvar arquivo .srt ao lado
                </label>
                {captionsHidden ? (
                  <span id="caption-burn-hint" className="basis-full text-[11px] text-muted" data-caption-hidden-hint="">
                    A faixa Legendas está oculta, então nada é queimado no vídeo. Mostre a faixa (ícone do olho) para queimar; o arquivo .srt continua com as legendas.
                  </span>
                ) : null}
              </div>
            ) : null}

            {privacy.length ? <PrivacySection warnings={privacy} onReview={review} /> : null}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              {!isPng ? (
                <Button variant="secondary" disabled={!!blocker} title={blocker ?? 'Exporta depois das que já estão na fila; o diálogo continua aberto'} onClick={addToQueue} data-export-enqueue="">
                  <ListPlus className="h-4 w-4" /> Adicionar à fila
                </Button>
              ) : null}
              <Button variant={issues.length ? 'secondary' : 'primary'} disabled={!!blocker} title={blocker ?? undefined} onClick={() => void start()} data-export-start="">
                <Upload className="h-4 w-4" /> {issues.length ? 'Exportar mesmo assim' : 'Exportar'}
              </Button>
            </div>
          </div>
        ) : null}

        {phase.kind === 'running' ? <RunningView format={format} progress={phase.progress} cancelling={phase.cancelling} onCancel={cancel} /> : null}
        {phase.kind === 'queued' && (watched?.state === 'running' || watched?.state === 'pending') ? (
          <RunningView format={watched.job.kind} progress={watched.progress} cancelling={phase.cancelling} onCancel={cancel} onBackground={() => onOpenChange(false)} />
        ) : null}

        {phase.kind === 'done' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-xl border border-border bg-bg-2/60 p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ok/15 text-ok">
                <CircleCheckBig className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold" title={phase.done.result.path}>
                  {phase.done.result.path.split(/[\\/]/).pop()}
                </span>
                {phase.done.kind === 'video' ? <VideoDoneInfo result={phase.done.result} /> : <FormatDoneInfo result={phase.done.result} />}
              </span>
            </div>
            {phase.done.kind === 'video' ? <ChaptersSection markers={project.markers} fromUs={range.fromUs} toUs={range.toUs} projectName={project.name} folder={targetFolder} defaultOpen={project.markers.length > 0} /> : null}
            {phase.done.result.warnings.length ? (
              <ul className="flex flex-col gap-1 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
                {phase.done.result.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{w}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Fechar
              </Button>
              <Button variant="secondary" onClick={() => void copyOutputFile(phase.done.result.path)}>
                <Copy className="h-4 w-4" /> Copiar arquivo
              </Button>
              <Button variant="primary" onClick={() => showOutputInFolder(phase.done.result.path)}>
                <FolderOpen className="h-4 w-4" /> Abrir pasta
              </Button>
            </div>
          </div>
        ) : null}

        {phase.kind === 'error' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12px] text-danger">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{phase.message}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Fechar
              </Button>
              <Button variant="secondary" onClick={() => setPhase({ kind: 'form' })}>
                Voltar
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Campo numérico com rascunho: digitar não reformata. `commitOnBlur`: aplica só ao sair/Enter (a resolução
 * recalcula o outro lado); sem ele, aplica a cada número válido. Valor inválido ao sair volta ao atual.
 */
function NumberField({ id, ariaLabel, value, step, commitOnBlur, onCommit }: { id: string; ariaLabel: string; value: number; step: number; commitOnBlur?: boolean; onCommit: (v: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const parse = (t: string): number | null => {
    const n = Number(t.replace(',', '.'))
    return t.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
  }
  const commit = (): void => {
    const n = parse(draft)
    if (n === null) setDraft(String(value))
    else if (n !== value) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      type="text"
      inputMode="decimal"
      data-step={step}
      className="h-8 w-20 rounded-lg border border-border-strong bg-bg-2 px-2 text-right font-mono text-[12px] tabular-nums text-fg outline-none focus:border-accent/60"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        if (!commitOnBlur) {
          const n = parse(e.target.value)
          if (n !== null && n !== value) onCommit(n)
        }
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      spellCheck={false}
    />
  )
}

function PrivacySection({ warnings, onReview }: { warnings: PrivacyWarning[]; onReview: (w: PrivacyWarning) => void }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  if (!project) return null
  return (
    <div data-privacy-warnings="" className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12px] text-warn" role="status">
      <span className="flex items-start gap-1.5 font-semibold">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Privacidade
      </span>
      <ul className="mt-1.5 flex max-h-32 flex-col gap-1 overflow-y-auto">
        {warnings.map((w) => {
          const f = findItem(project, w.itemId)
          const item = f?.item
          const name = item?.type === 'effect' ? (item.name ?? EFFECT_LABEL[item.effect]) : 'Efeito'
          return (
            <li key={`${w.itemId}:${w.kind}`} className="flex items-center gap-2 pl-5">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">
                  {name}
                  {` em ${formatClock(w.tUs / 1000, false)}`}
                </span>
                {' — '}
                {w.message}
              </span>
              <Button variant="secondary" size="sm" className="h-6 shrink-0 rounded-md px-2 text-[11px]" onClick={() => onReview(w)}>
                Revisar
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function VideoDoneInfo({ result }: { result: EditorExportResult }): React.JSX.Element {
  return (
    <>
      <span className="block text-[11px] text-muted" data-export-done-info="">
        MP4 · {CODEC_LABEL[result.codec]} · {result.width}×{result.height} · {formatFps(result.fps)} · {formatBytes(result.size)}
        {result.audioCodec ? ` · áudio ${result.audioCodec === 'aac' ? 'AAC' : 'Opus'} ${Math.round(result.audioBitrate / 1000)} kbps` : ''}
        {result.passes > 1 ? ` · ${result.passes} passadas (refeito para caber no tamanho alvo)` : ''}
      </span>
      {result.fellBackFromHevc ? <span className="block text-[11px] text-warn">O HEVC falhou neste computador; o vídeo saiu em H.264.</span> : null}
      {result.fellBackToX264 ? (
        <span className="block text-[11px] text-muted">Codificado com o codificador de reserva (libx264): os codificadores de vídeo do sistema falharam.</span>
      ) : result.fellBackToSoftware ? (
        <span className="block text-[11px] text-muted">Codificado em software (o encoder de hardware falhou).</span>
      ) : null}
      {result.srtPath ? (
        <span className="block truncate text-[11px] text-muted" title={result.srtPath} data-export-srt="">
          Legendas: {result.srtPath.split(/[\\/]/).pop()}
        </span>
      ) : null}
    </>
  )
}

function FormatDoneInfo({ result }: { result: FormatExportResult }): React.JSX.Element {
  const info =
    result.kind === 'gif'
      ? `GIF · ${result.width}×${result.height} · ${result.fps} fps · ${result.frames} quadros · repete sem parar`
      : result.kind === 'png'
        ? `PNG · ${result.width}×${result.height}`
        : `${AUDIO_DONE_LABEL[result.format ?? 'wav']} · 48 kHz estéreo`
  return (
    <span className="block text-[11px] text-muted" data-export-done-info="">
      {info} · {formatBytes(result.size)}
    </span>
  )
}

/** Rótulo da etapa em andamento (por formato). */
function stageLabel(format: ExportFormat, progress: EditorExportProgress | null): string {
  if (!progress) return 'Preparando…'
  if (progress.stage === 'finalize') return format === 'gif' ? 'Gerando a paleta do GIF…' : 'Finalizando o arquivo…'
  if (progress.reserve) {
    const what = progress.stage === 'resize' ? 'ajustando tamanho' : progress.total ? `quadro ${progress.frame} de ${progress.total}` : 'preparando o áudio'
    return `Codificador de reserva… ${what}`
  }
  if (progress.stage === 'resize') return `Ajustando tamanho… quadro ${progress.frame} de ${progress.total}`
  if (format === 'audio') return 'Mixando o áudio…'
  return `Quadro ${progress.frame} de ${progress.total}`
}

function RunningView({ format, progress, cancelling, onCancel, onBackground }: { format: ExportFormat; progress: EditorExportProgress | null; cancelling: boolean; onCancel: () => void; onBackground?: () => void }): React.JSX.Element {
  const pct = progress?.percent ?? 0
  const finalizing = progress?.stage === 'finalize'
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] text-fg-2">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {cancelling ? 'Cancelando…' : stageLabel(format, progress)}
        </span>
        <span className="font-mono text-[13px] font-semibold tabular-nums text-fg">{Math.floor(pct)}%</span>
      </div>
      <Progress value={pct} />
      <div className="flex justify-between text-[11px] text-muted">
        <span>{progress?.speed ? `${progress.speed.toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}× tempo real` : '—'}</span>
        <span>{progress?.etaS != null && !finalizing ? `faltam ${formatClock(progress.etaS * 1000, false)}` : ''}</span>
      </div>
      <div className="flex items-center justify-end gap-2">
        {onBackground ? (
          <>
            <span className="mr-auto text-[11px] text-muted">Pode fechar: a exportação continua em “Exportações”.</span>
            <Button variant="ghost" onClick={onBackground} data-export-background="">
              Continuar em segundo plano
            </Button>
          </>
        ) : null}
        <Button variant="secondary" onClick={onCancel} disabled={cancelling}>
          <X className="h-4 w-4" /> Cancelar
        </Button>
      </div>
    </div>
  )
}
