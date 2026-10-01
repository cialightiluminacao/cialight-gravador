import { describe, expect, it } from 'vitest'
import { commit, initHistory, redo, undo } from './history'

describe('history', () => {
  it('commit empilha o present em past', () => {
    const h = commit(initHistory(1), 2)
    expect(h).toEqual({ past: [1], present: 2, future: [] })
  })

  it('ignora commit do mesmo objeto', () => {
    const h = initHistory({ a: 1 })
    expect(commit(h, h.present)).toBe(h)
  })

  it('undo e redo percorrem os estados', () => {
    let h = commit(commit(initHistory(1), 2), 3)
    h = undo(h)
    expect(h).toEqual({ past: [1], present: 2, future: [3] })
    h = undo(h)
    expect(h.present).toBe(1)
    expect(undo(h)).toBe(h)
    h = redo(h)
    expect(h.present).toBe(2)
    h = redo(redo(h))
    expect(h.present).toBe(3)
  })

  it('commit limpa o futuro', () => {
    let h = commit(commit(initHistory(1), 2), 3)
    h = undo(h)
    h = commit(h, 9)
    expect(h).toEqual({ past: [1, 2], present: 9, future: [] })
  })

  it('respeita o limite descartando os mais antigos', () => {
    let h = initHistory(0)
    for (let i = 1; i <= 10; i++) h = commit(h, i, 3)
    expect(h.past).toEqual([7, 8, 9])
    expect(h.present).toBe(10)
  })
})
