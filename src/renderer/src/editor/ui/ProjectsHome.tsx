import { useCallback, useEffect, useState } from 'react'
import { Clapperboard, Film, LoaderCircle, Pencil, Plus, RefreshCw, Scissors, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectSummary } from '@shared/ipc'
import { createEmptyProject } from '@shared/editor/factory'
import { newProjectId } from '@shared/editor/ids'
import { useAppStore } from '@/app/store'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, EmptyState, Segmented, Tip } from '@/components/ui/primitives'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/cn'
import { ASPECTS, canvasForAspect, type AspectId } from './aspects'
import { shortDuration } from './MediaCard'
import { projectFileUrl } from './mediaImport'

// Projetos do editor (screen 'projects'): novo projeto (nome + proporção), lista com abrir/renomear/
// excluir e atalho para editar uma gravação do Histórico.

type ListState = { status: 'loading' } | { status: 'ready'; items: ProjectSummary[] } | { status: 'error'; message: string }
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const NEW_ASPECTS = ASPECTS.filter((a) => a.id !== 'original').map((a) => ({ value: a.id, label: a.id, title: a.label }))

export function ProjectsHome(): React.JSX.Element {
  const api = window.api
  const openEditor = useAppStore((s) => s.openEditor)
  const setScreen = useAppStore((s) => s.setScreen)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [creating, setCreating] = useState<{ name: string; aspect: AspectId } | null>(null)
  const [renaming, setRenaming] = useState<{ p: ProjectSummary; name: string } | null>(null)
  const [toDelete, setToDelete] = useState<ProjectSummary | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList({ status: 'ready', items: await api.project.list() })
    } catch (e) {
      setList({ status: 'error', message: errMsg(e) })
    }
  }, [api])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (fn: () => Promise<void>, fail: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(`${fail}: ${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const create = (): Promise<void> =>
    run(async () => {
      if (!creating) return
      const base = createEmptyProject(creating.name.trim() || 'Projeto sem título')
      const project = { ...base, id: newProjectId(new Date()), canvas: { ...base.canvas, ...canvasForAspect(base, creating.aspect) } }
      await api.project.create(project)
      setCreating(null)
      openEditor(project.id)
    }, 'Não foi possível criar o projeto')

  const rename = (): Promise<void> =>
    run(async () => {
      if (!renaming) return
      const name = renaming.name.trim()
      if (name && name !== renaming.p.name) {
        const p = await api.project.load(renaming.p.id)
        await api.project.save({ ...p, name, updatedAt: new Date().toISOString() })
      }
      setRenaming(null)
      await refresh()
    }, 'Não foi possível renomear')

  const remove = (): Promise<void> =>
    run(async () => {
      if (!toDelete) return
      await api.project.remove(toDelete.id)
      toast('Projeto enviado à Lixeira.')
      setToDelete(null)
      await refresh()
    }, 'Não foi possível excluir')

  const items = list.status === 'ready' ? list.items : []
  return (
    <div className="flex h-full min-h-0 flex-col p-4 rise-in">
      <header className="mb-3 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border-strong bg-surface-2 text-fg-2">
          <Clapperboard className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold tracking-tight">Projetos do editor</h1>
          <p className="text-[11px] text-muted">{list.status === 'ready' ? (items.length === 0 ? 'Nenhum projeto ainda.' : `${items.length} ${items.length === 1 ? 'projeto' : 'projetos'}`) : 'Carregando…'}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={list.status === 'loading'}>
          <RefreshCw className={cn('h-3.5 w-3.5', list.status === 'loading' && 'animate-spin')} /> Atualizar
        </Button>
        <Button variant="primary" size="sm" onClick={() => setCreating({ name: '', aspect: '16:9' })}>
          <Plus className="h-3.5 w-3.5" /> Novo projeto
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {list.status === 'loading' ? (
          <div className="flex h-40 items-center justify-center text-muted">
            <LoaderCircle className="h-5 w-5 animate-spin" />
          </div>
        ) : list.status === 'error' ? (
          <EmptyState title="Não foi possível listar os projetos" description={list.message} action={<Button onClick={() => void refresh()}>Tentar de novo</Button>} className="mx-auto mt-10 max-w-md" />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            <button type="button" onClick={() => setScreen('history')} className="card group flex min-h-[200px] flex-col items-center justify-center gap-2 border-dashed p-4 text-center transition-colors hover:border-accent/40">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/12 text-accent ring-1 ring-accent/25 transition-transform group-hover:scale-105">
                <Scissors className="h-5 w-5" />
              </span>
              <span className="text-[13px] font-semibold">Editar uma gravação</span>
              <span className="max-w-[200px] text-[11px] leading-relaxed text-muted">Escolha uma gravação no Histórico e toque em Editar: tela, webcam, áudios e anotações viram faixas.</span>
            </button>
            {items.map((p, i) => (
              <ProjectCard key={p.id} p={p} index={i} onOpen={() => openEditor(p.id)} onRename={() => setRenaming({ p, name: p.name })} onDelete={() => setToDelete(p)} />
            ))}
          </div>
        )}
      </div>

      <Dialog open={creating !== null} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent
          title="Novo projeto"
          description="Dê um nome e escolha a proporção do vídeo. Dá para mudar depois."
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(null)} disabled={busy}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={() => void create()} disabled={busy}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Criar e abrir
              </Button>
            </>
          }
        >
          {creating ? (
            <div className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-fg-2">Nome</span>
                <input
                  autoFocus
                  className="h-10 w-full rounded-xl border border-border-strong bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent/60"
                  placeholder="Projeto sem título"
                  value={creating.name}
                  onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && void create()}
                />
              </label>
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-fg-2">Proporção</span>
                <Segmented className="flex w-full [&>*]:flex-1" value={creating.aspect} options={NEW_ASPECTS} onValueChange={(aspect) => setCreating({ ...creating, aspect })} />
                <p className="text-[11px] text-muted">{ASPECTS.find((a) => a.id === creating.aspect)?.label}</p>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent
          title="Renomear projeto"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenaming(null)} disabled={busy}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={() => void rename()} disabled={busy || !renaming?.name.trim()}>
                Salvar
              </Button>
            </>
          }
        >
          {renaming ? (
            <input
              autoFocus
              aria-label="Nome do projeto"
              className="h-10 w-full rounded-xl border border-border-strong bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent/60"
              value={renaming.name}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void rename()}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent
          title="Excluir projeto?"
          description={toDelete ? `“${toDelete.name}” vai para a Lixeira, com proxies e miniaturas. As mídias originais e as gravações não são apagadas.` : undefined}
          footer={
            <>
              <Button variant="ghost" onClick={() => setToDelete(null)} disabled={busy}>
                Cancelar
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                <Trash2 className="h-4 w-4" /> Excluir
              </Button>
            </>
          }
        />
      </Dialog>
    </div>
  )
}

function ProjectCard({ p, index, onOpen, onRename, onDelete }: { p: ProjectSummary; index: number; onOpen: () => void; onRename: () => void; onDelete: () => void }): React.JSX.Element {
  const [thumbOk, setThumbOk] = useState(true)
  return (
    <article className={cn('card group flex flex-col overflow-hidden rise-in', index < 8 && `rise-in-${Math.min(4, (index % 4) + 1)}`)}>
      <button type="button" className="relative aspect-video w-full overflow-hidden bg-bg-2" onClick={onOpen} aria-label={`Abrir ${p.name}`}>
        {p.thumb && thumbOk ? (
          <img src={projectFileUrl(p.id, 'cache/thumb.jpg')} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" onError={() => setThumbOk(false)} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-2">
            <Film className="h-8 w-8" />
          </div>
        )}
        {p.durationUs > 0 ? <span className="font-mono tnum absolute bottom-2 left-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white">{shortDuration(p.durationUs)}</span> : null}
      </button>
      <div className="flex items-center gap-1 p-3 pr-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen} tabIndex={-1}>
          <div className="truncate text-[13px] font-semibold" title={p.name}>
            {p.name}
          </div>
          <div className="truncate text-[11px] text-muted">Editado em {formatDate(p.updatedAt)}</div>
        </button>
        <Tip content="Renomear">
          <button type="button" className="rounded-md p-1.5 text-muted hover:bg-white/5 hover:text-fg" onClick={onRename} aria-label="Renomear">
            <Pencil className="h-4 w-4" />
          </button>
        </Tip>
        <Tip content="Excluir projeto">
          <button type="button" className="rounded-md p-1.5 text-muted hover:bg-danger/10 hover:text-danger" onClick={onDelete} aria-label="Excluir">
            <Trash2 className="h-4 w-4" />
          </button>
        </Tip>
      </div>
    </article>
  )
}
