// Cenas sintéticas para os testes de transição (resolve, privacidade e áudio). Só dados; sem ops.
import { createEffectItem, defaultAudio, defaultVisual } from '../factory'
import type { Asset, EffectItem, Item, MediaItem, Project, TextItem, Track, Transition, TransitionKind } from '../project'

export const S = 1_000_000

export const vid = (id: string, dur = 20 * S): Asset => ({
  id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S },
  audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready'
})
export const img = (id: string): Asset => ({
  id, name: id, kind: 'image', source: { type: 'file', path: `C:/${id}.png`, size: 1, mtimeMs: 1 }, durationUs: null,
  video: { width: 800, height: 600, fps: 0, codec: 'png', rotation: 0, decodable: true, gopUs: 0 }, status: 'ready'
})

/** Clipe de vídeo (sem áudio próprio por padrão, como addMediaFromAsset faz com o vídeo). */
export function vclip(id: string, assetId: string, startUs: number, durationUs: number, extra: Partial<MediaItem> = {}): MediaItem {
  return { id, type: 'media', assetId, startUs, durationUs, inUs: 0, speed: 1, reverse: false, audio: { ...defaultAudio(), enabled: false }, visual: defaultVisual(), ...extra }
}
/** Clipe de áudio. */
export function aclip(id: string, assetId: string, startUs: number, durationUs: number, extra: Partial<MediaItem> = {}): MediaItem {
  return { id, type: 'media', assetId, startUs, durationUs, inUs: 0, speed: 1, reverse: false, audio: defaultAudio(), ...extra }
}
export function textClip(id: string, startUs: number, durationUs: number, extra: Partial<TextItem> = {}): TextItem {
  return {
    id, type: 'text', startUs, durationUs, text: 'Olá', visual: defaultVisual(),
    style: { font: 'Inter', size: { value: 48 }, weight: 400, color: '#ffffff', align: 'center', lineHeight: 1.2 }, ...extra
  }
}
export function fx(id: string, preset: Parameters<typeof createEffectItem>[0], startUs: number, durationUs: number, extra: Partial<EffectItem> = {}): EffectItem {
  return { ...createEffectItem(preset, startUs, durationUs), id, ...extra }
}
export function track(id: string, kind: Track['kind'], items: Item[], extra: Partial<Track> = {}): Track {
  return { id, kind, name: id, muted: false, hidden: false, locked: false, volume: 1, items, ...extra }
}
export function project(tracks: Track[], assets: Asset[]): Project {
  return {
    version: 1, id: 'p_tr', name: 'transições', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
    canvas: { width: 1920, height: 1080, fps: 30, background: '#000000' }, assets, tracks, markers: []
  }
}
export const tr = (kind: TransitionKind, durationUs: number): Transition => ({ kind, durationUs })

/** O mesmo projeto sem nenhuma transição (o "resolve sem transição" dos oráculos). */
export function withoutTransitions(p: Project): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      items: t.items.map((i) => {
        if ((i.type !== 'media' && i.type !== 'text') || !i.transitionIn) return i
        const c = { ...i }
        delete c.transitionIn
        return c
      })
    }))
  }
}
