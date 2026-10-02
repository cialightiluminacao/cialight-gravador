import { AlertTriangle, AudioLines, Film, Image as ImageIcon, Plus, SearchX } from 'lucide-react'
import type { Asset, Us } from '@shared/editor/project'
import type { IngestStep } from '@shared/ipc'
import { Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import type { IngestProgress } from '../state/editorStore'
import { mediaUrl, projectFileUrl } from './mediaImport'

// Cartão de mídia da biblioteca: miniatura (1º quadro do filmstrip), duração e estado da ingestão.
// Arrastável para a linha do tempo (application/x-cialight-asset); duplo clique adiciona no playhead.

export const ASSET_MIME = 'application/x-cialight-asset'

const STEP_LABEL: Record<IngestStep, string> = { probe: 'Analisando', proxy: 'Gerando proxy', intermediate: 'Convertendo', filmstrip: 'Miniaturas', peaks: 'Forma de onda', speech: 'Detectando fala', loudness: 'Medindo volume', audioProcess: 'Processando áudio' }

export function shortDuration(us: Us | null): string {
  if (us === null) return ''
  const s = Math.max(0, Math.round(us / 1e6))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function Thumb({ projectId, asset }: { projectId: string; asset: Asset }): React.JSX.Element {
  const fs = asset.filmstripInfo
  if (asset.kind === 'image' && (asset.status === 'ready' || asset.status === 'processing')) {
    return <img src={mediaUrl(projectId, asset.id)} alt="" draggable={false} className="h-full w-full object-contain" />
  }
  if (asset.kind === 'video' && asset.filmstrip && fs) {
    return (
      <div
        className="h-full max-w-full bg-no-repeat"
        style={{ aspectRatio: `${fs.tileW} / ${fs.tileH}`, backgroundImage: `url("${projectFileUrl(projectId, asset.filmstrip)}")`, backgroundSize: `${fs.frames * 100}% 100%`, backgroundPosition: '0 0' }}
      />
    )
  }
  const Icon = asset.kind === 'audio' ? AudioLines : asset.kind === 'image' ? ImageIcon : Film
  return <Icon className={cn('h-6 w-6', asset.kind === 'audio' ? 'text-info/70' : 'text-muted-2')} />
}

export function MediaCard({ projectId, asset, progress, onAdd, onRelink }: { projectId: string; asset: Asset; progress?: IngestProgress; onAdd: () => void; onRelink: () => void }): React.JSX.Element {
  const unusable = asset.status === 'error'
  return (
    <div
      className={cn('group relative flex min-w-0 flex-col gap-1 rounded-lg p-1 outline-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-[var(--ring)]', unusable ? 'cursor-default' : 'cursor-grab active:cursor-grabbing')}
      draggable={!unusable}
      tabIndex={0}
      role="button"
      aria-label={`${asset.name}${unusable ? ' (com erro)' : '. Enter ou duplo clique adiciona no playhead'}`}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_MIME, asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={() => !unusable && onAdd()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !unusable) onAdd()
      }}
      title={asset.error ?? asset.name}
    >
      <div className={cn('relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border', asset.kind === 'audio' ? 'bg-gradient-to-br from-info/10 to-bg-2' : 'bg-bg-2')}>
        <Thumb projectId={projectId} asset={asset} />
        {asset.durationUs !== null ? <span className="font-mono tnum absolute bottom-1 right-1 rounded bg-black/65 px-1 text-[9.5px] leading-4 text-white">{shortDuration(asset.durationUs)}</span> : null}
        {asset.status === 'processing' ? (
          <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 pb-1 pt-0.5">
            <div className="flex justify-between text-[9.5px] leading-4 text-white/90">
              <span className="truncate">{progress ? STEP_LABEL[progress.step as IngestStep] ?? 'Processando' : 'Na fila'}</span>
              {progress ? <span className="font-mono tnum">{Math.round(progress.percent)}%</span> : null}
            </div>
            <div className="h-0.5 overflow-hidden rounded bg-white/15">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
          </div>
        ) : null}
        {asset.status === 'missing' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70">
            <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warn">
              <SearchX className="h-3 w-3" /> Ausente
            </span>
            <button type="button" className="rounded-md border border-border-strong bg-surface-3 px-2 py-0.5 text-[10.5px] font-semibold text-fg hover:bg-surface-2" onClick={onRelink}>
              Localizar…
            </button>
          </div>
        ) : null}
        {asset.status === 'error' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-black/70 px-2 text-center">
            <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-danger">
              <AlertTriangle className="h-3 w-3" /> Erro
            </span>
            <span className="line-clamp-2 w-full text-[9.5px] leading-3 text-white/70 [overflow-wrap:anywhere]">{asset.error ?? 'Não foi possível processar'}</span>
          </div>
        ) : null}
        {!unusable ? (
          <Tip content="Adicionar no playhead">
            <button
              type="button"
              aria-label={`Adicionar ${asset.name} no playhead`}
              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-accent text-white opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onAdd()
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tip>
        ) : null}
      </div>
      <span className="truncate px-0.5 text-[11px] leading-4 text-fg-2">{asset.name}</span>
    </div>
  )
}
