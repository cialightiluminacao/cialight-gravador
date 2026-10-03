import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ipcErrorMessage } from '@/lib/ipcError'
import type { Asset, MediaItem } from '@shared/editor/project'
import { toScreen } from '@shared/editor/contentPose'
import { findItem } from '@shared/editor/ops'
import { clipFrameAt } from '@shared/editor/resolve'
import { useAppStore } from '@/app/store'
import { flushAutosave, startAutosave, useEditorStore } from '../state/editorStore'
import { CURVE_EDITOR_ACTIONS, shortcutFor, TRANSPORT_ACTIONS } from '../shortcuts'
import { createEditorEngine, type EditorEngine } from './editorEngine'
import { registerExportOpen, runShortcut, seekTo } from './editorActions'
import { enqueuePending, importPaths } from './mediaImport'
import { closeRelinkPrompt, offerRelinks } from './relinkFlow'
import { RelinkDialog } from './RelinkDialog'
import { startAudioProcessing } from './audioProcessing'
import { audioSourceKey } from '@shared/editor/audioProcess'
import { TopBar } from './TopBar'
import { ExportDialog } from './ExportDialog'
import { requestLeaveEditor } from './ExportQueuePanel'
import { registerEditorLeave } from './editorLeave'
import { exportQueue, offerResume, setQueueBeforeItem } from '../export/exportQueueStore'
import { SilenceDialog } from './SilenceDialog'
import { ReframeDialog } from './ReframeDialog'
import { useReframe } from '../state/reframe'
import { useSilencePreview } from '../state/silencePreview'
import { useNarration } from '../state/narration'
import { useExpandedItems } from '../state/keyframeLanes'
import { NarrationOverlay } from './NarrationRecorder'
import { abandonNarration, narrationActive, recoverNarrations, settleNarration } from './narrationFlow'
import { MediaBin } from './MediaBin'
import { Viewer } from './Viewer'
import { Inspector } from './Inspector/Inspector'
import { CurveEditor } from './Inspector/CurveEditor'
import { Timeline } from './timeline/Timeline'
import { invalidatePeaks } from './timeline/peaks'
import { filmstripBudget, type FilmstripStats } from './timeline/filmstripBudget'
import { gestureActive } from './timeline/useTimelineDrag'
import { viewerGestureActive } from './viewer/viewerGesture'

// Tela do editor (spec §9): [Biblioteca 280 | Visualizador | Inspetor 320] em cima e a linha do
// tempo embaixo (altura redimensionável, salva no localStorage). Monta o motor (render, áudio,
// reprodução), o autosave e a ingestão; ao sair: salva, solta o projeto no main e libera tudo.

declare global {
  interface Window {
    __qaEditor?: { store: typeof useEditorStore; silence: typeof useSilencePreview; reframe: typeof useReframe; narration: typeof useNarration; expanded: typeof useExpandedItems; engine: EditorEngine; controller: EditorEngine['playback']; importPaths: (paths: string[]) => Promise<Asset[]>; queue: typeof exportQueue; memStats: () => ReturnType<EditorEngine['render']['memStats']>; filmstrips: () => FilmstripStats; exportDir?: string; narrationFailWritesAfter?: number; clipPoint: (itemId: string, tUs: number, x: number, y: number) => { x: number; y: number } | null }
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

/** QA (fora do pacote): ponto da fonte do clipe (0–1) → px do quadro em tUs, pela geometria do resolve; null = invisível. */
function qaClipPoint(itemId: string, tUs: number, x: number, y: number): { x: number; y: number } | null {
  const p = useEditorStore.getState().project
  const m = p ? findItem(p, itemId)?.item : undefined
  if (!p || m?.type !== 'media') return null
  const cf = clipFrameAt(p, m as MediaItem, tUs)
  return cf ? toScreen(cf, x * cf.g.dw, y * cf.g.dh) : null
}

export function EditorScreen({ projectId }: { projectId: string }): React.JSX.Element {
  const [engine, setEngine] = useState<EditorEngine | null>(null)
  const [timelineH, setTimelineH] = useState(readTimelineHeight)
  const [exportOpen, setExportOpen] = useState(false)
  const loaded = useEditorStore((s) => s.project?.id === projectId)
  const engineRef = useRef<EditorEngine | null>(null)

  // Ctrl+E (editorActions) abre o diálogo de exportação desta tela
  useEffect(() => {
    registerExportOpen(() => setExportOpen(true))
    return () => registerExportOpen(null)
  }, [])

  // fila de exportações: cada item pausa a reprodução ao começar (a regra do onBeforeExport)
  useEffect(() => setQueueBeforeItem(() => engineRef.current?.playback.pause()), [])
  // há itens guardados (interrompidos/da sessão anterior) fora da fila viva: oferece retomar ao abrir o editor
  useEffect(() => offerResume(), [])

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
    if (useAppStore.getState().appInfo?.isPackaged === false) window.__qaEditor = { store: useEditorStore, silence: useSilencePreview, reframe: useReframe, narration: useNarration, expanded: useExpandedItems, engine: eng, controller: eng.playback, importPaths: (paths) => importPaths(projectId, paths), queue: exportQueue, memStats: () => eng.render.memStats(), filmstrips: () => filmstripBudget.stats(), clipPoint: qaClipPoint }
    const offProgress = api.media.onProgress((j) => {
      if (j.projectId.toLowerCase() !== projectId.toLowerCase()) return
      const st = useEditorStore.getState()
      // pré-processamento de áudio: progresso por asset~chave (quem encerra é o pedido em audioProcessing.ts)
      if (j.step === 'audioProcess' && j.key) {
        const id = audioSourceKey(j.assetId, j.key)
        if (st.audioJobs[id] && j.percent < 100) st.setAudioJob(id, { percent: j.percent })
      } else st.setIngest(j.assetId, { step: j.step, percent: j.percent })
    })
    const offDone = api.media.onDone((d) => {
      if (d.projectId.toLowerCase() !== projectId.toLowerCase()) return
      const st = useEditorStore.getState()
      st.setIngest(d.assetId, null)
      st.applyAssetPatch(d.assetId, d.patch)
      // peaks regravados no mesmo caminho: a linha do tempo relê
      if (d.patch.peaks) invalidatePeaks(d.assetId)
      if (d.patch.status === 'error') {
        const name = st.project?.assets.find((a) => a.id === d.assetId)?.name ?? 'mídia'
        toast.error(`Não foi possível processar “${name}”`, { description: d.patch.error })
      }
    })
    // fechar a janela/sair com o editor aberto: o main pede para gravar tudo antes (e espera até 2 s)
    const offFlush = api.editor.onFlushRequest(async () => {
      // narração gravando: para e insere o que foi gravado antes de salvar
      await settleNarration()
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
    let stopAudioProcessing: (() => void) | null = null
    void (async () => {
      try {
        const project = await api.project.load(projectId)
        if (!alive) return
        useEditorStore.getState().open(project)
        await api.media.setOpenProject(project.id)
        if (!alive) return
        enqueuePending(project.id, project.assets)
        // mídia importada ausente (pasta movida/renomeada): procura em segundo plano e pergunta antes de reapontar
        void offerRelinks(project.id)
        // narrações que a janela/o app não chegaram a inserir (queda no meio da gravação): entram com aviso
        void recoverNarrations(project.id)
        // redução de ruído/normalização pedidas e sem o arquivo em cache (ex.: projeto vindo de outro PC): reprocessa
        stopAudioProcessing = startAudioProcessing(project.id)
      } catch (e) {
        if (!alive) return
        toast.error(`Não foi possível abrir o projeto: ${ipcErrorMessage(e)}`)
        useAppStore.getState().closeEditor()
      }
    })()

    return () => {
      alive = false
      stopAudioProcessing?.()
      offFlush()
      offProgress()
      offDone()
      // gravando narração ao desmontar sem passar por "Voltar": fecha o arquivo; o projeto a recupera ao abrir
      abandonNarration()
      closeRelinkPrompt()
      eng.playback.pause()
      useSilencePreview.getState().close()
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
    // K segurado: J/L andam quadro a quadro (e repetem segurados, como as setas)
    let kHeld = false
    const isK = (e: KeyboardEvent): boolean => e.code === 'KeyK' || e.key.toLowerCase() === 'k'
    const frameStep = (e: KeyboardEvent): boolean => kHeld && (e.code === 'KeyJ' || e.code === 'KeyL' || e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'l')
    const onKeyUp = (e: KeyboardEvent): void => {
      if (isK(e)) kHeld = false
    }
    const onBlur = (): void => {
      kHeld = false
    }
    const onKey = (e: KeyboardEvent): void => {
      if (isK(e) && !e.ctrlKey && !e.altKey && !e.metaKey) kHeld = true
      if (e.defaultPrevented || (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && !frameStep(e))) return
      if (useEditorStore.getState().project?.id !== projectId) return // outro projeto ainda no store (troca em curso)
      if (narrationActive()) return // gravando narração: o teclado é da barra de gravação (Espaço/Esc param)
      if (gestureActive() || viewerGestureActive()) return // arraste na linha do tempo/no visualizador: o teclado é do gesto
      // diálogo aberto (ex.: exportação): o teclado é dele. Os painéis "Remover silêncios" e "Reenquadrar" (não modais)
      // só deixam passar o transporte, e os controles deles (sliders, interruptores, botões) ficam com as próprias teclas
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      // O editor de curvas (popover não modal) deixa passar o transporte e desfazer/refazer, também com o foco
      // nele (as setas das alças são dele)
      const panel = dialogs.find((d) => d.hasAttribute('data-silence-dialog') || d.hasAttribute('data-reframe-dialog'))
      const curve = dialogs.find((d) => d.hasAttribute('data-curve-editor'))
      if (dialogs.some((d) => d !== panel && d !== curve)) return
      const t = e.target as Element | null
      if (panel && t instanceof Node && panel.contains(t)) return
      if (!e.ctrlKey && t?.closest?.(OWN_KEYS)) return
      const action = shortcutFor(e, { kHeld })
      if (panel && action && !TRANSPORT_ACTIONS.has(action)) return
      if (curve && action && (!CURVE_EDITOR_ACTIONS.has(action) || (t instanceof Node && curve.contains(t) && action !== 'undo' && action !== 'redo'))) return
      if (action && runShortcut(action, engineRef.current?.playback ?? null)) e.preventDefault()
    }
    // arquivos soltos fora da biblioteca não podem navegar a janela para o arquivo
    const blockDrop = (e: DragEvent): void => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('dragover', blockDrop)
    window.addEventListener('drop', blockDrop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('dragover', blockDrop)
      window.removeEventListener('drop', blockDrop)
    }
  }, [projectId])

  const leave = async (): Promise<void> => {
    await settleNarration()
    engineRef.current?.playback.pause()
    await flushAutosave()
    useAppStore.getState().closeEditor()
  }
  const leaveRef = useRef(leave)
  leaveRef.current = leave
  useEffect(() => registerEditorLeave(() => leaveRef.current()), [])
  // fila de exportações ativa: pergunta antes (sair interrompe; os itens ficam salvos para retomar depois)
  const back = (): void => requestLeaveEditor(() => void leave())

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
      {loaded ? <TopBar onBack={back} onExport={() => setExportOpen(true)} /> : <div className="h-12 shrink-0 border-b border-border bg-surface/70" />}
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_320px]">
        {loaded ? <MediaBin projectId={projectId} playback={engine?.playback ?? null} /> : <div className="border-r border-border bg-surface/60" />}
        <Viewer engine={loaded ? engine : null} />
        {loaded ? <Inspector playback={engine?.playback ?? null} /> : <div className="border-l border-border bg-surface/60" />}
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
        {loaded ? <Timeline playback={engine?.playback ?? null} /> : <div className="h-full bg-bg-2" />}
      </div>
      {loaded ? <SilenceDialog /> : null}
      {loaded ? <ReframeDialog playback={engine?.playback ?? null} /> : null}
      {loaded ? <CurveEditor /> : null}
      {loaded ? <NarrationOverlay /> : null}
      {loaded ? <RelinkDialog /> : null}
      {loaded ? <ExportDialog open={exportOpen} onOpenChange={setExportOpen} onBeforeExport={() => engineRef.current?.playback.pause()} onSeek={(us) => seekTo(engineRef.current?.playback ?? null, us)} /> : null}
    </div>
  )
}
