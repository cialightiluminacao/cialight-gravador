import { describe, expect, it, vi } from 'vitest'
import { runWhenIdle } from './whenIdle'

describe('runWhenIdle (probe de encoders adiado: nunca durante gravação/exportação)', () => {
  it('ocioso: roda já', async () => {
    const task = vi.fn(async () => {})
    await runWhenIdle(task, { isBusy: () => false, retryMs: 60_000 })
    expect(task).toHaveBeenCalledTimes(1)
  })
  it('gravando/exportando: adia e tenta de novo até ficar ocioso', async () => {
    vi.useFakeTimers()
    try {
      let busy = true
      const task = vi.fn(async () => {})
      const done = runWhenIdle(task, { isBusy: () => busy, retryMs: 60_000 })
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(task).not.toHaveBeenCalled()
      busy = false
      await vi.advanceTimersByTimeAsync(60_000)
      await done
      expect(task).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('desistiu (app saindo): não roda', async () => {
    vi.useFakeTimers()
    try {
      let stop = false
      const task = vi.fn(async () => {})
      const done = runWhenIdle(task, { isBusy: () => true, retryMs: 1000, stopped: () => stop })
      await vi.advanceTimersByTimeAsync(1000)
      stop = true
      await vi.advanceTimersByTimeAsync(5000)
      await done
      expect(task).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
