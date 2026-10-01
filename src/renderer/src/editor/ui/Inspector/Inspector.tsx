import { useState } from 'react'
import { Film, Image as ImageIcon, Layers, Music, SlidersHorizontal } from 'lucide-react'
import { findItem, linkedIds } from '@shared/editor/ops'
import type { Item, MediaItem, Project, VisualProps } from '@shared/editor/project'
import { formatTimecodeUs } from '@shared/editor/time'
import { Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { useEditorStore } from '../../state/editorStore'
import { NumberField } from './NumberField'
import { ColorInput, FieldRow, PanelSection } from './common'
import { VideoPanel } from './VideoPanel'
import { AudioPanel } from './AudioPanel'
import { SpeedPanel } from './SpeedPanel'

// Inspetor (coluna direita): propriedades do item selecionado; sem seleção, as do projeto.

const FPS_OPTIONS = [24, 25, 30, 50, 60].map((f) => ({ value: String(f), label: `${f} fps` }))
const ITEM_KIND: Record<Item['type'], string> = { media: 'Mídia', text: 'Texto', shape: 'Forma', effect: 'Efeito', annotations: 'Anotações' }

export function Inspector(): React.JSX.Element {
  const project = useEditorStore((s) => s.project)
  const selection = useEditorStore((s) => s.selection)
  const found = project && selection.length === 1 ? findItem(project, selection[0]) : null

  let body: React.ReactNode
  let title = 'Projeto'
  let icon = <SlidersHorizontal className="h-3.5 w-3.5" />
  if (!project) body = null
  else if (selection.length > 1) {
    title = `${selection.length} itens`
    icon = <Layers className="h-3.5 w-3.5" />
    body = <p className="px-3 py-4 text-[11px] leading-relaxed text-muted">Vários itens selecionados. Selecione um só para editar as propriedades.</p>
  } else if (found) {
    const asset = found.item.type === 'media' ? project.assets.find((a) => a.id === (found.item as MediaItem).assetId) : undefined
    title = found.item.name ?? asset?.name ?? ITEM_KIND[found.item.type]
    icon = found.track.kind === 'audio' ? <Music className="h-3.5 w-3.5" /> : asset?.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5" /> : <Film className="h-3.5 w-3.5" />
    body = <ItemPanels key={found.item.id} project={project} item={found.item} trackKind={found.track.kind} />
  } else body = <ProjectPanel project={project} />

  return (
    <aside className="flex min-h-0 flex-col border-l border-border bg-surface/60" aria-label="Inspetor">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-muted">{icon}</span>
        <h2 className="truncate text-[12px] font-semibold" title={title}>
          {title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{body}</div>
    </aside>
  )
}

function ItemPanels({ project, item, trackKind }: { project: Project; item: Item; trackKind: 'video' | 'audio' }): React.JSX.Element {
  const [tab, setTab] = useState(trackKind === 'video' ? 'video' : 'audio')
  if (item.type !== 'media') {
    return (
      <PanelSection title={ITEM_KIND[item.type]}>
        <Timing item={item} fps={project.canvas.fps} />
        <p className="pt-1 text-[11px] leading-relaxed text-muted">As propriedades deste tipo de item chegam numa próxima versão do editor.</p>
      </PanelSection>
    )
  }
  // o som de um vídeo fica no item de áudio vinculado (addMediaFromAsset); é ele que a aba Áudio edita
  const audioItem =
    trackKind === 'audio'
      ? item
      : (linkedIds(project, item.id)
          .map((id) => findItem(project, id))
          .find((f) => f && f.track.kind === 'audio' && f.item.type === 'media')?.item as MediaItem | undefined)
  const visual = trackKind === 'video' && item.visual ? (item as MediaItem & { visual: VisualProps }) : null
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col">
      <div className="px-3 pt-2.5">
        <TabsList className="flex w-full p-0.5">
          {visual ? <TabsTrigger value="video" className="h-7 flex-1 text-xs">Vídeo</TabsTrigger> : null}
          {audioItem ? <TabsTrigger value="audio" className="h-7 flex-1 text-xs">Áudio</TabsTrigger> : null}
          <TabsTrigger value="speed" className="h-7 flex-1 text-xs">Velocidade</TabsTrigger>
        </TabsList>
      </div>
      <div className="border-b border-border px-3 py-2">
        <Timing item={item} fps={project.canvas.fps} />
      </div>
      {visual ? <TabsContent value="video">{<VideoPanel item={visual} />}</TabsContent> : null}
      {audioItem ? <TabsContent value="audio">{<AudioPanel item={audioItem} />}</TabsContent> : null}
      <TabsContent value="speed">
        <SpeedPanel item={item} />
      </TabsContent>
    </Tabs>
  )
}

function Timing({ item, fps }: { item: Item; fps: number }): React.JSX.Element {
  return (
    <div className="font-mono tnum flex justify-between text-[10.5px] text-muted">
      <span title="Início na linha do tempo">{formatTimecodeUs(item.startUs, fps)}</span>
      <span title="Duração" className="text-fg-2">
        {formatTimecodeUs(item.durationUs, fps)}
      </span>
    </div>
  )
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

function ProjectPanel({ project }: { project: Project }): React.JSX.Element {
  const apply = useEditorStore((s) => s.apply)
  const c = project.canvas
  return (
    <>
      <PanelSection title="Quadro do projeto">
        <div className="grid grid-cols-2 gap-x-3">
          <NumberField compact label="Largura" value={c.width} min={16} max={7680} step={2} unit="px" onChange={(v) => apply((p) => ({ ...p, canvas: { ...p.canvas, width: even(v) } }), { transient: true })} />
          <NumberField compact label="Altura" value={c.height} min={16} max={7680} step={2} unit="px" onChange={(v) => apply((p) => ({ ...p, canvas: { ...p.canvas, height: even(v) } }), { transient: true })} />
        </div>
        <FieldRow label="Quadros/s">
          <Select triggerClassName="h-7 rounded-md px-2 text-[11px]" value={String(c.fps)} options={FPS_OPTIONS.some((o) => o.value === String(c.fps)) ? FPS_OPTIONS : [...FPS_OPTIONS, { value: String(c.fps), label: `${c.fps} fps` }]} onValueChange={(v) => apply((p) => ({ ...p, canvas: { ...p.canvas, fps: Number(v) } }))} />
        </FieldRow>
        <FieldRow label="Fundo">
          <span className="font-mono text-[10.5px] uppercase text-muted">{c.background}</span>
          <ColorInput label="Cor de fundo" value={c.background} onChange={(hex) => apply((p) => ({ ...p, canvas: { ...p.canvas, background: hex } }), { transient: true })} />
        </FieldRow>
      </PanelSection>
      <PanelSection title="Resumo">
        <FieldRow label="Mídias">
          <span className="font-mono tnum text-[11px] text-fg-2">{project.assets.length}</span>
        </FieldRow>
        <FieldRow label="Faixas">
          <span className="font-mono tnum text-[11px] text-fg-2">{project.tracks.length}</span>
        </FieldRow>
      </PanelSection>
      <p className="px-3 py-3 text-[11px] leading-relaxed text-muted-2">Selecione um item na linha do tempo ou no visualizador para editar posição, corte, áudio e velocidade.</p>
    </>
  )
}
