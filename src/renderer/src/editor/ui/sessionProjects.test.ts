import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from '@shared/ipc'
import { pickProjectForSession } from './sessionProjects'

const sum = (id: string, updatedAt: string, originSessionId?: string): ProjectSummary => ({ id, name: id, updatedAt, durationUs: 0, originSessionId })

describe('pickProjectForSession', () => {
  it('o projeto mais recente criado daquela gravação', () => {
    const list = [sum('a', '2026-10-01T10:00:00Z', 's1'), sum('b', '2026-10-01T12:00:00Z', 's1'), sum('c', '2026-10-01T13:00:00Z', 's2'), sum('d', '2026-10-01T14:00:00Z')]
    expect(pickProjectForSession(list, 's1')?.id).toBe('b')
    expect(pickProjectForSession(list, 's2')?.id).toBe('c')
    expect(pickProjectForSession(list, 's3')).toBeNull()
  })
})
