import { describe, expect, it, vi } from 'vitest'
import { EditorExportCancelled, finalizeOrCancel } from './finalize'

const fakeApi = (finalize: () => Promise<{ path: string; size: number }>) => ({ finalize: vi.fn(finalize), cancel: vi.fn(async () => {}) })

describe('finalizeOrCancel', () => {
  it('normal: finaliza e devolve o arquivo', async () => {
    const api = fakeApi(async () => ({ path: 'x.mp4', size: 1 }))
    await expect(finalizeOrCancel(api, 'j', {}, new AbortController().signal)).resolves.toEqual({ path: 'x.mp4', size: 1 })
    expect(api.cancel).not.toHaveBeenCalled()
  })
  it('cancelado entre a codificação e o finalize: apaga o parcial, não finaliza', async () => {
    const ac = new AbortController()
    ac.abort()
    const api = fakeApi(async () => ({ path: 'x.mp4', size: 1 }))
    await expect(finalizeOrCancel(api, 'j', {}, ac.signal)).rejects.toBeInstanceOf(EditorExportCancelled)
    expect(api.finalize).not.toHaveBeenCalled()
    expect(api.cancel).toHaveBeenCalledWith('j')
  })
  it('cancelado durante o remux: pede o cancelamento ao main e rejeita como cancelado', async () => {
    const ac = new AbortController()
    let fail: (e: Error) => void = () => {}
    const api = fakeApi(() => new Promise((_, rej) => (fail = rej)))
    const p = finalizeOrCancel(api, 'j', {}, ac.signal)
    await Promise.resolve()
    ac.abort()
    expect(api.cancel).toHaveBeenCalledWith('j')
    fail(new Error('cancelado'))
    await expect(p).rejects.toBeInstanceOf(EditorExportCancelled)
  })
})
