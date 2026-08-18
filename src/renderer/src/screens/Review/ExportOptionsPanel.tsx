import { memo } from 'react'
import { Circle, FolderOpen, RotateCcw, Square } from 'lucide-react'
import type { AudioMode, ExportOptions, PipKeyframe, PipShape, Session } from '@shared/types'
import { PRESETS } from '@shared/presets/presets'
import { needsTwoPass, planForTarget } from '@shared/presets/sizeTarget'
import { Button } from '@/components/ui/Button'
import { Segmented, Slider, Toggle } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'

// Opções de exportação (spec §4.3 item 3). Só mostra o que faz sentido para a sessão
// (webcam/anotações/áudios gravados) e para o preset escolhido (alvo, Reels, separado).

export type PipCorner = 'tl' | 'tr' | 'bl' | 'br'
export type PipSize = 'p' | 'm' | 'g'
export type PipChoice = { mode: 'original' } | { mode: 'fixed'; corner: PipCorner; size: PipSize; shape: PipShape }

const PIP_SIZE_W: Record<PipSize, number> = { p: 0.16, m: 0.2, g: 0.28 }
/** Margem até a borda, em fração da largura (a vertical usa a mesma medida em pixels). */
const PIP_MARGIN_X = 0.03

/** Keyframe único (posição fixa) para a escolha; null = manter o movimento gravado. */
export function pipOverrideFor(choice: PipChoice, videoW: number, videoH: number): PipKeyframe[] | null {
  if (choice.mode === 'original') return null
  const aspect = videoW > 0 && videoH > 0 ? videoW / videoH : 16 / 9
  const w = PIP_SIZE_W[choice.size]
  const h = Math.min(1, w * aspect)
  const mx = PIP_MARGIN_X
  const my = PIP_MARGIN_X * aspect
  const x = choice.corner === 'tl' || choice.corner === 'bl' ? mx : 1 - w - mx
  const y = choice.corner === 'tl' || choice.corner === 'tr' ? my : 1 - h - my
  return [{ tMs: 0, x, y, w, h, shape: choice.shape, visible: true }]
}

/** Estimativa (MB) do preset atual — para avisar sobre 2 passes / qualidade baixa no alvo. */
export interface TargetHint {
  estimateMB: number
  durationMs: number
  srcHeight: number
}

interface Props {
  session: Session
  options: ExportOptions
  onChange: (patch: Partial<ExportOptions>) => void
  pipChoice: PipChoice
  onPipChoice: (update: (prev: PipChoice) => PipChoice) => void
  outputDir: string
  onPickFolder: () => void
  targetHint: TargetHint
}

const AUDIO_LABELS: Record<AudioMode, string> = { mix: 'Mixar', micOnly: 'Só microfone', systemOnly: 'Só sistema', separate: 'Separado' }

export const ExportOptionsPanel = memo(function ExportOptionsPanel({ session, options, onChange, pipChoice, onPipChoice, outputDir, onPickFolder, targetHint }: Props): React.JSX.Element {
  const preset = PRESETS[options.presetId]
  const hasWebcam = session.tracks.webcam !== undefined
  const hasStrokes = session.strokes.length > 0
  const hasMic = session.tracks.mic !== undefined
  const hasSystem = session.tracks.system !== undefined
  const canCompose = !preset.copyVideo

  const audioModes: AudioMode[] = []
  if (hasMic && hasSystem) audioModes.push('mix')
  if (hasMic) audioModes.push('micOnly')
  if (hasSystem) audioModes.push('systemOnly')
  if (options.presetId === 'separate' && (hasMic || hasSystem)) audioModes.push('separate')

  const target = options.targetSizeMB
  const targetPlan = target ? planForTarget(target, targetHint.durationMs, preset.audioKbps, targetHint.srcHeight) : null
  const targetTwoPass = target ? needsTwoPass(targetHint.estimateMB, target) : false

  return (
    <div className="divide-y divide-border">
      {hasWebcam ? (
        <Row label="Incluir webcam" hint={canCompose ? 'PiP composta no vídeo final' : 'Este preset não recompõe o vídeo'}>
          <Toggle checked={options.includeWebcam && canCompose} disabled={!canCompose} onCheckedChange={(v) => onChange({ includeWebcam: v })} size="sm" />
        </Row>
      ) : null}
      {hasWebcam && canCompose && options.includeWebcam ? (
        <div className="py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] font-medium">Posição da PiP</div>
            <Segmented<'original' | 'fixed'>
              size="sm"
              value={pipChoice.mode}
              onValueChange={(v) => onPipChoice(() => (v === 'original' ? { mode: 'original' } : { mode: 'fixed', corner: 'br', size: 'm', shape: session.pip[0]?.shape ?? 'circle' }))}
              options={[
                { value: 'original', label: 'Como gravado' },
                { value: 'fixed', label: 'Fixa' }
              ]}
            />
          </div>
          {pipChoice.mode === 'fixed' ? (
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <CornerPicker value={pipChoice.corner} onChange={(corner) => onPipChoice((prev) => (prev.mode === 'fixed' ? { ...prev, corner } : prev))} />
              <Segmented<PipSize>
                size="sm"
                value={pipChoice.size}
                onValueChange={(size) => onPipChoice((prev) => (prev.mode === 'fixed' ? { ...prev, size } : prev))}
                options={[
                  { value: 'p', label: 'P', title: 'Pequena' },
                  { value: 'm', label: 'M', title: 'Média' },
                  { value: 'g', label: 'G', title: 'Grande' }
                ]}
              />
              <Segmented<PipShape>
                size="sm"
                value={pipChoice.shape}
                onValueChange={(shape) => onPipChoice((prev) => (prev.mode === 'fixed' ? { ...prev, shape } : prev))}
                options={[
                  { value: 'circle', label: <Circle className="h-3.5 w-3.5" />, title: 'Círculo' },
                  { value: 'rounded', label: <Square className="h-3.5 w-3.5" />, title: 'Retângulo' }
                ]}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {hasStrokes ? (
        <Row label="Incluir anotações" hint={session.strokes.length === 1 ? '1 traço desenhado durante a gravação' : `${session.strokes.length} traços desenhados durante a gravação`}>
          <Toggle checked={options.includeAnnotations && canCompose} disabled={!canCompose} onCheckedChange={(v) => onChange({ includeAnnotations: v })} size="sm" />
        </Row>
      ) : null}

      {audioModes.length > 0 ? (
        <div className="py-2.5">
          <div className="mb-2 text-[13px] font-medium">Áudio</div>
          <Segmented<AudioMode> size="sm" className="w-full" value={options.audioMode} onValueChange={(audioMode) => onChange({ audioMode })} options={audioModes.map((m) => ({ value: m, label: AUDIO_LABELS[m] }))} />
        </div>
      ) : null}

      {hasMic && hasSystem && options.audioMode !== 'systemOnly' ? (
        <div className="py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-medium">Atraso do microfone</div>
              <div className="text-[11px] text-muted">Negativo adianta, positivo atrasa a voz</div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono tnum w-[64px] text-right text-sm text-fg-2">
                {options.micOffsetMs > 0 ? '+' : ''}
                {options.micOffsetMs} ms
              </span>
              <button type="button" className={cn('rounded-md p-1 text-muted hover:bg-white/5 hover:text-fg', options.micOffsetMs === 0 && 'invisible')} onClick={() => onChange({ micOffsetMs: 0 })} aria-label="Zerar atraso">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <Slider className="mt-2" min={-500} max={500} step={10} value={[options.micOffsetMs]} onValueChange={([v]) => onChange({ micOffsetMs: v })} />
        </div>
      ) : null}

      {preset.supportsTargetSize ? (
        <div className="py-2.5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-medium">Tamanho-alvo</div>
              <div className="text-[11px] text-muted">WhatsApp aceita 64 MB; e-mail, cerca de 20 MB</div>
            </div>
            <Segmented<'64' | '20' | 'none'>
              size="sm"
              value={target === 64 ? '64' : target === 20 ? '20' : 'none'}
              onValueChange={(v) => onChange({ targetSizeMB: v === '64' ? 64 : v === '20' ? 20 : null })}
              options={[
                { value: '64', label: '64 MB', title: 'WhatsApp' },
                { value: '20', label: '20 MB', title: 'E-mail' },
                { value: 'none', label: 'Livre', title: 'Sem limite de tamanho' }
              ]}
            />
          </div>
          {targetPlan && targetTwoPass ? (
            <div className={cn('rounded-lg border px-2.5 py-1.5 text-[11px]', targetPlan.warn ? 'border-warn/30 bg-warn/10 text-warn' : 'border-info/30 bg-info/10 text-info')}>
              {targetPlan.warn
                ? `Para caber em ${target} MB a qualidade fica muito baixa (${targetPlan.kbps} kbps). Prefira enviar como documento no WhatsApp.`
                : `Estimativa acima do alvo: será codificado em 2 passes a ${targetPlan.kbps} kbps${targetPlan.height < targetHint.srcHeight ? ` em ${targetPlan.height}p` : ''}.`}
            </div>
          ) : null}
        </div>
      ) : null}

      {preset.supportsReels ? (
        <Row label="Reels 9:16" hint="1080×1920 com barras — Instagram/TikTok">
          <Toggle checked={options.reels} onCheckedChange={(reels) => onChange({ reels })} size="sm" />
        </Row>
      ) : null}

      <div className="py-2.5">
        <label className="mb-1.5 block text-[13px] font-medium" htmlFor="export-file-name">
          Nome do arquivo
        </label>
        <div className="flex items-center gap-2">
          <input
            id="export-file-name"
            value={options.fileName}
            onChange={(e) => onChange({ fileName: e.target.value })}
            spellCheck={false}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-bg-2 px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent/60"
            placeholder="Nome do vídeo"
          />
          <span className="shrink-0 text-[11px] text-muted">{preset.container === 'multi' ? 'vários arquivos' : '.mp4'}</span>
        </div>
      </div>

      <div className="py-2.5">
        <div className="mb-1.5 text-[13px] font-medium">Pasta de destino</div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-border bg-bg-2/60 px-3 py-2 text-xs text-fg-2" title={outputDir} dir="rtl">
            <span dir="ltr">{outputDir}</span>
          </div>
          <Button size="sm" variant="outline" onClick={onPickFolder}>
            <FolderOpen className="h-3.5 w-3.5" /> Trocar
          </Button>
        </div>
      </div>
    </div>
  )
})

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        {hint ? <div className="text-[11px] text-muted">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const CORNERS: PipCorner[] = ['tl', 'tr', 'bl', 'br']
const CORNER_LABEL: Record<PipCorner, string> = { tl: 'Superior esquerdo', tr: 'Superior direito', bl: 'Inferior esquerdo', br: 'Inferior direito' }

function CornerPicker({ value, onChange }: { value: PipCorner; onChange: (c: PipCorner) => void }): React.JSX.Element {
  return (
    <div className="grid h-9 w-14 grid-cols-2 gap-0.5 rounded-lg border border-border-strong bg-bg-2 p-0.5" role="radiogroup" aria-label="Canto da PiP">
      {CORNERS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          title={CORNER_LABEL[c]}
          onClick={() => onChange(c)}
          className={cn('flex items-center justify-center rounded-[5px] transition-colors', value === c ? 'bg-surface-3' : 'hover:bg-white/5')}
        >
          <span className={cn('h-2 w-2 rounded-full', value === c ? 'bg-accent' : 'bg-muted-2')} />
        </button>
      ))}
    </div>
  )
}
