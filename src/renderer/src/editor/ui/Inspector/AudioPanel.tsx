import { useEffect, useRef } from 'react'
import { AlertTriangle, Check, Headphones, Info, Loader2 } from 'lucide-react'
import { findItem } from '@shared/editor/ops'
import type { MediaItem } from '@shared/editor/project'
import { audioProcessKey, audioSourceKey } from '@shared/editor/audioProcess'
import { planAudio } from '@shared/editor/audioPlan'
import { Progress, Slider, Toggle } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'
import { retryAudioProcessing, voiceProcessStatus } from '../audioProcessing'
import { usePausedPlayhead } from '../../state/pausedPlayhead'
import { KeyframeButton } from './KeyframeButton'
import { NumberField } from './NumberField'
import { PanelSection, animAt, editItem, editItemTransient, localUs, sec2ToUs, usToSec2, withValue } from './common'

// Inspetor de áudio do item de mídia: ativar, volume em dB (−60…+12; −60 = mudo), fades e o tratamento da voz
// (redução de ruído e normalização a −16 LUFS, pré-processados em cache — ver audioProcessing.ts), com o estado do
// processamento e a comparação A/B (segurar o botão toca o original). Item numa faixa de Voz cuja mídia ainda não tem a
// análise de fala: aviso de que ele não abaixa a música (ducking).

const MIN_DB = -60
const MAX_DB = 12

export const gainToDb = (g: number): number => (g <= 0.001 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(g))))
export const dbToGain = (db: number): number => (db <= MIN_DB ? 0 : Math.pow(10, db / 20))

export function AudioPanel({ item }: { item: MediaItem }): React.JSX.Element {
  // tocando, o inspetor não acompanha o playhead (evita re-render a cada quadro)
  const playheadUs = usePausedPlayhead()
  const local = localUs(item, playheadUs)
  const a = item.audio
  const id = item.id
  const db = Math.round(gainToDb(animAt(a.volume, local)) * 10) / 10
  const sliding = useRef(false)
  const setDb = (v: number): void => editItemTransient<MediaItem>(id, (d) => { d.audio.volume = withValue(d.audio.volume, local, dbToGain(v)) })
  const halfSec = usToSec2(item.durationUs / 2)

  return (
    <>
      <PanelSection
        title="Áudio"
        aside={<Toggle size="sm" checked={a.enabled} onCheckedChange={(on) => editItem<MediaItem>(id, (d) => { d.audio.enabled = on })} aria-label="Ativar áudio do item" />}
      >
        <NumberField label="Volume" value={db} min={MIN_DB} max={MAX_DB} precision={1} step={0.1} unit="dB" disabled={!a.enabled} onChange={setDb} title="−60 dB = sem som" trailing={<KeyframeButton item={item} path="audio.volume" label="Volume" />} />
        <Slider
          aria-label="Volume em dB"
          min={MIN_DB}
          max={MAX_DB}
          step={0.5}
          disabled={!a.enabled}
          value={[db]}
          onValueChange={([v]) => {
            if (!sliding.current) {
              sliding.current = true
              useEditorStore.getState().begin()
            }
            setDb(v)
          }}
          onValueCommit={() => {
            sliding.current = false
            useEditorStore.getState().commitTx()
          }}
        />
        <div className="flex justify-between font-mono text-[9px] text-muted-2">
          <span>−60</span>
          <span>0 dB</span>
          <span>+12</span>
        </div>
      </PanelSection>
      <VoicePanel item={item} />
      <SpeechNote item={item} />
      <PanelSection title="Fade de áudio">
        <div className="grid grid-cols-2 gap-x-3">
          <NumberField compact label="Entrada" value={usToSec2(a.fadeInUs)} min={0} max={halfSec} precision={2} step={0.01} unit="s" disabled={!a.enabled} onChange={(n) => editItemTransient<MediaItem>(id, (d) => { d.audio.fadeInUs = sec2ToUs(n) })} />
          <NumberField compact label="Saída" value={usToSec2(a.fadeOutUs)} min={0} max={halfSec} precision={2} step={0.01} unit="s" disabled={!a.enabled} onChange={(n) => editItemTransient<MediaItem>(id, (d) => { d.audio.fadeOutUs = sec2ToUs(n) })} />
        </div>
      </PanelSection>
    </>
  )
}

/** Faixa de Voz sem os intervalos de fala da mídia: este item não abaixa a música (sem dados, sem ducking). */
function SpeechNote({ item }: { item: MediaItem }): React.JSX.Element | null {
  const voice = useEditorStore((s) => !!s.project && findItem(s.project, item.id)?.track.role === 'voice')
  const asset = useEditorStore((s) => s.project?.assets.find((a) => a.id === item.assetId))
  const analyzing = useEditorStore((s) => !!s.ingest[item.assetId])
  const failed = useEditorStore((s) => !!s.speechFailed[item.assetId])
  if (!voice || !asset || (asset.speech && !failed)) return null
  return (
    <p className="flex items-start gap-1.5 border-b border-border px-3 py-2 text-[11px] leading-relaxed text-muted-2" data-speech-note="">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{!failed && (asset.status === 'processing' || analyzing) ? 'Analisando a fala desta mídia… até lá ela não abaixa a música.' : failed ? 'Sem dados de fala (a análise não pôde ser lida): esta mídia não abaixa a música.' : 'Fala desta mídia não analisada: ela não abaixa a música (ducking).'}</span>
    </p>
  )
}

function OptionRow({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn('flex min-h-7 items-center justify-between gap-2 text-[11px]', disabled && 'opacity-50')}>
      <span className="min-w-0 truncate text-muted">{label}</span>
      {children}
    </div>
  )
}

/** Redução de ruído / normalização do item: switches, estado do processamento e A/B segurando o botão. */
function VoicePanel({ item }: { item: MediaItem }): React.JSX.Element {
  const a = item.audio
  const id = item.id
  const projectId = useEditorStore((s) => s.project?.id ?? '')
  const asset = useEditorStore((s) => s.project?.assets.find((x) => x.id === item.assetId))
  const key = audioProcessKey({ denoise: a.denoise, normalize: a.normalize })
  const jobId = key ? audioSourceKey(item.assetId, key) : null
  const job = useEditorStore((s) => (jobId ? s.audioJobs[jobId] : undefined))
  const bypass = useEditorStore((s) => s.audioBypass)
  const setBypass = useEditorStore((s) => s.setAudioBypass)
  const ready = !!key && !!asset?.processedAudio?.[key]
  // o item soa no plano (áudio ligado, item ativo, faixa não muda)? Senão nada é pedido: não está "aguardando"
  const active = useEditorStore((s) => !!s.project && planAudio(s.project).some((x) => x.itemId === id))
  const status = voiceProcessStatus({ ready, job, active, assetReady: asset?.status === 'ready' })
  // soltar o botão fora dele/trocar de item: o A/B nunca fica preso no original
  useEffect(() => () => useEditorStore.getState().setAudioBypass(false), [id])

  const hold = (on: boolean): void => {
    if (on !== useEditorStore.getState().audioBypass) setBypass(on)
  }
  return (
    <PanelSection title="Voz">
      <OptionRow label="Reduzir ruído (voz)" disabled={!a.enabled}>
        <Toggle size="sm" checked={a.denoise} disabled={!a.enabled} onCheckedChange={(on) => editItem<MediaItem>(id, (d) => { d.audio.denoise = on })} aria-label="Reduzir ruído (voz)" />
      </OptionRow>
      <OptionRow label="Normalizar volume (−16 LUFS)" disabled={!a.enabled}>
        <Toggle size="sm" checked={a.normalize} disabled={!a.enabled} onCheckedChange={(on) => editItem<MediaItem>(id, (d) => { d.audio.normalize = on })} aria-label="Normalizar volume (−16 LUFS)" />
      </OptionRow>
      {key ? (
        <div className="space-y-1.5 pt-0.5" data-audio-process-status={status}>
          {status === 'ready' ? (
            <p className="flex items-center gap-1.5 text-[11px] text-ok">
              <Check className="h-3.5 w-3.5" /> Áudio tratado pronto
            </p>
          ) : status === 'error' ? (
            <div className="flex items-start gap-1.5 text-[11px] text-warn" role="alert">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                Falha ao processar; tocando o original.{' '}
                <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={() => retryAudioProcessing(projectId, jobId!)}>
                  Tentar de novo
                </button>
              </span>
            </div>
          ) : status === 'inactive' ? (
            <p className="text-[11px] text-muted-2">O tratamento é feito quando o áudio do item estiver ligado e a faixa com som.</p>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {status === 'waiting' ? 'Aguardando a mídia…' : `Processando… ${job && 'percent' in job ? Math.round(job.percent) : 0}%`} <span className="text-muted-2">(tocando o original)</span>
              </p>
              {job && 'percent' in job ? <Progress value={job.percent} tone="info" className="h-1" /> : null}
            </>
          )}
          <button
            type="button"
            disabled={!ready}
            aria-pressed={bypass}
            className={cn(
              'flex h-7 w-full select-none items-center justify-center gap-1.5 rounded-lg border text-[11px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40',
              bypass ? 'border-info/50 bg-info/15 text-info' : 'border-border-strong text-fg-2 hover:bg-white/5'
            )}
            title="Segure para ouvir o áudio original; solte para voltar ao tratado"
            onPointerDown={(e) => {
              hold(true)
              // captura: soltar fora do botão também encerra a comparação
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                // ponteiro já solto/inexistente: o pointerup/blur encerram
              }
            }}
            onPointerUp={() => hold(false)}
            onPointerCancel={() => hold(false)}
            onLostPointerCapture={() => hold(false)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                hold(true)
              }
            }}
            onKeyUp={() => hold(false)}
            onBlur={() => hold(false)}
          >
            <Headphones className="h-3.5 w-3.5" /> {bypass ? 'Ouvindo o original' : 'Segure para comparar (A/B)'}
          </button>
        </div>
      ) : null}
    </PanelSection>
  )
}
