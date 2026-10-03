import { renameSync } from 'fs'

// No Windows, antivírus, indexador ou outro processo lendo o destino (ex.: a versão instalada do app) seguram o
// arquivo por alguns milissegundos e o rename da gravação atômica falha com EPERM/EACCES/EBUSY. Tenta de novo
// com espera curta (mesma ideia do graceful-fs) antes de desistir; outros erros sobem na hora.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const MAX_WAIT_MS = 2000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function renameSyncRetry(from: string, to: string, deps: { rename?: typeof renameSync; sleep?: (ms: number) => void } = {}): void {
  const rename = deps.rename ?? renameSync
  const sleep = deps.sleep ?? sleepSync
  let waited = 0
  let delay = 10
  for (;;) {
    try {
      rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!code || !RETRY_CODES.has(code) || waited >= MAX_WAIT_MS) throw e
      sleep(delay)
      waited += delay
      delay = Math.min(delay * 2, 200)
    }
  }
}
