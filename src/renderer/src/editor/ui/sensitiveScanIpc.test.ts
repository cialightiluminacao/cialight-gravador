import { describe, expect, it } from 'vitest'
import type { ScanResult } from '@shared/editor/sensitiveScan'
import type { SensitiveScanDone, SensitiveScanProgress } from '@shared/ipc'
import { scanOnce, type SensitiveIpc } from './sensitiveScanIpc'

const result = (extra: Partial<ScanResult> = {}): ScanResult => ({ occurrences: [], framesSampled: 2, framesOcr: 2, ms: 1, lang: 'pt-BR', ...extra })

/** API falsa: start responde quando `respond()` é chamado; registra os cancelamentos. */
function fakeApi() {
  const prog = new Set<(p: SensitiveScanProgress) => void>()
  const done = new Set<(d: SensitiveScanDone) => void>()
  const cancelled: string[] = []
  let respond: (id: string) => void = () => {}
  const api: SensitiveIpc = {
    start: () => new Promise((r) => (respond = (id) => r({ scanId: id }))),
    cancel: async (id) => {
      cancelled.push(id)
      return true
    },
    onProgress: (cb) => (prog.add(cb), () => prog.delete(cb)),
    onDone: (cb) => (done.add(cb), () => done.delete(cb))
  }
  return { api, cancelled, respond: (id: string) => respond(id), emitDone: (d: SensitiveScanDone) => [...done].forEach((f) => f(d)), emitProg: (p: SensitiveScanProgress) => [...prog].forEach((f) => f(p)), listeners: () => prog.size + done.size }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const req = { filePath: 'C:/v.mp4', fromUs: 0, toUs: 1_000_000 }

describe('scanOnce', () => {
  it('caminho normal: id, progresso (inclusive o que chegou antes do id) e o resultado; solta os ouvintes', async () => {
    const f = fakeApi()
    const seen: number[] = []
    let id = ''
    const p = scanOnce(f.api, req, { onProgress: (x) => seen.push(x.done), onId: (s) => (id = s) })
    f.emitProg({ scanId: 's1', phase: 'amostrando', done: 1, total: 4 })
    f.respond('s1')
    await tick()
    f.emitProg({ scanId: 'outra', phase: 'lendo', done: 9, total: 9 })
    f.emitProg({ scanId: 's1', phase: 'lendo', done: 2, total: 4 })
    f.emitDone({ scanId: 's1', result: result() })
    expect((await p).lang).toBe('pt-BR')
    expect(id).toBe('s1')
    expect(seen).toEqual([1, 2])
    expect(f.listeners()).toBe(0)
    expect(f.cancelled).toEqual([])
  })
  it('cancelada ANTES do start responder: o cancelamento chega ao main com o id, e espera o fim dela', async () => {
    const f = fakeApi()
    let stale = false
    let gotId = false
    const p = scanOnce(f.api, req, { isStale: () => stale, onId: () => (gotId = true) })
    stale = true // Cancelar/Esc/fechar enquanto o start ainda não respondeu
    f.respond('s2')
    await tick()
    expect(f.cancelled).toEqual(['s2'])
    expect(gotId).toBe(false)
    let resolved = false
    void p.then(() => (resolved = true))
    await tick()
    expect(resolved).toBe(false)
    f.emitDone({ scanId: 's2', result: result({ cancelled: true, occurrences: [] }) })
    expect((await p).cancelled).toBe(true)
    expect(f.listeners()).toBe(0)
  })
  it('done antes da resposta do start não se perde', async () => {
    const f = fakeApi()
    const p = scanOnce(f.api, req)
    f.emitDone({ scanId: 's3', result: result({ framesSampled: 7 }) })
    f.respond('s3')
    expect((await p).framesSampled).toBe(7)
  })
  it('erro imediato do start (busy/invalid) resolve com o erro, sem cancelar', async () => {
    const api: SensitiveIpc = { start: async () => ({ scanId: '', error: { code: 'busy', message: 'ocupado' } }), cancel: async () => true, onProgress: () => () => {}, onDone: () => () => {} }
    expect((await scanOnce(api, req)).error?.code).toBe('busy')
  })
})
