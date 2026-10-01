import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, Item, MediaItem, Project } from './project'
import * as ops from './ops'
import { validateProject } from './schema'
const S = 1_000_000
const vid = (id = 'a1', dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
function base(): { p: Project; v: string; a: string } {
  let p = ops.addAsset(createEmptyProject('t'), vid())
  const r = ops.addMediaFromAsset(p, 'a1', 0); p = r.project
  return { p, v: r.itemIds[0], a: r.itemIds[1] }
}
const items = (p: Project, ti: number) => p.tracks[ti].items as MediaItem[]
describe('ops', () => {
  it('addMediaFromAsset cria vídeo + áudio vinculados', () => {
    const { p } = base()
    expect(items(p, 0)).toHaveLength(1); expect(items(p, 1)).toHaveLength(1)
    expect(items(p, 0)[0].linkId).toBeDefined(); expect(items(p, 0)[0].linkId).toBe(items(p, 1)[0].linkId)
    expect(items(p, 0)[0].audio.enabled).toBe(false); expect(items(p, 1)[0].visual).toBeUndefined()
    expect(validateProject(p)).toEqual([])
  })
  it('splitAt divide vídeo e áudio vinculados', () => {
    const { p, v } = base(); const q = ops.splitAt(p, [v], 4 * S)
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs, i.inUs])).toEqual([[0, 4 * S, 0], [4 * S, 6 * S, 4 * S]])
    expect(items(q, 1)).toHaveLength(2)
    expect(items(q, 0)[1].linkId).toBe(items(q, 1)[1].linkId); expect(items(q, 0)[1].linkId).not.toBe(items(q, 0)[0].linkId)
  })
  it('splitAt na borda não cria item vazio', () => { const { p, v } = base(); expect(ops.splitAt(p, [v], 0)).toEqual(p); expect(ops.splitAt(p, [v], 10 * S)).toEqual(p) })
  it('splitAt com speed 2 calcula inUs na fonte', () => {
    const { p, v } = base(); const q = ops.splitAt(ops.setSpeed(p, v, 2), [v], 2 * S)
    expect(items(q, 0)[1].inUs).toBe(4 * S); expect(items(q, 0)[1].durationUs).toBe(3 * S)
  })
  it('deleteRange apaga o meio e fecha o buraco em todas as faixas', () => {
    const { p } = base(); const q = ops.deleteRange(p, 2 * S, 5 * S)
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs, i.inUs])).toEqual([[0, 2 * S, 0], [2 * S, 5 * S, 5 * S]])
    expect(ops.projectDurationUs(q)).toBe(7 * S); expect(validateProject(q)).toEqual([])
  })
  it('trimItem start respeita inUs ≥ 0 e move vinculados', () => {
    const { p, v } = base(); const q = ops.trimItem(p, v, 'start', 3 * S)
    expect(items(q, 0)[0]).toMatchObject({ startUs: 3 * S, inUs: 3 * S, durationUs: 7 * S }); expect(items(q, 1)[0]).toMatchObject({ startUs: 3 * S, inUs: 3 * S })
    const back = ops.trimItem(q, v, 'start', -5 * S); expect(items(back, 0)[0]).toMatchObject({ startUs: 0, inUs: 0 })
  })
  it('trimItem end não passa da fonte', () => { const { p, v } = base(); expect(items(ops.trimItem(p, v, 'end', 20 * S), 0)[0].durationUs).toBe(10 * S) })
  it('moveItems sobre outro item sem modo lança overlap; com overwrite recorta', () => {
    let { p } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const second = items(p, 0)[1].id
    expect(() => ops.moveItems(p, [second], -5 * S)).toThrow(ops.EditError)
    const q = ops.moveItems(p, [second], -5 * S, { mode: 'overwrite' })
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs])).toEqual([[0, 5 * S], [5 * S, 10 * S]]); expect(validateProject(q)).toEqual([])
  })
  it('deleteItems ripple fecha buraco', () => {
    let { p, v } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const q = ops.deleteItems(p, [v], { ripple: true }); expect(items(q, 0)[0].startUs).toBe(0); expect(items(q, 1)[0].startUs).toBe(0)
  })
  it('detachAudio em item já vinculado desvincula', () => { const { p, v } = base(); const q = ops.detachAudio(p, v); expect(items(q, 0)[0].linkId).toBeUndefined(); expect(items(q, 1)[0].linkId).toBeUndefined() })
  it('setSpeed 0.5 dobra a duração e empurra posteriores', () => {
    let { p, v } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const q = ops.setSpeed(p, v, 0.5); expect(items(q, 0)[0].durationUs).toBe(20 * S); expect(items(q, 0)[1].startUs).toBe(20 * S); expect(validateProject(q)).toEqual([])
  })
  it('faixa bloqueada recusa edição', () => { const { p, v } = base(); const q = ops.updateTrack(p, p.tracks[0].id, { locked: true }); expect(() => ops.deleteItems(q, [v], { includeLinked: false })).toThrow(/bloquead/) })

  // --- testes adicionais ---
  it('findItem e linkedIds', () => {
    const { p, v, a } = base()
    expect(ops.findItem(p, a)).toMatchObject({ trackIndex: 1, itemIndex: 0 })
    expect(ops.findItem(p, 'nada')).toBeNull()
    expect(ops.linkedIds(p, v).sort()).toEqual([v, a].sort())
    expect(ops.linkedIds(p, 'nada')).toEqual([])
  })
  it('splitAt reparte keyframes e mantém transitionIn só no 1º pedaço', () => {
    const { p, v } = base()
    const q0 = ops.updateItem<MediaItem>(p, v, (d) => {
      d.visual!.transform.opacity = { value: 1, keys: [{ tUs: 0, value: 0, ease: 'linear' }, { tUs: 10 * S, value: 1, ease: 'linear' }] }
      d.transitionIn = { kind: 'crossfade', durationUs: S }
    })
    const q = ops.splitAt(q0, [v], 4 * S)
    const [l, r] = items(q, 0)
    expect(l.visual!.transform.opacity.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 0], [4 * S, 0.4]])
    expect(r.visual!.transform.opacity.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 0.4], [6 * S, 1]])
    expect(l.transitionIn).toBeDefined(); expect(r.transitionIn).toBeUndefined()
    expect(validateProject(q)).toEqual([])
  })
  it('splitAt em item reverso pega o fim da fonte no 1º pedaço; ease bezier sobrevive', () => {
    const { p, v } = base()
    const q0 = ops.updateItem<MediaItem>(p, v, (d) => {
      d.reverse = true
      d.visual!.transform.x = { value: 0.5, keys: [{ tUs: 0, value: 0, ease: { bezier: [0.4, 0, 0.2, 1] } }, { tUs: 10 * S, value: 1, ease: 'linear' }] }
    })
    const q = ops.splitAt(q0, [v], 4 * S)
    expect(items(q, 0).map((i) => i.inUs)).toEqual([6 * S, 0])
    expect(items(q, 0)[1].visual!.transform.x.keys!.at(-1)).toMatchObject({ tUs: 6 * S, value: 1 })
    expect(items(q, 0)[0].visual!.transform.x.keys![0].ease).toEqual({ bezier: [0.4, 0, 0.2, 1] })
    expect(Object.isFrozen(items(q, 0)[1])).toBe(true)
  })
  it("splitAt 'all' divide todas as faixas desbloqueadas", () => {
    const { p } = base(); const q = ops.splitAt(p, 'all', 3 * S)
    expect(items(q, 0)).toHaveLength(2); expect(items(q, 1)).toHaveLength(2)
  })
  it('splitAt perto da borda (< MIN_ITEM_US) não divide', () => { const { p, v } = base(); expect(ops.splitAt(p, [v], 10_000)).toBe(p) })
  it('insertItems insert empurra todas as faixas e divide o item cruzado', () => {
    const { p } = base()
    const r = ops.addMediaFromAsset(p, 'a1', 4 * S, { videoTrackId: p.tracks[0].id, mode: 'insert' })
    const q = r.project
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs, i.inUs])).toEqual([[0, 4 * S, 0], [4 * S, 10 * S, 0], [14 * S, 6 * S, 4 * S]])
    expect(items(q, 1).map((i) => [i.startUs, i.durationUs])).toEqual([[0, 4 * S], [4 * S, 10 * S], [14 * S, 6 * S]])
    expect(validateProject(q)).toEqual([])
  })
  it('insertItems overwrite recorta o que está embaixo', () => {
    const { p } = base()
    const q = ops.addMediaFromAsset(p, 'a1', 2 * S, { videoTrackId: p.tracks[0].id, audioTrackId: p.tracks[1].id, mode: 'overwrite' }).project
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs])).toEqual([[0, 2 * S], [2 * S, 10 * S]])
    expect(validateProject(q)).toEqual([])
  })
  it('addMediaFromAsset sem faixa livre cria faixa nova', () => {
    const { p } = base(); const q = ops.addMediaFromAsset(p, 'a1', 5 * S).project
    expect(q.tracks.map((t) => [t.kind, t.name])).toEqual([['video', 'Vídeo 1'], ['video', 'Vídeo 2'], ['audio', 'Áudio 1'], ['audio', 'Áudio 2']])
    expect(validateProject(q)).toEqual([])
  })
  it('addMediaFromAsset de asset inexistente lança notFound', () => {
    const { p } = base()
    try { ops.addMediaFromAsset(p, 'x', 0); expect.unreachable() } catch (e) { expect((e as ops.EditError).code).toBe('notFound') }
  })
  it('trimItem end com ripple desloca posteriores de todas as faixas', () => {
    let { p, v } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const q = ops.trimItem(p, v, 'end', 6 * S, { ripple: true })
    expect(items(q, 0).map((i) => i.startUs)).toEqual([0, 6 * S]); expect(items(q, 1).map((i) => i.startUs)).toEqual([0, 6 * S])
    expect(validateProject(q)).toEqual([])
  })
  it('trimItem end é limitado pelo próximo vizinho', () => {
    let { p, v } = base(); p = ops.trimItem(p, v, 'end', 5 * S)
    p = ops.addMediaFromAsset(p, 'a1', 7 * S).project
    expect(p.tracks).toHaveLength(2)
    expect(items(ops.trimItem(p, v, 'end', 20 * S), 0)[0].durationUs).toBe(7 * S)
  })
  it('moveItems limita início a 0 e move vinculados', () => {
    let { p, v } = base(); p = ops.moveItems(p, [v], 3 * S)
    expect(items(p, 0)[0].startUs).toBe(3 * S); expect(items(p, 1)[0].startUs).toBe(3 * S)
    const q = ops.moveItems(p, [v], -10 * S); expect(items(q, 0)[0].startUs).toBe(0); expect(items(q, 1)[0].startUs).toBe(0)
  })
  it('moveItems para outra faixa', () => {
    let { p, v } = base(); const r = ops.addTrack(p, 'video'); p = r.project
    const q = ops.moveItems(p, [v], 0, { toTrackId: r.trackId, includeLinked: false })
    expect(q.tracks.find((t) => t.id === r.trackId)!.items.map((i) => i.id)).toEqual([v]); expect(items(q, 0)).toHaveLength(0)
    expect(() => ops.moveItems(p, [v], 0, { toTrackId: p.tracks[2].id, includeLinked: false })).toThrow(ops.EditError)
  })
  it('deleteItems ripple não fecha se causar dessincronia', () => {
    let { p, v } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const q = ops.deleteItems(p, [v], { ripple: true, includeLinked: false })
    expect(items(q, 0)[0].startUs).toBe(10 * S); expect(items(q, 1)).toHaveLength(2)
  })
  it('deleteItems sem ripple deixa buraco e desfaz vínculo órfão', () => {
    let { p, v } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const q = ops.deleteItems(p, [v], { includeLinked: false })
    expect(items(q, 0)).toHaveLength(1); expect(items(q, 1)[0].linkId).toBeUndefined()
  })
  it('detachAudio em vídeo com áudio próprio cria item de áudio vinculado', () => {
    let { p, v, a } = base(); p = ops.deleteItems(ops.detachAudio(p, v), [a])
    p = ops.updateItem<MediaItem>(p, v, (d) => { d.audio.enabled = true })
    const q = ops.detachAudio(p, v)
    expect(items(q, 0)[0].audio.enabled).toBe(false); expect(items(q, 1)).toHaveLength(1)
    expect(items(q, 1)[0]).toMatchObject({ startUs: 0, durationUs: 10 * S, linkId: items(q, 0)[0].linkId })
    expect(items(q, 1)[0].audio.enabled).toBe(true); expect(validateProject(q)).toEqual([])
  })
  it('linkItems e unlinkItems', () => {
    const { p, v, a } = base(); const u = ops.unlinkItems(p, [v])
    expect(ops.linkedIds(u, v)).toEqual([v])
    const l = ops.linkItems(u, [v, a]); expect(ops.linkedIds(l, v).sort()).toEqual([v, a].sort())
  })
  it('setSpeed limita ao intervalo e escala keyframes', () => {
    const { p, v } = base()
    const q0 = ops.updateItem<MediaItem>(p, v, (d) => { d.audio.volume = { value: 1, keys: [{ tUs: 0, value: 0, ease: 'linear' }, { tUs: 10 * S, value: 1, ease: 'linear' }] } })
    const q = ops.setSpeed(q0, v, 100)
    expect(items(q, 0)[0].speed).toBe(16); expect(items(q, 1)[0].speed).toBe(16)
    expect(items(q, 0)[0].durationUs).toBe(625_000); expect(items(q, 0)[0].audio.volume.keys![1].tUs).toBe(625_000)
  })
  it('updateItem recusa duração menor que o mínimo', () => {
    const { p, v } = base(); expect(() => ops.updateItem<MediaItem>(p, v, (d) => { d.durationUs = 10 })).toThrow(ops.EditError)
  })
  it('duplicateItems copia com novos ids e vínculo próprio', () => {
    const { p, v } = base(); const r = ops.duplicateItems(p, [v])
    expect(r.itemIds).toHaveLength(2)
    expect(items(r.project, 0).map((i) => i.startUs)).toEqual([0, 10 * S])
    expect(items(r.project, 0)[1].linkId).toBe(items(r.project, 1)[1].linkId); expect(items(r.project, 0)[1].linkId).not.toBe(items(r.project, 0)[0].linkId)
    expect(validateProject(r.project)).toEqual([])
  })
  it('closeGaps encosta os itens', () => {
    let { p, v } = base(); p = ops.moveItems(p, [v], 2 * S, { includeLinked: false })
    expect(items(ops.closeGaps(p, p.tracks[0].id), 0)[0].startUs).toBe(0)
  })
  it('removeAsset remove itens que o usam', () => { const { p } = base(); const q = ops.removeAsset(p, 'a1'); expect(q.assets).toHaveLength(0); expect(items(q, 0)).toHaveLength(0); expect(items(q, 1)).toHaveLength(0) })
  it('addTrack, moveTrack, removeTrack', () => {
    const { p } = base(); const r = ops.addTrack(p, 'audio', undefined, 'Música')
    expect(r.project.tracks[2]).toMatchObject({ kind: 'audio', name: 'Música' })
    const m = ops.moveTrack(r.project, r.trackId, 0); expect(m.tracks[0].id).toBe(r.trackId)
    expect(ops.removeTrack(m, r.trackId).tracks).toHaveLength(2)
  })
  it('addMarker e projectDurationUs ignora faixas ocultas', () => {
    const { p } = base(); const q = ops.addMarker(p, 2 * S, 'Início')
    expect(q.markers[0]).toMatchObject({ tUs: 2 * S, label: 'Início' })
    expect(ops.projectDurationUs(q)).toBe(10 * S)
    let h = ops.updateTrack(q, q.tracks[0].id, { hidden: true }); h = ops.updateTrack(h, h.tracks[1].id, { hidden: true })
    expect(ops.projectDurationUs(h)).toBe(0)
  })

  // --- correções da revisão ---
  it('setSpeed escala fades, animações e transição e limita à nova duração', () => {
    const { p, v } = base()
    const q0 = ops.updateItem<MediaItem>(p, v, (d) => {
      d.visual!.fadeInUs = S; d.visual!.fadeOutUs = S; d.audio.fadeInUs = S; d.audio.fadeOutUs = S
      d.visual!.animIn = { preset: 'fade', durationUs: 2 * S }; d.visual!.animOut = { preset: 'zoom', durationUs: 20 * S }
      d.transitionIn = { kind: 'crossfade', durationUs: 8 * S }
    })
    const it = items(ops.setSpeed(q0, v, 16), 0)[0]
    expect([it.visual!.fadeInUs, it.visual!.fadeOutUs, it.audio.fadeInUs, it.audio.fadeOutUs]).toEqual([62_500, 62_500, 62_500, 62_500])
    expect(it.visual!.animIn!.durationUs).toBe(125_000)
    expect(it.visual!.animOut!.durationUs).toBe(625_000) // 1_250_000 limitado à duração
    expect(it.transitionIn!.durationUs).toBe(312_500) // 500_000 limitado à metade da duração
  })
  it('setSpeed mantém fadeIn + fadeOut ≤ duração (vídeo e áudio) apesar do arredondamento', () => {
    const { p, v } = base()
    const q0 = ops.updateItem<MediaItem>(p, v, (d) => {
      d.durationUs = S; d.visual!.fadeInUs = S / 2; d.visual!.fadeOutUs = S / 2; d.audio.fadeInUs = S / 2; d.audio.fadeOutUs = S / 2
    })
    const it = items(ops.setSpeed(q0, v, 3), 0)[0] // 1 s / 3 = 333 333 µs; cada fade arredondaria para 166 667
    expect(it.durationUs).toBe(333_333)
    expect(it.visual!.fadeInUs + it.visual!.fadeOutUs).toBeLessThanOrEqual(it.durationUs)
    expect(it.audio.fadeInUs + it.audio.fadeOutUs).toBeLessThanOrEqual(it.durationUs)
    expect(it.visual!.fadeInUs).toBe(166_667)
  })
  it('deleteRange: cada linkId vincula pedaços no mesmo tempo', () => {
    const { p, a } = base()
    const q = ops.deleteRange(ops.trimItem(p, a, 'start', 3 * S, { includeLinked: false }), 2 * S, 5 * S)
    const groups = new Map<string, Item[]>()
    for (const t of q.tracks) for (const i of t.items) if (i.linkId) groups.set(i.linkId, [...(groups.get(i.linkId) ?? []), i])
    expect(groups.size).toBe(1)
    for (const g of groups.values()) { expect(g).toHaveLength(2); expect(new Set(g.map((i) => i.startUs)).size).toBe(1) }
    expect(validateProject(q)).toEqual([])
  })
  it('closeGaps move os vinculados de outras faixas (ou pula se colidir)', () => {
    let { p, v } = base(); p = ops.moveItems(p, [v], 2 * S)
    const q = ops.closeGaps(p, p.tracks[0].id)
    expect(items(q, 0)[0].startUs).toBe(0); expect(items(q, 1)[0].startUs).toBe(0)
    p = ops.addAsset(p, { ...vid('a2', S), kind: 'audio', video: undefined })
    p = ops.addMediaFromAsset(p, 'a2', 0).project
    expect(items(p, 1)).toHaveLength(2)
    const r = ops.closeGaps(p, p.tracks[0].id)
    expect(items(r, 0)[0].startUs).toBe(0); expect(items(r, 1).map((i) => i.startUs)).toEqual([0, 2 * S])
    expect(validateProject(r)).toEqual([])
  })
  it('deleteRange remove marcadores do trecho e puxa os posteriores', () => {
    let { p } = base(); p = ops.addMarker(ops.addMarker(ops.addMarker(p, S), 3 * S), 6 * S)
    expect(ops.deleteRange(p, 2 * S, 5 * S).markers.map((m) => m.tUs)).toEqual([S, 3 * S])
  })
  it('ripple desloca marcadores só quando aplicado a todas as faixas', () => {
    let { p, v } = base(); p = ops.addMarker(ops.addMediaFromAsset(p, 'a1', 10 * S).project, 12 * S)
    expect(ops.deleteItems(p, [v], { ripple: true }).markers[0].tUs).toBe(2 * S)
    expect(ops.trimItem(p, v, 'end', 6 * S, { ripple: true }).markers[0].tUs).toBe(8 * S)
    expect(ops.trimItem(p, v, 'end', 6 * S, { ripple: true, includeLinked: false }).markers[0].tUs).toBe(12 * S)
    expect(ops.setSpeed(p, v, 0.5).markers[0].tUs).toBe(22 * S)
  })
  it('insertItems recusa ids repetidos; updateAsset ignora id', () => {
    const { p, v } = base()
    const dup = { ...items(p, 0)[0], startUs: 20 * S }
    try { ops.insertItems(p, p.tracks[0].id, [dup], 'overwrite'); expect.unreachable() } catch (e) { expect((e as ops.EditError).code).toBe('invalid') }
    const fresh = { ...dup, id: 'novo', linkId: undefined }
    expect(() => ops.insertItems(p, p.tracks[0].id, [fresh, { ...fresh, startUs: 30 * S }], 'overwrite')).toThrow(ops.EditError)
    expect(ops.updateAsset(p, 'a1', { id: 'x', name: 'n' }).assets[0]).toMatchObject({ id: 'a1', name: 'n' })
    expect(v).toBeDefined()
  })
})
