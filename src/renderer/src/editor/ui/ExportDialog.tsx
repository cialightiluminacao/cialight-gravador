import { useEffect, useRef, useState } from 'react'
import { Captions, CircleCheckBig, Copy, FolderOpen, LoaderCircle, ShieldAlert, TriangleAlert, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { fileNameFromTitle, sanitizeFileName } from '@shared/filenames'
import { captionCues, contentEndUs, findItem } from '@shared/editor/ops'
import { privacyWarnings, type PrivacyWarning } from '@shared/editor/privacy'
import { planAudio } from '@shared/editor/audioPlan'
import { audioProcessIssues } from './audioProcessing'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Progress, Segmented } from '@/components/ui/primitives'
import { PathField } from '@/components/ui/PathField'
import { useAppStore } from '@/app/store'
import { formatBytes, formatClock } from '@/lib/format'
import { cn } from '@/lib/cn'
import { ipcErrorMessage } from '@/lib/ipcError'
import { copyOutputFile, showOutputInFolder } from '@/screens/Review/outputActions'
import { useEditorStore } from '../state/editorStore'
import { EditorExportCancelled, editorExportRunning, runEditorExport, type EditorExportProgress, type EditorExportResult } from '../export/editorExport'
import { AUDIO_KBPS, EDITOR_EXPORT_PRESETS, estimateBytes, exportMediaIssues, exportRange, hasInOut, outputSize, presetVideoBitrate, WHATSAPP_TARGET_MB, type EditorExportPresetId, type ExportMediaIssue } from '../export/exportPlan'

// Diálogo de exportação do editor: preset, intervalo (tudo / I–O), nome e pasta, estimativa de tamanho;
// depois progresso (%, velocidade × tempo real, tempo restante, cancelar) e o resultado (abrir pasta /
// copiar arquivo). A exportação usa workers próprios: o preview continua vivo (pausado ao começar).
// Avisos de privacidade do intervalo (efeito fraco/desativado) aparecem com "Revisar"; nunca bloqueiam.

type Phase =
  | { kind: 'form' }
  | { kind: 'running'; progress: EditorExportProgress | null; cancelling: boolean }
  | { kind: 'done'; result: EditorExportResult }
  | { kind: 'error'; message: string }

const formatMbps = (bps: number): string => `${(bps / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps`
const ISSUE_LABEL: Record<ExportMediaIssue['status'], string> = { missing: 'ausente', processing: 'ainda processando', error: 'com erro' }
const EFFECT_LABEL = { blur: 'Blur', pixelate: 'Pixelizar', solid: 'Tarja' } as const
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
  const [preset, setPreset] = useState<EditorExportPresetId>('high1080')
  const [rangeMode, setRangeMode] = useState<'all' | 'inout'>('all')
  const [fileName, setFileName] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [captions, setCaptionsState] = useState(captionChoice)
  const setCaptions = (patch: Partial<typeof captionChoice>): void => {
    captionChoice = { ...captionChoice, ...patch }
    setCaptionsState(captionChoice)
  }
  const abortRef = useRef<AbortController | null>(null)

  // fim do conteúdo (sem efeitos e itens desativados): um efeito depois da mídia não estica "Tudo" com preto
  const totalUs = project ? contentEndUs(project) : 0
  const inOutUsable = hasInOut(totalUs, inUs, outUs)

  // ao abrir (fora de uma exportação): formulário com os padrões do projeto
  useEffect(() => {
    if (!open || !project || phase.kind === 'running') return
    setPhase({ kind: 'form' })
    setFileName(`${fileNameFromTitle(project.name) || 'Vídeo'}.mp4`)
    setRangeMode(hasInOut(contentEndUs(project), useEditorStore.getState().inUs, useEditorStore.getState().outUs) ? 'inout' : 'all')
    setCaptionsState(captionChoice)
  }, [open])

  // diálogo desmontado (editor fechado) no meio da exportação: cancela
  useEffect(() => () => abortRef.current?.abort(), [])

  if (!project) return null
  const range = exportRange(totalUs, inUs, outUs, rangeMode)
  const durationUs = range.toUs - range.fromUs
  const size = outputSize(preset, project.canvas)
  const fps = project.canvas.fps
  const videoBps = presetVideoBitrate(preset, fps, durationUs)
  const hasAudio = planAudio(project).some((s) => s.mode !== 'mute')
  // redução de ruído/normalização ainda processando ou que falhou: a exportação sairia com o original nesses trechos
  const voiceIssues = audioProcessIssues(project, audioJobs, range.fromUs, range.toUs)
  const audioBps = hasAudio ? AUDIO_KBPS * 1000 : 0
  const estimate = estimateBytes(videoBps, audioBps, durationUs)
  // pré-checagem: mídia do intervalo que sairia como "mídia indisponível" exige confirmação explícita
  const issues = durationUs > 0 ? exportMediaIssues(project, range.fromUs, range.toUs) : []
  const privacy = durationUs > 0 ? privacyWarnings(project, range.fromUs, range.toUs) : []
  // legendas habilitadas (o projeto tem legendas: mostra "Queimar no vídeo" / "Salvar arquivo .srt ao lado")
  const hasCaptions = captionCues(project).length > 0
  // "Revisar": seleciona o efeito, leva o playhead ao instante do aviso (o mais fraco, o início da mídia por
  // cima…, sempre dentro do intervalo) e fecha o diálogo
  const review = (w: PrivacyWarning): void => {
    if (!findItem(project, w.itemId)) return
    useEditorStore.getState().select([w.itemId])
    onSeek(Math.min(Math.max(w.tUs, range.fromUs), Math.max(range.fromUs, range.toUs - 1)))
    onOpenChange(false)
  }
  // QA (só fora do pacote): window.__qaEditor.exportDir troca a pasta padrão (o QA nunca grava na pasta real)
  const qaDir = appInfo?.isPackaged === false ? window.__qaEditor?.exportDir : undefined
  const defaultFolder = qaDir ?? settings.outputDir ?? appInfo?.paths.output ?? null
  const targetFolder = folder ?? defaultFolder
  const name = sanitizeFileName(fileName.trim())
  const running = phase.kind === 'running'
  const blocker = !size
    ? 'Mude a proporção do projeto para 9:16 para usar o preset Vertical.'
    : durationUs <= 0
      ? 'A linha do tempo está vazia.'
      : !targetFolder
        ? 'Escolha a pasta de destino.'
        : !name
          ? 'Dê um nome ao arquivo.'
          : null

  const start = async (): Promise<void> => {
    if (!size || !targetFolder || blocker || editorExportRunning()) return
    onBeforeExport()
    const snapshot = useEditorStore.getState().project ?? project
    const ac = new AbortController()
    abortRef.current = ac
    setPhase({ kind: 'running', progress: null, cancelling: false })
    try {
      const result = await runEditorExport(
        {
          project: snapshot,
          width: size.width,
          height: size.height,
          fps,
          fromUs: range.fromUs,
          toUs: range.toUs,
          videoBitrate: videoBps,
          audioBitrate: AUDIO_KBPS * 1000,
          outputDir: targetFolder,
          fileName: name,
          estimateBytes: estimate,
          ...(preset === 'whatsapp' ? { targetBytes: WHATSAPP_TARGET_MB * 1024 * 1024 } : {}),
          ...(captionCues(snapshot).length ? { captions } : {})
        },
        { signal: ac.signal, onProgress: (progress) => setPhase((p) => (p.kind === 'running' ? { ...p, progress } : p)) }
      )
      setPhase({ kind: 'done', result })
      if (result.srtPath) toast.success('Legendas salvas ao lado do vídeo', { description: result.srtPath })
    } catch (e) {
      if (e instanceof EditorExportCancelled) setPhase({ kind: 'form' })
      else setPhase({ kind: 'error', message: ipcErrorMessage(e) })
    } finally {
      if (abortRef.current === ac) abortRef.current = null
    }
  }

  const cancel = (): void => {
    abortRef.current?.abort()
    setPhase((p) => (p.kind === 'running' ? { ...p, cancelling: true } : p))
  }

  const title = phase.kind === 'done' ? 'Vídeo exportado' : phase.kind === 'running' ? 'Exportando…' : phase.kind === 'error' ? 'A exportação falhou' : 'Exportar vídeo'

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent title={title} hideClose={running} className="w-[min(600px,94vw)]">
        {phase.kind === 'form' ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Preset de exportação">
              {EDITOR_EXPORT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={preset === p.id}
                  onClick={() => setPreset(p.id)}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 text-left transition-colors',
                    preset === p.id ? 'border-accent/70 bg-accent/10' : 'border-border-strong bg-bg-2 hover:border-white/20'
                  )}
                >
                  <span className="block text-[13px] font-semibold text-fg">{p.label}</span>
                  <span className="block text-[11px] text-muted">{p.hint}</span>
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-medium text-fg-2">Intervalo</span>
              <Segmented
                size="sm"
                value={rangeMode}
                onValueChange={setRangeMode}
                options={[
                  { value: 'all', label: 'Tudo' },
                  { value: 'inout', label: 'Entrada–Saída (I–O)', disabled: !inOutUsable, title: inOutUsable ? undefined : 'Marque a entrada (I) e/ou a saída (O) na linha do tempo' }
                ]}
              />
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-fg-2">Nome do arquivo</span>
              <input
                className="h-10 rounded-xl border border-border-strong bg-bg-2 px-3 text-[13px] text-fg outline-none focus:border-accent/60"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  // com mídia indisponível, só o botão "Exportar mesmo assim" confirma
                  if (e.key === 'Enter' && !blocker && !issues.length) void start()
                }}
                spellCheck={false}
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-fg-2">Pasta</span>
              <PathField value={folder} defaultPath={defaultFolder} onChange={setFolder} />
            </div>

            <div className="rounded-xl border border-border bg-bg-2/60 px-3 py-2.5 text-[12px] text-fg-2">
              {size ? (
                <span>
                  {size.width}×{size.height} · {fps} fps · {formatClock(durationUs / 1000, false)} · H.264 {formatMbps(videoBps)}
                  {hasAudio ? ` + AAC ${AUDIO_KBPS} kbps` : ' · sem áudio'} ·{' '}
                  <span className="font-semibold text-fg">≈ {formatBytes(estimate)}</span>
                </span>
              ) : null}
              {blocker ? (
                <span className={cn('flex items-start gap-1.5 text-warn', size && 'mt-1.5')}>
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

            {hasCaptions ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" role="group" aria-label="Legendas" data-export-captions="">
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
                  <Captions className="h-3.5 w-3.5" /> Legendas
                </span>
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={captions.burn} onChange={(e) => setCaptions({ burn: e.target.checked })} data-caption-burn="" />
                  Queimar no vídeo
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={captions.srtBeside} onChange={(e) => setCaptions({ srtBeside: e.target.checked })} data-caption-srt="" />
                  Salvar arquivo .srt ao lado
                </label>
              </div>
            ) : null}

            {privacy.length ? <PrivacySection warnings={privacy} onReview={review} /> : null}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button variant={issues.length ? 'secondary' : 'primary'} disabled={!!blocker} onClick={() => void start()}>
                <Upload className="h-4 w-4" /> {issues.length ? 'Exportar mesmo assim' : 'Exportar'}
              </Button>
            </div>
          </div>
        ) : null}

        {phase.kind === 'running' ? <RunningView progress={phase.progress} cancelling={phase.cancelling} onCancel={cancel} /> : null}

        {phase.kind === 'done' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-xl border border-border bg-bg-2/60 p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ok/15 text-ok">
                <CircleCheckBig className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold" title={phase.result.path}>
                  {phase.result.path.split(/[\\/]/).pop()}
                </span>
                <span className="block text-[11px] text-muted">
                  MP4 · {formatBytes(phase.result.size)}
                  {phase.result.fellBackToSoftware ? ' · codificado em software (o encoder de hardware falhou)' : ''}
                  {phase.result.passes > 1 ? ' · refeito para caber no tamanho-alvo' : ''}
                </span>
                {phase.result.srtPath ? (
                  <span className="block truncate text-[11px] text-muted" title={phase.result.srtPath} data-export-srt="">
                    Legendas: {phase.result.srtPath.split(/[\\/]/).pop()}
                  </span>
                ) : null}
              </span>
            </div>
            {phase.result.warnings.length ? (
              <ul className="flex flex-col gap-1 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
                {phase.result.warnings.map((w) => (
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
              <Button variant="secondary" onClick={() => void copyOutputFile(phase.result.path)}>
                <Copy className="h-4 w-4" /> Copiar arquivo
              </Button>
              <Button variant="primary" onClick={() => showOutputInFolder(phase.result.path)}>
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

function RunningView({ progress, cancelling, onCancel }: { progress: EditorExportProgress | null; cancelling: boolean; onCancel: () => void }): React.JSX.Element {
  const pct = progress?.percent ?? 0
  const finalizing = progress?.stage === 'finalize'
  const resizing = progress?.stage === 'resize'
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] text-fg-2">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {cancelling
            ? 'Cancelando…'
            : finalizing
              ? 'Finalizando o arquivo…'
              : resizing
                ? `Ajustando tamanho… quadro ${progress.frame} de ${progress.total}`
                : progress
                  ? `Quadro ${progress.frame} de ${progress.total}`
                  : 'Preparando…'}
        </span>
        <span className="font-mono text-[13px] font-semibold tabular-nums text-fg">{Math.floor(pct)}%</span>
      </div>
      <Progress value={pct} />
      <div className="flex justify-between text-[11px] text-muted">
        <span>{progress?.speed ? `${progress.speed.toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}× tempo real` : '—'}</span>
        <span>{progress?.etaS != null && !finalizing ? `faltam ${formatClock(progress.etaS * 1000, false)}` : ''}</span>
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={cancelling}>
          <X className="h-4 w-4" /> Cancelar
        </Button>
      </div>
    </div>
  )
}
