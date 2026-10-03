import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import { editorExportRunning } from './exportLock'
import { EditorExportCancelled } from './finalize'
import { exportStill, type StillClient } from './formatExport'

const project = createEmptyProject('Teste', { width: 64, height: 36, fps: 30, background: '#000000' })
const req = { project, tUs: 1_000_000, outputDir: 'C:/saida', fileName: 'q.png' }

/** Cliente de render falso: `answer` null → nunca responde (decoder/GPU pendurado). */
function fakeClient(answer: ArrayBuffer | null) {
  const c = {
    ready: Promise.resolve(),
    setProject: vi.fn(),
    exportStill: vi.fn(() => (answer ? Promise.resolve({ t: 'still' as const, id: 1, png: answer, missing: [], missingAnnotations: [] }) : new Promise<never>(() => {}))),
    dispose: vi.fn()
  }
  return c satisfies StillClient
}

const writeStill = vi.fn(async (_d: string, _n: string, png: Uint8Array) => ({ path: 'C:/saida/q.png', size: png.byteLength }))
beforeEach(() => {
  writeStill.mockClear()
  vi.stubGlobal('window', { api: { editorExport: { writeStill } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('exportStill (quadro PNG)', () => {
  it('render que nunca responde: erro claro no prazo, nada gravado, instância descartada e trava solta', async () => {
    const c = fakeClient(null)
    await expect(exportStill(req, { timeoutMs: 20, client: () => c })).rejects.toThrow(/O quadro não ficou pronto em 1 s \(o render parou de responder\)/)
    expect(c.dispose).toHaveBeenCalled()
    expect(writeStill).not.toHaveBeenCalled()
    expect(editorExportRunning()).toBe(false)
  })

  it('Cancelar durante o render: EditorExportCancelled, nada gravado, trava solta', async () => {
    const c = fakeClient(null)
    const ac = new AbortController()
    const p = exportStill(req, { signal: ac.signal, client: () => c })
    expect(editorExportRunning()).toBe(true)
    setTimeout(() => ac.abort(), 5)
    await expect(p).rejects.toBeInstanceOf(EditorExportCancelled)
    expect(c.dispose).toHaveBeenCalled()
    expect(writeStill).not.toHaveBeenCalled()
    expect(editorExportRunning()).toBe(false)
  })

  it('normal: grava os bytes do PNG e solta a trava', async () => {
    const c = fakeClient(new Uint8Array([137, 80, 78, 71]).buffer)
    const r = await exportStill(req, { client: () => c })
    expect(writeStill).toHaveBeenCalledWith('C:/saida', 'q.png', new Uint8Array([137, 80, 78, 71]))
    expect(r).toMatchObject({ kind: 'png', path: 'C:/saida/q.png', size: 4, width: 64, height: 36 })
    expect(editorExportRunning()).toBe(false)
  })
})
