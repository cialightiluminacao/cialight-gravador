import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportProgress, ExportRequest } from '@shared/ipc'
import type { ExportOptions, Session } from '@shared/types'

// Testa o executor de exportação isolado: filtro de eventos por jobId, cancelamento tardio
// (main responde "done" a um cancel → tratado como cancelado), descarte do composed.mp4 e
// exclusividade (uma exportação por vez).

const toastMock = vi.hoisted(() => {
  const t = vi.fn() as ReturnType<typeof vi.fn> & { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  t.success = vi.fn()
  t.error = vi.fn()
  return t
})
vi.mock('sonner', () => ({ toast: toastMock }))

const composer = vi.hoisted(() => ({
  needsComposition: vi.fn<() => boolean>(() => false),
  composeSession: vi.fn<() => Promise<string>>(async () => 'C:/raw/s1/composed.mp4'),
  discardComposed: vi.fn<() => Promise<void>>(async () => {}),
  ComposeCancelledError: class ComposeCancelledError extends Error {}
}))
vi.mock('@/export/exportComposer', () => composer)

type ProgressCb = (p: ExportProgress) => void
const api = vi.hoisted(() => {
  const state: { cb: ProgressCb | null; nextJob: string } = { cb: null, nextJob: 'job-1' }
  return {
    state,
    export: {
      onProgress: vi.fn((cb: ProgressCb) => {
        state.cb = cb
        return () => {}
      }),
      run: vi.fn(async (_req: ExportRequest) => ({ jobId: state.nextJob })),
      cancel: vi.fn(async () => {})
    },
    session: { get: vi.fn(async () => null) }
  }
})
Object.assign(globalThis, { window: { api } })

import { useAppStore } from '@/app/store'
import { cancelExport, resetExport, startExport } from './exportRunner'

const emit = (p: ExportProgress): void => api.state.cb?.(p)

const session = {
  id: 's1',
  video: { width: 1920, height: 1080, fps: 30 },
  tracks: { screen: 0, mic: 0 },
  strokes: [],
  pip: []
} as unknown as Session

const options: ExportOptions = {
  presetId: 'high',
  trimStartMs: 0,
  trimEndMs: null,
  includeWebcam: false,
  includeAnnotations: false,
  audioMode: 'mix',
  micOffsetMs: 0,
  targetSizeMB: null,
  reels: false,
  outputDir: 'C:/out',
  fileName: 'teste',
  pipOverride: null
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('exportRunner', () => {
  beforeEach(() => {
    api.state.nextJob = `job-${Math.random().toString(36).slice(2)}`
    api.export.run.mockClear()
    api.export.cancel.mockClear()
    composer.discardComposed.mockClear()
    composer.needsComposition.mockReturnValue(false)
    toastMock.mockClear()
    toastMock.success.mockClear()
    toastMock.error.mockClear()
  })

  it('exporta sem composição: run → progresso → done com os arquivos', async () => {
    const p = startExport({ session, options, durationMs: 12000, autoFadeMs: null })
    await flush()
    const jobId = api.state.nextJob
    emit({ jobId, stage: 'encode', percent: 40 })
    emit({ jobId, stage: 'done', percent: 100, outputs: ['C:/out/teste.mp4'] })
    await expect(p).resolves.toEqual({ outputs: ['C:/out/teste.mp4'] })
    expect(composer.discardComposed).not.toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalled()
    resetExport('s1')
  })

  it('ignora eventos de outros jobs (inclusive "cancelled" tardio de job antigo)', async () => {
    const p = startExport({ session, options, durationMs: 12000, autoFadeMs: null })
    await flush()
    const jobId = api.state.nextJob
    emit({ jobId: 'job-antigo', stage: 'cancelled', percent: 0 })
    emit({ jobId: 'job-antigo', stage: 'done', percent: 100, outputs: ['x.mp4'] })
    let settled = false
    void p.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    emit({ jobId, stage: 'done', percent: 100, outputs: ['C:/out/ok.mp4'] })
    await expect(p).resolves.toEqual({ outputs: ['C:/out/ok.mp4'] })
    resetExport('s1')
  })

  it('cancelar na etapa ffmpeg: "done" que chega depois do cancel vira cancelado (não sucesso falso)', async () => {
    const p = startExport({ session, options, durationMs: 12000, autoFadeMs: null })
    await flush()
    const jobId = api.state.nextJob
    emit({ jobId, stage: 'encode', percent: 6 })
    cancelExport()
    expect(api.export.cancel).toHaveBeenCalledWith(jobId)
    emit({ jobId, stage: 'done', percent: 100, outputs: ['C:/out/quebrado.mp4'] })
    await expect(p).resolves.toEqual({ outputs: [], error: 'cancelado' })
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith('Exportação cancelada.', expect.objectContaining({ description: expect.stringContaining('parcial') }))
  })

  it('com composição: descarta composed.mp4 ao terminar e recusa 2ª exportação em paralelo', async () => {
    composer.needsComposition.mockReturnValue(true)
    const p = startExport({ session, options: { ...options, includeWebcam: true }, durationMs: 12000, autoFadeMs: null })
    await flush()
    await expect(startExport({ session, options, durationMs: 12000, autoFadeMs: null })).resolves.toMatchObject({ outputs: [], error: expect.stringContaining('andamento') })
    expect(api.export.run).toHaveBeenCalledTimes(1)
    expect(api.export.run.mock.calls[0][0]).toMatchObject({ composedFile: 'C:/raw/s1/composed.mp4' })
    const jobId = api.state.nextJob
    emit({ jobId, stage: 'done', percent: 100, outputs: ['C:/out/c.mp4'] })
    await expect(p).resolves.toEqual({ outputs: ['C:/out/c.mp4'] })
    expect(composer.discardComposed).toHaveBeenCalledWith('s1')
    resetExport('s1')
  })

  it('com a Revisão da sessão na tela, não mostra toast de sucesso (o painel já diz "Concluído")', async () => {
    useAppStore.getState().setReviewSession(session)
    useAppStore.getState().setScreen('review')
    const p = startExport({ session, options, durationMs: 12000, autoFadeMs: null })
    await flush()
    emit({ jobId: api.state.nextJob, stage: 'done', percent: 100, outputs: ['C:/out/v.mp4'] })
    await expect(p).resolves.toEqual({ outputs: ['C:/out/v.mp4'] })
    expect(toastMock.success).not.toHaveBeenCalled()
    useAppStore.getState().setScreen('prepare')
    useAppStore.getState().setReviewSession(null)
    resetExport('s1')
  })

  it('erro do main vira resultado com error e libera o slot para tentar de novo', async () => {
    const p = startExport({ session, options, durationMs: 12000, autoFadeMs: null })
    await flush()
    emit({ jobId: api.state.nextJob, stage: 'error', percent: 0, error: 'ffmpeg saiu com código 1' })
    await expect(p).resolves.toEqual({ outputs: [], error: 'ffmpeg saiu com código 1' })
    expect(toastMock.error).toHaveBeenCalled()
    api.state.nextJob = 'job-retry'
    const p2 = startExport({ session, options, durationMs: 12000, autoFadeMs: null })
    await flush()
    emit({ jobId: 'job-retry', stage: 'done', percent: 100, outputs: ['C:/out/r.mp4'] })
    await expect(p2).resolves.toEqual({ outputs: ['C:/out/r.mp4'] })
    resetExport('s1')
  })
})
