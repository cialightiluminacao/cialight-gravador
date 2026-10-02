import { create } from 'zustand'
import { toast } from 'sonner'
import { EditError, updateAsset } from '@shared/editor/ops'
import type { Asset, Project, Us } from '@shared/editor/project'
import { withProcessedAudio } from '@shared/editor/audioProcess'
import { commit, initHistory, redo as redoH, undo as undoH, type History } from './history'
import { clampZoom, usToPx, ZOOM_DEFAULT, zoomAround } from './zoom'
import { ipcErrorMessage } from '@/lib/ipcError'

// Store do editor (zustand): projeto com histórico, transações (arrasto = 1 passo de undo),
// seleção, viewport da timeline e autosave. Operações puras vivem em @shared/editor/ops.

export interface IngestProgress { step: string; percent: number }
/** Pré-processamento de áudio (redução de ruído/normalização) de um par asset~chave: progresso ou falha. */
export type AudioJobState = { percent: number } | { error: string }

export interface EditorState {
  history: History<Project>
  project: Project | null // === history.present
  dirty: boolean
  saving: boolean
  lastSavedAt: number | null
  selection: string[]
  playheadUs: Us
  playing: boolean
  /** Taxa da reprodução (shuttle J/K/L: ±1, ±2, ±4, ±8); 1 quando parado. */
  playRate: number
  zoomPxPerSec: number
  scrollUs: Us
  snapping: boolean
  inUs: Us | null
  outUs: Us | null
  txBase: Project | null // transação aberta
  ingest: Record<string, IngestProgress>
  /** Processamentos de áudio em curso/falhos por `assetId~chave` (audioProcess.audioSourceKey). */
  audioJobs: Record<string, AudioJobState>
  /** Comparar A/B (botão segurado): o preview toca o original em vez do áudio processado. */
  audioBypass: boolean
  canUndo: boolean
  canRedo: boolean

  open(p: Project): void
  close(): void
  /** transient = dentro de transação (não grava histórico). EditError → toast + false. */
  apply(fn: (p: Project) => Project, opts?: { transient?: boolean }): boolean
  /** Aplica patch em asset SEM entrada de histórico (resultado de ingest); corrige past/present/future. */
  applyAssetPatch(assetId: string, patch: Partial<Asset>): void
  setIngest(assetId: string, progress: IngestProgress | null): void
  /** Versão de áudio processada pronta: `asset.processedAudio[key] = fingerprint` (sem histórico, como a ingestão). */
  markAudioProcessed(assetId: string, key: string, fingerprint: string): void
  setAudioJob(id: string, state: AudioJobState | null): void
  setAudioBypass(on: boolean): void
  begin(): void
  commitTx(): void
  cancelTx(): void
  undo(): void
  redo(): void
  markSaved(): void
  select(ids: string[], mode?: 'set' | 'add' | 'toggle'): void
  setPlayhead(us: Us): void
  setPlaying(b: boolean, rate?: number): void
  setZoom(pxPerSec: number, anchorUs?: Us): void
  setScroll(us: Us): void
  setInOut(inUs: Us | null, outUs: Us | null): void
  toggleSnapping(): void
}

const HISTORY_LIMIT = 300

const touch = (p: Project): Project => ({ ...p, updatedAt: new Date().toISOString() })

/** Campos derivados do histórico (project, canUndo, canRedo). */
function derive(h: History<Project>): Pick<EditorState, 'history' | 'project' | 'canUndo' | 'canRedo'> {
  return { history: h, project: h.present, canUndo: h.past.length > 0, canRedo: h.future.length > 0 }
}

const INITIAL = {
  history: { past: [], present: null as unknown as Project, future: [] } as History<Project>,
  project: null as Project | null,
  canUndo: false,
  canRedo: false,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  selection: [] as string[],
  playheadUs: 0,
  playing: false,
  playRate: 1,
  zoomPxPerSec: ZOOM_DEFAULT,
  scrollUs: 0,
  snapping: true,
  inUs: null,
  outUs: null,
  txBase: null,
  ingest: {} as Record<string, IngestProgress>,
  audioJobs: {} as Record<string, AudioJobState>,
  audioBypass: false,
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  ...INITIAL,

  open: (p) => set({ ...INITIAL, ...derive(initHistory(p)) }),
  close: () => set({ ...INITIAL }),

  apply: (fn, opts) => {
    const { history, txBase } = get()
    if (!history.present) return false
    let next: Project
    try {
      next = fn(history.present)
    } catch (e) {
      if (e instanceof EditError) {
        toast.error(e.message)
        return false
      }
      throw e
    }
    if (next === history.present) return true
    // transient sem transação aberta cai num commit real (decisão: não abre transação implícita)
    if (opts?.transient && txBase) {
      // dentro de transação: troca o present sem gravar histórico
      set({ ...derive({ ...history, present: next }) })
      return true
    }
    // commit real (se houver transação aberta, ela é encerrada com este estado)
    const h = commit(txBase ? { ...history, present: txBase } : history, touch(next), HISTORY_LIMIT)
    set({ ...derive(h), dirty: true, txBase: null })
    return true
  },

  applyAssetPatch: (assetId, patch) => {
    const { history, txBase } = get()
    if (!history.present) return
    const fix = (p: Project): Project => {
      if (!p.assets.some((a) => a.id === assetId)) return p // snapshot anterior à criação do asset
      return updateAsset(p, assetId, patch)
    }
    const h: History<Project> = {
      past: history.past.map(fix),
      present: fix(history.present),
      future: history.future.map(fix),
    }
    set({ ...derive(h), txBase: txBase ? fix(txBase) : null, dirty: true })
  },

  markAudioProcessed: (assetId, key, fingerprint) => {
    const a = get().project?.assets.find((x) => x.id === assetId)
    if (!a) return
    const processedAudio = withProcessedAudio(a.processedAudio, key, fingerprint)
    if (processedAudio !== a.processedAudio) get().applyAssetPatch(assetId, { processedAudio })
  },

  setAudioJob: (id, state) =>
    set((s) => {
      const audioJobs = { ...s.audioJobs }
      if (state) audioJobs[id] = state
      else delete audioJobs[id]
      return { audioJobs }
    }),

  setAudioBypass: (on) => set({ audioBypass: on }),

  setIngest: (assetId, progress) =>
    set((s) => {
      const ingest = { ...s.ingest }
      if (progress) ingest[assetId] = progress
      else delete ingest[assetId]
      return { ingest }
    }),

  begin: () => {
    const { project, txBase } = get()
    if (project && !txBase) set({ txBase: project })
  },

  commitTx: () => {
    const { history, txBase } = get()
    if (!txBase) return
    if (history.present === txBase) {
      set({ txBase: null })
      return
    }
    const h = commit({ ...history, present: txBase }, touch(history.present), HISTORY_LIMIT)
    set({ ...derive(h), dirty: true, txBase: null })
  },

  cancelTx: () => {
    const { history, txBase } = get()
    if (!txBase) return
    set({ ...derive({ ...history, present: txBase }), txBase: null })
  },

  undo: () => {
    const { history, txBase } = get()
    // desfazer no meio de uma transação apenas a cancela
    if (txBase) {
      set({ ...derive({ ...history, present: txBase }), txBase: null })
      return
    }
    if (history.past.length === 0) return
    set({ ...derive(undoH(history)), dirty: true })
  },

  redo: () => {
    const { history, txBase } = get()
    if (txBase || history.future.length === 0) return
    set({ ...derive(redoH(history)), dirty: true })
  },

  markSaved: () => set({ dirty: false, lastSavedAt: Date.now() }),

  select: (ids, mode = 'set') =>
    set((s) => {
      if (mode === 'set') return { selection: [...ids] }
      if (mode === 'add') return { selection: [...s.selection, ...ids.filter((i) => !s.selection.includes(i))] }
      const toggled = new Set(ids)
      return { selection: [...s.selection.filter((i) => !toggled.has(i)), ...ids.filter((i) => !s.selection.includes(i))] }
    }),

  setPlayhead: (us) => set({ playheadUs: Math.max(0, Math.round(us)) }),
  setPlaying: (b, rate = 1) => set({ playing: b, playRate: b ? rate : 1 }),

  setZoom: (pxPerSec, anchorUs) =>
    set((s) => {
      if (anchorUs === undefined) return { zoomPxPerSec: clampZoom(pxPerSec) }
      // mantém o instante âncora na mesma posição de tela (mesma conta do zoom pela roda/slider)
      const r = zoomAround(s.zoomPxPerSec, pxPerSec / s.zoomPxPerSec, anchorUs, s.scrollUs, usToPx(anchorUs, s.zoomPxPerSec, s.scrollUs))
      return { zoomPxPerSec: r.pxPerSec, scrollUs: r.scrollUs }
    }),

  setScroll: (us) => set({ scrollUs: Math.max(0, Math.round(us)) }),
  setInOut: (inUs, outUs) => set({ inUs, outUs }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
}))

// ---------------------------------------------------------------- autosave

const AUTOSAVE_DEBOUNCE_MS = 1000

let flushImpl: (() => Promise<void>) | null = null

/** Salva o projeto 1 s após a última mudança. Retorna o unsubscribe. */
export function startAutosave(save: (p: Project) => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> = Promise.resolve()
  let failed = false // avisa só uma vez por sequência de falhas

  const run = (): Promise<void> => {
    inflight = inflight.then(async () => {
      const { project, dirty, txBase } = useEditorStore.getState()
      // nunca persiste estado não commitado; commitTx/cancelTx reagendam
      if (!project || !dirty || txBase) return
      useEditorStore.setState({ saving: true })
      try {
        await save(project)
        // só limpa dirty se nada mudou durante o save
        failed = false
        if (useEditorStore.getState().project === project) useEditorStore.getState().markSaved()
      } catch (e) {
        console.error('[editor] autosave falhou', e)
        if (!failed) toast.error(`Não foi possível salvar o projeto: ${ipcErrorMessage(e)}`)
        failed = true
      } finally {
        useEditorStore.setState({ saving: false })
      }
    })
    return inflight
  }

  const unsub = useEditorStore.subscribe((s, prev) => {
    const txEnded = !!prev.txBase && !s.txBase
    if ((s.project === prev.project && !txEnded) || !s.project || !s.dirty || s.txBase) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void run() }, AUTOSAVE_DEBOUNCE_MS)
  })

  const flush = async (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null }
    const { dirty, txBase } = useEditorStore.getState()
    if (dirty && !txBase) await run()
    else await inflight
  }
  flushImpl = flush

  return () => {
    unsub()
    if (timer) clearTimeout(timer)
    timer = null
    if (flushImpl === flush) flushImpl = null
  }
}

/** Salva já o que estiver pendente (usar antes de fechar o editor). */
export async function flushAutosave(): Promise<void> {
  await flushImpl?.()
}
