import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Asset } from '@shared/editor/project'
import type { MediaInfo } from './probe'

// Fila com ffmpeg falso: cada etapa vira uma promessa controlada pelo teste, para medir a
// concorrência (1 pesado + 2 leves), a substituição de execuções e o cancelamento.

type Kind = 'heavy' | 'light'
interface Call { kind: Kind; what: string; signal?: AbortSignal; resolve: (v?: unknown) => void; settled: boolean }

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  running: { heavy: 0, light: 0 },
  max: { heavy: 0, light: 0 }
}))

function gate(kind: Kind, what: string, signal: AbortSignal | undefined, value?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    h.running[kind]++
    h.max[kind] = Math.max(h.max[kind], h.running[kind])
    const call: Call = {
      kind,
      what,
      signal,
      settled: false,
      resolve: () => {
        if (call.settled) return
        call.settled = true
        h.running[kind]--
        resolve(value)
      }
    }
    signal?.addEventListener('abort', async () => {
      if (call.settled) return
      call.settled = true
      h.running[kind]--
      const { CancelledError } = await vi.importActual<typeof import('./analysis')>('./analysis')
      reject(new CancelledError())
    })
    h.calls.push(call)
  })
}

const info: MediaInfo = {
  durationUs: 6_000_000,
  kind: 'video',
  video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 0, gopUs: 10_000_000 },
  audio: { channels: 2, sampleRate: 48000, codec: 'aac' },
  vfr: false,
  formatName: 'mp4'
}

vi.mock('./probe', async (orig) => ({
  ...(await orig<typeof import('./probe')>()),
  probe: async () => {
    h.running.light++
    h.max.light = Math.max(h.max.light, h.running.light)
    await Promise.resolve()
    h.running.light--
    return info
  }
}))
vi.mock('./analysis', async (orig) => ({
  ...(await orig<typeof import('./analysis')>()),
  runToFile: (_args: unknown, _out: string, opts: { signal?: AbortSignal }) => gate('heavy', 'proxy', opts.signal),
  buildFilmstrip: (_i: string, file: string, _d: number, opts: { signal?: AbortSignal }) => gate('light', 'filmstrip', opts.signal, { file, frames: 6, everyUs: 1_000_000, tileW: 114, tileH: 64 }),
  buildPeaks: (_i: string, file: string, opts: { signal?: AbortSignal }) => gate('light', 'peaks', opts.signal, { file, samplesPerSec: 100 }),
  buildThumb: async (_i: string, file: string) => file
}))

const { IngestQueue } = await import('./ingest')

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function asset(id: string): Asset {
  return {
    id, name: id, kind: 'video', source: { type: 'file', path: `C:/v/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: 6_000_000, status: 'processing',
    video: { ...info.video!, decodable: true }, audio: info.audio
  }
}

describe('IngestQueue', () => {
  let dir: string
  let queue: InstanceType<typeof IngestQueue>
  let done: { assetId: string; patch: Partial<Asset> }[]

  beforeEach(() => {
    h.calls.length = 0
    h.running.heavy = h.running.light = 0
    h.max.heavy = h.max.light = 0
    dir = mkdtempSync(join(tmpdir(), 'cialight-ingest-'))
    queue = new IngestQueue({ projectFile: (pid, rel) => join(dir, pid, rel), resolveInput: (_p, a) => ({ path: (a.source as { path: string }).path }), encoder: () => 'libx264' })
    done = []
    queue.on('done', (_pid, assetId, patch) => done.push({ assetId, patch }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Libera as etapas pendentes uma a uma (FIFO) conferindo os limites a cada passo. */
  async function drain(): Promise<void> {
    for (let guard = 0; guard < 200; guard++) {
      await flush()
      expect(h.running.heavy).toBeLessThanOrEqual(1)
      expect(h.running.light).toBeLessThanOrEqual(2)
      const next = h.calls.find((c) => !c.settled)
      if (!next) return
      next.resolve()
    }
    throw new Error('etapas não terminaram')
  }

  it('no máximo 1 transcodificação e 2 etapas leves ao mesmo tempo', async () => {
    for (const id of ['a', 'b', 'c']) queue.enqueue('p', asset(id))
    await flush()
    expect(h.calls.filter((c) => c.what === 'proxy')).toHaveLength(1)
    await drain()
    expect(h.max).toEqual({ heavy: 1, light: 2 })
    expect(done.map((d) => d.assetId).sort()).toEqual(['a', 'b', 'c'])
    for (const d of done) expect(d.patch).toMatchObject({ status: 'ready', proxy: `proxies/${d.assetId}.mp4`, filmstrip: `cache/${d.assetId}.strip.jpg`, peaks: `cache/${d.assetId}.peaks.bin` })
    expect(queue.busy('p')).toBe(false)
  })

  it('reenfileirar um asset ativo cancela a execução anterior; só a nova emite done', async () => {
    queue.enqueue('p', asset('a'))
    await flush()
    const first = h.calls.filter((c) => !c.settled)
    expect(first.length).toBeGreaterThan(0)
    queue.enqueue('p', { ...asset('a'), name: 'relink' })
    await flush()
    expect(first.every((c) => c.signal?.aborted && c.settled)).toBe(true)
    await drain()
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ assetId: 'a', patch: { status: 'ready' } })
  })

  it('cancelar com job esperando o slot pesado: nada roda nem emite, e o slot é liberado', async () => {
    queue.enqueue('p', asset('a'))
    queue.enqueue('p', asset('b'))
    await flush()
    expect(h.calls.filter((c) => c.what === 'proxy')).toHaveLength(1) // b espera o slot pesado
    queue.cancel('p')
    await flush()
    expect(h.calls.every((c) => c.settled)).toBe(true)
    expect(h.running).toEqual({ heavy: 0, light: 0 })
    expect(queue.busy('p')).toBe(false)
    expect(h.calls.filter((c) => c.what === 'proxy')).toHaveLength(1) // o de b nunca começou
    // slots liberados: um novo job anda normalmente
    queue.enqueue('p', asset('c'))
    await drain()
    expect(done.map((d) => d.assetId)).toEqual(['c'])
  })
})
