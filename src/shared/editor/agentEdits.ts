import type { AgentAction } from '../agentProtocol'
import { agentActionSchema } from '../agentProtocol'
import type { MediaItem, TextItem, Project } from './project'
import { applyZoom } from './zoom'
import { getAnim, assignAnim } from './animPaths'
import { setKey } from './anim'
import * as ops from './ops'
import { reframeProject } from './reframe'
import { parseProject, validateProject } from './schema'

const us = (s: number): number => Math.round(s * 1e6)
export function applyAgentEdits(project: Project, actions: readonly AgentAction[]): { project: Project; createdIds: string[]; warnings: string[] } {
  let p = project
  const createdIds: string[] = [], warnings: string[] = []
  for (const raw of actions) {
    const a = agentActionSchema.parse(raw)
    switch (a.type) {
      case 'add_media': {
        const asset = p.assets.find(x => x.id === a.assetId)
        if (!asset || asset.status === 'error' || asset.status === 'missing') throw new Error('Mídia ausente ou inválida')
        const added = ops.addMediaFromAsset(p, a.assetId, us(a.at), { videoTrackId: asset.kind !== 'audio' ? a.trackId : undefined, audioTrackId: asset.kind === 'audio' ? a.trackId : undefined, inUs: us(a.sourceStart), durationUs: a.duration === undefined ? undefined : us(a.duration) })
        p = added.project
        createdIds.push(...added.itemIds)
        break
      }
      case 'add_track': { const r = ops.addTrack(p, a.kind, undefined, a.name, a.role); p = r.project; createdIds.push(r.trackId); break }
      case 'split': p = ops.splitAt(p, a.itemIds, us(a.at)); break
      case 'trim': p = ops.trimItem(p, a.itemId, a.edge, us(a.to), { ripple: a.ripple }); break
      case 'move': p = ops.moveItems(p, a.itemIds, us(a.delta), { toTrackId: a.trackId }); break
      case 'delete': p = ops.deleteItems(p, a.itemIds, { ripple: a.ripple }); break
      case 'delete_ranges': p = ops.deleteRanges(p, a.ranges.map(r => ({ fromUs: us(r.from), toUs: us(r.to) }))); break
      case 'speed': p = ops.setSpeed(p, a.itemId, a.speed, { ripple: a.ripple }); break
      case 'audio': p = ops.updateItem<MediaItem>(p, a.itemId, i => {
        if (i.type !== 'media') throw new Error('O item não é mídia')
        if (a.volume !== undefined) i.audio.volume = { value: a.volume }
        if (a.normalize !== undefined) i.audio.normalize = a.normalize
        if (a.denoise !== undefined) i.audio.denoise = a.denoise
        if (a.enabled !== undefined) i.audio.enabled = a.enabled
        if (a.fadeIn !== undefined) i.audio.fadeInUs = us(a.fadeIn)
        if (a.fadeOut !== undefined) i.audio.fadeOutUs = us(a.fadeOut)
      }); break
      case 'transform': p = ops.updateItem(p, a.itemId, i => {
        if (!('visual' in i) || !i.visual) throw new Error('O item não possui transformação visual')
        for (const key of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) if (a[key] !== undefined) i.visual.transform[key] = { value: a[key]! }
      }); break
      case 'text': { const r = ops.addText(p, a.preset, us(a.at), { text: a.text, durationUs: us(a.duration) }); p = r.project; createdIds.push(r.itemId); break }
      case 'caption': { const r = ops.addCaption(p, us(a.at), a.text, { durationUs: us(a.duration) }); p = r.project; createdIds.push(r.itemId); break }
      case 'effect': { const r = ops.addEffect(p, a.preset, us(a.at), { durationUs: us(a.duration), region: { x: a.x, y: a.y, w: a.width, h: a.height } }); p = r.project; createdIds.push(r.itemId); break }
      case 'transition': p = ops.addTransition(p, a.rightItemId, a.kind, us(a.duration)); break
      case 'track': { const { type: _, trackId, ...patch } = a; p = ops.updateTrack(p, trackId, patch); break }
      case 'marker': p = ops.addMarker(p, us(a.at), a.label); break
      case 'reframe': { const r = reframeProject(p, a.aspect, { mode: a.mode }); p = r.project; warnings.push(...r.warnings.map(w => w.message)); break }
      case 'rename': p = { ...p, name: a.name }; break
      case 'duplicate': { const r = ops.duplicateItems(p, a.itemIds, a.at === undefined ? undefined : us(a.at)); p = r.project; createdIds.push(...r.itemIds); break }
      case 'enabled': p = ops.setItemEnabled(p, a.itemIds, a.enabled); break
      case 'reverse': p = ops.setReverse(p, a.itemIds, a.reverse); break
      case 'freeze': p = ops.freezeFrameAt(p, a.itemId, us(a.at), us(a.duration)); break
      case 'text_update': p = ops.updateItem<TextItem>(p, a.itemId, i => {
        if (i.type !== 'text') throw new Error('O item não é texto')
        if (a.text !== undefined) i.text = a.text
        if (a.color !== undefined) i.style.color = a.color
        if (a.font !== undefined) i.style.font = a.font
        if (a.size !== undefined) i.style.size = { value: a.size }
        if (a.align !== undefined) i.style.align = a.align
      }); break
      case 'animation': p = ops.updateItem(p, a.itemId, i => {
        if (!('visual' in i) || !i.visual) throw new Error('O item não é visual')
        if (us(a.duration) > i.durationUs) throw new Error('A animação não pode ser maior que o clipe')
        i.visual[a.edge === 'in' ? 'animIn' : 'animOut'] = { preset: a.preset, durationUs: us(a.duration), ease: 'inOut' }
      }); break
      case 'keyframe': {
        p = ops.updateItem(p, a.itemId, i => {
          const animation = getAnim(i, a.path), local = us(a.at) - i.startUs
          if (!animation || local < 0 || local > i.durationUs) throw new Error('Propriedade ou instante inválido para o keyframe')
          const range = a.path === 'transform.scale' ? [0.01, 100] : a.path === 'text.size' ? [1, 1000] : a.path === 'audio.volume' ? [0, 4] : a.path === 'strength' ? [0, 100] : a.path === 'visual.radius' ? [0, 0.5] : a.path === 'transform.opacity' || a.path.startsWith('crop.') ? [0, 1] : a.path.endsWith('rotation') ? [-3600, 3600] : a.path.startsWith('adjust.') ? [-100, 100] : a.path === 'region.w' || a.path === 'region.h' ? [0.001, 10] : [-10, 10]
          if (a.value < range[0] || a.value > range[1]) throw new Error('Valor fora dos limites da propriedade animada')
          assignAnim(i, a.path, setKey(animation, local, a.value, a.ease))
        })
        break
      }
      case 'zoom': { const r = applyZoom(p, a.itemId, { x: a.x, y: a.y, w: a.width, h: a.height }, us(a.at), us(a.duration), a.hold === undefined ? null : us(a.hold), 'inOut', { clamp: true }); p = r.project; break }
      case 'mix': { const { type: _, ...mix } = a; p = { ...p, audioMix: mix }; break }
    }
  }
  p = parseProject(p)
  const errors = validateProject(p)
  if (errors.length) throw new Error(errors.join('; '))
  return { project: p, createdIds, warnings }
}
