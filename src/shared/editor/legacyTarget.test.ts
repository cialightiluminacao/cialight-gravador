import { describe, expect, it } from 'vitest'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { createEmptyProject } from './factory'
import * as ops from './ops'
import type { Asset, EffectItem, Item, MediaItem, Project } from './project'
import { effectBound, resolveFrame } from './resolve'
import { parseProject, toDiskProject } from './schema'

// Efeito ANTIGO de escopo `track` sem targetTrackId (alvo pela posição: a faixa de vídeo visível logo abaixo) cuja faixa
// de baixo tem texto: a primeira edição grava o alvo de hoje (com `targetMediaOnly`, a regra do alvo antigo: só mídia,
// anotações e transição) — assim uma faixa de vídeo criada entre o efeito e a faixa dele não rouba o alvo.

const S = 1_000_000
const vid = (id: string): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: 30 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' })
const items = (p: Project): Item[] => p.tracks.flatMap((t) => t.items)

/** V1: clipe 0–10 s + título 12–15 s; Efeitos: blur antigo 1–7 s sem alvo gravado. */
function scene(): { p: Project; v1: string; fx: string; clip: string; text: string } {
  let p = ops.addAsset(ops.addAsset(createEmptyProject('legado'), vid('a')), vid('b'))
  const m = ops.addMediaFromAsset(p, 'a', 0)
  p = ops.updateItem<MediaItem>(m.project, m.itemIds[0], (d) => { d.durationUs = 10 * S })
  const v1 = ops.findItem(p, m.itemIds[0])!.track.id
  const t = ops.addText(p, 'title', 12 * S, { trackId: v1 })
  const fx = ops.addEffect(t.project, 'blur', 1 * S, { durationUs: 6 * S })
  const legacy = (i: Item): Item => {
    if (i.id !== fx.itemId || i.type !== 'effect') return i
    const { targetTrackId: _t, linkId: _l, ...rest } = i
    return { ...rest, scope: 'track' }
  }
  return { p: { ...fx.project, tracks: fx.project.tracks.map((x) => ({ ...x, items: x.items.map(legacy) })) }, v1, fx: fx.itemId, clip: m.itemIds[0], text: t.itemId }
}
const fxOf = (p: Project, id: string): EffectItem => ops.findItem(p, id)!.item as EffectItem
/** Camadas dos itens originais iguais a cada 1/240 s em [0, fim). */
function sameCoverage(p: Project, q: Project): void {
  const orig = new Set(items(p).map((i) => i.id))
  for (let t = 0; t < ops.projectDurationUs(p); t += Math.round(S / 240)) {
    const a = JSON.stringify(resolveFrame(p, t))
    const b = JSON.stringify(resolveFrame(q, t).filter((l) => 'itemId' in l && orig.has(l.itemId)))
    if (a !== b) throw new Error(`cobertura diferente em t=${t} µs:\n${a}\n${b}`)
  }
}

describe('efeito antigo de escopo track com texto na faixa-alvo', () => {
  it('addMediaFromAsset criando faixa nova entre o efeito e o alvo: o efeito continua no mesmo clipe (denso 1/240 s)', () => {
    const { p, v1, fx } = scene()
    const r = ops.addMediaFromAsset(p, 'b', 2 * S) // V1 ocupada em 2 s → faixa de vídeo nova logo abaixo dos efeitos
    const q = r.project
    const newTrack = ops.findItem(q, r.itemIds[0])!.track
    expect(newTrack.id).not.toBe(v1)
    const fxTrack = q.tracks.findIndex((t) => t.items.some((i) => i.id === fx))
    expect(q.tracks.findIndex((t) => t.id === newTrack.id)).toBe(fxTrack - 1) // entre o efeito e a V1
    sameCoverage(p, q)
    expect(fxOf(q, fx)).toMatchObject({ targetTrackId: v1, targetMediaOnly: true })
  })

  it('o alvo gravado mantém a regra antiga (texto da faixa não é afetado) e a v1.3 lê o projeto', () => {
    const { p, fx, text } = scene()
    const q = ops.addMarker(p, 0) // qualquer edição grava
    expect(fxOf(q, fx).targetMediaOnly).toBe(true)
    const layer = resolveFrame(q, 2 * S).find((l) => l.kind === 'effect')!
    expect(layer).toMatchObject({ legacyTarget: true })
    // efeito esticado sobre o título: o título não é coberto (regra do alvo antigo)
    const long = ops.updateItem<EffectItem>(q, fx, (d) => { d.durationUs = 14 * S })
    expect(ops.findItem(long, text)!.item.startUs).toBe(12 * S)
    const at13 = resolveFrame(long, 13 * S)
    const fxAt = at13.findIndex((l) => l.kind === 'effect')
    expect(at13.some((l) => l.kind === 'text')).toBe(true)
    expect(effectBound(at13, fxAt)).toBe(false) // não age no texto (fica sem camada-alvo)
    const at2 = resolveFrame(long, 2 * S)
    expect(effectBound(at2, at2.findIndex((l) => l.kind === 'effect'))).toBe(true) // e continua no clipe
    const disk = JSON.parse(JSON.stringify(toDiskProject(q)))
    expect(parseProjectV13(disk).success).toBe(true)
    expect(parseProject(disk)).toEqual(q)
  })

  it('sem nada abaixo: continua sem alvo (aviso noTarget); trocar o escopo tira a marca', () => {
    const { p, fx } = scene()
    const lone: Project = { ...p, tracks: p.tracks.filter((t) => t.kind !== 'video' || t.items.some((i) => i.id === fx)) }
    expect(fxOf(ops.addMarker(lone, 0), fx).targetTrackId).toBeUndefined()
    const q = ops.addMarker(p, 0)
    const below = ops.setEffectScope(q, fx, 'below')
    expect(fxOf(below, fx).targetMediaOnly).toBeUndefined()
    const track = ops.setEffectScope(below, fx, 'track')
    expect(fxOf(track, fx).targetMediaOnly).toBeUndefined()
  })
})
