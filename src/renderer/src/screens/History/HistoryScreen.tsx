import { useCallback, useEffect, useState } from 'react'
import { Camera, Clapperboard, FolderOpen, History, LoaderCircle, RefreshCw, Scissors, Trash2, Video } from 'lucide-react'
import { toast } from 'sonner'
import type { SessionState, SessionSummary } from '@shared/types'
import { useAppStore } from '@/app/store'
import { Button } from '@/components/ui/Button'
import { Badge, Dialog, DialogContent, EmptyState, Tip } from '@/components/ui/primitives'
import { formatBytes, formatClock, formatDate } from '@/lib/format'
import { cn } from '@/lib/cn'

// Histórico de gravações brutas (spec §4.3 item 5): cards com miniatura, data, duração,
// tamanho, fonte e badges; abrir na Revisão, abrir pasta, excluir (com confirmação).

const STATE_BADGE: Record<SessionState, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'info' | 'accent' } | null> = {
  recording: { label: 'Interrompida', tone: 'warn' },
  stopped: { label: 'Não exportada', tone: 'info' },
  finalized: { label: 'Exportada', tone: 'ok' },
  aborted: { label: 'Cancelada', tone: 'neutral' }
}

type ListState = { status: 'loading' } | { status: 'ready'; items: SessionSummary[] } | { status: 'error'; message: string }

export function HistoryScreen(): React.JSX.Element {
  const api = window.api
  const setReviewSession = useAppStore((s) => s.setReviewSession)
  const setScreen = useAppStore((s) => s.setScreen)
  const openEditor = useAppStore((s) => s.openEditor)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [toDelete, setToDelete] = useState<SessionSummary | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const items = await api.session.list()
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setList({ status: 'ready', items })
    } catch (e) {
      setList({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const open = async (s: SessionSummary): Promise<void> => {
    setBusyId(s.id)
    try {
      const session = await api.session.get(s.id)
      if (!session) {
        toast.error('Esta gravação não foi encontrada no disco.')
        await refresh()
        return
      }
      setReviewSession(session)
      setScreen('review')
    } finally {
      setBusyId(null)
    }
  }

  /** Cria um projeto do editor a partir da gravação e o abre. */
  const edit = async (s: SessionSummary): Promise<void> => {
    setBusyId(s.id)
    try {
      const project = await api.project.fromSession(s.id)
      openEditor(project.id)
    } catch (e) {
      toast.error(`Não foi possível abrir no editor: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (!toDelete) return
    setBusyId(toDelete.id)
    try {
      await api.session.delete(toDelete.id)
      toast('Gravação enviada à Lixeira.')
      setToDelete(null)
      await refresh()
    } catch (e) {
      toast.error(`Não foi possível excluir: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const items = list.status === 'ready' ? list.items : []
  const totalBytes = items.reduce((acc, s) => acc + s.bytes, 0)

  return (
    <div className="flex h-full min-h-0 flex-col p-4 rise-in">
      <header className="mb-3 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border-strong bg-surface-2 text-fg-2">
          <History className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold tracking-tight">Histórico de gravações</h1>
          <p className="text-[11px] text-muted">
            {list.status === 'ready'
              ? items.length === 0
                ? 'Nenhuma gravação bruta guardada.'
                : `${items.length} ${items.length === 1 ? 'gravação bruta' : 'gravações brutas'} · ${formatBytes(totalBytes)} em disco`
              : 'Carregando…'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={list.status === 'loading'}>
          <RefreshCw className={cn('h-3.5 w-3.5', list.status === 'loading' && 'animate-spin')} /> Atualizar
        </Button>
        <Button variant="primary" size="sm" onClick={() => setScreen('prepare')}>
          <Video className="h-3.5 w-3.5" /> Nova gravação
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {list.status === 'loading' ? (
          <div className="flex h-40 items-center justify-center text-muted">
            <LoaderCircle className="h-5 w-5 animate-spin" />
          </div>
        ) : list.status === 'error' ? (
          <EmptyState title="Não foi possível listar as gravações" description={list.message} action={<Button onClick={() => void refresh()}>Tentar de novo</Button>} className="mx-auto mt-10 max-w-md" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Clapperboard className="h-8 w-8" />}
            title="Nenhuma gravação ainda"
            description="As gravações brutas ficam aqui até você exportar e excluir. Comece gravando o seu primeiro vídeo."
            action={
              <Button variant="primary" onClick={() => setScreen('prepare')}>
                <Video className="h-4 w-4" /> Gravar agora
              </Button>
            }
            className="mx-auto mt-10 max-w-md"
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {items.map((s, i) => (
              <SessionCard key={s.id} s={s} index={i} busy={busyId === s.id} onOpen={() => void open(s)} onEdit={() => void edit(s)} onFolder={() => void api.session.openFolder(s.id)} onDelete={() => setToDelete(s)} />
            ))}
          </div>
        )}
      </div>

      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent
          title="Excluir gravação bruta?"
          description={toDelete ? `A gravação de ${formatDate(toDelete.createdAt)} (${toDelete.sourceName}, ${formatBytes(toDelete.bytes)}) vai para a Lixeira. Vídeos já exportados não são afetados.` : undefined}
          footer={
            <>
              <Button variant="ghost" onClick={() => setToDelete(null)} disabled={busyId !== null}>
                Cancelar
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busyId !== null}>
                <Trash2 className="h-4 w-4" /> Excluir
              </Button>
            </>
          }
        />
      </Dialog>
    </div>
  )
}

function SessionCard({ s, index, busy, onOpen, onEdit, onFolder, onDelete }: { s: SessionSummary; index: number; busy: boolean; onOpen: () => void; onEdit: () => void; onFolder: () => void; onDelete: () => void }): React.JSX.Element {
  const [thumbOk, setThumbOk] = useState(true)
  const badge = STATE_BADGE[s.state]
  const thumbUrl = s.thumb ? window.api.session.fileUrl(s.id, 'thumbs/001.jpg') : null
  return (
    <article className={cn('card group flex flex-col overflow-hidden rise-in', index < 8 && `rise-in-${Math.min(4, (index % 4) + 1)}`)}>
      <button type="button" className="relative aspect-video w-full overflow-hidden bg-bg-2 text-left" onClick={onOpen} aria-label="Abrir na Revisão">
        {thumbUrl && thumbOk ? (
          <img src={thumbUrl} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" onError={() => setThumbOk(false)} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-2">
            <Clapperboard className="h-8 w-8" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 to-transparent p-2">
          <span className="font-mono tnum rounded-md bg-black/50 px-1.5 py-0.5 text-[11px] text-white">{s.durationMs !== null ? formatClock(s.durationMs) : '—:—:—'}</span>
          <span className="flex gap-1">
            {s.hasWebcam ? (
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-black/50 text-white" title="Com webcam">
                <Camera className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </span>
        </div>
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <LoaderCircle className="h-5 w-5 animate-spin text-white" />
          </div>
        ) : null}
      </button>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{formatDate(s.createdAt)}</div>
            <div className="truncate text-[11px] text-muted" title={s.sourceName}>
              {s.sourceName}
            </div>
          </div>
          {badge ? (
            <Badge tone={badge.tone} className="shrink-0 whitespace-nowrap">
              {badge.label}
            </Badge>
          ) : null}
        </div>
        <div className="mt-auto flex items-center gap-1 pt-1">
          <span className="font-mono tnum mr-auto text-[11px] text-muted">{formatBytes(s.bytes)}</span>
          <Tip content="Abrir pasta da gravação">
            <button type="button" className="rounded-md p-1.5 text-muted hover:bg-white/5 hover:text-fg" onClick={onFolder} aria-label="Abrir pasta">
              <FolderOpen className="h-4 w-4" />
            </button>
          </Tip>
          <Tip content="Excluir gravação bruta">
            <button type="button" className="rounded-md p-1.5 text-muted hover:bg-danger/10 hover:text-danger" onClick={onDelete} aria-label="Excluir">
              <Trash2 className="h-4 w-4" />
            </button>
          </Tip>
          <Tip content="Criar um projeto no editor com esta gravação">
            <Button size="sm" variant="outline" className="ml-1" onClick={onEdit} disabled={busy || !s.durationMs}>
              <Scissors className="h-3.5 w-3.5" /> Editar
            </Button>
          </Tip>
          <Button size="sm" variant="secondary" onClick={onOpen} disabled={busy}>
            Revisar
          </Button>
        </div>
      </div>
    </article>
  )
}
