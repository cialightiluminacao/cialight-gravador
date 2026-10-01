import { describe, expect, it } from 'vitest'
import { newProjectId } from './ids'

describe('newProjectId', () => {
  it('formato p-<data local>-<4 base36>, minúsculo e seguro como nome de pasta', () => {
    const id = newProjectId(new Date(2026, 9, 1, 14, 5, 9), () => 0.5)
    expect(id).toBe('p-2026-10-01t14-05-09-iiii')
    expect(id).toMatch(/^p-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-[0-9a-z]{4}$/)
    expect(id).toBe(id.toLowerCase())
  })
  it('ids no mesmo segundo diferem pelo sufixo aleatório', () => {
    const d = new Date(2026, 9, 1, 14, 5, 9)
    expect(newProjectId(d)).not.toBe(newProjectId(d))
  })
})
