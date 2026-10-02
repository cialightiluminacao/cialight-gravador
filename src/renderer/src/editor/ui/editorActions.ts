// Ações do editor disparadas por atalhos e botões (transporte, edição no playhead, histórico).
// Operam sobre o store e o PlaybackController; as operações de edição são as puras de @shared/editor/ops.
import { toast } from 'sonner'
import { addEffect, addMarker, addMediaFromAsset, addTrack, deleteItems, musicTrackName, updateTrack, deleteRange, duplicateItems, findItem, keyframePaths, nextKeyframeUs, projectDurationUs, removeKeyframesAt, splitAt, toggleEnabled, toggleKeyframes, trimItem } from '@shared/editor/ops'
import type { EffectPresetId, EffectRegionInit } from '@shared/editor/factory'
import type { Item, Project, TrackKind, Us } from '@shared/editor/project'
import { frameDurUs, frameToUs, itemEndUs, usToFrame } from '@shared/editor/time'
import type { PlaybackController } from '../engine/PlaybackController'
import type { ShortcutAction } from '../shortcuts'
import { flushAutosave, useEditorStore } from '../state/editorStore'
import { useKeyframeSelection } from '../state/keyframeSelection'
import { useViewerTool } from '../state/viewerTool'
import { autoMusicLanding } from './musicLanding'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

/** Área de transferência interna (ids dos itens copiados). */
let clipboard: string[] = []

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
      // música (arquivo só de áudio) solta abaixo das faixas: a faixa nova já nasce com papel música
      const music = track.newTrack === 'audio' && q.assets.find((a) => a.id === assetId)?.kind === 'audio'
      const r = music ? addTrack(q, 'audio', undefined, musicTrackName(q), 'music') : addTrack(q, track.newTrack)
      q = r.project
      trackId = r.trackId
    } else trackId = track?.trackId
    const kind = q.tracks.find((t) => t.id === trackId)?.kind
    const r = addMediaFromAsset(q, assetId, atUs, kind === 'video' ? { videoTrackId: trackId } : kind === 'audio' ? { audioTrackId: trackId } : undefined)
    ids = r.itemIds
    return r.project
  })
  if (!ok) return
  s.select(ids)
  // áudio que caiu sozinho na faixa Música: pode ser narração — um clique troca o papel da faixa para Voz
  const p = st().project
  const landed = p ? autoMusicLanding(p, assetId, ids, !track || 'newTrack' in track) : null
  if (landed) {
    toast(`Áudio adicionado à faixa “${landed.trackName}”`, {
      description: 'A música abaixa sozinha quando há fala nas faixas de Voz.',
      action: { label: 'É narração? Mover para Voz', onClick: () => void st().apply((q) => updateTrack(q, landed.trackId, { role: 'voice' })) }
    })
  }
}

/** Adiciona o asset no playhead (vídeo + áudio vinculado) e seleciona o que entrou. */
export function addAssetAtPlayhead(assetId: string): void {
  addAssetAt(assetId, st().playheadUs)
}

/**
 * Adiciona um efeito da biblioteca em atUs (duração: até o fim do clipe sob ele, ou 5 s) e o seleciona.
 * `trackId`: faixa escolhida ao soltar na linha do tempo; sem ela, a faixa "Efeitos" (ou uma nova).
 */
export function addEffectAt(preset: EffectPresetId, atUs: Us, opts?: { trackId?: string; region?: EffectRegionInit }): void {
  const s = st()
  let id = ''
  const ok = s.apply((p) => {
    const r = addEffect(p, preset, atUs, opts)
    id = r.itemId
    return r.project
  })
  if (ok) s.select([id])
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

/** Delete com um losango selecionado na linha do tempo: remove os keys daquele instante (não o item). */
function deleteSelectedKeyframe(): boolean {
  const kf = useKeyframeSelection.getState().sel
  const { selection } = st()
  if (!kf || selection.length !== 1 || selection[0] !== kf.itemId) return false
  useKeyframeSelection.getState().set(null)
  st().apply((p) => removeKeyframesAt(p, kf.itemId, kf.tUs))
  return true
}

/**
 * Alt+K: liga/desliga o keyframe no playhead dos itens selecionados que o contêm (efeito: região;
 * vídeo: transformação; áudio: volume). Tudo num passo de desfazer.
 */
export function toggleKeyframeAtPlayhead(): void {
  const { project, selection, playheadUs } = st()
  if (!project) return
  const targets = selection.flatMap((id) => {
    const f = findItem(project, id)
    if (!f || playheadUs < f.item.startUs || playheadUs >= itemEndUs(f.item)) return [] // fim exclusivo, como no visualizador
    const paths = keyframePaths(f.item, f.track.kind)
    return paths.length ? [{ id, paths }] : []
  })
  if (!targets.length) {
    toast('Selecione um item sob o playhead para criar um keyframe.')
    return
  }
  st().apply((p) => targets.reduce((q, t) => toggleKeyframes(q, t.id, t.paths, playheadUs), p))
}

/**
 * [ / ]: vai ao keyframe anterior/próximo (qualquer propriedade) dos itens selecionados, além de ±meio
 * quadro do playhead (a mesma tolerância dos botões ◀ ▶ e do ◇).
 */
export function jumpToKeyframe(playback: PlaybackController | null, dir: 1 | -1): void {
  const { project, selection, playheadUs } = st()
  if (!project) return
  const from = playheadUs + (dir * frameDurUs(project.canvas.fps)) / 2
  let best: Us | null = null
  for (const id of selection) {
    const t = nextKeyframeUs(project, id, 'any', from, dir)
    if (t !== null && (best === null || (dir === 1 ? t < best : t > best))) best = t
  }
  if (best === null) return
  if (st().playing) playback?.pause()
  seekTo(playback, best)
}

/** Shift+E / menu: desativa os selecionados e vinculados (se algum está ativo) ou reativa todos; Alt ignora o vínculo. */
export function toggleEnabledSelection(ids = st().selection, includeLinked = true): void {
  if (!st().project || !ids.length) return
  st().apply((q) => toggleEnabled(q, ids, includeLinked))
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
    // J/L: shuttle — parado ou no outro sentido toca a 1×; de novo no mesmo sentido dobra até 8× (K pausa)
    case 'shuttleBack': void playback?.shuttle(-1); return true
    case 'shuttleForward': void playback?.shuttle(1); return true
    case 'prevFrame': stepFrames(playback, -1); return true
    case 'nextFrame': stepFrames(playback, 1); return true
    case 'back1s': stepFrames(playback, -Math.round(fps)); return true
    case 'fwd1s': stepFrames(playback, Math.round(fps)); return true
    case 'home': seekTo(playback, 0); return true
    case 'end': seekTo(playback, projectDurationUs(p)); return true
    case 'split': splitAtPlayhead(); return true
    case 'rippleTrimStart': trimToPlayhead('start'); return true
    case 'rippleTrimEnd': trimToPlayhead('end'); return true
    case 'delete': if (!deleteSelectedKeyframe()) deleteSelection(false); return true
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
    case 'toggleKeyframe': toggleKeyframeAtPlayhead(); return true
    case 'prevKeyframe': jumpToKeyframe(playback, -1); return true
    case 'nextKeyframe': jumpToKeyframe(playback, 1); return true
    case 'toggleEnabled': toggleEnabledSelection(); return true
    case 'toggleEnabledUnlinked': toggleEnabledSelection(st().selection, false); return true
    case 'deselect':
      if (s.txBase) s.cancelTx()
      else if (useKeyframeSelection.getState().sel) useKeyframeSelection.getState().set(null) // Esc primeiro solta o losango
      else if (useViewerTool.getState().drawing) useViewerTool.getState().setDrawing(false) // Esc primeiro sai da ferramenta
      else s.select([])
      return true
  }
}
