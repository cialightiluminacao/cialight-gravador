import { describe, expect, it } from 'vitest'
import type { PipKeyframe, Session } from '../types'
import { createEmptyProject } from './factory'
import { projectFromSession } from './fromSession'
import type { Asset, EffectItem, Item, Project } from './project'
import * as ops from './ops'
import { parseProject } from './schema'
import { privacyWarnings } from './privacy'

// Ajustes pré-release da F2 (re-revisão final): anotações não são clipe/alvo de efeito, rótulo do alvo, covered com
// escopo `track`, duplicar projeto antigo.
const S = 1_000_000
const fx = (p: Project, id: string): EffectItem => ops.findItem(p, id)!.item as EffectItem

/** Gravação com tela, webcam (PiP visível) e traços → faixas Tela, Webcam, Anotações, Microfone, Áudio do sistema. */
function recording(): Project {
  const sq = (w: number): number => w * (1920 / 1080)
  const pip: PipKeyframe[] = [{ tMs: 0, x: 0.75, y: 0.7, w: 0.2, h: sq(0.2), shape: 'circle', visible: true }]
  const session = {
    version: 1, id: '2026-10-02T10-00-00', createdAt: '2026-10-02T13:00:00.000Z', state: 'done',
    source: { kind: 'screen', id: 'screen:0:0', name: 'Monitor 1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    video: { width: 1920, height: 1080, fps: 30, codec: 'avc1.640028', bitrate: 12e6 },
    webcam: { deviceId: 'd', label: 'cam', width: 1280, height: 720, mirrored: false },
    mic: { deviceId: 'm', label: 'mic', echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    systemAudio: true, tracks: { screen: 0, webcam: 1, mic: 0, system: 1 }, durationMs: 10_000, pauses: [], pip,
    strokes: [{ tMs: 1000 }, { tMs: 3000 }], clearEvents: [], markers: [], engine: 'webcodecs', files: { rec: 'rec.mp4' }
  } as unknown as Session
  return projectFromSession(session, { projectId: 'p1', name: 'Gravação', now: '2026-10-02T13:00:00.000Z' })
}
const track = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!
const itemOn = (p: Project, name: string): Item => track(p, name).items[0]

describe('anotações não são clipe nem alvo de efeito', () => {
  it('efeito criado sobre uma gravação com traços vincula e mira a webcam, não a faixa "Anotações"', () => {
    const p = recording()
    expect(p.tracks.map((t) => t.name)).toEqual(['Tela', 'Webcam', 'Anotações', 'Microfone', 'Áudio do sistema'])
    const e = ops.addEffect(p, 'blurFace', 2 * S)
    const cam = itemOn(e.project, 'Webcam')
    expect(fx(e.project, e.itemId).linkId).toBeDefined()
    expect(fx(e.project, e.itemId).linkId).toBe(cam.linkId)
    expect(fx(e.project, e.itemId).targetTrackId).toBe(track(e.project, 'Webcam').id)
    expect(ops.scopeTargetTrack(ops.setEffectScope(e.project, e.itemId, 'track'), e.itemId)?.name).toBe('Webcam')
  })
  it('sem vínculo, "só a faixa abaixo" pula a faixa de anotações até a mídia', () => {
    const p = recording()
    const e = ops.addEffect(p, 'blur', 2 * S)
    const loose = ops.setEffectScope(ops.unlinkItems(e.project, [e.itemId]), e.itemId, 'track')
    expect(fx(loose, e.itemId).linkId).toBeUndefined()
    expect(ops.scopeTargetTrack(loose, e.itemId)?.name).toBe('Webcam')
  })
})

describe('scopeTargetTrack (rótulo "Alvo:" do inspetor)', () => {
  it('alvo gravado, alvo antigo pela posição e alvo apagado', () => {
    const p = recording()
    const e = ops.addEffect(p, 'blur', 2 * S)
    const q = ops.setEffectScope(e.project, e.itemId, 'track')
    expect(ops.scopeTargetTrack(q, e.itemId)?.name).toBe('Webcam')
    const legacy = ops.updateItem<EffectItem>(q, e.itemId, (d) => { delete d.targetTrackId })
    // projeto antigo: a faixa de vídeo visível logo abaixo da "Efeitos" (aqui, a de anotações)
    expect(legacy.tracks.find((t) => t.items.some((i) => i.id === e.itemId))!.name).toBe('Efeitos')
    expect(ops.scopeTargetTrack(legacy, e.itemId)?.name).toBe('Anotações')
    expect(ops.scopeTargetTrack(ops.updateItem<EffectItem>(q, e.itemId, (d) => { d.targetTrackId = 't_sumiu' }), e.itemId)).toBeNull()
  })
})

describe('covered ignora a faixa-alvo do próprio efeito "só a faixa abaixo"', () => {
  it('alvo acima da faixa do efeito não conta como mídia por cima; outra mídia acima continua contando', () => {
    const p = recording()
    const camTrack = track(p, 'Webcam').id
    const below = ops.addTrack(p, 'video', 1, 'Efeitos baixos', 'effects') // entre Tela e Webcam
    const f = ops.addEffect(createEmptyProject('x'), 'blur', 0).project.tracks[1].items[0] as EffectItem
    const item: EffectItem = { ...f, startUs: S, durationUs: 2 * S, scope: 'track', targetTrackId: camTrack }
    const q = ops.insertItems(below.project, below.trackId, [item], 'overwrite')
    const kinds = (x: Project) => privacyWarnings(x, 0, 10 * S).filter((w) => w.itemId === item.id).map((w) => w.kind)
    expect(kinds(q)).toEqual([])
    // escopo "tudo abaixo" na mesma posição: a webcam acima conta
    expect(kinds(ops.setEffectScope(q, item.id, 'below'))).toEqual(['covered'])
  })
})

describe('duplicar projeto antigo: a cópia herda o alvo gravado e é remapeada', () => {
  const vid = (id: string, dur: number): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
  it('colar a webcam (cópia cai numa faixa nova): o efeito copiado mira a faixa nova', () => {
    let p = ops.addAsset(ops.addAsset(createEmptyProject('t'), vid('tela', 20 * S)), vid('cam', 4 * S))
    p = ops.addMediaFromAsset(p, 'tela', 0).project
    const c1 = ops.addMediaFromAsset(p, 'cam', 0)
    const camTrack = c1.project.tracks.find((t) => t.items.some((i) => i.id === c1.itemIds[0]))!.id
    const c2 = ops.addMediaFromAsset(c1.project, 'cam', 10 * S, { videoTrackId: camTrack })
    const e = ops.addEffect(c2.project, 'blurFace', 0)
    const json = JSON.parse(JSON.stringify(ops.setEffectScope(e.project, e.itemId, 'track'))) as Project
    for (const t of json.tracks) for (const i of t.items) if (i.type === 'effect') delete i.targetTrackId
    const legacy = parseProject(json)
    expect(fx(legacy, e.itemId).targetTrackId).toBeUndefined()
    const r = ops.duplicateItems(legacy, [c1.itemIds[0]], 12 * S) // [12,16) bate na webcam 2 → faixa nova
    const items = r.itemIds.map((id) => ops.findItem(r.project, id)!)
    const copyCam = items.find((f) => f.item.type === 'media' && f.track.kind === 'video')!
    const copyFx = items.find((f) => f.item.type === 'effect')!.item as EffectItem
    expect(copyCam.track.id).not.toBe(camTrack)
    expect(copyFx.targetTrackId).toBe(copyCam.track.id)
    expect(fx(r.project, e.itemId).targetTrackId).toBe(camTrack) // o original foi gravado com o alvo de antes
  })
})
