import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import { MIN_ITEM_US, type Asset, type EffectItem, type Item, type MediaItem, type Project } from './project'
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
    p = ops.addMediaFromAsset(p, 'a2', 0, { audioTrackId: p.tracks[1].id }).project
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

describe('efeitos de privacidade', () => {
  const fxItems = (p: Project, ti: number) => p.tracks[ti].items as EffectItem[]
  it('addEffect cria faixa "Efeitos" no topo; duração segue o clipe sob o playhead', () => {
    const { p } = base()
    const r = ops.addEffect(p, 'blur', 4 * S)
    const top = r.project.tracks.filter((t) => t.kind === 'video').at(-1)!
    expect(top.name).toBe('Efeitos')
    expect(r.project.tracks.indexOf(top)).toBe(1) // acima de "Vídeo 1" e antes do áudio
    expect(top.items[0]).toMatchObject({ id: r.itemId, type: 'effect', startUs: 4 * S, durationUs: 6 * S })
    expect(validateProject(r.project)).toEqual([])
  })
  it('sem clipe sob o playhead dura 5 s; durationUs explícito vence', () => {
    const p = createEmptyProject('t')
    expect(fxItems(ops.addEffect(p, 'pixelate', 3 * S).project, 1)[0].durationUs).toBe(5 * S)
    expect(fxItems(ops.addEffect(p, 'solid', 0, { durationUs: 2 * S }).project, 1)[0].durationUs).toBe(2 * S)
  })
  it('defaultEffectDurationUs: até o fim do clipe sob o ponto, senão 5 s (o mesmo que addEffect usa)', () => {
    const { p } = base()
    expect(ops.defaultEffectDurationUs(p, 4 * S)).toBe(6 * S)
    expect(ops.defaultEffectDurationUs(createEmptyProject('t'), 3 * S)).toBe(5 * S)
  })
  it('reaproveita a faixa "Efeitos" quando livre; cria "Efeitos 2" quando ocupada', () => {
    const { p } = base()
    const a = ops.addEffect(p, 'blur', 0, { durationUs: 2 * S })
    const b = ops.addEffect(a.project, 'blur', 3 * S, { durationUs: 2 * S })
    expect(b.project.tracks.filter((t) => t.name === 'Efeitos')).toHaveLength(1)
    expect(fxItems(b.project, 1)).toHaveLength(2)
    const c = ops.addEffect(b.project, 'blur', S, { durationUs: 3 * S })
    expect(c.project.tracks.map((t) => t.name)).toEqual(['Vídeo 1', 'Efeitos', 'Efeitos 2', 'Áudio 1'])
    expect(fxItems(c.project, 2)).toHaveLength(1)
  })
  it('addEffect com trackId explícito e região', () => {
    const { p } = base()
    const r = ops.addEffect(p, 'blurFace', S, { trackId: p.tracks[0].id, region: { x: 0.3 } })
    const fx = r.project.tracks[0].items.find((i) => i.id === r.itemId) as EffectItem
    expect(fx.region.x.value).toBe(0.3)
    expect(fx.region.shape).toBe('ellipse')
  })
  it('addEffect explícito: arredonda e prende atUs ≥ 0 e durationUs ≥ MIN_ITEM_US', () => {
    const p = createEmptyProject('t')
    const a = fxItems(ops.addEffect(p, 'blur', 1_000_000.6, { durationUs: 2_000_000.4 }).project, 1)[0]
    expect(a).toMatchObject({ startUs: 1_000_001, durationUs: 2_000_000 })
    const b = fxItems(ops.addEffect(p, 'blur', -500, { durationUs: 10 }).project, 1)[0]
    expect(b).toMatchObject({ startUs: 0, durationUs: MIN_ITEM_US })
    const c = ops.addEffect(p, 'solid', 3.7, { trackId: p.tracks[0].id, durationUs: 5 })
    expect(c.project.tracks[0].items[0]).toMatchObject({ startUs: 4, durationUs: MIN_ITEM_US })
  })
  it('addEffect rejeita trackId explícito que não é faixa de vídeo', () => {
    const p = createEmptyProject('t')
    const audio = p.tracks.find((t) => t.kind === 'audio')!
    expect(() => ops.addEffect(p, 'blur', 0, { trackId: audio.id })).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
  it('setItemEnabled grava false e omite o campo ao reativar', () => {
    const p = ops.addEffect(base().p, 'blur', 0).project
    const id = p.tracks[1].items[0].id
    const off = ops.setItemEnabled(p, [id], false)
    expect(off.tracks[1].items[0].enabled).toBe(false)
    const on = ops.setItemEnabled(off, [id], true)
    expect('enabled' in on.tracks[1].items[0]).toBe(false)
    expect(on).toEqual(p)
  })
  it('setAnimValue: sem keys muda o base; animado cria key (tempo absoluto → local)', () => {
    const r = ops.addEffect(base().p, 'blur', 2 * S, { durationUs: 4 * S })
    const a = ops.setAnimValue(r.project, r.itemId, 'strength', 3 * S, 80)
    expect(fxItems(a, 1)[0].strength).toEqual({ value: 80 })
    const k = ops.toggleKeyframe(a, r.itemId, 'strength', 3 * S)
    const b = ops.setAnimValue(k, r.itemId, 'strength', 4 * S, 20)
    expect(fxItems(b, 1)[0].strength.keys).toEqual([{ tUs: S, value: 80, ease: 'linear' }, { tUs: 2 * S, value: 20, ease: 'linear' }])
    expect(() => ops.setAnimValue(r.project, r.itemId, 'transform.x', 3 * S, 1)).toThrow(ops.EditError)
    expect(() => ops.setAnimValue(r.project, r.itemId, 'strength', 7 * S, 1)).toThrow(ops.EditError)
  })
  it('toggleKeyframe adiciona (valor avaliado) e remove em ±meio quadro', () => {
    const r = ops.addEffect(base().p, 'blur', 0, { durationUs: 4 * S })
    const half = Math.floor(1e6 / 30 / 2)
    const a = ops.toggleKeyframe(r.project, r.itemId, 'region.x', S)
    expect(fxItems(a, 1)[0].region.x.keys).toEqual([{ tUs: S, value: 0.5, ease: 'linear' }])
    const b = ops.toggleKeyframe(a, r.itemId, 'region.x', S + half) // dentro da tolerância → remove
    expect(fxItems(b, 1)[0].region.x).toEqual({ value: 0.5 })
    const c = ops.toggleKeyframe(a, r.itemId, 'region.x', S + half + 2000) // fora → adiciona outro
    expect(fxItems(c, 1)[0].region.x.keys).toHaveLength(2)
    const d = ops.setAnimValue(c, r.itemId, 'region.x', 3 * S, 0.9)
    const e = ops.toggleKeyframe(d, r.itemId, 'region.x', 2 * S)
    expect(fxItems(e, 1)[0].region.x.keys!.find((k) => k.tUs === 2 * S)).toBeDefined()
  })
  it('toggleKeyframe/setAnimValue em mídia (transform e audio.volume)', () => {
    const { p, v, a } = base()
    const q = ops.toggleKeyframe(p, v, 'transform.opacity', S)
    expect(items(q, 0)[0].visual!.transform.opacity.keys).toHaveLength(1)
    const w = ops.setAnimValue(p, a, 'audio.volume', 0, 0.5)
    expect(items(w, 1)[0].audio.volume.value).toBe(0.5)
  })
  it('nextKeyframeUs nos dois sentidos, por propriedade e com "any"', () => {
    const r = ops.addEffect(base().p, 'blur', 2 * S, { durationUs: 6 * S })
    let q = ops.toggleKeyframe(r.project, r.itemId, 'strength', 3 * S) // local 1 s
    q = ops.toggleKeyframe(q, r.itemId, 'strength', 6 * S) // local 4 s
    q = ops.toggleKeyframe(q, r.itemId, 'region.x', 5 * S) // local 3 s
    const n = (path: ops.AnimPath | 'any', from: number, dir: 1 | -1) => ops.nextKeyframeUs(q, r.itemId, path, from, dir)
    expect(n('strength', 0, 1)).toBe(3 * S)
    expect(n('strength', 3 * S, 1)).toBe(6 * S)
    expect(n('strength', 6 * S, 1)).toBeNull()
    expect(n('strength', 6 * S, -1)).toBe(3 * S)
    expect(n('strength', 3 * S, -1)).toBeNull()
    expect(n('any', 3 * S, 1)).toBe(5 * S)
    expect(n('any', 7 * S, -1)).toBe(6 * S)
    expect(n('any', 5 * S, -1)).toBe(3 * S)
    expect(n('region.y', 0, 1)).toBeNull()
    expect(ops.nextKeyframeUs(q, 'nope', 'any', 0, 1)).toBeNull()
  })
  it('getAnim devolve null para propriedade inexistente', () => {
    const p = ops.addEffect(base().p, 'blur', 0).project
    const fx = p.tracks[1].items[0] as EffectItem
    expect(ops.getAnim(fx, 'strength')).toBe(fx.strength)
    expect(ops.getAnim(fx, 'audio.volume')).toBeNull()
    expect(ops.getAnim(fx, 'transform.x')).toBeNull()
  })
  it('splitAt/trimItem de EffectItem reparte keys de region.* e strength', () => {
    const r = ops.addEffect(base().p, 'blur', 0, { durationUs: 8 * S })
    let q = r.project
    for (const [path, t, val] of [['strength', 0, 20], ['strength', 8 * S, 100], ['region.x', 0, 0.2], ['region.x', 8 * S, 0.8]] as const) {
      q = ops.toggleKeyframe(q, r.itemId, path, t)
      q = ops.setAnimValue(q, r.itemId, path, t, val)
    }
    const s = ops.splitAt(q, [r.itemId], 4 * S)
    const [l, rt] = fxItems(s, 1)
    expect(l.strength.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 20], [4 * S, 60]])
    expect(rt.strength.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 60], [4 * S, 100]])
    expect(l.region.x.keys!.at(-1)!.tUs).toBe(4 * S); expect(l.region.x.keys!.at(-1)!.value).toBeCloseTo(0.5, 6)
    expect(rt.region.x.keys![0].tUs).toBe(0); expect(rt.region.x.keys![0].value).toBeCloseTo(0.5, 6)
    expect(validateProject(s)).toEqual([])
    const t = ops.trimItem(q, r.itemId, 'end', 4 * S)
    expect(fxItems(t, 1)[0].strength.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 20], [4 * S, 60]])
    expect(validateProject(t)).toEqual([])
  })
})
describe('keyframes (Task 4): grupo, tempos, mover, remover; conversão de efeito', () => {
  const fx0 = (p: Project) => p.tracks[1].items[0] as EffectItem
  const half = Math.floor(1e6 / 30 / 2)
  it('keyframePaths: região no efeito, transformação no vídeo, volume no áudio', () => {
    const { p, v, a } = base()
    const r = ops.addEffect(p, 'blur', 0, { durationUs: 4 * S })
    expect(ops.keyframePaths(fx0(r.project), 'video')).toEqual(['region.x', 'region.y', 'region.w', 'region.h', 'region.rotation'])
    expect(ops.keyframePaths(ops.findItem(p, v)!.item, 'video')).toEqual(['transform.x', 'transform.y', 'transform.scale', 'transform.rotation', 'transform.opacity'])
    expect(ops.keyframePaths(ops.findItem(p, a)!.item, 'audio')).toEqual(['audio.volume'])
  })
  it('toggleKeyframes: adiciona em todas; com algum key no instante remove só os do instante', () => {
    const r = ops.addEffect(base().p, 'blur', S, { durationUs: 4 * S })
    const paths: ops.AnimPath[] = ['region.x', 'region.y']
    const a = ops.toggleKeyframes(r.project, r.itemId, paths, 2 * S)
    expect(fx0(a).region.x.keys).toEqual([{ tUs: S, value: 0.5, ease: 'linear' }])
    expect(fx0(a).region.y.keys).toHaveLength(1)
    // só x tem key a ±meio quadro → remove x e não cria em y
    const b = ops.toggleKeyframe(a, r.itemId, 'region.y', 2 * S)
    const c = ops.toggleKeyframes(b, r.itemId, paths, 2 * S + half)
    expect(fx0(c).region.x).toEqual({ value: 0.5 })
    expect(fx0(c).region.y).toEqual({ value: 0.5 })
    expect(() => ops.toggleKeyframes(r.project, r.itemId, paths, 9 * S)).toThrow(ops.EditError)
  })
  it('keyframeTimesUs: instantes locais de todas as propriedades, ordenados e sem repetição', () => {
    const r = ops.addEffect(base().p, 'blur', S, { durationUs: 4 * S })
    let q = ops.toggleKeyframe(r.project, r.itemId, 'strength', 3 * S)
    q = ops.toggleKeyframe(q, r.itemId, 'region.x', 3 * S)
    q = ops.toggleKeyframe(q, r.itemId, 'region.w', 2 * S)
    expect(ops.keyframeTimesUs(fx0(q))).toEqual([S, 2 * S])
    expect(ops.keyframeTimesUs(fx0(r.project))).toEqual([])
  })
  it('moveKeyframes: move os keys do instante em todas as propriedades, preso ao item', () => {
    const r = ops.addEffect(base().p, 'blur', S, { durationUs: 4 * S })
    let q = ops.toggleKeyframe(r.project, r.itemId, 'strength', 2 * S) // local 1 s
    q = ops.toggleKeyframe(q, r.itemId, 'region.x', 2 * S)
    q = ops.setAnimValue(q, r.itemId, 'region.x', 2 * S, 0.3)
    const m = ops.moveKeyframes(q, r.itemId, S, 1.5 * S)
    expect(fx0(m).strength.keys!.map((k) => k.tUs)).toEqual([1.5 * S])
    expect(fx0(m).region.x.keys).toEqual([{ tUs: 1.5 * S, value: 0.3, ease: 'linear' }])
    expect(fx0(ops.moveKeyframes(q, r.itemId, S, -3 * S)).strength.keys![0].tUs).toBe(0)
    expect(fx0(ops.moveKeyframes(q, r.itemId, S, 99 * S)).strength.keys![0].tUs).toBe(4 * S)
    expect(ops.moveKeyframes(q, r.itemId, S, S)).toBe(q)
    expect(ops.moveKeyframes(q, r.itemId, 3 * S, 2 * S)).toBe(q) // nenhum key em 3 s
  })
  it('moveKeyframes: soltar sobre outro key (±meio quadro) o substitui', () => {
    const r = ops.addEffect(base().p, 'blur', 0, { durationUs: 4 * S })
    let q = ops.toggleKeyframe(r.project, r.itemId, 'strength', S)
    q = ops.setAnimValue(q, r.itemId, 'strength', S, 10)
    q = ops.toggleKeyframe(q, r.itemId, 'strength', 3 * S)
    q = ops.setAnimValue(q, r.itemId, 'strength', 3 * S, 90)
    const m = ops.moveKeyframes(q, r.itemId, S, 3 * S - half)
    expect(fx0(m).strength.keys).toEqual([{ tUs: 3 * S - half, value: 10, ease: 'linear' }])
  })
  it('removeKeyframesAt remove o instante em todas as propriedades', () => {
    const r = ops.addEffect(base().p, 'blur', 0, { durationUs: 4 * S })
    let q = ops.toggleKeyframe(r.project, r.itemId, 'strength', S)
    q = ops.toggleKeyframe(q, r.itemId, 'region.x', S)
    q = ops.toggleKeyframe(q, r.itemId, 'region.x', 2 * S)
    const d = ops.removeKeyframesAt(q, r.itemId, S)
    expect(fx0(d).strength).toEqual({ value: 60 })
    expect(fx0(d).region.x.keys!.map((k) => k.tUs)).toEqual([2 * S])
    expect(ops.removeKeyframesAt(q, r.itemId, 3 * S)).toBe(q)
  })
  it('keyframes em faixa bloqueada são recusados', () => {
    const r = ops.addEffect(base().p, 'blur', 0, { durationUs: 4 * S })
    const q = ops.toggleKeyframe(r.project, r.itemId, 'strength', S)
    const locked = ops.updateTrack(q, q.tracks[1].id, { locked: true })
    expect(() => ops.moveKeyframes(locked, r.itemId, S, 2 * S)).toThrow(ops.EditError)
    expect(() => ops.removeKeyframesAt(locked, r.itemId, S)).toThrow(ops.EditError)
  })
  it('convertEffects troca o tipo; Tarja zera a borda suave (cor exata)', () => {
    const r = ops.addEffect(base().p, 'blur', 0, { durationUs: 4 * S })
    const s = ops.convertEffects(r.project, [r.itemId], 'solid')
    expect(fx0(s)).toMatchObject({ effect: 'solid', feather: 0 })
    const b = ops.convertEffects(s, [r.itemId], 'pixelate')
    expect(fx0(b)).toMatchObject({ effect: 'pixelate', feather: 0 })
    expect(ops.convertEffects(b, [r.itemId], 'pixelate')).toBe(b)
    const { p, v } = base()
    expect(ops.convertEffects(p, [v], 'solid')).toBe(p) // só efeitos
  })
})
describe('Task 4 (revisão): ativar/desativar com vínculo, conversão, keyframePaths', () => {
  const fx0 = (p: Project) => p.tracks[1].items[0] as EffectItem
  it('toggleEnabled: expande os vinculados (cálculo e aplicação); sem vínculo só os dados', () => {
    const { p, v, a } = base()
    const off = ops.toggleEnabled(p, [v], true)
    expect(ops.findItem(off, v)!.item.enabled).toBe(false)
    expect(ops.findItem(off, a)!.item.enabled).toBe(false)
    // só o áudio ainda ativo: algum ativo no grupo → desativa todos (não reativa o vídeo)
    const mixed = ops.setItemEnabled(p, [v], false)
    const all = ops.toggleEnabled(mixed, [v], true)
    expect([v, a].map((id) => ops.findItem(all, id)!.item.enabled)).toEqual([false, false])
    expect(ops.toggleEnabled(off, [a], true)).toEqual(p)
    const alt = ops.toggleEnabled(p, [v], false)
    expect(ops.findItem(alt, v)!.item.enabled).toBe(false)
    expect('enabled' in ops.findItem(alt, a)!.item).toBe(false)
  })
  it('keyframePaths: anotações → nenhum; mídia sem visual em faixa de vídeo → volume', () => {
    const { p, v } = base()
    const ann: Item = { id: 'n', type: 'annotations', sessionId: 's', inUs: 0, startUs: 0, durationUs: S }
    expect(ops.keyframePaths(ann, 'video')).toEqual([])
    const media = ops.findItem(p, v)!.item as MediaItem
    expect(ops.keyframePaths({ ...media, visual: undefined }, 'video')).toEqual(['audio.volume'])
  })
  it('convertEffects: Tarja tira os keys de intensidade; voltar de Tarja usa a borda padrão do tipo; mesmo tipo = nada', () => {
    const r = ops.addEffect(base().p, 'blur', 0, { durationUs: 4 * S })
    const k = ops.toggleKeyframe(ops.toggleKeyframe(r.project, r.itemId, 'strength', 0), r.itemId, 'strength', 2 * S)
    const s = ops.convertEffects(k, [r.itemId], 'solid')
    expect(fx0(s).strength).toEqual({ value: 60 })
    expect(ops.convertEffects(s, [r.itemId], 'solid')).toBe(s)
    expect(fx0(ops.convertEffects(s, [r.itemId], 'blur')).feather).toBe(0.15)
    expect(fx0(ops.convertEffects(s, [r.itemId], 'pixelate')).feather).toBe(0)
    const withFeather = ops.updateItem<EffectItem>(r.project, r.itemId, (d) => { d.feather = 0.5 })
    expect(fx0(ops.convertEffects(withFeather, [r.itemId], 'pixelate')).feather).toBe(0.5) // fora da Tarja mantém
  })
})
