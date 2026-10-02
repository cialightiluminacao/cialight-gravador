import { Info, Rewind, Snowflake } from 'lucide-react'
import { toast } from 'sonner'
import { FREEZE_DEFAULT_US, findItem, freezeFrameAt, linkedIds, setReverse, setSpeed, updateItem } from '@shared/editor/ops'
import { MAX_STRETCH_SPEED } from '@shared/editor/audioPlan'
import { MAX_SPEED, MIN_SPEED, type MediaItem, type Project } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'
import { Toggle } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../../state/editorStore'
import { NumberField } from './NumberField'
import { PanelSection } from './common'

// Velocidade do item (e dos vinculados): presets, campo livre, tom preservado, áudio acima de 4×, congelar quadro
// (2 s no playhead, com ripple) e reverso. Mudar a velocidade recalcula a duração e empurra o que vem depois
// (ripple), como em ops.setSpeed; as opções de áudio valem para a mídia vinculada (o som do vídeo fica no item de
// áudio).

const PRESETS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8, 16]
const fmt = (n: number): string => `${String(n).replace('.', ',')}×`

/** O item e a mídia vinculada a ele (vídeo + áudio separado). */
function mediaGroup(p: Project, itemId: string): MediaItem[] {
  return linkedIds(p, itemId)
    .map((id) => findItem(p, id))
    .filter((f): f is NonNullable<typeof f> => !!f && f.item.type === 'media')
    .map((f) => f.item as MediaItem)
}

/** Clipe de vídeo do grupo (o próprio item numa faixa de vídeo, senão o vídeo vinculado). */
function videoClipOf(p: Project, itemId: string): MediaItem | null {
  for (const id of linkedIds(p, itemId)) {
    const f = findItem(p, id)
    if (f && f.track.kind === 'video' && f.item.type === 'media' && f.item.visual && p.assets.find((a) => a.id === (f.item as MediaItem).assetId)?.kind === 'video') return f.item
  }
  return null
}

function OptionRow({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn('flex min-h-7 items-center justify-between gap-2 text-[11px]', disabled && 'opacity-50')}>
      <span className="min-w-0 truncate text-muted">{label}</span>
      {children}
    </div>
  )
}

export function SpeedPanel({ item }: { item: MediaItem }): React.JSX.Element {
  const apply = useEditorStore((s) => s.apply)
  const project = useEditorStore((s) => s.project)
  if (item.freeze) {
    return (
      <PanelSection title="Velocidade">
        <p className="flex items-start gap-1.5 rounded-md bg-info/10 px-2 py-1.5 text-[10.5px] leading-snug text-info">
          <Snowflake className="mt-px h-3 w-3 shrink-0" />
          Quadro congelado: mostra um único quadro do vídeo, sem som. Ajuste a duração pelas bordas na linha do tempo.
        </p>
      </PanelSection>
    )
  }
  const group = project ? mediaGroup(project, item.id) : [item]
  // as opções de áudio moram no item que toca (o de áudio vinculado, se houver)
  const audible = group.find((m) => m.audio.enabled) ?? item
  const preservePitch = audible.audio.preservePitch
  const keepFast = audible.audio.keepFastAudio ?? false
  const setAudioFlag = (patch: { preservePitch?: boolean; keepFastAudio?: boolean }): void => {
    apply((p) => mediaGroup(p, item.id).reduce((q, m) => updateItem<MediaItem>(q, m.id, (d) => Object.assign(d.audio, patch)), p))
  }
  const clip = project ? videoClipOf(project, item.id) : null
  const freeze = (): void => {
    if (!clip) return
    const at = useEditorStore.getState().playheadUs
    if (at < clip.startUs || at > itemEndUs(clip)) {
      toast('Posicione o playhead sobre o clipe para congelar o quadro.')
      return
    }
    apply((p) => freezeFrameAt(p, clip.id, at, FREEZE_DEFAULT_US))
  }
  const muted = preservePitch && !keepFast && item.speed > MAX_STRETCH_SPEED

  return (
    <>
      <PanelSection title="Velocidade">
        <div className="grid grid-cols-4 gap-1">
          {PRESETS.map((s) => (
            <button
              key={s}
              className={cn(
                'font-mono tnum h-7 rounded-md border text-[11px] font-medium transition-colors',
                Math.abs(item.speed - s) < 1e-6 ? 'border-accent/60 bg-accent/15 text-accent-2' : 'border-border bg-bg-2 text-fg-2 hover:border-border-strong hover:text-fg'
              )}
              onClick={() => apply((p) => setSpeed(p, item.id, s))}
              aria-pressed={Math.abs(item.speed - s) < 1e-6}
            >
              {fmt(s)}
            </button>
          ))}
        </div>
        <NumberField label="Personalizada" value={item.speed} min={MIN_SPEED} max={MAX_SPEED} precision={2} step={0.01} unit="×" onChange={(v) => apply((p) => setSpeed(p, item.id, v), { transient: true })} />
        <OptionRow label="Manter tom">
          <Toggle size="sm" checked={preservePitch} onCheckedChange={(on) => setAudioFlag({ preservePitch: on })} aria-label="Manter tom" />
        </OptionRow>
        <OptionRow label="Manter áudio acima de 4×" disabled={!preservePitch}>
          <Toggle size="sm" checked={keepFast} disabled={!preservePitch} onCheckedChange={(on) => setAudioFlag({ keepFastAudio: on })} aria-label="Manter áudio acima de 4×" />
        </OptionRow>
        {muted ? (
          <p className="flex items-start gap-1.5 rounded-md bg-info/10 px-2 py-1.5 text-[10.5px] leading-snug text-info">
            <Info className="mt-px h-3 w-3 shrink-0" />
            Acima de 4× o áudio fica mudo. Ligue “Manter áudio acima de 4×” para mantê-lo (acelerado, com o tom preservado).
          </p>
        ) : null}
        {!preservePitch && item.speed !== 1 ? (
          <p className="flex items-start gap-1.5 rounded-md bg-info/10 px-2 py-1.5 text-[10.5px] leading-snug text-info">
            <Info className="mt-px h-3 w-3 shrink-0" />
            Sem manter o tom, a voz fica mais aguda ao acelerar e mais grave ao desacelerar.
          </p>
        ) : null}
      </PanelSection>
      <PanelSection title="Tempo">
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            disabled={!clip}
            onClick={freeze}
            title={clip ? 'Congela o quadro do playhead por 2 s, empurrando o resto' : 'Só para clipes de vídeo'}
            className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-2 text-[11px] font-medium text-fg-2 transition-colors hover:border-border-strong hover:text-fg disabled:opacity-40"
          >
            <Snowflake className="h-3.5 w-3.5" />
            Congelar quadro
          </button>
          <button
            type="button"
            aria-pressed={item.reverse}
            onClick={() => apply((p) => setReverse(p, [item.id], !item.reverse))}
            title="Toca o clipe de trás para frente (efeitos vinculados acompanham)"
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 rounded-md border text-[11px] font-medium transition-colors',
              item.reverse ? 'border-accent/60 bg-accent/15 text-accent-2' : 'border-border bg-bg-2 text-fg-2 hover:border-border-strong hover:text-fg'
            )}
          >
            <Rewind className="h-3.5 w-3.5" />
            Reverter
          </button>
        </div>
        {item.reverse && item.speed !== 1 ? (
          <p className="flex items-start gap-1.5 rounded-md bg-info/10 px-2 py-1.5 text-[10.5px] leading-snug text-info">
            <Info className="mt-px h-3 w-3 shrink-0" />
            No reverso fora de 1× o tom do áudio acompanha a velocidade.
          </p>
        ) : null}
      </PanelSection>
    </>
  )
}
