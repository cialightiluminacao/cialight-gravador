import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, EffectItem, Item, Project } from './project'
import * as ops from './ops'
import { parseProject, validateProject } from './schema'
import { effectBound, resolveFrame } from './resolve'
import { privacyWarnings } from './privacy'

// Escopo "só a faixa abaixo" com alvo explícito (targetTrackId) e faixas de efeitos pelo papel (role 'effects'):
// ruling da re-revisão 3 da F2. A posição da faixa do efeito não decide mais a ligação.
const S = 1_000_000
const vid = (id = 'a1', dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
const it_ = (p: Project, id: string): Item => ops.findItem(p, id)!.item
const fx = (p: Project, id: string): EffectItem => it_(p, id) as EffectItem
const trackOf = (p: Project, id: string): string => ops.findItem(p, id)!.track.name
const trackIdOf = (p: Project, id: string): string => ops.findItem(p, id)!.track.id
const noTarget = (p: Project, from = 0, to = 30 * S) => privacyWarnings(p, from, to).filter((w) => w.kind === 'noTarget')

/** O efeito age (resolveFrame + a condição de ligação do compositor, effectBound) em cada instante. */
function renders(p: Project, fxId: string, times: number[]): boolean[] {
  return times.map((t) => {
    const layers = resolveFrame(p, t)
    const i = layers.findIndex((l) => l.kind === 'effect' && l.itemId === fxId)
    return i >= 0 && effectBound(layers, i)
  })
}

/**
 * Tela [0,20) na Vídeo 1; webcam 1 [0,4) e webcam 2 [10,14) na Vídeo 2, cada uma com um blur "só a faixa abaixo"
 * na faixa "Efeitos" compartilhada; blur do texto da tela [6,10) também na "Efeitos" (tudo abaixo).
 */
function twoCams(): { p: Project; cam1: string; cam2: string; b1: string; b2: string; text: string; camTrack: string } {
  let p = ops.addAsset(ops.addAsset(createEmptyProject('t'), vid('tela', 20 * S)), vid('cam', 4 * S))
  p = ops.addMediaFromAsset(p, 'tela', 0).project
  const c1 = ops.addMediaFromAsset(p, 'cam', 0)
  const camTrack = trackIdOf(c1.project, c1.itemIds[0])
  const c2 = ops.addMediaFromAsset(c1.project, 'cam', 10 * S, { videoTrackId: camTrack })
  const e1 = ops.addEffect(c2.project, 'blurFace', 0)
  const e2 = ops.addEffect(e1.project, 'blurFace', 10 * S)
  const tx = ops.addEffect(e2.project, 'blurText', 6 * S, { durationUs: 4 * S })
  p = ops.setEffectScope(ops.setEffectScope(tx.project, e1.itemId, 'track'), e2.itemId, 'track')
  expect([trackOf(p, e1.itemId), trackOf(p, e2.itemId), trackOf(p, tx.itemId)]).toEqual(['Efeitos', 'Efeitos', 'Efeitos'])
  expect([fx(p, e1.itemId).targetTrackId, fx(p, e2.itemId).targetTrackId]).toEqual([camTrack, camTrack])
  expect(renders(p, e1.itemId, [S, 3 * S])).toEqual([true, true])
  expect(renders(p, e2.itemId, [11 * S, 13 * S])).toEqual([true, true])
  expect(noTarget(p)).toEqual([])
  return { p, cam1: c1.itemIds[0], cam2: c2.itemIds[0], b1: e1.itemId, b2: e2.itemId, text: tx.itemId, camTrack }
}

describe('escopo "só a faixa abaixo" ligado pelo targetTrackId (cenários da revisão)', () => {
  it('mover a webcam 1 +5 s (sobrescrever): o blur dela realoca para outra faixa de efeitos e os dois blurs seguem escondendo', () => {
    const { p, cam1, b1, b2, text, camTrack } = twoCams()
    const q = ops.moveItems(p, [cam1], 5 * S, { mode: 'overwrite' })
    expect([fx(q, b1).startUs, fx(q, b1).durationUs, fx(q, b1).scope, fx(q, b1).targetTrackId]).toEqual([5 * S, 4 * S, 'track', camTrack])
    expect(trackOf(q, b1)).toBe('Efeitos 2')
    expect(renders(q, b1, [5.5 * S, 8 * S, 8.9 * S])).toEqual([true, true, true])
    expect(renders(q, b2, [11 * S, 13 * S])).toEqual([true, true])
    expect(renders(q, text, [7 * S])).toEqual([true])
    expect(noTarget(q)).toEqual([])
    expect(validateProject(q)).toEqual([])
  })
  it('colar a webcam 1 em 12 s (a cópia cai numa faixa de mídia nova): todos os blurs seguem escondendo; a cópia mira a faixa nova', () => {
    const { p, cam1, b2, camTrack } = twoCams()
    const r = ops.duplicateItems(p, [cam1], 12 * S)
    const copyCam = r.itemIds.map((id) => it_(r.project, id)).find((i) => i.type === 'media' && trackIdOf(r.project, i.id) !== camTrack && ops.findItem(r.project, i.id)!.track.kind === 'video')!
    const copyFx = r.itemIds.map((id) => it_(r.project, id)).find((i) => i.type === 'effect') as EffectItem
    const newTrack = trackIdOf(r.project, copyCam.id)
    expect(newTrack).not.toBe(camTrack)
    expect(copyFx.targetTrackId).toBe(newTrack)
    expect(renders(r.project, b2, [11 * S, 13 * S])).toEqual([true, true]) // pela posição, a faixa nova entre a webcam e os efeitos o desligava
    expect(renders(r.project, copyFx.id, [12.5 * S, 15 * S])).toEqual([true, true])
    expect(noTarget(r.project)).toEqual([])
  })
  it('importar mídia que cria uma faixa nova abaixo da "Efeitos": os blurs seguem escondendo', () => {
    const { p, b1, b2 } = twoCams()
    const r = ops.addMediaFromAsset(p, 'cam', 0) // Vídeo 1 e 2 ocupadas em [0,4): faixa nova logo abaixo do bloco de efeitos
    expect(p.tracks.filter((t) => t.kind === 'video').length + 1).toBe(r.project.tracks.filter((t) => t.kind === 'video').length)
    expect(renders(r.project, b1, [S, 3 * S])).toEqual([true, true])
    expect(renders(r.project, b2, [11 * S])).toEqual([true])
  })
  it('velocidade, aparar e ripple na webcam: o blur realocado segue ligado à webcam', () => {
    const { p, cam1, b1 } = twoCams()
    const slow = ops.setSpeed(p, cam1, 0.25) // webcam 1 [0,16) colide com a webcam 2 → ripple; blur [0,16) bate no texto
    expect(renders(slow, b1, [S, 7 * S, 15.9 * S])).toEqual([true, true, true])
    const short = ops.trimItem(p, cam1, 'end', 2 * S)
    const other = ops.addEffect(short, 'solid', 3 * S, { durationUs: 2 * S })
    const back = ops.trimItem(other.project, cam1, 'end', 4 * S)
    expect([fx(back, other.itemId).startUs, fx(back, other.itemId).durationUs]).toEqual([3 * S, 2 * S])
    expect(renders(back, b1, [S, 3.5 * S])).toEqual([true, true])
    const rip = ops.trimItem(p, cam1, 'end', 2 * S, { ripple: true })
    expect(renders(rip, b1, [S])).toEqual([true])
  })
  it('dois blurs "só a faixa abaixo" na mesma webcam ao mesmo tempo: os dois agem (encadeados)', () => {
    const { p, b1 } = twoCams()
    const e = ops.addEffect(p, 'pixelate', S, { durationUs: 2 * S })
    const q = ops.setEffectScope(e.project, e.itemId, 'track')
    expect(trackOf(q, e.itemId)).toBe('Efeitos 2')
    expect(renders(q, b1, [1.5 * S])).toEqual([true])
    expect(renders(q, e.itemId, [1.5 * S])).toEqual([true])
  })
  it('clipe movido para outra faixa (toTrackId): o alvo dos blurs dele vai junto', () => {
    const { p, cam1, b1 } = twoCams()
    const nt = ops.addTrack(p, 'video')
    const q = ops.moveItems(nt.project, [cam1], 0, { toTrackId: nt.trackId })
    expect(fx(q, b1).targetTrackId).toBe(nt.trackId)
    expect(renders(q, b1, [S])).toEqual([true])
  })
  it('setEffectScope sem vínculo: alvo = faixa de mídia visível mais próxima abaixo (pula faixas de efeitos)', () => {
    const p0 = ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid()), 'a1', 0).project
    const free = ops.addEffect(p0, 'blur', 12 * S) // depois do clipe: sem vínculo
    const q = ops.setEffectScope(free.project, free.itemId, 'track')
    expect(fx(q, free.itemId).targetTrackId).toBe(p0.tracks[0].id)
    expect('targetTrackId' in fx(ops.setEffectScope(q, free.itemId, 'below'), free.itemId)).toBe(false)
  })
})

describe('projeto antigo sem targetTrackId; faixas de efeitos pelo papel', () => {
  /** twoCams sem targetTrackId nem role (como gravado antes deste ruling), passando pela migração. */
  function legacy(): ReturnType<typeof twoCams> {
    const r = twoCams()
    const json = JSON.parse(JSON.stringify(r.p)) as Project
    for (const t of json.tracks) {
      delete t.role
      for (const i of t.items) if (i.type === 'effect') delete i.targetTrackId
    }
    return { ...r, p: parseProject(json) }
  }
  it('renderiza como antes (ligação pela posição) e a migração devolve o papel à faixa "Efeitos"', () => {
    const { p, b1, b2 } = legacy()
    expect(p.tracks.find((t) => t.name === 'Efeitos')!.role).toBe('effects')
    expect(fx(p, b1).targetTrackId).toBeUndefined()
    expect(renders(p, b1, [S, 3 * S])).toEqual([true, true])
    expect(renders(p, b2, [11 * S])).toEqual([true])
  })
  it('qualquer edição grava o alvo atual; inserir uma faixa depois não desliga mais', () => {
    const { p, b1, b2, camTrack } = legacy()
    const r = ops.addMediaFromAsset(p, 'cam', 0)
    expect([fx(r.project, b1).targetTrackId, fx(r.project, b2).targetTrackId]).toEqual([camTrack, camTrack])
    expect(renders(r.project, b1, [S, 3 * S])).toEqual([true, true])
  })
  it('migração: só "Efeitos"/"Efeitos N" de vídeo com só efeitos (ou vazia) ganha o papel; mídia chamada "Efeitos" continua mídia', () => {
    const { p } = twoCams()
    const json = JSON.parse(JSON.stringify(p)) as Project
    for (const t of json.tracks) delete t.role
    const v1 = json.tracks[0]
    v1.name = 'Efeitos 2' // faixa de mídia com nome de efeitos
    json.tracks.push({ id: 't_vazia', kind: 'video', name: 'Efeitos 3', muted: false, hidden: false, locked: false, volume: 1, items: [] })
    const m = parseProject(json)
    expect(m.tracks.find((t) => t.name === 'Efeitos')!.role).toBe('effects')
    expect(m.tracks.find((t) => t.name === 'Efeitos 3')!.role).toBe('effects')
    expect(m.tracks.find((t) => t.name === 'Efeitos 2')!.role).toBeUndefined()
    expect(json.tracks.find((t) => t.name === 'Efeitos')!.role).toBeUndefined() // não muda o objeto recebido
  })
  it('faixa de efeitos renomeada continua de efeitos; faixa de mídia chamada "Efeitos" se comporta como mídia', () => {
    const { p } = twoCams()
    const fxTrack = p.tracks.find((t) => t.role === 'effects')!
    const renamed = ops.updateTrack(p, fxTrack.id, { name: 'Desfoques' })
    const e = ops.addEffect(renamed, 'solid', 16 * S, { durationUs: 2 * S })
    expect(trackOf(e.project, e.itemId)).toBe('Desfoques')
    expect(() => ops.addMediaFromAsset(renamed, 'cam', 25 * S, { videoTrackId: fxTrack.id })).toThrow(expect.objectContaining({ code: 'invalid' }))
    const mediaNamed = ops.updateTrack(p, p.tracks[0].id, { name: 'Efeitos 7' })
    const r = ops.addMediaFromAsset(mediaNamed, 'cam', 25 * S, { videoTrackId: p.tracks[0].id })
    expect(trackOf(r.project, r.itemIds[0])).toBe('Efeitos 7')
  })
})

describe('noTarget: a faixa-alvo não tem camada desenhada em algum instante', () => {
  it('efeito mais longo que a webcam: avisa a partir do fim dela', () => {
    const { p, b1 } = twoCams()
    const longer = ops.updateItem<EffectItem>(p, b1, (d) => { d.durationUs = 5 * S })
    expect(noTarget(longer)).toEqual([{ itemId: b1, kind: 'noTarget', message: "Efeito 'só a faixa abaixo' sem mídia embaixo neste trecho", tUs: 4 * S }])
    expect(noTarget(longer, 0, 3 * S)).toEqual([])
  })
  it('faixa-alvo apagada, oculta, ou com o clipe desativado/sem asset: avisa', () => {
    const { p, b1, b2, camTrack, cam1 } = twoCams()
    const hidden = ops.updateTrack(p, camTrack, { hidden: true })
    expect(noTarget(hidden).map((w) => [w.itemId, w.tUs])).toEqual([[b1, 0], [b2, 10 * S]])
    const off = ops.setItemEnabled(p, [cam1], false)
    expect(noTarget(off).map((w) => w.itemId)).toEqual([b1])
    const noAsset: Project = { ...p, assets: p.assets.filter((a) => a.id !== 'cam') }
    expect(noTarget(noAsset).map((w) => w.itemId)).toEqual([b1, b2])
    // faixa apagada: o efeito sem o clipe (desvinculado) fica mirando uma faixa que não existe
    const loose = ops.unlinkItems(p, [b1])
    const gone = ops.removeTrack(loose, camTrack)
    expect(noTarget(gone).map((w) => [w.itemId, w.tUs])).toEqual([[b1, 0], [b2, 10 * S]])
    expect(renders(gone, b1, [S])).toEqual([false])
  })
})
