import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import type { AnnotationsItem, Asset, Item, Project, Track } from './project'
import { MIN_ITEM_US } from './project'
import * as ops from './ops'

// deleteRanges (vários cortes numa edição) = deleteRange do último intervalo para o primeiro, em projetos aleatórios.

const S = 1_000_000
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const asset = (id: string, kind: 'video' | 'audio'): Asset => ({
  id, name: id, kind, source: { type: 'file', path: `C:/${id}`, size: 1, mtimeMs: 1 }, durationUs: 600 * S, status: 'ready',
  audio: { channels: 2, sampleRate: 48000, codec: 'aac' },
  ...(kind === 'video' ? { video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0 as const, decodable: true, gopUs: S } } : {})
})

function randomProject(r: () => number): Project {
  const int = (a: number, b: number): number => Math.floor(a + r() * (b - a))
  const links = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']
  const kinds: { kind: 'video' | 'audio'; make: 'video' | 'audio' | 'ann' | 'fx'; role?: Track['role'] }[] = [
    { kind: 'video', make: 'video' }, { kind: 'video', make: 'video' }, { kind: 'video', make: 'ann' },
    { kind: 'video', make: 'fx', role: 'effects' }, { kind: 'audio', make: 'audio', role: 'voice' }, { kind: 'audio', make: 'audio', role: 'music' }
  ]
  const tracks: Track[] = kinds.map((k, ti) => {
    const items: Item[] = []
    let t = int(0, 2 * S)
    const n = int(1, 9)
    for (let i = 0; i < n; i++) {
      const dur = r() < 0.15 ? int(MIN_ITEM_US, 3 * MIN_ITEM_US) : int(MIN_ITEM_US, 6 * S)
      let it: Item
      if (k.make === 'fx') {
        it = { ...createEffectItem('blur', t, dur), id: `i${ti}_${i}` }
        if (r() < 0.5) it = { ...it, region: { ...it.region, x: { value: 0.5, keys: [{ tUs: 0, value: 0.1, ease: 'linear' }, { tUs: Math.floor(dur * r()), value: 0.9, ease: 'linear' }, { tUs: dur, value: 0.3, ease: 'linear' }] } } }
      } else if (k.make === 'ann') {
        it = { id: `i${ti}_${i}`, type: 'annotations', sessionId: 's', inUs: int(0, 5 * S), startUs: t, durationUs: dur } satisfies AnnotationsItem
      } else {
        const m = createMediaItem(asset(k.make === 'video' ? 'v' : 'a', k.make), t, k.kind)
        it = { ...m, id: `i${ti}_${i}`, durationUs: dur, inUs: int(0, 30 * S), speed: [1, 1, 2, 0.5][int(0, 4)], reverse: r() < 0.2 }
        if (r() < 0.4) it = { ...it, audio: { ...it.audio, fadeInUs: int(0, dur), volume: { value: 1, keys: [{ tUs: Math.floor(dur * r()), value: 0.4, ease: 'linear' }] } } }
      }
      if (r() < 0.6) it = { ...it, linkId: links[int(0, links.length)] }
      items.push(it)
      t += dur + (r() < 0.3 ? 0 : int(0, 3 * S))
    }
    return { id: `t${ti}`, kind: k.kind, name: `T${ti}`, muted: false, hidden: false, locked: r() < 0.15, volume: 1, ...(k.role ? { role: k.role } : {}), items }
  })
  const markers = Array.from({ length: int(0, 5) }, (_, i) => ({ id: `m${i}`, tUs: int(0, 40 * S), label: '', color: '#fff' }))
  return { ...createEmptyProject('rnd'), assets: [asset('v', 'video'), asset('a', 'audio')], tracks, markers }
}

/** Intervalos disjuntos (alguns encostados, alguns rente às bordas dos itens, ± alguns ms). */
function randomRanges(p: Project, r: () => number): { fromUs: number; toUs: number }[] {
  const edges = p.tracks.flatMap((t) => t.items.flatMap((i) => [i.startUs, i.startUs + i.durationUs]))
  const out: { fromUs: number; toUs: number }[] = []
  let t = Math.floor(r() * 2 * S)
  const n = 1 + Math.floor(r() * 12)
  for (let i = 0; i < n; i++) {
    let from = t
    if (r() < 0.4) {
      const near = edges.filter((e) => e > t).sort((a, b) => a - b)[0]
      if (near !== undefined) from = Math.max(t, near + (r() < 0.3 ? 0 : Math.floor((r() - 0.5) * 2 * MIN_ITEM_US)))
    }
    let to = from + 1 + Math.floor(r() < 0.2 ? r() * MIN_ITEM_US : r() * 3 * S)
    // às vezes o corte termina exatamente numa borda de item
    const edge = edges.filter((e) => e > from).sort((a, b) => a - b)[0]
    if (edge !== undefined && r() < 0.25) to = edge
    out.push({ fromUs: from, toUs: to })
    t = to + (r() < 0.2 ? 0 : Math.floor(r() * 4 * S))
  }
  return out
}

/** Ids novos (gerados) e linkIds trocados por nomes na ordem em que aparecem: compara a estrutura, não os ids aleatórios. */
function canon(p: Project, original: Set<string>): unknown {
  let n = 0
  const linkNames = new Map<string, string>()
  return {
    markers: p.markers,
    tracks: p.tracks.map((t) => ({
      ...t,
      items: t.items.map((i) => {
        const linkId = i.linkId ? (linkNames.get(i.linkId) ?? (linkNames.set(i.linkId, `L#${linkNames.size}`), linkNames.get(i.linkId))) : undefined
        return { ...i, id: original.has(i.id) ? i.id : `new#${n++}`, linkId }
      })
    }))
  }
}

const sequential = (p: Project, ranges: { fromUs: number; toUs: number }[]): Project =>
  [...ranges].sort((a, b) => b.fromUs - a.fromUs).reduce((q, c) => ops.deleteRange(q, c.fromUs, c.toUs), p)

describe('deleteRanges = deleteRange do último intervalo para o primeiro', () => {
  it('200 projetos aleatórios (mídia com velocidade/reverso/keyframes, anotações, efeitos vinculados, faixas bloqueadas, marcadores)', () => {
    const r = rng(20261002)
    let compared = 0
    for (let k = 0; k < 200; k++) {
      const p = randomProject(r)
      const ranges = randomRanges(p, r)
      const original = new Set(p.tracks.flatMap((t) => t.items.map((i) => i.id)))
      let want: Project
      try {
        want = sequential(p, ranges)
      } catch {
        expect(() => ops.deleteRanges(p, ranges)).toThrow()
        continue
      }
      expect(canon(ops.deleteRanges(p, ranges), original), `projeto ${k}`).toEqual(canon(want, original))
      compared++
    }
    expect(compared).toBeGreaterThan(160)
  }, 30_000)

  it('sem intervalos devolve o mesmo projeto; intervalo vazio ou sobreposto é erro', () => {
    const p = randomProject(rng(1))
    expect(ops.deleteRanges(p, [])).toBe(p)
    expect(() => ops.deleteRanges(p, [{ fromUs: 5, toUs: 5 }])).toThrow(ops.EditError)
    expect(() => ops.deleteRanges(p, [{ fromUs: 0, toUs: 10 }, { fromUs: 5, toUs: 20 }])).toThrow(/sobrepostos/)
  })
})
