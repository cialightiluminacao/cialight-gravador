import { describe, expect, it } from 'vitest'
import { commit, initHistory, redo, redoMeta, undo, undoMeta } from './history'

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

  it('metadado de marcas: fica na entrada; undo -> before, redo -> after; sem meta não muda', () => {
    const m1 = { before: 'b1', after: 'a1' }
    let h = commit(commit(commit(initHistory(1), 2), 3, 300, m1), 4)
    expect(undoMeta(h)).toBeUndefined() // 3 -> 4 sem meta
    h = undo(h)
    expect(undoMeta(h)).toEqual(m1)
    expect(redoMeta(h)).toBeUndefined()
    h = undo(h)
    expect(redoMeta(h)).toEqual(m1)
    expect(h.present).toBe(2)
    h = redo(h)
    expect(h.present).toBe(3)
    expect(undoMeta(h)).toEqual(m1)
    h = redo(h)
    expect(h.present).toBe(4)
    expect(commit(h, 5).future).toEqual([])
  })

  it('sem meta nenhum, o formato é o original', () => {
    expect(commit(initHistory(1), 2)).toEqual({ past: [1], present: 2, future: [] })
    expect('pastMeta' in commit(initHistory(1), 2)).toBe(false)
  })

  it('limite de histórico mantém metas alinhadas', () => {
    const m = { before: 'b', after: 'a' }
    let h = commit(initHistory(0), 1, 2, m)
    h = commit(h, 2, 2)
    h = commit(h, 3, 2)
    expect(h.past).toEqual([1, 2])
    expect(h.pastMeta).toEqual([undefined, undefined])
    h = undo(undo(h))
    expect(h.present).toBe(1)
    expect(undoMeta(h)).toBeUndefined()
  })
})
