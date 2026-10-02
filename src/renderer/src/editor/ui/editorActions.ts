// Ações do editor disparadas por atalhos e botões (transporte, edição no playhead, histórico).
// Operam sobre o store e o PlaybackController; as operações de edição são as puras de @shared/editor/ops.
import { toast } from 'sonner'
import { addEffect, addMarker, updateItem, addMediaFromAsset, addShape, addText, addTrack, addTransition, removeTransition, setTransitionDuration, copyKeyframes, deleteItems, musicTrackName, deleteRange, duplicateItems, findItem, keyframePaths, nextKeyframeUs, pasteKeyframes, projectDurationUs, removeKeys, splitAt, toggleEnabled, toggleKeyframes, trimItem, type KeyframeClipboard } from '@shared/editor/ops'
import type { EffectPresetId, EffectRegionInit, ShapePresetId, TextPresetId } from '@shared/editor/factory'
import type { Item, MediaItem, Project, TrackKind, TransitionKind, Us } from '@shared/editor/project'
import { frameDurUs, frameToUs, itemEndUs, usToFrame } from '@shared/editor/time'
import type { PlaybackController } from '../engine/PlaybackController'
import type { ShortcutAction } from '../shortcuts'
import { flushAutosave, useEditorStore } from '../state/editorStore'
import { concreteRefs, useKeyframeSelection, type KeyframeSel } from '../state/keyframeSelection'
import { useViewerTool } from '../state/viewerTool'
import { autoMusicLanding, moveToVoice } from './musicLanding'
import { narrationActive } from './narrationFlow'
import { planKeyframePaste } from './keyframePaste'
import { nearestEligibleCut } from './timeline/transitionMath'
import { formatTransitionDuration, transitionLabel } from './transitionInfo'

/** Efeito ancorado colado/duplicado sem o clipe da âncora: a cópia fica solta na caixa de reserva (ops.duplicateItems). */
const LOOSE_PASTE = 'Efeito colado sem o clipe — ficou solto'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

/** Área de transferência interna: itens (ids) ou keyframes — vale o que foi copiado por último. */
let clipboard: { kind: 'items'; ids: string[] } | { kind: 'keys'; clip: KeyframeClipboard } | null = null

/** Há algo copiado (itens ou keyframes) para o "Colar" do menu. */
export const hasClipboard = (): boolean => clipboard !== null

/** "Ajustar tudo" (Shift+Z) depende da largura da linha do tempo: ela registra o handler aqui. */
let zoomFitHandler: (() => void) | null = null
export function registerZoomFit(fn: (() => void) | null): void {
  zoomFitHandler = fn
}

export function seekTo(playback: PlaybackController | null, us: Us): void {
  const p = st().project
  // gravando narração: o relógio da reprodução é a referência do início da gravação
  if (!p || narrationActive()) return
  const t = Math.min(Math.max(0, Math.round(us)), projectDurationUs(p))
  if (playback) playback.seek(t)
  else st().setPlayhead(t)
}

export function togglePlay(playback: PlaybackController | null): void {
  if (!playback || narrationActive()) return
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
  const tracksBefore = new Set(s.project?.tracks.map((t) => t.id) ?? [])
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
  // áudio que caiu sozinho na faixa Música: pode ser narração — um clique leva ESTE item para uma faixa de Voz (a
  // faixa Música e o que mais houver nela continuam música; se ela foi criada só para ele e ficou vazia, sai)
  const p = st().project
  const landed = p ? autoMusicLanding(p, assetId, ids, !track || 'newTrack' in track) : null
  if (landed) {
    const itemId = ids.find((id) => findItem(p!, id)?.track.id === landed.trackId)!
    const created = !tracksBefore.has(landed.trackId)
    toast(`Áudio adicionado à faixa “${landed.trackName}”`, {
      description: 'A música abaixa sozinha quando há fala nas faixas de Voz.',
      action: {
        label: 'É narração? Mover para Voz',
        onClick: () => {
          if (!st().project || !findItem(st().project!, itemId)) return toast('O áudio não está mais na linha do tempo.')
          void st().apply((q) => moveToVoice(q, itemId, created ? { removeEmptyTrackId: landed.trackId } : undefined))
        }
      }
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

/** Centro do texto/forma recém-criado no ponto (normalizado) — dentro da mesma edição, um passo só. */
function placeAt(p: Project, itemId: string, at: { x: number; y: number }): Project {
  return updateItem(p, itemId, (d) => {
    if (d.type !== 'text' && d.type !== 'shape') return
    d.visual.transform.x = { value: at.x }
    d.visual.transform.y = { value: at.y }
  })
}

/** Texto da biblioteca em atUs (faixa escolhida ao soltar na linha do tempo; sem ela, colocação automática); seleciona o item. */
export function addTextAt(preset: TextPresetId, atUs: Us, opts?: { trackId?: string; at?: { x: number; y: number } }): string | null {
  const s = st()
  let id = ''
  const ok = s.apply((p) => {
    const r = addText(p, preset, atUs, opts?.trackId ? { trackId: opts.trackId } : undefined)
    id = r.itemId
    return opts?.at ? placeAt(r.project, r.itemId, opts.at) : r.project
  })
  if (ok) s.select([id])
  return ok ? id : null
}

/** Forma da biblioteca em atUs (como addTextAt). */
export function addShapeAt(preset: ShapePresetId, atUs: Us, opts?: { trackId?: string; at?: { x: number; y: number } }): string | null {
  const s = st()
  let id = ''
  const ok = s.apply((p) => {
    const r = addShape(p, preset, atUs, opts?.trackId ? { trackId: opts.trackId } : undefined)
    id = r.itemId
    return opts?.at ? placeAt(r.project, r.itemId, opts.at) : r.project
  })
  if (ok) s.select([id])
  return ok ? id : null
}

/**
 * Transição `kind` na entrada do clipe `toId` (B). Se já havia uma, troca o tipo e mantém a duração. Seleciona a
 * transição; erros de regra (EditError) viram toast pelo store.
 */
export function addTransitionTo(toId: string, kind: TransitionKind): boolean {
  const s = st()
  const prev = s.project ? (findItem(s.project, toId)?.item as MediaItem | undefined)?.transitionIn : undefined
  const ok = s.apply((p) => addTransition(p, toId, kind, prev?.durationUs))
  if (ok) s.selectTransition(toId)
  return ok
}

/**
 * Transição no corte elegível mais próximo do playhead: nas faixas de vídeo dos itens selecionados (ou da transição
 * selecionada); sem seleção de faixa, em todas as de vídeo. Sem corte elegível → toast que explica.
 */
export function addTransitionNearPlayhead(kind: TransitionKind): boolean {
  const { project, selection, selectedTransition, playheadUs } = st()
  if (!project) return false
  const tracks = new Set<string>()
  for (const id of selectedTransition ? [selectedTransition, ...selection] : selection) {
    const f = findItem(project, id)
    if (f && f.track.kind === 'video') tracks.add(f.track.id)
  }
  const cut = nearestEligibleCut(project, tracks.size ? [...tracks] : null, playheadUs)
  if (!cut) {
    toast(`Não há corte para a transição “${transitionLabel(kind)}”`, {
      description: tracks.size
        ? 'Na faixa selecionada não há dois clipes de vídeo, imagem ou texto encostados e ativos. Aproxime os clipes ou selecione outra faixa.'
        : 'Ela vai entre dois clipes de vídeo, imagem ou texto encostados e ativos na mesma faixa. Coloque dois clipes lado a lado.'
    })
    return false
  }
  return addTransitionTo(cut.toId, kind)
}

/** Nova duração da transição de `toId`; o op limita a [mínimo, metade do clipe mais curto] — se limitou, avisa. */
export function setTransitionDurationTo(toId: string, wantedUs: Us): boolean {
  const s = st()
  const ok = s.apply((p) => setTransitionDuration(p, toId, wantedUs))
  if (!ok) return false
  const got = (findItem(st().project!, toId)?.item as MediaItem | undefined)?.transitionIn?.durationUs
  if (got !== undefined && got !== Math.round(wantedUs)) toast(`Duração limitada a ${formatTransitionDuration(got)}`, { description: got < wantedUs ? 'A transição ocupa no máximo metade do clipe mais curto.' : 'A transição dura no mínimo 0,1 s.' })
  return true
}

/** Remove a transição selecionada (Delete). */
export function removeSelectedTransition(): boolean {
  const s = st()
  const id = s.selectedTransition
  if (!id) return false
  // a transição selecionada já não existe (desfeita/removida por outro caminho): solta a seleção e deixa o Delete seguir
  if (!s.project || !(findItem(s.project, id)?.item as MediaItem | undefined)?.transitionIn) {
    s.selectTransition(null)
    return false
  }
  const ok = s.apply((p) => removeTransition(p, id))
  if (ok) s.selectTransition(null)
  return true
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

/** Losangos selecionados que valem agora (o item deles é a seleção única) e o item. */
function activeKeyframeSel(): { kf: KeyframeSel; item: Item } | null {
  const kf = useKeyframeSelection.getState().sel
  const { selection, project } = st()
  if (!kf || !project || selection.length !== 1 || selection[0] !== kf.itemId) return null
  const f = findItem(project, kf.itemId)
  return f ? { kf, item: f.item } : null
}

/** Delete com losangos selecionados na linha do tempo: remove esses keys (não o item). */
function deleteSelectedKeyframe(): boolean {
  const a = activeKeyframeSel()
  if (!a) return false
  useKeyframeSelection.getState().set(null)
  st().apply((p) => removeKeys(p, a.kf.itemId, concreteRefs(a.item, a.kf.keys)))
  return true
}

/** Ctrl+C com losangos selecionados: copia esses keyframes (tempos relativos ao primeiro). */
function copySelectedKeyframes(): boolean {
  const a = activeKeyframeSel()
  const p = st().project
  if (!a || !p) return false
  const clip = copyKeyframes(p, a.kf.itemId, { keys: concreteRefs(a.item, a.kf.keys) })
  if (!clip) return false
  clipboard = { kind: 'keys', clip }
  toast('Keyframes copiados — Ctrl+V cola no playhead do item selecionado.', { duration: 1800 })
  return true
}

/** Ctrl+V de keyframes: a partir do playhead, em cada item selecionado sob ele (tempos relativos mantidos; um passo de desfazer). */
function pasteKeyframesAtPlayhead(clip: KeyframeClipboard): void {
  const { project, selection, playheadUs } = st()
  if (!project) return
  // faixa bloqueada e item sem as propriedades copiadas ficam de fora (com aviso); colar parcial avisa "N de M"
  const plan = planKeyframePaste(project, selection, playheadUs, clip)
  if (plan.targets.length) st().apply((p) => plan.targets.reduce((q, id) => pasteKeyframes(q, id, clip, playheadUs), p))
  if (plan.message) toast(plan.message)
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
  // gravando narração: nada de transporte nem edição (a barra de gravação cuida de Espaço/Esc)
  if (!p || narrationActive()) return false
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
    case 'delete': if (!removeSelectedTransition() && !deleteSelectedKeyframe()) deleteSelection(false); return true
    case 'addTitle': addTextAt('title', s.playheadUs); return true
    case 'addCrossfade': addTransitionNearPlayhead('crossfade'); return true
    case 'rippleDelete': deleteSelection(true); return true
    case 'copy':
      if (copySelectedKeyframes()) return true
      if (!s.selection.length) return false
      clipboard = { kind: 'items', ids: [...s.selection] }
      toast(s.selection.length === 1 ? 'Item copiado — Ctrl+V cola no playhead.' : `${s.selection.length} itens copiados — Ctrl+V cola no playhead.`, { duration: 1800 })
      return true
    case 'paste': {
      if (!clipboard) return true
      if (clipboard.kind === 'keys') {
        pasteKeyframesAtPlayhead(clipboard.clip)
        return true
      }
      const ids0 = clipboard.ids
      let ids: string[] = []
      let loose = 0
      if (s.apply((q) => { const r = duplicateItems(q, ids0, s.playheadUs); ids = r.itemIds; loose = r.detached.length; return r.project })) {
        s.select(ids)
        if (loose) toast(LOOSE_PASTE)
      }
      return true
    }
    case 'duplicate': {
      if (!s.selection.length) return true
      let ids: string[] = []
      let loose = 0
      if (s.apply((q) => { const r = duplicateItems(q, s.selection); ids = r.itemIds; loose = r.detached.length; return r.project })) {
        s.select(ids)
        if (loose) toast(LOOSE_PASTE)
      }
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
    case 'zoomTool': {
      const tool = useViewerTool.getState()
      tool.setZooming(!tool.zooming)
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
      else if (useViewerTool.getState().zooming) useViewerTool.getState().setZooming(false)
      else s.select([])
      return true
  }
}
