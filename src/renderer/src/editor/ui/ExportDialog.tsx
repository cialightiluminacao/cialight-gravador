import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, CircleCheckBig, Copy, FolderOpen, LoaderCircle, ShieldAlert, SlidersHorizontal, TriangleAlert, Upload, X } from 'lucide-react'
import { fileNameFromTitle, sanitizeFileName } from '@shared/filenames'
import { contentEndUs, findItem } from '@shared/editor/ops'
import { privacyWarnings, type PrivacyWarning } from '@shared/editor/privacy'
import { planAudio } from '@shared/editor/audioPlan'
import type { Project } from '@shared/editor/project'
import { audioProcessIssues } from './audioProcessing'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Progress, Segmented, Select } from '@/components/ui/primitives'
import { PathField } from '@/components/ui/PathField'
import { useAppStore } from '@/app/store'
import { formatBytes, formatClock } from '@/lib/format'
import { cn } from '@/lib/cn'
import { ipcErrorMessage } from '@/lib/ipcError'
import { copyOutputFile, showOutputInFolder } from '@/screens/Review/outputActions'
import { useEditorStore } from '../state/editorStore'
import { EditorExportCancelled, editorExportRunning, runEditorExport, type EditorExportProgress, type EditorExportResult } from '../export/editorExport'
import { exportMediaIssues, exportRange, hasInOut, type ExportMediaIssue } from '../export/exportPlan'
import {
  EXPORT_PRESETS,
  estimateFor,
  exportRequestFor,
  fpsChoices,
  outputFileName,
  presetAvailability,
  presetById,
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

// Diálogo de exportação do editor: preset (cartões com o motivo quando indisponível), "Personalizar"
// (resolução na proporção do projeto, fps, qualidade por taxa ou tamanho alvo, codec H.264/HEVC — HEVC só
// quando o hardware confirma), intervalo (tudo / I–O), nome e pasta, estimativa e avisos; um bloqueio desativa
// Exportar com o motivo. Depois: progresso (%, velocidade × tempo real, tempo restante, cancelar) e o resultado
// (codec usado, resolução, passadas, avisos; abrir pasta / copiar arquivo). A exportação usa workers próprios:
// o preview continua vivo (pausado ao começar). Avisos de privacidade do intervalo aparecem com "Revisar".

type Phase =
  | { kind: 'form' }
  | { kind: 'running'; progress: EditorExportProgress | null; cancelling: boolean }
  | { kind: 'done'; result: EditorExportResult }
  | { kind: 'error'; message: string }

const DEFAULT_PRESET: ExportPresetId = 'youtube1080'
const formatMbps = (bps: number): string => `${(bps / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps`
const formatFps = (fps: number): string => `${fps.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} fps`
const CODEC_LABEL: Record<VideoCodecChoice, string> = { h264: 'H.264', hevc: 'HEVC' }
const ISSUE_LABEL: Record<ExportMediaIssue['status'], string> = { missing: 'ausente', processing: 'ainda processando', error: 'com erro' }
const EFFECT_LABEL = { blur: 'Blur', pixelate: 'Pixelizar', solid: 'Tarja' } as const
const canvasKey = (c: Project['canvas']): string => `${c.width}x${c.height}@${c.fps}`

export function ExportDialog({ open, onOpenChange, onBeforeExport, onSeek }: { open: boolean; onOpenChange: (open: boolean) => void; onBeforeExport: () => void; onSeek: (us: number) => void }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const inUs = useEditorStore((s) => s.inUs)
  const outUs = useEditorStore((s) => s.outUs)
  const audioJobs = useEditorStore((s) => s.audioJobs)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  // preset de base (disponibilidade, HEVC permitido) + configurações (a verdade); qualquer ajuste → "Personalizado"
  const [exp, setExp] = useState<{ settings: ExportSettings; customized: boolean; canvas: string } | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [hevc, setHevc] = useState<{ key: string; ok: boolean } | null>(null)
  const [rangeMode, setRangeMode] = useState<'all' | 'inout'>('all')
  const [fileName, setFileName] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const ids = useId()

  // fim do conteúdo (sem efeitos e itens desativados): um efeito depois da mídia não estica "Tudo" com preto
  const totalUs = project ? contentEndUs(project) : 0
  const inOutUsable = hasInOut(totalUs, inUs, outUs)

  // ao abrir (fora de uma exportação): formulário com os padrões do projeto; ajustes personalizados valem
  // enquanto o quadro do projeto não muda (senão, volta ao preset — ou ao padrão, se ele deixou de servir)
  useEffect(() => {
    if (!open || !project || phase.kind === 'running') return
    setPhase({ kind: 'form' })
    setFileName(outputFileName(fileNameFromTitle(project.name) || 'Vídeo', 'mp4'))
    const range0 = hasInOut(contentEndUs(project), useEditorStore.getState().inUs, useEditorStore.getState().outUs)
    setRangeMode(range0 ? 'inout' : 'all')
    const key = canvasKey(project.canvas)
    setExp((cur) => {
      if (cur && cur.customized && cur.canvas === key) return cur
      const base = cur?.settings.presetId ?? DEFAULT_PRESET
      const id = presetAvailability(base, project.canvas, contentEndUs(project)).ok ? base : DEFAULT_PRESET
      return { settings: settingsForPreset(id, project.canvas), customized: false, canvas: key }
    })
  }, [open])

  // diálogo desmontado (editor fechado) no meio da exportação: cancela
  useEffect(() => () => abortRef.current?.abort(), [])

  // suporte a HEVC na resolução/fps de saída (cache por w×h@fps no hevcSupport)
  const s = exp?.settings
  const probeKey = s ? `${s.width}x${s.height}@${s.fps}` : ''
  useEffect(() => {
    if (!open || !s || !presetById(s.presetId)?.allowHevc) return
    let alive = true
    void probeHevc(s.width, s.height, s.fps).then((ok) => {
      if (alive) setHevc({ key: probeKey, ok })
    })
    return () => {
      alive = false
    }
  }, [open, probeKey, s?.presetId])

  if (!project || !exp || !s) return null
  const canvas = project.canvas
  const range = exportRange(totalUs, inUs, outUs, rangeMode)
  const durationUs = range.toUs - range.fromUs
  const hasAudio = planAudio(project).some((x) => x.mode !== 'mute')
  // redução de ruído/normalização ainda processando ou que falhou: a exportação sairia com o original nesses trechos
  const voiceIssues = audioProcessIssues(project, audioJobs, range.fromUs, range.toUs)
  const basePreset = presetById(s.presetId)
  const hevcState: 'checking' | 'ok' | 'no' = hevc?.key === probeKey ? (hevc.ok ? 'ok' : 'no') : 'checking'
  const validation = validateExport(s, canvas, durationUs, hevcState === 'ok')
  const videoBps = videoBitrateFor(s, durationUs)
  const estimate = estimateFor(s, durationUs, hasAudio)
  // pré-checagem: mídia do intervalo que sairia como "mídia indisponível" exige confirmação explícita
  const issues = durationUs > 0 ? exportMediaIssues(project, range.fromUs, range.toUs) : []
  const privacy = durationUs > 0 ? privacyWarnings(project, range.fromUs, range.toUs) : []
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
  const codecBlocked = s.codec === 'hevc' && hevcState === 'checking' ? 'Verificando o suporte a HEVC…' : null
  const blocker = validation.blocker ?? codecBlocked ?? (!targetFolder ? 'Escolha a pasta de destino.' : !name ? 'Dê um nome ao arquivo.' : null)

  const pickPreset = (id: ExportPresetId): void => setExp({ settings: settingsForPreset(id, canvas), customized: false, canvas: canvasKey(canvas) })
  const edit = (patch: Partial<ExportSettings>): void => setExp((cur) => (cur ? { ...cur, settings: { ...cur.settings, ...patch }, customized: true } : cur))
  const hevcTitle = !basePreset?.allowHevc
    ? `O preset “${basePreset?.label ?? ''}” usa só H.264 (compatibilidade).`
    : hevcState === 'checking'
      ? 'Verificando o suporte a HEVC…'
      : hevcState === 'no'
        ? 'HEVC não suportado neste computador'
        : undefined
  const fpsOptions = fpsChoices(canvas.fps).map((f) => ({ value: String(f), label: formatFps(f), hint: f === canvas.fps ? 'do projeto' : undefined }))

  const start = async (): Promise<void> => {
    if (!targetFolder || blocker || editorExportRunning()) return
    onBeforeExport()
    const snapshot = useEditorStore.getState().project ?? project
    const ac = new AbortController()
    abortRef.current = ac
    setPhase({ kind: 'running', progress: null, cancelling: false })
    try {
      const result = await runEditorExport(
        { project: snapshot, fromUs: range.fromUs, toUs: range.toUs, ...exportRequestFor(s, durationUs), outputDir: targetFolder, fileName: name, estimateBytes: estimate },
        { signal: ac.signal, onProgress: (progress) => setPhase((p) => (p.kind === 'running' ? { ...p, progress } : p)) }
      )
      setPhase({ kind: 'done', result })
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
  const label = (id: string): string => `${ids}-${id}`

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent title={title} hideClose={running} className="w-[min(680px,94vw)]">
        {phase.kind === 'form' ? (
          <div className="flex max-h-[min(78vh,760px)] flex-col gap-4 overflow-y-auto pr-1">
            <div className="flex items-baseline justify-between gap-3">
              <span id={label('presets')} className="text-[12px] font-medium text-fg-2">
                Preset
              </span>
              {exp.customized ? (
                <span className="text-[11px] text-accent-2" data-export-custom="">
                  Personalizado (a partir de {basePreset?.label})
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
                      {selected && exp.customized ? <span className="ml-1.5 text-[11px] font-medium text-accent-2">· Personalizado</span> : null}
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
                    {hevcTitle ? (
                      <span className="text-[11px] text-muted" data-hevc-note="">
                        {hevcTitle}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted">HEVC: arquivo menor; nem todo aparelho reproduz</span>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

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
                data-export-name=""
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-fg-2">Pasta</span>
              <PathField value={folder} defaultPath={defaultFolder} onChange={setFolder} />
            </div>

            <div className="rounded-xl border border-border bg-bg-2/60 px-3 py-2.5 text-[12px] text-fg-2" data-export-estimate="" aria-live="polite">
              {durationUs > 0 ? (
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
              {validation.warnings.length ? (
                <ul className="mt-1.5 flex flex-col gap-0.5 text-warn" data-export-warnings="">
                  {validation.warnings.map((w) => (
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

            {privacy.length ? <PrivacySection warnings={privacy} onReview={review} /> : null}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button variant={issues.length ? 'secondary' : 'primary'} disabled={!!blocker} title={blocker ?? undefined} onClick={() => void start()} data-export-start="">
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
                <span className="block text-[11px] text-muted" data-export-done-info="">
                  MP4 · {CODEC_LABEL[phase.result.codec]} · {phase.result.width}×{phase.result.height} · {formatFps(phase.result.fps)} · {formatBytes(phase.result.size)}
                  {phase.result.passes > 1 ? ` · ${phase.result.passes} passadas (refeito para caber no tamanho alvo)` : ''}
                </span>
                {phase.result.fellBackFromHevc ? <span className="block text-[11px] text-warn">O HEVC falhou neste computador; o vídeo saiu em H.264.</span> : null}
                {phase.result.fellBackToSoftware ? <span className="block text-[11px] text-muted">Codificado em software (o encoder de hardware falhou).</span> : null}
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
