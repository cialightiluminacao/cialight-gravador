import { Copy, Eye, EyeOff, Gauge, Link2, Repeat, Scissors, SplitSquareHorizontal, Trash2, Unlink } from 'lucide-react'
import { convertEffects, detachAudio, enableGroupIds, findItem, linkedIds, linkItems, setSpeed, unlinkMedia } from '@shared/editor/ops'
import type { EffectItem, Marker, Project } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'
import type { PlaybackController } from '../../engine/PlaybackController'
import { SHORTCUT_LABELS } from '../../shortcuts'
import { useEditorStore } from '../../state/editorStore'
import { deleteSelection, runShortcut, seekTo, splitAtPlayhead, toggleEnabledSelection } from '../editorActions'
import type { MenuEntry } from './ContextMenu'

// Entradas dos menus de contexto da linha do tempo (item e marcador).
// "Congelar quadro" chega na F3: fica fora do menu até lá.

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8]
const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const fmtSpeed = (s: number): string => `${String(s).replace('.', ',')}×`
const EFFECT_KINDS: { value: EffectItem['effect']; label: string }[] = [
  { value: 'solid', label: 'Tarja' },
  { value: 'blur', label: 'Blur' },
  { value: 'pixelate', label: 'Pixelizar' }
]

/** "Converter em" (só quando há efeitos na seleção): troca o tipo de todos os efeitos selecionados. */
function convertEntry(p: Project, sel: string[]): MenuEntry[] {
  const fx = sel.map((id) => findItem(p, id)?.item).filter((i): i is EffectItem => i?.type === 'effect')
  if (fx.length === 0) return []
  const ids = fx.map((i) => i.id)
  return [
    {
      label: 'Converter em',
      icon: Repeat,
      sub: EFFECT_KINDS.map((k) => ({
        label: fx.every((i) => i.effect === k.value) ? `${k.label}  ✓` : k.label,
        onSelect: () => st().apply((q) => convertEffects(q, ids, k.value))
      }))
    }
  ]
}

/** Vincular (seleção de 2+ fora de um mesmo grupo) / Desvincular / Separar áudio (vídeo com áudio próprio). */
function linkEntry(p: Project, itemId: string, selection: string[]): MenuEntry {
  const f = findItem(p, itemId)
  const links = new Set(selection.map((id) => findItem(p, id)?.item.linkId))
  if (selection.length >= 2 && (links.size > 1 || links.has(undefined))) {
    return { label: 'Vincular', icon: Link2, onSelect: () => st().apply((q) => linkItems(q, selection)) }
  }
  if (f?.item.linkId) {
    // clipe vinculado só a efeitos: o menu diz o que vai acontecer (solta os efeitos), nunca um clique sem efeito
    const onlyFx = f.item.type !== 'effect' && linkedIds(p, itemId).every((id) => id === itemId || findItem(p, id)?.item.type === 'effect')
    return { label: onlyFx ? 'Desvincular efeitos' : 'Desvincular', icon: Unlink, onSelect: () => st().apply((q) => unlinkMedia(q, itemId)) }
  }
  const it = f?.item
  const asset = it?.type === 'media' ? p.assets.find((a) => a.id === it.assetId) : undefined
  const canDetach = f?.track.kind === 'video' && it?.type === 'media' && it.audio.enabled && !!asset?.audio
  return { label: 'Separar áudio', icon: SplitSquareHorizontal, disabled: !canDetach, onSelect: () => st().apply((q) => detachAudio(q, itemId)) }
}

export function itemMenuEntries(p: Project, itemId: string, playback: PlaybackController | null): MenuEntry[] {
  const { selection, playheadUs } = st()
  const sel = selection.length ? selection : [itemId]
  const splittable = sel.some((id) => {
    const it = findItem(p, id)?.item
    return !!it && playheadUs > it.startUs && playheadUs < itemEndUs(it)
  })
  const media = sel.filter((id) => findItem(p, id)?.item.type === 'media')
  const main = findItem(p, itemId)?.item
  const current = main?.type === 'media' ? main.speed : null
  // mesmo grupo que Shift+E desativa: a seleção e os vinculados
  const anyOn = enableGroupIds(p, sel.filter((id) => findItem(p, id)), true).some((id) => findItem(p, id)?.item.enabled !== false)
  return [
    { label: 'Dividir no playhead', icon: Scissors, shortcut: SHORTCUT_LABELS.split, disabled: !splittable, onSelect: splitAtPlayhead },
    { label: 'Duplicar', icon: Copy, shortcut: SHORTCUT_LABELS.duplicate, onSelect: () => runShortcut('duplicate', playback) },
    linkEntry(p, itemId, sel),
    {
      label: 'Velocidade',
      icon: Gauge,
      disabled: media.length === 0,
      sub: SPEEDS.map((s) => ({
        label: s === current ? `${fmtSpeed(s)}  ✓` : fmtSpeed(s),
        onSelect: () => st().apply((q) => media.reduce((acc, id) => (findItem(acc, id) ? setSpeed(acc, id, s) : acc), q))
      }))
    },
    { label: anyOn ? 'Desativar' : 'Ativar', icon: anyOn ? EyeOff : Eye, shortcut: SHORTCUT_LABELS.toggleEnabled, onSelect: () => toggleEnabledSelection(sel) },
    ...convertEntry(p, sel),
    { separator: true },
    { label: 'Excluir', icon: Trash2, shortcut: SHORTCUT_LABELS.delete, danger: true, onSelect: () => deleteSelection(false) },
    { label: 'Excluir com ripple', icon: Trash2, shortcut: SHORTCUT_LABELS.rippleDelete, danger: true, onSelect: () => deleteSelection(true) }
  ]
}

export function markerMenuEntries(m: Marker, playback: PlaybackController | null): MenuEntry[] {
  return [
    { label: 'Ir para o marcador', onSelect: () => seekTo(playback, m.tUs) },
    { separator: true },
    { label: 'Excluir marcador', icon: Trash2, danger: true, onSelect: () => st().apply((q) => ({ ...q, markers: q.markers.filter((x) => x.id !== m.id) })) }
  ]
}
