import { useRef } from 'react'
import type { MediaItem } from '@shared/editor/project'
import { Slider, Toggle } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { usePausedPlayhead } from '../../state/pausedPlayhead'
import { NumberField } from './NumberField'
import { PanelSection, animAt, editItem, editItemTransient, localUs, sec2ToUs, usToSec2, withValue } from './common'

// Inspetor de áudio do item de mídia: ativar, volume em dB (−60…+12; −60 = mudo) e fades.

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
        <NumberField label="Volume" value={db} min={MIN_DB} max={MAX_DB} precision={1} step={0.1} unit="dB" disabled={!a.enabled} onChange={setDb} title="−60 dB = sem som" />
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
      <PanelSection title="Fade de áudio">
        <div className="grid grid-cols-2 gap-x-3">
          <NumberField compact label="Entrada" value={usToSec2(a.fadeInUs)} min={0} max={halfSec} precision={2} step={0.01} unit="s" disabled={!a.enabled} onChange={(n) => editItemTransient<MediaItem>(id, (d) => { d.audio.fadeInUs = sec2ToUs(n) })} />
          <NumberField compact label="Saída" value={usToSec2(a.fadeOutUs)} min={0} max={halfSec} precision={2} step={0.01} unit="s" disabled={!a.enabled} onChange={(n) => editItemTransient<MediaItem>(id, (d) => { d.audio.fadeOutUs = sec2ToUs(n) })} />
        </div>
      </PanelSection>
    </>
  )
}
