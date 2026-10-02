import { useEffect, useState } from 'react'
import { Check, ChevronLeft, CloudAlert, Crop, ImageDown, ListOrdered, LoaderCircle, Redo2, Undo2, Upload } from 'lucide-react'
import type { Project } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { Select, Tip, type SelectOption } from '@/components/ui/primitives'
import { useEditorStore } from '../state/editorStore'
import { SHORTCUT_LABELS } from '../shortcuts'
import { ASPECTS, aspectIdOf, canvasForAspect, firstMediaSize, type AspectId } from './aspects'
import { useReframe } from '../state/reframe'
import { defaultReframeAspect } from './ReframeDialog'
import { exportCurrentFrame } from './frameExport'
import { copyProjectChapters } from './chaptersActions'
import { ExportQueueButton } from './ExportQueuePanel'

// Barra superior do editor: voltar (salva antes), nome editável, desfazer/refazer, estado do
// autosave, proporção do quadro (só o quadro), "Reenquadrar" (proporção nova com o conteúdo reposicionado),
// "Quadro" (o quadro do cursor como PNG), "Exportações" (a fila, quando há itens) e Exportar.

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

function SaveState(): React.JSX.Element {
  const saving = useEditorStore((s) => s.saving)
  const dirty = useEditorStore((s) => s.dirty)
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt)
  const now = useNow(5000)
  let label: string
  let icon: React.ReactNode
  if (saving) {
    label = 'Salvando…'
    icon = <LoaderCircle className="h-3 w-3 animate-spin" />
  } else if (dirty) {
    label = 'Alterações pendentes'
    icon = <CloudAlert className="h-3 w-3 text-warn" />
  } else {
    const sec = lastSavedAt ? Math.max(0, Math.round((now - lastSavedAt) / 1000)) : null
    label = sec === null ? 'Salvo' : sec < 5 ? 'Salvo agora' : sec < 60 ? `Salvo há ${sec}s` : `Salvo há ${Math.floor(sec / 60)} min`
    icon = <Check className="h-3 w-3 text-ok" />
  }
  return (
    <span className="flex min-w-[118px] items-center gap-1.5 text-[11px] text-muted" role="status" aria-live="polite">
      {icon}
      {label}
    </span>
  )
}

function ProjectName({ project }: { project: Project }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    const name = draft?.trim()
    setDraft(null)
    if (name && name !== project.name) useEditorStore.getState().apply((p) => ({ ...p, name }))
  }
  return (
    <input
      aria-label="Nome do projeto"
      title="Clique para renomear"
      className="h-8 w-[clamp(140px,22vw,320px)] min-w-0 truncate rounded-lg border border-transparent bg-transparent px-2 text-[13px] font-semibold text-fg outline-none hover:border-border focus:border-accent/50 focus:bg-bg-2"
      value={draft ?? project.name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(null)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}

function HistoryButton({ label, shortcut, onClick, disabled, children }: { label: string; shortcut: string; onClick: () => void; disabled: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <Tip content={label} shortcut={shortcut} side="bottom">
      <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-2 hover:bg-white/6 hover:text-fg disabled:pointer-events-none disabled:opacity-30">
        {children}
      </button>
    </Tip>
  )
}

export function TopBar({ onBack, onExport }: { onBack: () => void; onExport: () => void }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const canUndo = useEditorStore((s) => s.canUndo)
  const canRedo = useEditorStore((s) => s.canRedo)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const reframing = useReframe((s) => s.open)
  if (!project) return <div className="h-12 shrink-0 border-b border-border" />
  const aspect = aspectIdOf(project)
  const original = firstMediaSize(project)
  const options: SelectOption[] = ASPECTS.filter((a) => a.id !== 'original' || original).map((a) => ({ value: a.id, label: a.label, hint: a.id === 'original' && original ? `${original.width}×${original.height}` : a.hint }))
  if (aspect === 'custom') options.push({ value: 'custom', label: 'Personalizada', hint: `${project.canvas.width}×${project.canvas.height}` })
  const setAspect = (id: string): void => {
    if (id === 'custom') return
    useEditorStore.getState().apply((p) => ({ ...p, canvas: { ...p.canvas, ...canvasForAspect(p, id as AspectId) } }))
  }
  return (
    <header data-editor-topbar="" className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface/70 px-2">
      <Tip content="Salvar e voltar aos projetos" side="bottom">
        <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={onBack} aria-label="Voltar aos projetos">
          <ChevronLeft className="h-4 w-4" /> Projetos
        </Button>
      </Tip>
      <div className="h-5 w-px bg-border-strong" />
      <ProjectName project={project} />
      <SaveState />
      <div className="ml-auto flex items-center gap-1">
        <HistoryButton label="Desfazer" shortcut="Ctrl+Z" onClick={undo} disabled={!canUndo}>
          <Undo2 className="h-4 w-4" />
        </HistoryButton>
        <HistoryButton label="Refazer" shortcut="Ctrl+Shift+Z" onClick={redo} disabled={!canRedo}>
          <Redo2 className="h-4 w-4" />
        </HistoryButton>
        <div className="mx-1.5 h-5 w-px bg-border-strong" />
        <Tip content="Proporção do quadro do projeto" side="bottom">
          <span className="block w-[200px]">
            <Select triggerClassName="h-8 rounded-lg px-2.5 text-xs" value={aspect} options={options} onValueChange={setAspect} />
          </span>
        </Tip>
        <Tip content="Reenquadrar para vertical, quadrado ou 4:5 seguindo o ponto de interesse" side="bottom">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5" data-reframe-open="" aria-pressed={reframing} onClick={() => (reframing ? useReframe.getState().close() : useReframe.getState().openPanel(defaultReframeAspect(project)))}>
            <Crop className="h-3.5 w-3.5" /> Reenquadrar
          </Button>
        </Tip>
        <Tip content="Exportar o quadro do cursor como PNG (tamanho do projeto)" shortcut={SHORTCUT_LABELS.exportFrame} side="bottom">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5" aria-label="Exportar quadro (PNG)" data-export-frame="" onClick={() => void exportCurrentFrame()}>
            <ImageDown className="h-3.5 w-3.5" /> Quadro
          </Button>
        </Tip>
        <Tip content="Copiar capítulos do YouTube (dos marcadores; usa I–O se marcado)" side="bottom">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5" aria-label="Copiar capítulos" data-copy-chapters="" onClick={() => void copyProjectChapters()}>
            <ListOrdered className="h-3.5 w-3.5" /> Capítulos
          </Button>
        </Tip>
        <ExportQueueButton />
        <Tip content="Exportar vídeo, GIF ou áudio" shortcut={SHORTCUT_LABELS.export} side="bottom">
          <Button variant="primary" size="sm" className="ml-1.5 h-8 px-3.5" onClick={onExport}>
            <Upload className="h-3.5 w-3.5" /> Exportar
          </Button>
        </Tip>
      </div>
    </header>
  )
}
