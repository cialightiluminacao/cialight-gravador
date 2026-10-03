import { describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import { parseQueueFile, serializeQueueFile } from '@shared/exportQueueFile'
import type { ParkedEntry } from './exportQueue'
import { fromPersisted, toPersisted } from './exportQueuePersist'

const entry = (name: string): ParkedEntry => ({
  job: {
    kind: 'video',
    request: { project: createEmptyProject('Fila', { width: 64, height: 36, fps: 30, background: '#000000' }), width: 64, height: 36, fps: 30, fromUs: 0, toUs: 2_000_000, videoBitrate: 1e6, audioBitrate: 128_000, outputDir: 'C:/saida', fileName: name, cursorTracks: new Map(), simulateHwFailure: true }
  },
  label: name,
  durationUs: 2_000_000,
  privacy: ['aviso'],
  createdAt: 42
})

describe('item da fila <-> arquivo', () => {
  it('ida e volta pelo texto do arquivo: mesmo pedido e mesmo projeto; campos só de teste ficam de fora', () => {
    const e = entry('a.mp4')
    const text = serializeQueueFile([toPersisted(e)])
    const parsed = parseQueueFile(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const back = fromPersisted(parsed.items[0])
    expect(back).not.toBeNull()
    expect(back?.job.kind).toBe('video')
    expect(back?.job.request.project).toEqual(e.job.request.project)
    expect(back?.job.request).toMatchObject({ fileName: 'a.mp4', outputDir: 'C:/saida', fromUs: 0, toUs: 2_000_000, videoBitrate: 1e6 })
    expect('cursorTracks' in (back?.job.request ?? {})).toBe(false)
    expect('simulateHwFailure' in (back?.job.request ?? {})).toBe(false)
    expect(back).toMatchObject({ label: 'a.mp4', durationUs: 2_000_000, privacy: ['aviso'], createdAt: 42 })
    expect(parsed.items[0].projectId).toBe(e.job.request.project.id)
  })
  it('projeto que não passa no schema: item descartado, sem lançar', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = toPersisted(entry('b.mp4'))
    expect(fromPersisted({ ...p, request: { ...p.request, project: { id: 'x', lixo: true } } })).toBeNull()
    warn.mockRestore()
  })
})
