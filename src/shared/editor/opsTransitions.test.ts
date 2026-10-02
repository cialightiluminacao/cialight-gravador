import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject, defaultVisual } from './factory'
import type { Asset, EffectItem, Item, MediaItem, Project, TextItem, Transition } from './project'
import * as ops from './ops'
import { parseProject, toDiskProject, validateProject } from './schema'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { DEFAULT_TRANSITION_US, MIN_TRANSITION_US } from './transitions'

const S = 1_000_000
const vid = (id: string, dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
const text = (id: string, startUs: number, durationUs: number, transitionIn?: Transition): TextItem => ({
  id, type: 'text', startUs, durationUs, text: 'Olá', visual: defaultVisual(),
  style: { font: 'Inter', size: { value: 48 }, weight: 400, color: '#ffffff', align: 'center', lineHeight: 1.2 },
  ...(transitionIn ? { transitionIn } : {})
})

/** V1: [A 0–aDur][B aDur–aDur+bDur] (vídeos com áudio vinculado em A1). */
function pair(aDur = 4 * S, bDur = 4 * S): { p: Project; a: string; b: string; aa: string; ab: string } {
  let p = ops.addAsset(ops.addAsset(createEmptyProject('t'), vid('a', aDur)), vid('b', bDur))
  const ra = ops.addMediaFromAsset(p, 'a', 0)
  const rb = ops.addMediaFromAsset(ra.project, 'b', aDur)
  p = rb.project
  return { p, a: ra.itemIds[0], b: rb.itemIds[0], aa: ra.itemIds[1], ab: rb.itemIds[1] }
}
/** Par com transição de `d` em B. */
function withTr(d = S, aDur = 4 * S, bDur = 4 * S): ReturnType<typeof pair> {
  const r = pair(aDur, bDur)
  return { ...r, p: ops.addTransition(r.p, r.b, 'crossfade', d) }
}
const item = (p: Project, id: string): Item => ops.findItem(p, id)!.item
const tr = (p: Project, id: string): Transition | undefined => (item(p, id) as MediaItem).transitionIn
const vItems = (p: Project): MediaItem[] => p.tracks[0].items as MediaItem[]
const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return `${(e as ops.EditError).code}: ${(e as Error).message}` }
  return 'ok'
}

describe('addTransition / removeTransition / setTransitionDuration', () => {
  it('grava em B; padrão 500 ms; substituir é a mesma operação', () => {
    const { p, a, b } = pair()
    const q = ops.addTransition(p, b, 'dipBlack')
    expect(tr(q, b)).toEqual({ kind: 'dipBlack', durationUs: DEFAULT_TRANSITION_US })
    expect(tr(q, a)).toBeUndefined()
    const r = ops.addTransition(q, b, 'wipeL', 2 * S)
    expect(tr(r, b)).toEqual({ kind: 'wipeL', durationUs: 2 * S })
    expect(validateProject(r)).toEqual([])
  })
  it('limita ao máximo floor(min/2) e ao mínimo; arredonda para µs inteiro', () => {
    const { p, b } = pair(4 * S, 600_001)
    expect(tr(ops.addTransition(p, b, 'crossfade'), b)!.durationUs).toBe(300_000)
    expect(tr(ops.addTransition(p, b, 'crossfade', 5 * S), b)!.durationUs).toBe(300_000)
    expect(tr(ops.addTransition(p, b, 'crossfade', 10), b)!.durationUs).toBe(MIN_TRANSITION_US)
    expect(tr(ops.addTransition(p, b, 'crossfade', 150_000.6), b)!.durationUs).toBe(150_001)
  })
  it('recusa: sem anterior, vão de 1 µs, faixa de áudio, efeito, desativado, curto demais, bloqueada', () => {
    const { p, a, b, ab } = pair()
    expect(code(() => ops.addTransition(p, a, 'crossfade'))).toBe('invalid: Transição só entre dois clipes encostados na mesma faixa')
    const gap = ops.moveItems(p, [b], 1)
    expect(code(() => ops.addTransition(gap, b, 'crossfade'))).toBe('invalid: Transição só entre dois clipes encostados na mesma faixa')
    expect(code(() => ops.addTransition(p, ab, 'crossfade'))).toMatch(/^invalid: Transição só entre clipes de faixas de vídeo/)
    expect(code(() => ops.addTransition(ops.setItemEnabled(p, [a], false), b, 'crossfade'))).toMatch(/^invalid: Transição só entre clipes ativos/)
    expect(code(() => ops.addTransition(ops.setItemEnabled(p, [b], false), b, 'crossfade'))).toMatch(/^invalid: Transição só entre clipes ativos/)
    const short = pair(150_000, 4 * S)
    expect(code(() => ops.addTransition(short.p, short.b, 'crossfade'))).toBe('invalid: Clipes curtos demais para a transição')
    const locked = ops.updateTrack(p, p.tracks[0].id, { locked: true })
    expect(code(() => ops.addTransition(locked, b, 'crossfade'))).toMatch(/^locked:/)
    // efeito encostado num clipe (mesma faixa de vídeo): não participa
    const fx: EffectItem = { ...createEffectItem('blur', 8 * S, 2 * S), id: 'fx' }
    const c: MediaItem = { ...(item(p, b) as MediaItem), id: 'c', startUs: 10 * S }
    delete c.linkId
    const withFx: Project = { ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, items: [...t.items, fx, c] } : t)) }
    expect(code(() => ops.addTransition(withFx, 'c', 'crossfade'))).toBe('invalid: Transição só entre clipes de vídeo, imagem ou texto')
    expect(code(() => ops.addTransition(withFx, 'fx', 'crossfade'))).toMatch(/^invalid/)
  })
  it('texto ↔ mídia participa', () => {
    const { p, b } = pair()
    const q = { ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, items: [...t.items, text('t1', 8 * S, 2 * S)] } : t)) }
    const r = ops.addTransition(q, 't1', 'slideL', S)
    expect((item(r, 't1') as TextItem).transitionIn).toEqual({ kind: 'slideL', durationUs: S })
    expect(tr(r, b)).toBeUndefined()
  })
  it('removeTransition e setTransitionDuration (limitado a [MIN, máx])', () => {
    const { p, b } = withTr(S)
    expect(tr(ops.removeTransition(p, b), b)).toBeUndefined()
    const none = ops.removeTransition(p, b)
    expect(ops.removeTransition(none, b)).toBe(none)
    expect(tr(ops.setTransitionDuration(p, b, 1_500_000), b)!.durationUs).toBe(1_500_000)
    expect(tr(ops.setTransitionDuration(p, b, 9 * S), b)!.durationUs).toBe(2 * S)
    expect(tr(ops.setTransitionDuration(p, b, 1), b)!.durationUs).toBe(MIN_TRANSITION_US)
    expect(code(() => ops.setTransitionDuration(pair().p, pair().b, S))).toMatch(/^(invalid|notFound)/)
    const locked = ops.updateTrack(p, p.tracks[0].id, { locked: true })
    expect(code(() => ops.removeTransition(locked, b))).toMatch(/^locked:/)
    expect(code(() => ops.setTransitionDuration(locked, b, S))).toMatch(/^locked:/)
  })
})

describe('normalização das transições em toda edição', () => {
  it('split dentro de A: o pedaço da direita vira o anterior; limita ao novo máximo', () => {
    const { p, b } = withTr(S)
    const q = ops.splitAt(p, [vItems(p)[0].id], 3_600_000)
    expect(tr(q, b)).toEqual({ kind: 'crossfade', durationUs: 200_000 })
    expect(validateProject(q)).toEqual([])
  })
  it('split dentro de B: o pedaço da esquerda mantém (limitado); o da direita não tem transição', () => {
    const { p, b } = withTr(S)
    const q = ops.splitAt(p, [b], 4_300_000)
    expect(tr(q, b)).toEqual({ kind: 'crossfade', durationUs: 150_000 })
    expect(vItems(q)[2].transitionIn).toBeUndefined()
    // pedaço curto demais (máximo < MIN): sai
    expect(tr(ops.splitAt(p, [b], 4_150_000), b)).toBeUndefined()
  })
  it('trim do fim de A: encolher abre vão e remove; com ripple continua encostado e mantém (limitado)', () => {
    const { p, a, b } = withTr(S)
    expect(tr(ops.trimItem(p, a, 'end', 3 * S), b)).toBeUndefined()
    const r = ops.trimItem(p, a, 'end', 1_500_000, { ripple: true })
    expect(item(r, b).startUs).toBe(1_500_000)
    expect(tr(r, b)).toEqual({ kind: 'crossfade', durationUs: 750_000 })
  })
  it('trim do início de B: sem ripple abre vão e remove; com ripple mantém', () => {
    const { p, b } = withTr(S)
    expect(tr(ops.trimItem(p, b, 'start', 5 * S), b)).toBeUndefined()
    const r = ops.trimItem(p, b, 'start', 5 * S, { ripple: true })
    expect(item(r, b).startUs).toBe(4 * S)
    expect(tr(r, b)).toEqual({ kind: 'crossfade', durationUs: S })
  })
  it('mover B para longe remove; voltar não recria (cada op é um passo)', () => {
    const { p, b } = withTr(S)
    const away = ops.moveItems(p, [b], 2 * S)
    expect(tr(away, b)).toBeUndefined()
    expect(tr(ops.moveItems(away, [b], -2 * S), b)).toBeUndefined()
    // mover A e B juntos mantém
    expect(tr(ops.moveItems(p, [vItems(p)[0].id, b], 2 * S), b)).toEqual({ kind: 'crossfade', durationUs: S })
  })
  it('deleteRanges que corta A mantém (B encosta no pedaço da direita de A; limita); corte que atravessa o corte remove', () => {
    const { p, b } = withTr(S)
    const q = ops.deleteRanges(p, [{ fromUs: S, toUs: 2_500_000 }])
    expect(item(q, b).startUs).toBe(2_500_000)
    // anterior agora = pedaço [1 s, 2,5 s) de A (1,5 s) → máximo 750 ms
    expect(tr(q, b)).toEqual({ kind: 'crossfade', durationUs: 750_000 })
    expect(tr(ops.deleteRanges(p, [{ fromUs: 0, toUs: S }]), b)).toEqual({ kind: 'crossfade', durationUs: S })
    const r = ops.deleteRanges(p, [{ fromUs: 3_500_000, toUs: 4_500_000 }])
    expect(vItems(r).every((i) => !i.transitionIn)).toBe(true)
  })
  it('setSpeed que encurta B limita ao máximo; desacelerar não estica a transição', () => {
    const { p, b } = withTr(1_500_000)
    expect(tr(ops.setSpeed(p, b, 4), b)).toEqual({ kind: 'crossfade', durationUs: 500_000 })
    expect(tr(ops.setSpeed(p, b, 0.5), b)).toEqual({ kind: 'crossfade', durationUs: 1_500_000 })
    // acelerar A abre vão (sem ripple ao encolher): remove
    expect(tr(ops.setSpeed(p, vItems(p)[0].id, 2), b)).toBeUndefined()
  })
  it('freezeFrameAt dentro de A: o resto de A e B andam juntos; mantém', () => {
    const { p, a, b } = withTr(S)
    const q = ops.freezeFrameAt(p, a, 2 * S, S)
    expect(item(q, b).startUs).toBe(5 * S)
    expect(tr(q, b)).toEqual({ kind: 'crossfade', durationUs: S })
    expect(validateProject(q)).toEqual([])
  })
  it('deleteItems com ripple: torna outro par encostado mas NÃO cria transição; o B sem anterior perde a sua', () => {
    const { p, a, b } = withTr(S)
    let q = ops.addAsset(p, vid('c', 4 * S))
    const rc = ops.addMediaFromAsset(q, 'c', 8 * S)
    q = rc.project
    const c = rc.itemIds[0]
    const r = ops.deleteItems(q, [b], { ripple: true })
    expect(item(r, c).startUs).toBe(4 * S)
    expect(tr(r, c)).toBeUndefined()
    expect(tr(ops.deleteItems(q, [a], { ripple: true }), b)).toBeUndefined()
  })
  it('duplicate: cópia encostada em B fica com a transição de B→cópia; cópia longe não herda', () => {
    const { p, b } = withTr(S)
    const near = ops.duplicateItems(p, [b])
    expect(tr(near.project, near.itemIds[0])).toEqual({ kind: 'crossfade', durationUs: S })
    const far = ops.duplicateItems(p, [b], 20 * S)
    expect(tr(far.project, far.itemIds[0])).toBeUndefined()
    expect(tr(far.project, b)).toEqual({ kind: 'crossfade', durationUs: S })
  })
  it('desativar A remove a transição de B', () => {
    const { p, a, b } = withTr(S)
    expect(tr(ops.setItemEnabled(p, [a], false), b)).toBeUndefined()
  })
  it('não mexe em faixa bloqueada nem em faixas que a op não tocou', () => {
    const { p, a, b } = withTr(S)
    // V2 bloqueada com transição inválida (vão) gravada fora do editor
    const bad: Project = {
      ...p,
      tracks: [...p.tracks, { id: 'v2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: true, volume: 1, items: [text('x', 0, S), text('y', 2 * S, S, { kind: 'crossfade', durationUs: 200_000 })] }]
    }
    const q = ops.trimItem(bad, a, 'end', 3 * S)
    expect(tr(q, b)).toBeUndefined()
    expect(q.tracks[2]).toBe(bad.tracks[2])
    // desbloqueada mas não tocada pela op: também fica igual
    const unl = { ...bad, tracks: bad.tracks.map((t) => (t.id === 'v2' ? { ...t, locked: false } : t)) }
    const r = ops.trimItem(unl, a, 'end', 3 * S)
    expect(r.tracks[2]).toBe(unl.tracks[2])
    // uma edição na própria faixa normaliza
    expect((item(ops.updateItem<TextItem>(unl, 'x', (d) => { d.name = 'n' }), 'y') as TextItem).transitionIn).toBeUndefined()
  })
  it('edição que não muda nada devolve o mesmo projeto', () => {
    const { p, b } = withTr(S)
    expect(ops.moveItems(p, [b], 0)).toBe(p)
  })
})

describe('validateProject e compatibilidade com a v1.3', () => {
  it('reporta transição sem anterior encostado, abaixo do mínimo e acima do máximo', () => {
    const { p, b } = withTr(S)
    expect(validateProject(p)).toEqual([])
    const set = (t: Transition): Project => ({ ...p, tracks: p.tracks.map((x, i) => (i === 0 ? { ...x, items: x.items.map((it) => (it.id === b ? { ...it, transitionIn: t } as Item : it)) } : x)) })
    expect(validateProject(set({ kind: 'crossfade', durationUs: 50_000 })).join()).toMatch(/transição/i)
    expect(validateProject(set({ kind: 'crossfade', durationUs: 2 * S + 1 })).join()).toMatch(/transição/i)
    const gap = { ...p, tracks: p.tracks.map((x, i) => (i === 0 ? { ...x, items: x.items.map((it) => (it.id === b ? { ...it, startUs: it.startUs + 1 } : it)) } : x)) }
    expect(validateProject(gap).join()).toMatch(/transição/i)
  })
  it('transições em mídia e texto: a v1.3 lê o arquivo e o parse novo volta ao mesmo projeto', () => {
    const { p } = withTr(S)
    const q = ops.addTransition({ ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, items: [...t.items, text('t1', 8 * S, 2 * S)] } : t)) }, 't1', 'blur', 700_001)
    expect(validateProject(q)).toEqual([])
    const disk = JSON.parse(JSON.stringify(toDiskProject(q)))
    expect(parseProjectV13(disk).success).toBe(true)
    expect(parseProject(toDiskProject(q))).toEqual(q)
  })
})
