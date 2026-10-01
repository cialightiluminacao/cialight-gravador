// Ações do editor disparadas por atalhos e botões (transporte, edição no playhead, histórico).
// Operam sobre o store e o PlaybackController; as operações de edição são as puras de @shared/editor/ops.
import { toast } from 'sonner'
import { addMarker, addMediaFromAsset, deleteItems, deleteRange, duplicateItems, projectDurationUs, splitAt, trimItem } from '@shared/editor/ops'
import type { Item, Project, Us } from '@shared/editor/project'
import { frameToUs, itemEndUs, secToUs, usToFrame } from '@shared/editor/time'
import type { PlaybackController } from '../engine/PlaybackController'
import type { ShortcutAction } from '../shortcuts'
import { flushAutosave, useEditorStore } from '../state/editorStore'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

/** Área de transferência interna (ids dos itens copiados). */
let clipboard: string[] = []

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

/** Adiciona o asset no playhead (vídeo + áudio vinculado) e seleciona o que entrou. */
export function addAssetAtPlayhead(assetId: string): void {
  const st = useEditorStore.getState()
  let ids: string[] = []
  const ok = st.apply((p) => {
    const r = addMediaFromAsset(p, assetId, st.playheadUs)
    ids = r.itemIds
    return r.project
  })
  if (ok) st.select(ids)
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
    case 'play': if (!s.playing) void playback?.play(); return true
    case 'pause': playback?.pause(); return true
    case 'shuttleBack':
      playback?.pause()
      seekTo(playback, s.playheadUs - secToUs(1))
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
    case 'save': void saveNow(); return true
    case 'toggleSnap':
      s.toggleSnapping()
      toast(st().snapping ? 'Ímã ligado' : 'Ímã desligado', { duration: 1200 })
      return true
    case 'deselect':
      if (s.txBase) s.cancelTx()
      else s.select([])
      return true
  }
}
