import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Asset } from '@shared/editor/project'
import { useAppStore } from '@/app/store'
import { flushAutosave, startAutosave, useEditorStore } from '../state/editorStore'
import { shortcutFor } from '../shortcuts'
import { createEditorEngine, type EditorEngine } from './editorEngine'
import { runShortcut } from './editorActions'
import { enqueuePending, importPaths } from './mediaImport'
import { TopBar } from './TopBar'
import { MediaBin } from './MediaBin'
import { Viewer } from './Viewer'
import { Inspector } from './Inspector/Inspector'
import { TimelinePlaceholder } from './TimelinePlaceholder'

// Tela do editor (spec §9): [Biblioteca 280 | Visualizador | Inspetor 320] em cima e a linha do
// tempo embaixo (altura redimensionável, salva no localStorage). Monta o motor (render, áudio,
// reprodução), o autosave e a ingestão; ao sair: salva, solta o projeto no main e libera tudo.

declare global {
  interface Window {
    __qaEditor?: { store: typeof useEditorStore; engine: EditorEngine; importPaths: (paths: string[]) => Promise<Asset[]> }
  }
}

const TIMELINE_KEY = 'editor.timelineHeight'
const TIMELINE_MIN = 220
const TOP_MIN = 300 // espaço mínimo para biblioteca/visualizador/inspetor
// janelas de exibição abertas: só a mais recente pode soltar o projeto/janela ao desmontar (StrictMode)
let mountSeq = 0

function readTimelineHeight(): number {
  try {
    const v = Number(localStorage.getItem(TIMELINE_KEY))
    return Number.isFinite(v) && v >= TIMELINE_MIN ? v : 260
  } catch {
    return 260
  }
}

/** Teclas que pertencem a controles focados (listas, sliders, abas, diálogos) e não viram atalho. */
const OWN_KEYS = ['listbox', 'option', 'menu', 'menuitem', 'dialog', 'slider', 'tab', 'tablist', 'group', 'radiogroup', 'switch', 'combobox'].map((r) => `[role="${r}"]`).join(',')

export function EditorScreen({ projectId }: { projectId: string }): React.JSX.Element {
  const [engine, setEngine] = useState<EditorEngine | null>(null)
  const [timelineH, setTimelineH] = useState(readTimelineHeight)
  const loaded = useEditorStore((s) => s.project?.id === projectId)
  const engineRef = useRef<EditorEngine | null>(null)

  // ---- ciclo de vida: projeto, motor, autosave, ingestão, janela maximizada ----
  useEffect(() => {
    const token = ++mountSeq
    let alive = true
    const api = window.api
    const eng = createEditorEngine()
    engineRef.current = eng
    setEngine(eng)
    const stopAutosave = startAutosave((p) => api.project.save(p))
    // QA (fora do pacote): store e motor acessíveis por CDP
    if (useAppStore.getState().appInfo?.isPackaged === false) window.__qaEditor = { store: useEditorStore, engine: eng, importPaths: (paths) => importPaths(projectId, paths) }
    const offProgress = api.media.onProgress((j) => {
      if (j.projectId.toLowerCase() === projectId.toLowerCase()) useEditorStore.getState().setIngest(j.assetId, { step: j.step, percent: j.percent })
    })
    const offDone = api.media.onDone((d) => {
      if (d.projectId.toLowerCase() !== projectId.toLowerCase()) return
      const st = useEditorStore.getState()
      st.setIngest(d.assetId, null)
      st.applyAssetPatch(d.assetId, d.patch)
      if (d.patch.status === 'error') {
        const name = st.project?.assets.find((a) => a.id === d.assetId)?.name ?? 'mídia'
        toast.error(`Não foi possível processar “${name}”`, { description: d.patch.error })
      }
    })
    // fechar a janela/sair com o editor aberto: o main pede para gravar tudo antes (e espera até 2 s)
    const offFlush = api.editor.onFlushRequest(async () => {
      // campo com texto digitado: o blur confirma o valor (commit síncrono)
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
      const st = useEditorStore.getState()
      if (st.txBase) st.commitTx()
      await flushAutosave()
      // daqui em diante o main grava sozinho os resultados de ingestão que chegarem
      await api.media.setOpenProject(null)
      // patches entregues antes da resposta acima já estão no store: grava de novo se algo mudou
      await flushAutosave()
    })
    void api.app.setEditorMode(true)
    void (async () => {
      try {
        const project = await api.project.load(projectId)
        if (!alive) return
        useEditorStore.getState().open(project)
        await api.media.setOpenProject(project.id)
        if (alive) enqueuePending(project.id, project.assets)
      } catch (e) {
        if (!alive) return
        toast.error(`Não foi possível abrir o projeto: ${e instanceof Error ? e.message : String(e)}`)
        useAppStore.getState().closeEditor()
      }
    })()

    return () => {
      alive = false
      offFlush()
      offProgress()
      offDone()
      eng.playback.pause()
      engineRef.current = null
      if (window.__qaEditor?.engine === eng) delete window.__qaEditor
      void (async () => {
        // ordem: salvar → soltar o projeto no main (patches voltam a ser gravados por ele) → liberar o motor.
        // Outra montagem pode começar durante cada await: só a mais recente solta projeto/janela/store.
        await flushAutosave().catch(() => {})
        stopAutosave()
        if (token === mountSeq) await api.media.setOpenProject(null).catch(() => {})
        eng.dispose()
        if (token === mountSeq) {
          useEditorStore.getState().close()
          void api.app.setEditorMode(false)
        }
      })()
    }
  }, [projectId])

  // ---- atalhos ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      if (useEditorStore.getState().project?.id !== projectId) return // outro projeto ainda no store (troca em curso)
      const t = e.target as Element | null
      if (!e.ctrlKey && t?.closest?.(OWN_KEYS)) return
      const action = shortcutFor(e)
      if (action && runShortcut(action, engineRef.current?.playback ?? null)) e.preventDefault()
    }
    // arquivos soltos fora da biblioteca não podem navegar a janela para o arquivo
    const blockDrop = (e: DragEvent): void => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragover', blockDrop)
    window.addEventListener('drop', blockDrop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', blockDrop)
      window.removeEventListener('drop', blockDrop)
    }
  }, [projectId])

  const back = async (): Promise<void> => {
    engineRef.current?.playback.pause()
    await flushAutosave()
    useAppStore.getState().closeEditor()
  }

  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineH
    let h = startH
    const move = (ev: PointerEvent): void => {
      const max = Math.max(TIMELINE_MIN, window.innerHeight - TOP_MIN - 88)
      h = Math.round(Math.min(max, Math.max(TIMELINE_MIN, startH + startY - ev.clientY)))
      setTimelineH(h)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      try {
        localStorage.setItem(TIMELINE_KEY, String(h))
      } catch {
        // sem armazenamento: a altura vale só nesta sessão
      }
    }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* até o projeto desta tela estar no store, nada é editável (numa troca, o anterior ainda pode estar lá) */}
      {loaded ? <TopBar onBack={() => void back()} onExport={() => toast('A exportação do editor chega na próxima etapa.', { description: 'Por enquanto, exporte gravações pela Revisão.' })} /> : <div className="h-12 shrink-0 border-b border-border bg-surface/70" />}
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_320px]">
        {loaded ? <MediaBin projectId={projectId} /> : <div className="border-r border-border bg-surface/60" />}
        <Viewer engine={loaded ? engine : null} />
        {loaded ? <Inspector /> : <div className="border-l border-border bg-surface/60" />}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Redimensionar linha do tempo"
        title="Arraste para redimensionar a linha do tempo"
        className="group relative h-1.5 shrink-0 cursor-row-resize border-t border-border bg-surface hover:bg-accent/30"
        onPointerDown={startResize}
      >
        <span className="absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded bg-white/15 group-hover:bg-accent" />
      </div>
      <div className="min-h-0 shrink-0" style={{ height: timelineH }}>
        {/* ==== TIMELINE (Task 11): trocar <TimelinePlaceholder> pela <Timeline> definitiva ==== */}
        {loaded ? <TimelinePlaceholder playback={engine?.playback ?? null} /> : <div className="h-full bg-bg-2" />}
      </div>
    </div>
  )
}
