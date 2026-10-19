import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], UrlSource: class {}, Input: class { async getPrimaryAudioTrack() { return { canDecode: async () => true } }; dispose() {} } }))
import { createEmptyProject } from '@shared/editor/factory'
import type { Asset } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'
import { importPaths, relinkTo, retryAsset } from './mediaImport'

const media: Asset = { id: 'audio', kind: 'audio', name: 'fala.wav', durationUs: 3_000_000, source: { type: 'file', path: 'C:/fala.wav', size: 20, mtimeMs: 1 }, status: 'ready', audio: { codec: 'pcm', channels: 1, sampleRate: 48000 } }
beforeEach(() => { useEditorStore.getState().close(); vi.clearAllMocks() })
afterEach(() => { vi.unstubAllGlobals(); useEditorStore.getState().close() })
describe('asynchronous media import ownership', () => {
  it('does not add files to a different project opened during probing', async () => {
    let complete!: (assets: Asset[]) => void
    vi.stubGlobal('window', { api: { media: { import: vi.fn(() => new Promise<Asset[]>(resolve => { complete = resolve })) } } })
    const first = { ...createEmptyProject('A'), id: 'project-a' }, second = { ...createEmptyProject('B'), id: 'project-b' }
    useEditorStore.getState().open(first)
    const pending = importPaths(first.id, ['C:/fala.wav'])
    useEditorStore.getState().open(second)
    complete([media])
    await pending
    expect(useEditorStore.getState().project?.id).toBe(second.id)
    expect(useEditorStore.getState().project?.assets).toEqual([])
  })
  it('does not apply a relink response to an asset with the same ID in another project', async () => {
    let complete!: (asset: Asset) => void
    vi.stubGlobal('window', { api: { media: { relink: vi.fn(() => new Promise<Asset>(resolve => { complete = resolve })), enqueue: vi.fn() } } })
    const first = { ...createEmptyProject('A'), id: 'project-a', assets: [media] }, second = { ...createEmptyProject('B'), id: 'project-b', assets: [media] }
    useEditorStore.getState().open(first)
    const pending = relinkTo(first.id, media, 'D:/nova.wav')
    useEditorStore.getState().open(second)
    complete({ ...media, source: { ...media.source as Extract<Asset['source'], { type: 'file' }>, path: 'D:/nova.wav' } })
    await pending.catch(() => {})
    expect(useEditorStore.getState().project?.assets[0].source).toEqual(media.source)
  })
  it('retries a failed imported asset in place rather than creating a duplicate', async () => {
    const failed = { ...media, status: 'error' as const, error: 'ffprobe ausente' }
    const relink = vi.fn(async () => ({ ...media, status: 'processing' as const })), enqueue = vi.fn(async () => {})
    vi.stubGlobal('window', { api: { media: { relink, enqueue } } })
    const project = { ...createEmptyProject('A'), id: 'project-a', assets: [failed] }
    useEditorStore.getState().open(project)
    await retryAsset(project.id, media.id)
    expect(relink).toHaveBeenCalledWith(project.id, media.id, 'C:/fala.wav')
    expect(enqueue).toHaveBeenCalledWith(project.id, media.id, { decodable: true, audioDecodable: true })
    expect(useEditorStore.getState().project?.assets).toHaveLength(1)
    expect(useEditorStore.getState().project?.assets[0].id).toBe(media.id)
  })
})
