// Ações do editor disparadas por atalhos e botões (transporte, edição no playhead, histórico).
// Operam sobre o store e o PlaybackController; as operações de edição são as puras de @shared/editor/ops.
import { toast } from 'sonner'
import { addMarker, addMediaFromAsset, addTrack, deleteItems, deleteRange, duplicateItems, projectDurationUs, splitAt, trimItem } from '@shared/editor/ops'
import type { Item, Project, TrackKind, Us } from '@shared/editor/project'
import { frameToUs, itemEndUs, usToFrame } from '@shared/editor/time'
import type { PlaybackController } from '../engine/PlaybackController'
import type { ShortcutAction } from '../shortcuts'
import { flushAutosave, useEditorStore } from '../state/editorStore'
import { useViewerTool } from '../state/viewerTool'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

/** Área de transferência interna (ids dos itens copiados). */
let clipboard: string[] = []

/** J/L: o motor só toca a 1× (sem taxas 2×/4× nem reverso), então J/L saltam 5 s sem parar a reprodução. */
export const SHUTTLE_JUMP_US = 5_000_000

/** "Ajustar tudo" (Shift+Z) depende da largura da linha do tempo: ela registra o handler aqui. */
let zoomFitHandler: (() => void) | null = null
export function registerZoomFit(fn: (() => void) | null): void {
  zoomFitHandler = fn
}

export function seekTo(playback: PlaybackController | null, us: Us): void {
  const p = st().project
  if (!p) return
  const t = Math.min(Math.max(0, Math.round(us)), projectDurationUs(p))
  if (playback) playback.seek(t)
  else st().setPlayhead(t)
}

export function togglePlay(playback: PlaybackController | null): void {
  if (!playback) return
  if (st().playing) playback.pause()
  else void playback.play()
}

export function stepFrames(playback: PlaybackController | null, n: number): void {
  const { project, playheadUs } = st()
  if (!project) return
  const fps = project.canvas.fps
  if (st().playing) playback?.pause()
  seekTo(playback, frameToUs(usToFrame(playheadUs, fps) + n, fps))
}

/** Itens (de faixas desbloqueadas) que contêm o playhead estritamente; selecionados primeiro. */
function itemsAtPlayhead(p: Project, t: Us): Item[] {
  const out: Item[] = []
  for (const track of p.tracks) {
    if (track.locked) continue
    for (const it of track.items) if (t > it.startUs && t < itemEndUs(it)) out.push(it)
  }
  return out
}

function trimToPlayhead(edge: 'start' | 'end'): void {
  const { project, playheadUs, selection } = st()
  if (!project) return
  const under = itemsAtPlayhead(project, playheadUs)
  const target = under.find((i) => selection.includes(i.id)) ?? under[0]
  if (!target) return
  st().apply((p) => trimItem(p, target.id, edge, playheadUs, { ripple: true }))
}

/**
 * Adiciona o asset em atUs (vídeo + áudio vinculado) e seleciona o que entrou. `track`: faixa
 * escolhida (soltar na linha do tempo) — existente (do tipo certo) ou nova; sem ela, a primeira livre.
 */
export function addAssetAt(assetId: string, atUs: Us, track?: { trackId: string } | { newTrack: TrackKind }): void {
  const s = st()
  let ids: string[] = []
  const ok = s.apply((p) => {
    let q = p
    let trackId: string | undefined
    if (track && 'newTrack' in track) {
      const r = addTrack(q, track.newTrack)
      q = r.project
      trackId = r.trackId
    } else trackId = track?.trackId
    const kind = q.tracks.find((t) => t.id === trackId)?.kind
    const r = addMediaFromAsset(q, assetId, atUs, kind === 'video' ? { videoTrackId: trackId } : kind === 'audio' ? { audioTrackId: trackId } : undefined)
    ids = r.itemIds
    return r.project
  })
  if (ok) s.select(ids)
}

/** Adiciona o asset no playhead (vídeo + áudio vinculado) e seleciona o que entrou. */
export function addAssetAtPlayhead(assetId: string): void {
  addAssetAt(assetId, st().playheadUs)
}

export function splitAtPlayhead(): void {
  const { selection, playheadUs } = st()
  st().apply((p) => splitAt(p, selection.length ? selection : 'all', playheadUs))
}

export function deleteSelection(ripple: boolean): void {
  const { selection } = st()
  if (!selection.length) return
  if (st().apply((p) => deleteItems(p, selection, { ripple }))) st().select([])
}

export async function saveNow(): Promise<void> {
  await flushAutosave()
  if (!st().dirty) toast.success('Projeto salvo.')
}

function zoomBy(factor: number): void {
  const { zoomPxPerSec, playheadUs } = st()
  st().setZoom(zoomPxPerSec * factor, playheadUs)
}

/** Executa a ação do atalho; devolve false se não se aplica (o evento segue o fluxo normal). */
export function runShortcut(action: ShortcutAction, playback: PlaybackController | null): boolean {
  const s = st()
  const p = s.project
  if (!p) return false
  const fps = p.canvas.fps
  switch (action) {
    case 'playPause': togglePlay(playback); return true
    case 'pause': playback?.pause(); return true
    // J/L: salto de 5 s (seek mantém a reprodução); L parado começa a tocar
    case 'shuttleBack': seekTo(playback, s.playheadUs - SHUTTLE_JUMP_US); return true
    case 'shuttleForward':
      if (!s.playing) void playback?.play()
      else seekTo(playback, s.playheadUs + SHUTTLE_JUMP_US)
      return true
    case 'prevFrame': stepFrames(playback, -1); return true
    case 'nextFrame': stepFrames(playback, 1); return true
    case 'back1s': stepFrames(playback, -Math.round(fps)); return true
    case 'fwd1s': stepFrames(playback, Math.round(fps)); return true
    case 'home': seekTo(playback, 0); return true
    case 'end': seekTo(playback, projectDurationUs(p)); return true
    case 'split': splitAtPlayhead(); return true
    case 'rippleTrimStart': trimToPlayhead('start'); return true
    case 'rippleTrimEnd': trimToPlayhead('end'); return true
    case 'delete': deleteSelection(false); return true
    case 'rippleDelete': deleteSelection(true); return true
    case 'copy':
      if (!s.selection.length) return false
      clipboard = [...s.selection]
      return true
    case 'paste': {
      if (!clipboard.length) return true
      let ids: string[] = []
      if (s.apply((q) => { const r = duplicateItems(q, clipboard, s.playheadUs); ids = r.itemIds; return r.project })) s.select(ids)
      return true
    }
    case 'duplicate': {
      if (!s.selection.length) return true
      let ids: string[] = []
      if (s.apply((q) => { const r = duplicateItems(q, s.selection); ids = r.itemIds; return r.project })) s.select(ids)
      return true
    }
    case 'undo': s.undo(); return true
    case 'redo': s.redo(); return true
    case 'markIn': s.setInOut(s.playheadUs, s.outUs !== null && s.outUs > s.playheadUs ? s.outUs : null); return true
    case 'markOut': s.setInOut(s.inUs !== null && s.inUs < s.playheadUs ? s.inUs : null, s.playheadUs); return true
    case 'deleteRange': {
      if (s.inUs === null || s.outUs === null) {
        toast('Marque o início (I) e o fim (O) do trecho a apagar.')
        return true
      }
      const { inUs, outUs } = s
      if (s.apply((q) => deleteRange(q, inUs, outUs))) {
        s.setInOut(null, null)
        seekTo(playback, inUs)
      }
      return true
    }
    case 'marker': s.apply((q) => addMarker(q, s.playheadUs)); return true
    case 'zoomIn': zoomBy(1.25); return true
    case 'zoomOut': zoomBy(0.8); return true
    case 'zoomFit': zoomFitHandler?.(); return true
    case 'save': void saveNow(); return true
    case 'toggleSnap':
      s.toggleSnapping()
      toast(st().snapping ? 'Ímã ligado' : 'Ímã desligado', { duration: 1200 })
      return true
    case 'drawRegion': {
      const tool = useViewerTool.getState()
      tool.setDrawing(!tool.drawing)
      return true
    }
    case 'deselect':
      if (s.txBase) s.cancelTx()
      else if (useViewerTool.getState().drawing) useViewerTool.getState().setDrawing(false) // Esc primeiro sai da ferramenta
      else s.select([])
      return true
  }
}
