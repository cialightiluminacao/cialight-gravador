import { describe, expect, it } from 'vitest'
import type { Marker } from '@shared/editor/project'
import { chaptersForEditor } from './chaptersRange'

const S = 1_000_000
const mk = (t: number, label: string): Marker => ({ id: label, tUs: t * S, label, color: '#f59e0b' })
const markers = [mk(0, 'A'), mk(20, 'B'), mk(50, 'C'), mk(80, 'D')]

describe('chaptersForEditor', () => {
  it('sem I–O: Tudo', () => {
    expect(chaptersForEditor(markers, 100 * S, null, null).text).toBe('00:00 A\n00:20 B\n00:50 C\n01:20 D')
  })
  it('com I–O: só o intervalo, tempo relativo à entrada', () => {
    expect(chaptersForEditor(markers, 100 * S, 20 * S, 60 * S).text).toBe('00:00 B\n00:30 C')
  })
  it('só a entrada marcada vale até o fim; I–O inválido cai em Tudo', () => {
    expect(chaptersForEditor(markers, 100 * S, 50 * S, null).text).toBe('00:00 C\n00:30 D')
    expect(chaptersForEditor(markers, 100 * S, 60 * S, 40 * S).chapters).toHaveLength(4)
  })
  it('sem marcadores: lista vazia', () => {
    expect(chaptersForEditor([], 100 * S, null, null).chapters).toEqual([])
  })
})
