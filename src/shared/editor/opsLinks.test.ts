import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, EffectItem, Item, MediaItem, Project } from './project'
import * as ops from './ops'
import { validateProject } from './schema'
import { itemEndUs as end } from './time'

// Efeitos vinculados ao clipe sobre o qual foram criados (revisão final F2, I3) e regras de faixa (I2, M6).
const S = 1_000_000
const vid = (id = 'a1', dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
/** Clipe v [0,10 s) na "Vídeo 1" + áudio a vinculado. */
function base(): { p: Project; v: string; a: string } {
  const p = ops.addAsset(createEmptyProject('t'), vid())
  const r = ops.addMediaFromAsset(p, 'a1', 0)
  return { p: r.project, v: r.itemIds[0], a: r.itemIds[1] }
}
const it_ = (p: Project, id: string): Item => ops.findItem(p, id)!.item
const fx = (p: Project, id: string): EffectItem => it_(p, id) as EffectItem
/** base + "Esconder texto" em 2 s (até o fim do clipe) com keys de region.x no início e no fim. */
function linked(): { p: Project; v: string; a: string; f: string } {
  const b = base()
  const r = ops.addEffect(b.p, 'blurText', 2 * S)
  let p = ops.toggleKeyframe(r.project, r.itemId, 'region.x', 2 * S)
  p = ops.toggleKeyframe(p, r.itemId, 'region.x', 10 * S)
  p = ops.setAnimValue(p, r.itemId, 'region.x', 10 * S, 0.9)
  return { p, v: b.v, a: b.a, f: r.itemId }
}

describe('efeitos vinculados ao clipe (seguem as edições do clipe)', () => {
  it('addEffect sobre um clipe vincula o efeito ao clipe e ao áudio dele; sem clipe, sem vínculo', () => {
    const { p, v, a, f } = linked()
    expect(fx(p, f).linkId).toBeDefined()
    expect([it_(p, v).linkId, it_(p, a).linkId]).toEqual([fx(p, f).linkId, fx(p, f).linkId])
    expect(ops.linkedIds(p, v)).toEqual(expect.arrayContaining([v, a, f]))
    expect(ops.linkedIds(p, f)).toEqual([f]) // a partir do efeito, só ele
    const empty = ops.addEffect(createEmptyProject('t'), 'blur', 0)
    expect(fx(empty.project, empty.itemId).linkId).toBeUndefined()
    // região desenhada (addEffect com região) também vincula; depois do fim do clipe não
    const drawn = ops.addEffect(base().p, 'blur', S, { region: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } })
    expect(fx(drawn.project, drawn.itemId).linkId).toBeDefined()
    const after = ops.addEffect(base().p, 'blur', 12 * S)
    expect(fx(after.project, after.itemId).linkId).toBeUndefined()
    expect(validateProject(p)).toEqual([])
  })
  it('mover o clipe move o efeito; mover o efeito não move o clipe', () => {
    const { p, v, f } = linked()
    const q = ops.moveItems(p, [v], 3 * S)
    expect([it_(q, v).startUs, fx(q, f).startUs]).toEqual([3 * S, 5 * S])
    const r = ops.moveItems(p, [f], S)
    expect([it_(r, v).startUs, fx(r, f).startUs]).toEqual([0, 3 * S])
    expect(fx(r, f).linkId).toBe(it_(r, v).linkId) // o vínculo continua
  })
  it('aparar: a borda alinhada do efeito acompanha (encolher e estender); efeito no meio fica', () => {
    const { p, v, f } = linked()
    const short = ops.trimItem(p, v, 'end', 6 * S)
    expect([end(it_(short, v)), fx(short, f).startUs, end(fx(short, f))]).toEqual([6 * S, 2 * S, 6 * S])
    expect(fx(short, f).region.x.keys!.at(-1)!.tUs).toBe(4 * S) // keys repartidos na nova borda
    const back = ops.trimItem(short, v, 'end', 9 * S)
    expect(end(fx(back, f))).toBe(9 * S)
    // efeito que termina antes do fim do clipe não é alinhado: fica onde está
    const mid = ops.addEffect(base().p, 'blur', 2 * S, { durationUs: 2 * S })
    const v2 = mid.project.tracks[0].items[0].id
    const t = ops.trimItem(mid.project, v2, 'end', 6 * S)
    expect([fx(t, mid.itemId).startUs, fx(t, mid.itemId).durationUs]).toEqual([2 * S, 2 * S])
    // pelo início: efeito que começa junto com o clipe acompanha
    const st = ops.addEffect(base().p, 'blur', 0)
    const v3 = st.project.tracks[0].items[0].id
    const s2 = ops.trimItem(st.project, v3, 'start', S)
    expect([it_(s2, v3).startUs, fx(s2, st.itemId).startUs, end(fx(s2, st.itemId))]).toEqual([S, S, 10 * S])
    expect(validateProject(s2)).toEqual([])
  })
  it('ripple: efeito vinculado anda com o clipe, mesmo começando antes do pivô (antes ficava parado)', () => {
    let { p } = base()
    const r2 = ops.addMediaFromAsset(p, 'a1', 10 * S)
    p = r2.project
    const v1 = p.tracks[0].items[0].id
    const v2 = r2.itemIds[0]
    const e = ops.addEffect(p, 'blurText', 10 * S) // [10,20) vinculado a v2
    // o usuário puxou o efeito 3 s para trás: agora cruza o fim de v1 (e o pivô do ripple)
    const moved = ops.moveItems(e.project, [e.itemId], -3 * S)
    expect(fx(moved, e.itemId).startUs).toBe(7 * S)
    const q = ops.trimItem(moved, v1, 'end', 8 * S, { ripple: true })
    expect([it_(q, v2).startUs, fx(q, e.itemId).startUs]).toEqual([8 * S, 5 * S])
    expect(validateProject(q)).toEqual([])
  })
  it('ripple pelo início: efeito no meio do clipe anda com o conteúdo', () => {
    const b = base()
    const e = ops.addEffect(b.p, 'blur', 4 * S, { durationUs: 2 * S })
    const q = ops.trimItem(e.project, b.v, 'start', 2 * S, { ripple: true })
    expect([it_(q, b.v).startUs, it_(q, b.v).durationUs]).toEqual([0, 8 * S])
    expect([fx(q, e.itemId).startUs, fx(q, e.itemId).durationUs]).toEqual([2 * S, 2 * S])
  })
  it('dividir o clipe divide o efeito; cada pedaço fica com o seu lado; dividir só o efeito mantém o vínculo', () => {
    const { p, v, f } = linked()
    const q = ops.splitAt(p, [v], 5 * S)
    const fxs = q.tracks[1].items as EffectItem[]
    const vs = q.tracks[0].items
    expect(fxs.map((i) => [i.startUs, i.durationUs])).toEqual([[2 * S, 3 * S], [5 * S, 5 * S]])
    expect(fxs[0].linkId).toBe(vs[0].linkId)
    expect(fxs[1].linkId).toBe(vs[1].linkId)
    expect(vs[0].linkId).not.toBe(vs[1].linkId)
    const only = ops.splitAt(p, [f], 6 * S)
    expect(only.tracks[1].items).toHaveLength(2)
    expect(only.tracks[1].items.every((i) => i.linkId === it_(only, v).linkId)).toBe(true)
    expect(validateProject(q)).toEqual([])
  })
  it('apagar o clipe apaga o efeito; apagar o efeito mantém o clipe (e o vínculo com o áudio)', () => {
    const { p, v, a, f } = linked()
    expect(ops.findItem(ops.deleteItems(p, [v]), f)).toBeNull()
    const r = ops.deleteItems(p, [f])
    expect(ops.findItem(r, v)).not.toBeNull()
    expect(it_(r, v).linkId).toBe(it_(r, a).linkId)
  })
  it('duplicar o clipe duplica o efeito, vinculado à cópia', () => {
    const { p, v } = linked()
    const r = ops.duplicateItems(p, [v])
    expect(r.itemIds).toHaveLength(3)
    const copies = r.itemIds.map((id) => it_(r.project, id))
    const cfx = copies.find((i) => i.type === 'effect')!
    expect(cfx.startUs).toBe(12 * S)
    expect(new Set(copies.map((i) => i.linkId)).size).toBe(1)
    expect(cfx.linkId).not.toBe(it_(p, v).linkId)
  })
  it('velocidade 0,5 no clipe: o efeito escala início, duração e keyframes pela mesma razão (cobre o clipe inteiro)', () => {
    const { p, v, f } = linked()
    const k = ops.toggleKeyframe(p, f, 'region.x', 5 * S) // local 3 s
    const q = ops.setSpeed(k, v, 0.5)
    expect([it_(q, v).startUs, end(it_(q, v))]).toEqual([0, 20 * S])
    expect([fx(q, f).startUs, end(fx(q, f))]).toEqual([4 * S, 20 * S])
    expect(fx(q, f).region.x.keys!.map((x) => x.tUs)).toEqual([0, 6 * S, 16 * S])
    expect(validateProject(q)).toEqual([])
    const fast = ops.setSpeed(p, v, 2)
    expect([fx(fast, f).startUs, end(fx(fast, f))]).toEqual([S, 5 * S])
  })
  it('velocidade com colisão: o efeito do clipe seguinte anda com ele', () => {
    const b = base()
    const r2 = ops.addMediaFromAsset(b.p, 'a1', 10 * S)
    const e = ops.addEffect(r2.project, 'blur', 10 * S)
    const q = ops.setSpeed(e.project, b.v, 0.5)
    expect([it_(q, r2.itemIds[0]).startUs, fx(q, e.itemId).startUs]).toEqual([20 * S, 20 * S])
    expect(validateProject(q)).toEqual([])
  })
  it('desvincular devolve o comportamento livre; desativar o clipe não desliga o efeito', () => {
    const { p, v, f } = linked()
    const free = ops.unlinkItems(p, [f])
    expect(fx(free, f).linkId).toBeUndefined()
    expect(fx(ops.moveItems(free, [v], 3 * S), f).startUs).toBe(2 * S)
    const off = ops.toggleEnabled(p, [v], true)
    expect(it_(off, v).enabled).toBe(false)
    expect('enabled' in fx(off, f)).toBe(false)
    expect(ops.enableGroupIds(p, [v], true)).not.toContain(f)
  })
  it('fechar vãos na faixa de efeitos não arrasta o clipe', () => {
    const b = base()
    const e = ops.addEffect(b.p, 'blur', 3 * S)
    const q = ops.closeGaps(e.project, e.project.tracks[1].id)
    expect([fx(q, e.itemId).startUs, it_(q, b.v).startUs]).toEqual([0, 0])
  })
  it('separar o áudio de um vídeo vinculado só a efeitos: separa e mantém o efeito no grupo', () => {
    const b = base()
    let p = ops.deleteItems(ops.unlinkItems(b.p, [b.v, b.a]), [b.a])
    p = ops.updateItem<MediaItem>(p, b.v, (d) => { d.audio.enabled = true })
    const e = ops.addEffect(p, 'blur', 0)
    const q = ops.detachAudio(e.project, b.v)
    const audio = q.tracks.find((t) => t.kind === 'audio')!.items[0]
    expect(audio.linkId).toBe(it_(q, b.v).linkId)
    expect(fx(q, e.itemId).linkId).toBe(it_(q, b.v).linkId)
  })
})

describe('faixas: mídia nunca por cima dos efeitos; fim do conteúdo', () => {
  it('importar com a faixa de vídeo ocupada cria a faixa nova abaixo de "Efeitos"; "Efeitos 2" vai ao topo', () => {
    const b = base()
    const e = ops.addEffect(b.p, 'blur', 0)
    const r = ops.addMediaFromAsset(e.project, 'a1', 2 * S)
    expect(r.project.tracks.map((t) => t.name)).toEqual(['Vídeo 1', 'Vídeo 2', 'Efeitos', 'Áudio 1', 'Áudio 2'])
    // faixa "Efeitos" livre no intervalo não recebe mídia
    const late = ops.addMediaFromAsset(e.project, 'a1', 12 * S)
    expect(late.project.tracks.find((t) => t.name === 'Efeitos')!.items.every((i) => i.type === 'effect')).toBe(true)
    const e2 = ops.addEffect(r.project, 'blur', 0)
    expect(e2.project.tracks.filter((t) => t.kind === 'video').map((t) => t.name)).toEqual(['Vídeo 1', 'Vídeo 2', 'Efeitos', 'Efeitos 2'])
  })
  it('effectTrackAllowed: recusa faixa oculta, bloqueada e faixa abaixo de mídia visível no intervalo', () => {
    let p = ops.addAsset(createEmptyProject('t'), vid())
    const lower = p.tracks[0].id
    const up = ops.addTrack(p, 'video')
    p = ops.addMediaFromAsset(up.project, 'a1', 0, { videoTrackId: up.trackId }).project
    expect(ops.effectTrackAllowed(p, lower, 0, 2 * S)).toBe(false) // mídia por cima
    expect(ops.effectTrackAllowed(p, lower, 11 * S, 12 * S)).toBe(true)
    expect(ops.effectTrackAllowed(ops.updateTrack(p, up.trackId, { hidden: true }), lower, 0, 2 * S)).toBe(true) // a de cima não aparece
    expect(ops.effectTrackAllowed(ops.updateTrack(p, lower, { hidden: true }), lower, 11 * S, 12 * S)).toBe(false)
    expect(ops.effectTrackAllowed(ops.updateTrack(p, lower, { locked: true }), lower, 11 * S, 12 * S)).toBe(false)
    // explícito numa faixa abaixo da mídia: cai na faixa "Efeitos" do topo
    const r = ops.addEffect(p, 'blur', 0, { trackId: lower })
    expect(ops.findItem(r.project, r.itemId)!.track.name).toBe('Efeitos')
  })
  it('contentEndUs ignora efeitos e itens desativados', () => {
    const b = base()
    const e = ops.addEffect(b.p, 'blur', 12 * S)
    expect(ops.projectDurationUs(e.project)).toBe(17 * S)
    expect(ops.contentEndUs(e.project)).toBe(10 * S)
    const r2 = ops.addMediaFromAsset(b.p, 'a1', 10 * S)
    expect(ops.contentEndUs(ops.setItemEnabled(r2.project, r2.itemIds, false))).toBe(10 * S)
  })
})
