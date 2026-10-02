import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import type { Asset } from '@shared/editor/project'
import type { IngestJob } from '@shared/ipc'
import { sourceFingerprint } from '@shared/editor/audioProcess'
import type { MediaInfo } from './probe'

// Fila com ffmpeg falso: cada etapa vira uma promessa controlada pelo teste, para medir a
// concorrência (1 pesado + 2 leves), a substituição de execuções e o cancelamento.

type Kind = 'heavy' | 'light'
interface Call { kind: Kind; what: string; signal?: AbortSignal; resolve: (v?: unknown) => void; fail: (e: Error) => void; settled: boolean }

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
      },
      fail: (e) => {
        if (call.settled) return
        call.settled = true
        h.running[kind]--
        reject(e)
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
  buildSpeech: (_i: string, _f: string, _d: number, opts: { signal?: AbortSignal }) => gate('light', 'speech', opts.signal, { version: 1, intervals: [] }),
  buildLoudness: (_i: string, _d: number, opts: { signal?: AbortSignal }) => gate('light', 'loudness', opts.signal, { integrated: -23, truePeak: -1, lra: 4 }),
  buildThumb: async (_i: string, file: string) => file
}))

vi.mock('./audioProcess', async (orig) => ({
  ...(await orig<typeof import('./audioProcess')>()),
  processAudioFile: (_i: string, _m: string, out: string, _o: unknown, run: { signal?: AbortSignal; onProgress?: (p: number) => void }) => {
    run.onProgress?.(40)
    return gate('heavy', `audio:${basename(out)}`, run.signal)
  }
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
    queue = new IngestQueue({ projectFile: (pid, rel) => join(dir, pid, rel), resolveInput: (_p, a) => ({ path: (a.source as { path: string }).path }), encoders: () => ['libx264'] })
    done = []
    queue.on('done', (_pid, assetId, patch) => done.push({ assetId, patch }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /**
   * Libera as etapas pendentes uma a uma (FIFO) conferindo os limites a cada passo. Sem etapa pendente, só
   * termina quando a fila esvaziou: com a suíte inteira em paralelo, o fs real entre etapas pode demorar mais
   * que alguns ticks (antes isso encerrava cedo e deixava jobs vazando para o teste seguinte).
   */
  async function drain(): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await flush()
      expect(h.running.heavy).toBeLessThanOrEqual(1)
      expect(h.running.light).toBeLessThanOrEqual(2)
      const next = h.calls.find((c) => !c.settled)
      if (next) next.resolve()
      else if (!queue.busy('p')) return
      else await new Promise((r) => setTimeout(r, 5))
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
    for (const d of done) expect(d.patch).toMatchObject({ status: 'ready', proxy: `proxies/${d.assetId}.mp4`, filmstrip: `cache/${d.assetId}.strip.jpg`, peaks: `cache/${d.assetId}.peaks.bin`, speech: `cache/${d.assetId}.speech.json`, loudness: { integrated: -23, truePeak: -1, lra: 4 } })
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

  it('áudio não decodificável num vídeo com GOP longo: intermediário (áudio AAC) e proxy, os dois no slot pesado', async () => {
    queue.enqueue('p', { ...asset('a'), audio: { ...info.audio!, decodable: false } })
    await drain()
    expect(h.calls.filter((c) => c.kind === 'heavy')).toHaveLength(2)
    expect(done[0].patch).toMatchObject({ status: 'ready', intermediate: 'proxies/a.intermediate.mp4', proxy: 'proxies/a.mp4', audio: { decodable: false } })
  })

  it('falha na fala/loudness é opcional: o asset segue ready, só sem esses campos', async () => {
    queue.enqueue('p', asset('a'))
    // a fala espera um slot leve: libera as etapas à frente até ela começar
    for (let i = 0; i < 20 && !h.calls.some((c) => c.what === 'speech'); i++) {
      await flush()
      h.calls.find((c) => !c.settled && c.what !== 'speech')?.resolve()
    }
    const speech = h.calls.find((c) => c.what === 'speech')
    expect(speech).toBeDefined()
    speech!.fail(new Error('silencedetect quebrou'))
    await drain()
    expect(done).toHaveLength(1)
    expect(done[0].patch).toMatchObject({ status: 'ready', peaks: 'cache/a.peaks.bin', loudness: { integrated: -23, truePeak: -1, lra: 4 } })
    expect(done[0].patch.error).toBeUndefined()
    expect(done[0].patch.speech).toBeUndefined()
  })

  it('analyzeAudio: só fala + loudness (sem proxy, filmstrip nem peaks) e sem tocar no status', async () => {
    queue.enqueue('p', { ...asset('a'), status: 'ready' }, { analyzeAudio: true })
    await drain()
    expect(h.calls.map((c) => c.what).sort()).toEqual(['loudness', 'speech'])
    expect(done).toHaveLength(1)
    expect(done[0].patch).toEqual({ speech: 'cache/a.speech.json', loudness: { integrated: -23, truePeak: -1, lra: 4 } })
  })

  it('analyzeAudio com falha nas duas análises: patch vazio, nunca status error', async () => {
    queue.enqueue('p', { ...asset('a'), status: 'ready' }, { analyzeAudio: true })
    await flush()
    for (const c of h.calls) c.fail(new Error('x'))
    await drain()
    expect(done).toHaveLength(1)
    expect(done[0].patch).toEqual({})
  })

  it('analyzeAudio em asset sem áudio não faz nada', async () => {
    queue.enqueue('p', { ...asset('a'), status: 'ready', audio: undefined }, { analyzeAudio: true })
    await drain()
    expect(h.calls).toHaveLength(0)
    expect(done[0].patch).toEqual({})
  })

  describe('processAudio (redução de ruído/normalização em cache)', () => {
    const jobs: IngestJob[] = []
    let srcFile: string
    const fp = (): string => {
      const st = statSync(srcFile)
      return sourceFingerprint(st.size, st.mtimeMs)
    }
    beforeEach(() => {
      jobs.length = 0
      queue.on('progress', (j) => jobs.push(j))
      srcFile = join(dir, 'fonte.wav')
      writeFileSync(srcFile, Buffer.alloc(100))
    })
    const ready = (id = 'a'): Asset => ({ ...asset(id), status: 'ready', source: { type: 'file', path: srcFile, size: 100, mtimeMs: 1 } })

    it('gera no slot pesado o arquivo de (chave, impressão da fonte) em generated/, com progresso por chave e sem emitir done', async () => {
      const p = queue.processAudio('p', ready(), { denoise: true, normalize: true })
      await flush()
      expect(h.calls.map((c) => [c.kind, c.what])).toEqual([['heavy', `audio:a.audio-dn-sh_ln-i16-tp1.5.${fp()}.m4a`]])
      expect(queue.busy('p')).toBe(true)
      h.calls[0].resolve()
      await expect(p).resolves.toEqual({ key: 'dn-sh_ln-i16-tp1.5', fingerprint: fp(), rel: `generated/a.audio-dn-sh_ln-i16-tp1.5.${fp()}.m4a` })
      expect(jobs.some((j) => j.step === 'audioProcess' && j.key === 'dn-sh_ln-i16-tp1.5' && j.percent === 40)).toBe(true)
      expect(done).toHaveLength(0)
      expect(queue.busy('p')).toBe(false)
    })

    it('arquivo já existe (cache): devolve na hora sem ffmpeg', async () => {
      const file = join(dir, 'p', 'generated', `a.audio-dn-sh.${fp()}.m4a`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'x')
      await expect(queue.processAudio('p', ready(), { denoise: true, normalize: false })).resolves.toEqual({ key: 'dn-sh', fingerprint: fp(), rel: `generated/a.audio-dn-sh.${fp()}.m4a` })
      expect(h.calls).toHaveLength(0)
    })

    it('fonte trocada (relink/arquivo regravado): impressão nova, nunca acha o cache antigo', async () => {
      const old = join(dir, 'p', 'generated', `a.audio-dn-sh.${fp()}.m4a`)
      mkdirSync(dirname(old), { recursive: true })
      writeFileSync(old, 'x')
      writeFileSync(srcFile, Buffer.alloc(200))
      const p = queue.processAudio('p', ready(), { denoise: true, normalize: false })
      await flush()
      expect(h.calls.map((c) => c.what)).toEqual([`audio:a.audio-dn-sh.${fp()}.m4a`])
      h.calls[0].resolve()
      await expect(p).resolves.toMatchObject({ fingerprint: fp() })
      expect(basename(old)).not.toBe(`a.audio-dn-sh.${fp()}.m4a`)
    })

    it('fonte ilegível: rejeita sem deixar a fila ocupada', async () => {
      await expect(queue.processAudio('p', { ...ready(), source: { type: 'file', path: join(dir, 'nao-existe.wav'), size: 1, mtimeMs: 1 } }, { denoise: true, normalize: false })).rejects.toThrow()
      expect(queue.busy('p')).toBe(false)
    })

    it('pedidos repetidos da mesma chave compartilham a execução; chaves diferentes e a ingestão do asset não se cancelam', async () => {
      const a = queue.processAudio('p', ready(), { denoise: true, normalize: false })
      const b = queue.processAudio('p', ready(), { denoise: true, normalize: false })
      const c = queue.processAudio('p', ready(), { denoise: false, normalize: true })
      queue.enqueue('p', ready(), { analyzeAudio: true })
      await drain()
      await expect(a).resolves.toMatchObject({ key: 'dn-sh' })
      await expect(b).resolves.toMatchObject({ key: 'dn-sh' })
      await expect(c).resolves.toMatchObject({ key: 'ln-i16-tp1.5' })
      expect(h.calls.filter((x) => x.what.startsWith('audio:')).map((x) => x.what).sort()).toEqual([`audio:a.audio-dn-sh.${fp()}.m4a`, `audio:a.audio-ln-i16-tp1.5.${fp()}.m4a`])
      expect(h.calls.every((x) => !x.signal?.aborted)).toBe(true)
      expect(done).toHaveLength(1) // a análise de áudio
    })

    it('cancelAudio: cancela só o processamento de áudio daquele asset (a ingestão dele e o de outro asset seguem)', async () => {
      const mine = queue.processAudio('p', ready('a'), { denoise: true, normalize: false })
      const mine2 = queue.processAudio('p', ready('a'), { denoise: false, normalize: true })
      const other = queue.processAudio('p', ready('b'), { denoise: true, normalize: false })
      queue.enqueue('p', ready('a'), { analyzeAudio: true })
      await flush()
      queue.cancelAudio('p', 'a')
      const [r1, r2] = await Promise.allSettled([mine, mine2])
      expect([r1, r2].map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'ok'))).toEqual(['cancelado', 'cancelado'])
      await drain()
      await expect(other).resolves.toMatchObject({ key: 'dn-sh' })
      expect(done.map((d) => d.assetId)).toEqual(['a'])
      expect(queue.busy('p')).toBe(false)
      // depois de cancelado, um novo pedido da mesma chave roda de novo
      const again = queue.processAudio('p', ready('a'), { denoise: true, normalize: false })
      await drain()
      await expect(again).resolves.toMatchObject({ key: 'dn-sh' })
    })

    it('cancelar o projeto rejeita com CancelledError e libera a fila', async () => {
      const p = queue.processAudio('p', ready(), { denoise: true, normalize: false })
      await flush()
      queue.cancel('p')
      await expect(p).rejects.toThrow('cancelado')
      expect(queue.busy('p')).toBe(false)
    })

    it('sem flags ou asset sem áudio: erro (nada a processar)', async () => {
      await expect(queue.processAudio('p', ready(), { denoise: false, normalize: false })).rejects.toThrow()
      await expect(queue.processAudio('p', { ...ready(), audio: undefined }, { denoise: true, normalize: false })).rejects.toThrow()
    })
  })
})
