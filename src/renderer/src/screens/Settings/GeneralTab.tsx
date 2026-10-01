import { useMemo } from 'react'
import { Circle, RectangleHorizontal } from 'lucide-react'
import type { CountdownSec, Fps, PipSettings, PipShape, Quality } from '@shared/types'
import { QUALITY_PRESETS } from '@shared/defaults'
import { useAppStore } from '@/app/store'
import { Section, Segmented, Select, Toggle } from '@/components/ui/primitives'
import { SettingRow, SettingRows } from '@/components/ui/SettingRow'
import { PathField } from '@/components/ui/PathField'
import { cn } from '@/lib/cn'
import { useSettingsPatch } from './useSettingsPatch'

// Aba Geral: gravação (qualidade, fps, contagem, som), pasta de saída, PiP padrão, retenção.

const QUALITY_ORDER: Quality[] = ['720p', '1080p', '1440p', 'native']
const FPS_OPTIONS: Fps[] = [30, 60]
const COUNTDOWN_OPTIONS: CountdownSec[] = [0, 3, 5]

type PipSize = 'p' | 'm' | 'g'
type PipCorner = 'tl' | 'tr' | 'bl' | 'br'

/** Largura da PiP (fração da largura do frame) por tamanho. */
const PIP_WIDTH: Record<PipSize, number> = { p: 0.14, m: 0.2, g: 0.28 }
/** Margem até a borda: 4 % da largura e o equivalente em altura (frame 16:9). */
const PIP_MARGIN_X = 0.04
const PIP_MARGIN_Y = (PIP_MARGIN_X * 16) / 9

const RETENTION_OPTIONS = [
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
  { value: 'never', label: 'Nunca apagar' }
]

function pipHeightFor(width: number, shape: PipShape): number {
  // círculo: quadrado em pixels (h em fração da altura); retângulo: câmera 16:9 → mesma fração
  return shape === 'circle' ? (width * 16) / 9 : width
}

function nearestSize(w: number): PipSize {
  let best: PipSize = 'm'
  let dist = Infinity
  for (const k of Object.keys(PIP_WIDTH) as PipSize[]) {
    const d = Math.abs(PIP_WIDTH[k] - w)
    if (d < dist) {
      dist = d
      best = k
    }
  }
  return best
}

function cornerOf(p: PipSettings): PipCorner {
  const cx = p.x + p.w / 2
  const cy = p.y + p.h / 2
  return `${cy < 0.5 ? 't' : 'b'}${cx < 0.5 ? 'l' : 'r'}` as PipCorner
}

/** Recalcula posição/tamanho da PiP a partir de forma, tamanho e canto. */
function layoutPip(prev: PipSettings, shape: PipShape, size: PipSize, corner: PipCorner): PipSettings {
  const w = PIP_WIDTH[size]
  const h = pipHeightFor(w, shape)
  const x = corner.endsWith('l') ? PIP_MARGIN_X : 1 - w - PIP_MARGIN_X
  const y = corner.startsWith('t') ? PIP_MARGIN_Y : 1 - h - PIP_MARGIN_Y
  return { ...prev, shape, x, y, w, h }
}

/** Miniatura 16:9 mostrando onde a câmera vai aparecer. */
function PipPreview({ pip }: { pip: PipSettings }): React.JSX.Element {
  const isCircle = pip.shape === 'circle'
  const side = Math.min(pip.w, (pip.h * 9) / 16)
  const style = isCircle
    ? {
        left: `${(pip.x + (pip.w - side) / 2) * 100}%`,
        top: `${(pip.y + (pip.h - (side * 16) / 9) / 2) * 100}%`,
        width: `${side * 100}%`,
        height: `${((side * 16) / 9) * 100}%`
      }
    : {
        left: `${pip.x * 100}%`,
        top: `${pip.y * 100}%`,
        width: `${pip.w * 100}%`,
        height: `${pip.h * 100}%`
      }
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border-strong bg-[linear-gradient(135deg,#1b202d,#0f121a)]">
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-[0.12] [&>span]:border-r [&>span]:border-b [&>span]:border-fg" aria-hidden>
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <div className={cn('absolute bg-accent/80 shadow-[0_0_0_2px_rgba(255,255,255,0.35)] transition-all duration-200', isCircle ? 'rounded-full' : 'rounded-[8%]')} style={style} />
    </div>
  )
}

function CornerPicker({ value, onChange }: { value: PipCorner; onChange: (c: PipCorner) => void }): React.JSX.Element {
  const corners: { id: PipCorner; label: string; cls: string }[] = [
    { id: 'tl', label: 'Canto superior esquerdo', cls: 'left-1 top-1' },
    { id: 'tr', label: 'Canto superior direito', cls: 'right-1 top-1' },
    { id: 'bl', label: 'Canto inferior esquerdo', cls: 'left-1 bottom-1' },
    { id: 'br', label: 'Canto inferior direito', cls: 'right-1 bottom-1' }
  ]
  return (
    <div className="relative h-11 w-[76px] rounded-lg border border-border-strong bg-bg-2" role="radiogroup" aria-label="Canto da câmera">
      {corners.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={value === c.id}
          title={c.label}
          aria-label={c.label}
          onClick={() => onChange(c.id)}
          className={cn('absolute h-4 w-6 rounded-[4px] border transition-colors', c.cls, value === c.id ? 'border-accent bg-accent/80' : 'border-border-strong bg-white/5 hover:bg-white/12')}
        />
      ))}
    </div>
  )
}

export function GeneralTab(): React.JSX.Element {
  const { settings, patch } = useSettingsPatch()
  const appInfo = useAppStore((s) => s.appInfo)
  const pip = settings.pip
  const size = useMemo(() => nearestSize(pip.w), [pip.w])
  const corner = useMemo(() => cornerOf(pip), [pip])
  const retentionValue = settings.rawRetentionDays === null ? 'never' : String(settings.rawRetentionDays)
  const retentionOptions = RETENTION_OPTIONS.some((o) => o.value === retentionValue) ? RETENTION_OPTIONS : [{ value: retentionValue, label: `${retentionValue} dias` }, ...RETENTION_OPTIONS]

  const setPipLayout = (shape: PipShape, sz: PipSize, cornerId: PipCorner): void => {
    void patch({ pip: layoutPip(pip, shape, sz, cornerId) })
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 @min-[720px]:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Section title="Gravação" className="rise-in">
          <SettingRows>
            <SettingRow label="Qualidade" description="Resolução do vídeo gravado. «Nativa» usa a resolução exata do monitor.">
              <Segmented<Quality>
                value={settings.quality}
                onValueChange={(q) => void patch({ quality: q })}
                options={QUALITY_ORDER.map((q) => ({
                  value: q,
                  label: QUALITY_PRESETS[q].label
                }))}
              />
            </SettingRow>
            <SettingRow label="Quadros por segundo" description="60 fps deixa o movimento mais fluido, mas gera arquivos ~65 % maiores.">
              <Segmented<string>
                value={String(settings.fps)}
                onValueChange={(v) => void patch({ fps: Number(v) as Fps })}
                options={FPS_OPTIONS.map((f) => ({
                  value: String(f),
                  label: `${f} fps`
                }))}
              />
            </SettingRow>
            <SettingRow label="Contagem regressiva" description="Tempo entre apertar Gravar e o início da captura.">
              <Segmented<string>
                value={String(settings.countdownSec)}
                onValueChange={(v) => void patch({ countdownSec: Number(v) as CountdownSec })}
                options={COUNTDOWN_OPTIONS.map((c) => ({
                  value: String(c),
                  label: c === 0 ? 'Sem' : `${c} s`
                }))}
              />
            </SettingRow>
            <SettingRow label="Som de início" description="Toca um bipe curto quando a gravação começa (não entra no vídeo)." htmlFor="startSound">
              <Toggle id="startSound" checked={settings.startSound} onCheckedChange={(v) => void patch({ startSound: v })} />
            </SettingRow>
          </SettingRows>
        </Section>

        <Section title="Pastas e arquivos" className="rise-in rise-in-1">
          <SettingRows>
            <SettingRow label="Onde salvar os vídeos exportados" description="Por padrão, dentro de Vídeos. Os brutos ficam numa subpasta (dá para trocar em Avançado)." stack>
              <PathField value={settings.outputDir} defaultPath={appInfo?.paths.output ?? null} onChange={(v) => void patch({ outputDir: v })} />
            </SettingRow>
            <SettingRow label="Manter gravações brutas por" description="Os brutos permitem reexportar depois com outro corte ou preset. Vídeos já exportados e gravações usadas em projetos do editor nunca são apagados.">
              <Select
                className="w-44"
                value={retentionValue}
                onValueChange={(v) =>
                  void patch({
                    rawRetentionDays: v === 'never' ? null : Number(v)
                  })
                }
                options={retentionOptions}
              />
            </SettingRow>
          </SettingRows>
        </Section>
      </div>

      <Section title="Câmera no vídeo (PiP)" className="rise-in rise-in-2">
        <PipPreview pip={pip} />
        <p className="mb-2 mt-1.5 text-center text-[11px] text-muted">Posição inicial — dá para arrastar durante a gravação</p>
        <SettingRows>
          <SettingRow label="Forma">
            <Segmented<PipShape>
              value={pip.shape}
              onValueChange={(s) => setPipLayout(s, size, corner)}
              options={[
                {
                  value: 'circle',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Circle className="h-3.5 w-3.5" /> Círculo
                    </span>
                  )
                },
                {
                  value: 'rounded',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <RectangleHorizontal className="h-3.5 w-3.5" /> Retângulo
                    </span>
                  )
                }
              ]}
            />
          </SettingRow>
          <SettingRow label="Tamanho">
            <Segmented<PipSize>
              value={size}
              onValueChange={(s) => setPipLayout(pip.shape, s, corner)}
              options={[
                { value: 'p', label: 'P', title: 'Pequena' },
                { value: 'm', label: 'M', title: 'Média' },
                { value: 'g', label: 'G', title: 'Grande' }
              ]}
            />
          </SettingRow>
          <SettingRow label="Canto">
            <CornerPicker value={corner} onChange={(c) => setPipLayout(pip.shape, size, c)} />
          </SettingRow>
          <SettingRow label="Espelhar" description="Como num espelho: mais natural para quem grava." htmlFor="pipMirror">
            <Toggle id="pipMirror" checked={pip.mirrored} onCheckedChange={(v) => void patch({ pip: { ...pip, mirrored: v } })} />
          </SettingRow>
        </SettingRows>
      </Section>
    </div>
  )
}
