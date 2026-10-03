import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { toast } from 'sonner'
import { createEffectItem, createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { addMarker, findItem } from '@shared/editor/ops'
import type { Asset, EffectItem, MediaItem, Project } from '@shared/editor/project'
import { applyZoom } from '@shared/editor/zoom'
import { useEditorStore } from './editorStore'
import { anchorAfterMotion } from './motionAnchor'

// Revisão final da F6, C1: "Ancorar" no toast do zoom troca o passo do zoom por "ancorar no projeto de antes + refazer
// o zoom" — um passo de desfazer; com o projeto já mudado, ancora no atual (e o guarda de attachEffects recusa keys
// num trecho em que o clipe já se move).

const S = 1_000_000
const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const video: Asset = {
  id: 'v', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's', stream: 'screen' }, durationUs: 10 * S,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready'
}

/** Clipe + blur solto acima com keys (conteúdo parado em 0,3; 0,3): o que o "Seguir conteúdo" deixa. */
function scene(preZoom = false): Project {
  const p = { ...createEmptyProject('t', { width: 1920, height: 1080, fps: 30 }), updatedAt: '2000-01-01T00:00:00.000Z' }
  p.assets = [video]
  const m: MediaItem = { ...createMediaItem(video, 0, 'video'), id: 'm', durationUs: 10 * S }
  const fx: EffectItem = { ...createEffectItem('blur', 0, 10 * S, { x: 0.3, y: 0.3, w: 0.1, h: 0.05 }), id: 'fx' }
  const k = (v: number): EffectItem['region']['x'] => ({ value: v, keys: [{ tUs: 0, value: v, ease: 'linear' }, { tUs: 9 * S, value: v, ease: 'linear' }] })
  fx.region = { ...fx.region, x: k(0.3), y: k(0.3) }
  p.tracks[0].items = [m]
  p.tracks = [p.tracks[0], { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }]
  return preZoom ? applyZoom(p, 'm', { x: 0.6, y: 0.6, w: 0.5, h: 0.5 }, 5 * S, S, null, 'linear', { clamp: true }).project : p
}
const zoom = (p: Project): Project => applyZoom(p, 'm', { x: 0.35, y: 0.35, w: 0.5, h: 0.5 }, 2 * S, S, 3 * S, 'inOut', { clamp: true }).project
const fxOf = (p: Project | null): EffectItem => findItem(p!, 'fx')!.item as EffectItem
const mOf = (p: Project | null): MediaItem => findItem(p!, 'm')!.item as MediaItem

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
})

describe('anchorAfterMotion', () => {
  it('logo depois do zoom: ancora no projeto de antes e refaz o zoom, num passo que substitui o do zoom', () => {
    st().close()
    st().open(scene())
    const before = st().project!
    expect(st().apply(zoom)).toBe(true)
    const after = st().project!
    expect(anchorAfterMotion('m', ['fx'], { after, edit: zoom })).toBe(true)
    expect(st().history.past).toHaveLength(1)
    expect(st().history.past[0]).toBe(before)
    expect(st().canRedo).toBe(false)
    expect(fxOf(st().project).attach?.mediaItemId).toBe('m')
    expect(mOf(st().project).visual!.transform).toEqual(mOf(after).visual!.transform)
    // região ancorada = a do clipe parado (pose de antes do zoom): o centro no conteúdo é o do key
    expect(fxOf(st().project).region.x.keys!.map((k) => k.value)).toEqual([0.3, 0.3].map((v) => expect.closeTo(v, 9)))
    // um Ctrl+Z volta a antes do zoom (zoom e âncora juntos)
    st().undo()
    expect(st().project).toBe(before)
  })
  it('o projeto mudou depois do zoom: ancora no atual — com keys num trecho em que o clipe se move, recusa com toast e nada muda', () => {
    st().close()
    st().open(scene())
    st().apply(zoom)
    const after = st().project!
    st().apply((p) => addMarker(p, 1000))
    const cur = st().project
    expect(anchorAfterMotion('m', ['fx'], { after, edit: zoom })).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Desfaça o movimento \(Ctrl\+Z\), ancore e refaça/))
    expect(st().project).toBe(cur)
  })
  it('ancorar no projeto de antes também falha (o clipe já se movia lá): o zoom volta como estava', () => {
    st().close()
    st().open(scene(true))
    st().apply(zoom)
    const after = st().project!
    const past = st().history.past.length
    expect(anchorAfterMotion('m', ['fx'], { after, edit: zoom })).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(st().project).toBe(after)
    expect(st().history.past).toHaveLength(past)
  })
})
