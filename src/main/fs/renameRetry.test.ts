import { describe, expect, it } from 'vitest'
import { renameSyncRetry } from './renameRetry'

const err = (code: string) => Object.assign(new Error(code), { code })

describe('renameSyncRetry', () => {
  it('tenta de novo em EPERM transitório e conclui', () => {
    let calls = 0
    const sleeps: number[] = []
    renameSyncRetry('a', 'b', {
      rename: () => {
        if (++calls < 3) throw err('EPERM')
      },
      sleep: (ms) => sleeps.push(ms),
    })
    expect(calls).toBe(3)
    expect(sleeps).toEqual([10, 20])
  })

  it('desiste depois do tempo máximo com o erro original', () => {
    let waited = 0
    expect(() =>
      renameSyncRetry('a', 'b', {
        rename: () => {
          throw err('EBUSY')
        },
        sleep: (ms) => (waited += ms),
      }),
    ).toThrow('EBUSY')
    expect(waited).toBeGreaterThanOrEqual(2000)
    expect(waited).toBeLessThan(2400)
  })

  it('não tenta de novo em erros que não são de trava', () => {
    let calls = 0
    expect(() =>
      renameSyncRetry('a', 'b', {
        rename: () => {
          calls++
          throw err('ENOENT')
        },
        sleep: () => {},
      }),
    ).toThrow('ENOENT')
    expect(calls).toBe(1)
  })
})
