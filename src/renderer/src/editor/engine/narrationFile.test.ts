import { describe, expect, it, vi } from 'vitest'
import { discardNarrationFile, NarrationCancelled, openNarrationFile, type NarrationFileApi } from './narrationFile'

// Abrir o arquivo da narração: falha no encoder (ou cancelamento) depois de abrir não deixa handle aberto nem
// marcador de recuperação; falha de escrita avisa uma vez.

const meta = { kind: 'narration' as const, startUs: 0, inUs: 0, createdAt: '2026-10-02T10:00:00.000Z' }

function fakeApi(opts: { failWritesFrom?: number } = {}): NarrationFileApi & { calls: string[] } {
  const calls: string[] = []
  let writes = 0
  return {
    calls,
    writeGeneratedOpen: vi.fn(async () => {
      calls.push('open')
      return { handle: 7, rel: 'generated/narracao-1.m4a' }
    }),
    writeGenerated: vi.fn(async () => {
      writes++
      calls.push('write')
      if (opts.failWritesFrom !== undefined && writes >= opts.failWritesFrom) throw new Error('disco cheio')
    }),
    writeGeneratedClose: vi.fn(async (h: number) => void calls.push(`close:${h}`)),
    clearPendingGenerated: vi.fn(async (_p: string, rel: string, o?: { discardFile?: boolean }) => void calls.push(`clear:${rel}:${o?.discardFile ? 'discard' : 'keep'}`))
  }
}

describe('openNarrationFile', () => {
  it('ok: devolve handle, arquivo e a saída já começada', async () => {
    const api = fakeApi()
    const start = vi.fn(async () => {})
    const r = await openNarrationFile(api, 'p', meta, () => ({ start }))
    expect(r).toMatchObject({ handle: 7, rel: 'generated/narracao-1.m4a' })
    expect(start).toHaveBeenCalledOnce()
    expect(api.calls).toEqual(['open'])
  })

  it('output.start falhou: fecha o handle e descarta arquivo + marcador, e repassa o erro', async () => {
    const api = fakeApi()
    await expect(openNarrationFile(api, 'p', meta, () => ({ start: async () => { throw new Error('encoder indisponível') } }))).rejects.toThrow('encoder indisponível')
    expect(api.calls).toEqual(['open', 'close:7', 'clear:generated/narracao-1.m4a:discard'])
  })

  it('montar a saída lançou (antes do start): o mesmo', async () => {
    const api = fakeApi()
    await expect(openNarrationFile(api, 'p', meta, () => { throw new Error('codec') })).rejects.toThrow('codec')
    expect(api.calls).toEqual(['open', 'close:7', 'clear:generated/narracao-1.m4a:discard'])
  })

  it('cancelado enquanto começava: descarta e lança NarrationCancelled', async () => {
    const api = fakeApi()
    let cancelled = false
    await expect(openNarrationFile(api, 'p', meta, () => ({ start: async () => { cancelled = true } }), { cancelled: () => cancelled })).rejects.toBeInstanceOf(NarrationCancelled)
    expect(api.calls).toEqual(['open', 'close:7', 'clear:generated/narracao-1.m4a:discard'])
  })

  it('falha de escrita: avisa uma vez (na 1ª) e repassa a cada chamada', async () => {
    const api = fakeApi({ failWritesFrom: 2 })
    const onWriteError = vi.fn()
    let write!: (d: Uint8Array, p: number) => Promise<void>
    await openNarrationFile(api, 'p', meta, (w) => ((write = w), { start: async () => {} }), { onWriteError })
    await write(new Uint8Array([1]), 0)
    await expect(write(new Uint8Array([1]), 1)).rejects.toThrow('disco cheio')
    await expect(write(new Uint8Array([1]), 2)).rejects.toThrow('disco cheio')
    expect(onWriteError).toHaveBeenCalledOnce()
  })

  it('discardNarrationFile nunca lança', async () => {
    const api = fakeApi()
    api.writeGeneratedClose = vi.fn(async () => { throw new Error('x') })
    api.clearPendingGenerated = vi.fn(async () => { throw new Error('y') })
    await expect(discardNarrationFile(api, 'p', 3, 'generated/narracao-1.m4a')).resolves.toBeUndefined()
  })
})
