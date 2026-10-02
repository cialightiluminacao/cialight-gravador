import { memo } from 'react'
import { AlertTriangle, EyeOff, Link2, PenLine, Rewind, Shapes, Sparkles, Type } from 'lucide-react'
import type { Asset, Item, MediaItem, TrackKind } from '@shared/editor/project'
import { cn } from '@/lib/cn'
import { mediaUrl, projectFileUrl } from '../mediaImport'
import { ITEM_TYPE_LABEL } from '../itemLabel'
import { FadeHandles } from './FadeHandles'
import { KeyframeMarks } from './KeyframeMarks'
import { filmstripSlots } from './itemMedia'
import { usePeaks } from './peaks'
import { Waveform } from './Waveform'
import { usToPx } from '../../state/zoom'

// Um item na faixa: posicionado por usToPx e recortado à área visível (+ margem), para que itens
// enormes em zoom alto não virem caixas de milhões de px. Vídeo mostra o filmstrip (fatias do sprite
// por background-position, ancoradas no início do item), imagem repete a própria imagem, áudio
// desenha a forma de onda. Losangos = keyframes (KeyframeMarks); item desativado fica apagado, com
// borda tracejada e ícone de olho cortado (a hachura é da faixa bloqueada). Bordas (data-edge) fazem
// trim; os eventos são tratados por delegação no useTimelineDrag (nenhum handler por item → memo efetivo).

export const ITEM_MARGIN_PX = 240
const INSET = 3
const EDGE_W = 7

interface Props {
  item: Item
  asset: Asset | undefined
  projectId: string
  kind: TrackKind
  rowH: number
  locked: boolean
  dimmed: boolean
  pxPerSec: number
  scrollUs: number
  viewW: number
  selected: boolean
}

const TONE: Record<Item['type'] | 'audio', string> = {
  media: 'bg-[#22314f] border-[#3d5a94]',
  audio: 'bg-[#173a2e] border-[#2c7a5c]',
  text: 'bg-[#3b2a55] border-[#7a58b0]',
  shape: 'bg-[#2d3a4a] border-[#5b7a99]',
  effect: 'bg-[#4a3518] border-[#a8792c]',
  annotations: 'bg-[#4a2a2f] border-[#a24d5a]'
}

const TYPE_ICON = { text: Type, shape: Shapes, effect: Sparkles, annotations: PenLine } as const

function speedLabel(speed: number): string {
  return `${String(Math.round(speed * 100) / 100).replace('.', ',')}×`
}

function itemName(item: Item, asset: Asset | undefined): string {
  if (item.name) return item.name
  if (item.type === 'text') return item.text || ITEM_TYPE_LABEL.text
  if (item.type === 'media' && asset) return asset.name
  return ITEM_TYPE_LABEL[item.type]
}

function Filmstrip({ item, asset, projectId, h, pxPerSec, clipFrom, clipTo }: { item: MediaItem; asset: Asset; projectId: string; h: number; pxPerSec: number; clipFrom: number; clipTo: number }): React.JSX.Element | null {
  const fs = asset.filmstripInfo
  if (!asset.filmstrip || !fs) return null
  const slotW = Math.max(8, (fs.tileW * h) / fs.tileH)
  const url = `url("${projectFileUrl(projectId, asset.filmstrip)}")`
  return (
    <>
      {filmstripSlots(item, fs, slotW, pxPerSec, clipFrom, clipTo).map((s) => (
        <span
          key={s.x}
          className="absolute top-0 block border-r border-black/30"
          style={{ left: s.x - clipFrom, width: slotW, height: h, backgroundImage: url, backgroundSize: `${fs.frames * slotW}px ${h}px`, backgroundPosition: `${-s.frame * slotW}px 0` }}
        />
      ))}
    </>
  )
}

function ItemWave({ item, asset, projectId, pxPerSec, clipFrom, clipTo, height, color }: { item: MediaItem; asset: Asset; projectId: string; pxPerSec: number; clipFrom: number; clipTo: number; height: number; color: string }): React.JSX.Element | null {
  const peaks = usePeaks(asset.id, asset.peaks && asset.status !== 'missing' ? projectFileUrl(projectId, asset.peaks) : null)
  if (!peaks) return null
  return <Waveform peaks={peaks} item={item} pxPerSec={pxPerSec} clipFromPx={clipFrom} clipToPx={clipTo} height={height} color={color} gain={item.audio.enabled ? item.audio.volume.value : 0.15} />
}

export const ItemView = memo(function ItemView({ item, asset, projectId, kind, rowH, locked, dimmed, pxPerSec, scrollUs, viewW, selected }: Props): React.JSX.Element | null {
  const x = usToPx(item.startUs, pxPerSec, scrollUs)
  const w = (item.durationUs * pxPerSec) / 1e6
  const visL = Math.max(x, -ITEM_MARGIN_PX)
  const visR = Math.min(x + w, viewW + ITEM_MARGIN_PX)
  if (visR <= visL) return null
  const clipFrom = visL - x
  const clipTo = visR - x
  const h = rowH - INSET * 2
  const media = item.type === 'media' ? item : null
  const isAudio = kind === 'audio'
  const broken = !!media && (!asset || asset.status === 'missing' || asset.status === 'error')
  const Icon = item.type !== 'media' ? TYPE_ICON[item.type] : null
  const narrow = visR - visL < 36
  const edgeW = Math.max(3, Math.min(EDGE_W, w / 4))
  // fades: item de faixa de vídeo usa os do visual; de faixa de áudio, os do áudio
  const fades = media ? (!isAudio && media.visual ? { in: media.visual.fadeInUs, out: media.visual.fadeOutUs } : { in: media.audio.fadeInUs, out: media.audio.fadeOutUs }) : null
  const fadeEditable = !!fades && !locked && w >= 30
  const disabled = item.enabled === false

  return (
    <div
      data-item-id={item.id}
      data-disabled={disabled || undefined}
      className={cn(
        'group absolute overflow-hidden rounded-[6px] border',
        TONE[isAudio ? 'audio' : item.type],
        locked ? 'cursor-not-allowed' : 'cursor-grab',
        (dimmed || disabled) && 'opacity-45',
        disabled && 'border-dashed',
        selected && 'z-[1] border-accent shadow-[0_0_0_1.5px_var(--accent)]'
      )}
      style={{ left: visL, width: visR - visL, top: INSET, height: h }}
    >
      {media && asset && !isAudio && asset.kind === 'video' ? <Filmstrip item={media} asset={asset} projectId={projectId} h={h} pxPerSec={pxPerSec} clipFrom={clipFrom} clipTo={clipTo} /> : null}
      {media && asset && asset.kind === 'image' && asset.status !== 'missing' ? (
        <span className="absolute inset-0 block opacity-90" style={{ backgroundImage: `url("${mediaUrl(projectId, asset.id)}")`, backgroundSize: `auto ${h}px`, backgroundRepeat: 'repeat-x', backgroundPosition: `${-clipFrom}px 0` }} />
      ) : null}
      {media && asset && isAudio ? <ItemWave item={media} asset={asset} projectId={projectId} pxPerSec={pxPerSec} clipFrom={clipFrom} clipTo={clipTo} height={h - 2} color="rgba(93, 224, 168, 0.85)" /> : null}
      {/* vídeo com áudio próprio (não separado): faixa de onda embaixo */}
      {media && asset && !isAudio && asset.kind === 'video' && media.audio.enabled && !media.linkId ? (
        <span className="absolute inset-x-0 bottom-0 block h-[16px] bg-black/45">
          <ItemWave item={media} asset={asset} projectId={projectId} pxPerSec={pxPerSec} clipFrom={clipFrom} clipTo={clipTo} height={16} color="rgba(93, 224, 168, 0.8)" />
        </span>
      ) : null}
      {broken ? <span className="absolute inset-0 block bg-[repeating-linear-gradient(135deg,rgba(255,92,92,0.22)_0_6px,transparent_6px_12px)]" /> : null}
      {locked ? <span className="absolute inset-0 block bg-[repeating-linear-gradient(135deg,rgba(0,0,0,0.28)_0_4px,transparent_4px_9px)]" /> : null}
      {fades ? <FadeHandles fadeInUs={fades.in} fadeOutUs={fades.out} pxPerSec={pxPerSec} w={w} clipFrom={clipFrom} visW={visR - visL} h={h} editable={fadeEditable} selected={selected} /> : null}
      <KeyframeMarks item={item} pxPerSec={pxPerSec} clipFrom={clipFrom} visW={visR - visL} h={h} locked={locked} />
      {/* desativado: o ícone aparece mesmo em item estreito (no rótulo quando cabe, senão no início) */}
      {disabled && narrow ? (
        <span className="pointer-events-none absolute left-0 top-0 z-[2] flex h-[14px] items-center rounded-br-[4px] bg-black/60 px-[2px] text-white/90">
          <EyeOff className="h-2.5 w-2.5" aria-label="Desativado" />
        </span>
      ) : null}
      {!narrow ? (
        <span className={cn('pointer-events-none absolute top-0 z-[2] flex max-w-full items-center gap-1 rounded-br-[5px] bg-black/55 px-1.5 py-[1px] text-[10px] font-semibold leading-[14px] text-white/90', fadeEditable && clipFrom === 0 ? 'left-[11px]' : 'left-0')}>
          {broken ? <AlertTriangle className="h-3 w-3 shrink-0 text-danger" /> : null}
          {disabled ? <EyeOff className="h-3 w-3 shrink-0" aria-label="Desativado" /> : null}
          {Icon ? <Icon className="h-3 w-3 shrink-0 opacity-80" /> : null}
          {item.linkId ? <Link2 className="h-3 w-3 shrink-0 opacity-80" aria-label="Vinculado" /> : null}
          <span className="truncate">{itemName(item, asset)}</span>
          {media && media.speed !== 1 ? <span className="shrink-0 rounded bg-warn/90 px-1 font-mono text-[9px] leading-[12px] text-black">{speedLabel(media.speed)}</span> : null}
          {media?.reverse ? <Rewind className="h-3 w-3 shrink-0 text-warn" aria-label="Reverso" /> : null}
        </span>
      ) : null}
      {/* alças de trim: só nas bordas reais (não nas de recorte) e fora de faixa bloqueada */}
      {!locked && clipFrom === 0 ? <span data-edge="start" className={cn('absolute inset-y-0 left-0 z-[2] block cursor-ew-resize group-hover:bg-white/25', selected && 'bg-accent/70 group-hover:bg-accent')} style={{ width: edgeW }} /> : null}
      {!locked && clipTo >= w - 0.5 ? <span data-edge="end" className={cn('absolute inset-y-0 right-0 z-[2] block cursor-ew-resize group-hover:bg-white/25', selected && 'bg-accent/70 group-hover:bg-accent')} style={{ width: edgeW }} /> : null}
    </div>
  )
})
