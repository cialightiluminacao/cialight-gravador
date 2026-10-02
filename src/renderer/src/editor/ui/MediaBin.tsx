import { useCallback, useEffect, useState } from 'react'
import { Clapperboard, FolderInput, LoaderCircle, Plus, Upload } from 'lucide-react'
import type { SessionSummary } from '@shared/types'
import type { Asset } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { Tabs, TabsContent, TabsList, TabsTrigger, Tip } from '@/components/ui/primitives'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useEditorStore } from '../state/editorStore'
import { EffectLibrary } from './EffectLibrary'
import { TextLibrary } from './TextLibrary'
import { TransitionLibrary } from './TransitionLibrary'
import { CaptionsPanel } from './CaptionsPanel'
import type { PlaybackController } from '../engine/PlaybackController'
import { MediaCard } from './MediaCard'
import { addAssetAtPlayhead } from './editorActions'
import { importPaths, importSession, relinkAsset } from './mediaImport'
import { stopAudioPreview } from './audioPreview'

// Biblioteca (coluna esquerda): abas Mídia / Áudio / Gravações / Efeitos / Texto / Transições / Legendas; importar por botão ou arrastando
// arquivos do Explorer; cartões arrastáveis para a linha do tempo (efeitos também para o visualizador).
// Aba Áudio: músicas com prévia no cartão; ao entrar na linha do tempo vão para a faixa "Música" (papel música,
// abaixa sozinha sob a voz). A prévia para quando a linha do tempo toca, ao trocar de aba ou ao sair do editor.

type Tab = 'media' | 'audio' | 'recordings' | 'effects' | 'text' | 'transitions' | 'captions'
const NO_ASSETS: Asset[] = []

const pad2 = (n: number): string => String(n).padStart(2, '0')
function sessionLabel(iso: string): string {
  const d = new Date(iso)
  return `Gravação ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

export function MediaBin({ projectId, playback }: { projectId: string; playback: PlaybackController | null }): React.JSX.Element {
  const assets = useEditorStore((s) => s.project?.assets ?? NO_ASSETS)
  const ingest = useEditorStore((s) => s.ingest)
  const [tab, setTab] = useState<Tab>('media')
  const [dropping, setDropping] = useState(false)
  const [busy, setBusy] = useState(false)
  const playing = useEditorStore((s) => s.playing)
  useEffect(() => {
    if (playing) stopAudioPreview()
  }, [playing])
  useEffect(() => () => stopAudioPreview(), [])
  useEffect(() => {
    if (tab !== 'audio') stopAudioPreview()
  }, [tab])

  const runImport = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    setBusy(true)
    try {
      const added = await importPaths(projectId, paths)
      if (added.length && added.every((a) => a.kind === 'audio')) setTab('audio')
      else if (added.length) setTab('media')
    } finally {
      setBusy(false)
    }
  }
  const pick = async (): Promise<void> => runImport(await window.api.project.pickMedia())

  const visual = assets.filter((a) => a.kind !== 'audio')
  const audio = assets.filter((a) => a.kind === 'audio')
  const grid = (list: Asset[], empty: React.ReactNode): React.ReactNode =>
    list.length === 0 ? (
      empty
    ) : (
      <div className="grid grid-cols-2 gap-1.5 p-2">
        {list.map((a) => (
          <MediaCard key={a.id} projectId={projectId} asset={a} progress={ingest[a.id]} onAdd={() => addAssetAtPlayhead(a.id)} onRelink={() => void relinkAsset(projectId, a)} />
        ))}
      </div>
    )

  return (
    <aside
      className={cn('relative flex min-h-0 flex-col border-r border-border bg-surface/60', dropping && 'ring-2 ring-inset ring-accent/70')}
      aria-label="Biblioteca de mídia"
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setDropping(false)
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.api.app.pathForFile(f))
          .filter(Boolean)
        void runImport(paths)
      }}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-9 shrink-0 items-start gap-2 border-b border-border px-2 py-1">
          {/* 7 abas não cabem numa linha de 280 px: a lista quebra em duas */}
          <TabsList className="h-auto min-w-0 flex-1 flex-wrap gap-0.5 rounded-lg p-0.5">
            <TabsTrigger value="media" className="h-6 rounded-md px-2 text-[11px]">
              Mídia
            </TabsTrigger>
            <TabsTrigger value="audio" className="h-6 rounded-md px-2 text-[11px]">
              Áudio
            </TabsTrigger>
            <TabsTrigger value="recordings" className="h-6 rounded-md px-2 text-[11px]">
              Gravações
            </TabsTrigger>
            <TabsTrigger value="effects" className="h-6 rounded-md px-2 text-[11px]">
              Efeitos
            </TabsTrigger>
            <TabsTrigger value="text" className="h-6 rounded-md px-2 text-[11px]">
              Texto
            </TabsTrigger>
            <TabsTrigger value="transitions" className="h-6 rounded-md px-2 text-[11px]">
              Transições
            </TabsTrigger>
            <TabsTrigger value="captions" className="h-6 rounded-md px-2 text-[11px]">
              Legendas
            </TabsTrigger>
          </TabsList>
          <Tip content="Importar vídeos, áudios e imagens">
            {/* só o ícone: com 4 abas a coluna de 280 px não comporta o rótulo */}
            <Button variant="secondary" size="sm" className="h-7 w-7 shrink-0 rounded-lg px-0" aria-label="Importar" onClick={() => void pick()} disabled={busy}>
              {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            </Button>
          </Tip>
        </div>
        <TabsContent value="media" className="min-h-0 flex-1 overflow-y-auto">
          {grid(visual, <DropHint onPick={() => void pick()} text="Arraste vídeos e imagens do Explorer para cá ou clique em Importar." />)}
        </TabsContent>
        <TabsContent value="audio" className="min-h-0 flex-1 overflow-y-auto">
          {audio.length ? <p className="px-3 pt-2 text-[10.5px] leading-relaxed text-muted-2">Na linha do tempo, a música vai para a faixa Música e abaixa sozinha quando há fala nas faixas de Voz.</p> : null}
          {grid(audio, <DropHint onPick={() => void pick()} text="Arraste músicas (MP3, WAV, M4A…) para cá ou clique em Importar. Elas vão para a faixa Música e abaixam sozinhas sob a voz." />)}
        </TabsContent>
        <TabsContent value="recordings" className="min-h-0 flex-1 overflow-y-auto">
          <Recordings projectId={projectId} onAdded={() => setTab('media')} />
        </TabsContent>
        <TabsContent value="effects" className="min-h-0 flex-1 overflow-y-auto">
          <EffectLibrary />
        </TabsContent>
        <TabsContent value="text" className="min-h-0 flex-1 overflow-y-auto">
          <TextLibrary />
        </TabsContent>
        <TabsContent value="transitions" className="min-h-0 flex-1 overflow-y-auto">
          <TransitionLibrary />
        </TabsContent>
        <TabsContent value="captions" className="min-h-0 flex-1 overflow-y-auto">
          <CaptionsPanel playback={playback} />
        </TabsContent>
      </Tabs>
      {dropping ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent/10 backdrop-blur-[1px]">
          <span className="flex items-center gap-2 rounded-lg bg-surface-3 px-3 py-2 text-xs font-semibold shadow-xl">
            <FolderInput className="h-4 w-4 text-accent" /> Solte para importar
          </span>
        </div>
      ) : null}
    </aside>
  )
}

function DropHint({ text, onPick }: { text: string; onPick: () => void }): React.JSX.Element {
  return (
    <button type="button" onClick={onPick} className="m-2 flex w-[calc(100%-16px)] flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-muted transition-colors hover:border-accent/50 hover:text-fg-2">
      <FolderInput className="h-6 w-6" />
      <span className="text-[11px] leading-relaxed">{text}</span>
    </button>
  )
}

function Recordings({ projectId, onAdded }: { projectId: string; onAdded: () => void }): React.JSX.Element {
  const [list, setList] = useState<SessionSummary[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const load = useCallback(async () => {
    const items = await window.api.session.list().catch(() => [] as SessionSummary[])
    setList(items.filter((s) => s.durationMs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  if (!list) {
    return (
      <div className="flex h-24 items-center justify-center text-muted">
        <LoaderCircle className="h-4 w-4 animate-spin" />
      </div>
    )
  }
  if (!list.length) {
    return (
      <div className="m-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-muted">
        <Clapperboard className="h-6 w-6" />
        <span className="text-[11px]">Nenhuma gravação no Histórico.</span>
      </div>
    )
  }
  const add = async (s: SessionSummary): Promise<void> => {
    setBusyId(s.id)
    const added = await importSession(projectId, s.id, sessionLabel(s.createdAt))
    setBusyId(null)
    if (added.length) onAdded()
  }
  return (
    <ul className="space-y-1 p-2">
      {list.map((s) => (
        <li key={s.id} className="flex items-center gap-2 rounded-lg p-1 hover:bg-white/4">
          <div className="flex aspect-video w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-bg-2">
            {s.thumb ? <img src={window.api.session.fileUrl(s.id, 'thumbs/001.jpg')} alt="" className="h-full w-full object-cover" /> : <Clapperboard className="h-4 w-4 text-muted-2" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-semibold text-fg-2">{sessionLabel(s.createdAt)}</div>
            <div className="font-mono tnum truncate text-[10px] text-muted">
              {formatClock(s.durationMs ?? 0)} · {s.sourceName}
            </div>
          </div>
          <Tip content="Adicionar as faixas desta gravação à biblioteca">
            <button type="button" aria-label="Adicionar gravação" disabled={busyId !== null} onClick={() => void add(s)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40">
              {busyId === s.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
            </button>
          </Tip>
        </li>
      ))}
    </ul>
  )
}
