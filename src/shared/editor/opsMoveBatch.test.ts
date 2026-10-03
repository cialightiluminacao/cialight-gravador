import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { addAsset, addMediaFromAsset, deleteItems, linkItems, moveItems, splitAt, trimItem } from './ops'
import type { Asset, EffectItem, Item, Project, Track } from './project'

// Revisão da Task 4 do G3 (otimização do moveItems/relocateFollowers para centenas de efeitos vinculados): edições sobre
// um projeto saído de outra edição (itens congelados pelo immer) seguem escrevendo no lugar sem TypeError, e a
// colocação dos seguidores que competem pela mesma vaga é a de antes (ordem de `ids`). Os resultados esperados foram
// gerados com o ops.ts de antes da otimização (873c1c8).

const S = 1_000_000
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'aac' }, status: 'ready' }

/** Três clipes (vídeo + áudio vinculados) em 0, 10 e 20 s — cada um por uma edição: tudo congelado. */
function three(): { p: Project; ids: string[]; lab: Map<string, string> } {
  let p = addAsset(createEmptyProject('t'), vid)
  const lab = new Map<string, string>()
  const ids: string[] = []
  ;[0, 10 * S, 20 * S].forEach((at, k) => {
    const r = addMediaFromAsset(p, 'v', at)
    p = r.project
    r.itemIds.forEach((id, j) => lab.set(id, `${j ? 'a' : 'v'}${k}`))
    ids.push(r.itemIds[0])
  })
  return { p, ids, lab }
}
const shape = (q: Project, lab: Map<string, string>): string[] => q.tracks.map((t) => t.items.map((i) => `${lab.get(i.id) ?? '?'}@${i.startUs / S}+${i.durationUs / S}`).join(' '))

describe('edições sobre projeto congelado (resultado igual ao de antes da otimização)', () => {
  const cases: [string, (p: Project, ids: string[]) => Project, string[]][] = [
    ['mover inserindo (makeRoom escreve no vizinho)', (p, ids) => moveItems(p, [ids[0]], 20 * S, { mode: 'insert' }), ['v1@10+10 v0@20+10 v2@30+10', 'a1@10+10 a0@20+10 a2@30+10']],
    ['mover sobrescrevendo (recorta os vizinhos)', (p, ids) => moveItems(p, [ids[0]], 15 * S, { mode: 'overwrite' }), ['v1@10+5 v0@15+10 v2@25+5', 'a1@10+5 a0@15+10 a2@25+5']],
    ['aparar com ripple', (p, ids) => trimItem(p, ids[1], 'end', 15 * S, { ripple: true }), ['v0@0+10 v1@10+5 v2@15+10', 'a0@0+10 a1@10+5 a2@15+10']],
    ['apagar com ripple', (p, ids) => deleteItems(p, [ids[1]], { ripple: true }), ['v0@0+10 v2@10+10', 'a0@0+10 a2@10+10']],
    ['dividir tudo', (p) => splitAt(p, 'all', 15 * S), ['v0@0+10 v1@10+5 ?@15+5 v2@20+10', 'a0@0+10 a1@10+5 ?@15+5 a2@20+10']]
  ]
  for (const [name, op, want] of cases) {
    it(name, () => {
      const { p, ids, lab } = three()
      expect(Object.isFrozen(p.tracks[0].items[1])).toBe(true)
      expect(shape(op(p, ids), lab)).toEqual(want)
    })
  }
  it('mover inserindo duas vezes seguidas e com o grupo religado (linkItems) também escreve no lugar', () => {
    const { p, ids, lab } = three()
    const q = moveItems(moveItems(linkItems(p, [ids[1], ids[2]]), [ids[0]], 20 * S, { mode: 'insert' }), [ids[1]], 5 * S, { mode: 'insert' })
    expect(shape(q, lab).length).toBe(2)
  })
})

describe('seguidores que competem pela mesma vaga: na ordem de ids (como antes)', () => {
  const tr = (id: string, items: Item[], fx = false): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, ...(fx ? { role: 'effects' as const } : {}), items })
  const fx = (id: string, s: number, d: number, link?: string): EffectItem => ({ ...createEffectItem('blur', s, d), id, ...(link ? { linkId: link } : {}) })
  /** A em 0–4 s com F1 (T1) e F2 (T3) vinculados; mover 4 s faz os dois baterem em E1/E3; T2 vazia só cabe um. */
  function scene(): Project {
    const p = createEmptyProject('t')
    p.assets = [vid]
    p.tracks = [tr('tv', [{ ...createMediaItem(vid, 0, 'video'), id: 'A', durationUs: 4 * S, linkId: 'L' }]), tr('T1', [fx('F1', 0, 3 * S, 'L'), fx('E1', 5 * S, 2 * S)], true), tr('T2', [], true), tr('T3', [fx('F2', 1 * S, 3 * S, 'L'), fx('E3', 6 * S, 2 * S)], true)]
    return p
  }
  const where = (q: Project): Record<string, string> => Object.fromEntries(q.tracks.flatMap((t) => t.items.filter((i) => i.id.startsWith('F')).map((i) => [i.id, t.id === 'T2' ? 'T2' : t.role === 'effects' && !['T1', 'T3'].includes(t.id) ? 'nova' : t.id])))
  it.each([
    [['F2', 'A'], { F2: 'T2', F1: 'nova' }],
    [['A'], { F1: 'T2', F2: 'nova' }],
    [['F1', 'F2', 'A'], { F1: 'T2', F2: 'nova' }]
  ] as const)('mover %j', (ids, want) => {
    expect(where(moveItems(scene(), [...ids], 4 * S))).toEqual(want)
  })
})
