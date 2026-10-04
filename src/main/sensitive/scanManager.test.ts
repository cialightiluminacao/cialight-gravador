import { describe, expect, it } from 'vitest'
import type { ScanResult } from '@shared/editor/sensitiveScan'
import type { ScanRequest, ScanRunOpts } from './scan'
import { EventEmitter } from 'events'
import { MAX_CUSTOM_TERMS, probeVideoStream, SensitiveScans, startScanForSender, validateScanRequest } from './scanManager'

const FILE = 'C:\\videos\\gravacao.mp4'
const isFile = (p: string): boolean => p === FILE
const ok = { filePath: FILE, fromUs: 0, toUs: 5_000_000 }
const empty: ScanResult = { occurrences: [], framesSampled: 0, framesOcr: 0, ms: 0, lang: 'en-US' }

describe('validateScanRequest', () => {
  it('aceita o pedido válido e arredonda os tempos para µs inteiros', () => {
    const v = validateScanRequest({ ...ok, fromUs: 10.4, toUs: 20.6, kinds: ['cpf', 'cpf', 'email'], customTerms: ['Projeto X'] }, isFile)
    expect(v).toEqual({ ok: true, req: { filePath: FILE, fromUs: 10, toUs: 21, kinds: ['cpf', 'email'], customTerms: ['Projeto X'] } })
  })
  it.each([
    ['sem objeto', null],
    ['caminho relativo', { ...ok, filePath: 'gravacao.mp4' }],
    ['não é vídeo', { ...ok, filePath: 'C:\\videos\\nota.txt' }],
    ['arquivo inexistente', { ...ok, filePath: 'C:\\videos\\outro.mp4' }],
    ['NaN', { ...ok, fromUs: NaN }],
    ['Infinity', { ...ok, toUs: Infinity }],
    ['texto no tempo', { ...ok, toUs: '5000000' }],
    ['trecho invertido', { ...ok, fromUs: 6_000_000 }],
    ['negativo', { ...ok, fromUs: -1 }],
    ['tipo desconhecido', { ...ok, kinds: ['cpf', 'senha'] }],
    ['termos demais', { ...ok, customTerms: Array.from({ length: MAX_CUSTOM_TERMS + 1 }, (_, i) => `t${i}`) }],
    ['termo longo demais', { ...ok, customTerms: ['x'.repeat(101)] }],
    ['termo não-texto', { ...ok, customTerms: [42] }],
    ['faixa de vídeo negativa', { ...ok, videoStreamIndex: -1 }],
    ['faixa de vídeo fracionária', { ...ok, videoStreamIndex: 1.5 }],
    ['faixa de vídeo em texto', { ...ok, videoStreamIndex: '1' }],
    ['faixa de vídeo absurda', { ...ok, videoStreamIndex: 64 }]
  ])('recusa: %s', (_n, raw) => {
    const v = validateScanRequest(raw, isFile)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.error.code).toBe('invalid')
      expect(v.error.message).toMatch(/^Pedido de busca de dados sensíveis inválido/)
    }
  })
  it('videoStreamIndex inteiro ≥ 0 passa adiante (ruling R23); ausente fica ausente', () => {
    expect(validateScanRequest({ ...ok, videoStreamIndex: 1 }, isFile)).toEqual({ ok: true, req: { ...ok, videoStreamIndex: 1 } })
    expect(validateScanRequest({ ...ok, videoStreamIndex: 0 }, isFile)).toEqual({ ok: true, req: { ...ok, videoStreamIndex: 0 } })
    expect(validateScanRequest(ok, isFile)).toEqual({ ok: true, req: ok })
  })
  it('50 termos de 100 caracteres passam', () => {
    expect(validateScanRequest({ ...ok, customTerms: Array.from({ length: 50 }, () => 'y'.repeat(100)) }, isFile).ok).toBe(true)
  })
})

describe('probeVideoStream (ruling R23)', () => {
  const webcam = { codec_type: 'video', width: 640, height: 480, avg_frame_rate: '30/1', r_frame_rate: '30/1', codec_name: 'h264', side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }
  it('v:0 usa o probe normal (sem ffprobe extra)', async () => {
    const calls: string[][] = []
    const r = await probeVideoStream(FILE, 0, { probe: async () => ({ video: { width: 1920, height: 1080 }, durationUs: 5 }), run: async (a) => (calls.push(a), '') })
    expect(r.video).toEqual({ width: 1920, height: 1080 })
    expect(calls).toEqual([])
  })
  it('v:1 pede só a faixa 1 ao ffprobe e devolve o tamanho/giro DELA', async () => {
    const calls: string[][] = []
    const r = await probeVideoStream(FILE, 1, {
      probe: async () => { throw new Error('não deveria usar o probe da v:0') },
      run: async (a) => (calls.push(a), JSON.stringify({ streams: [webcam], format: { duration: '8.0' } }))
    })
    expect(calls[0].slice(calls[0].indexOf('-select_streams'), calls[0].indexOf('-select_streams') + 2)).toEqual(['-select_streams', 'v:1'])
    expect(calls[0].at(-1)).toBe(FILE)
    expect(r.video).toMatchObject({ width: 640, height: 480, rotation: 90 })
    expect(r.durationUs).toBe(8_000_000)
  })
  it('faixa inexistente: erro (a varredura vira erro de ffmpeg, nunca a faixa errada)', async () => {
    await expect(probeVideoStream(FILE, 3, { probe: async () => ({ durationUs: 1 }), run: async () => JSON.stringify({ streams: [], format: { duration: '8' } }) })).rejects.toThrow(/v:3/)
  })
})

describe('SensitiveScans', () => {
  it('uma por vez: a 2ª recebe busy (sem done); progresso e done levam o scanId; depois libera', async () => {
    let finish: (r: ScanResult) => void = () => {}
    const run = (_r: ScanRequest, o: ScanRunOpts): Promise<ScanResult> => {
      o.onProgress?.({ phase: 'lendo', done: 1, total: 4 })
      return new Promise((res) => (finish = res))
    }
    const m = new SensitiveScans(run, isFile)
    const progress: unknown[] = [], done: { scanId: string; result: ScanResult }[] = []
    const sink = { progress: (p: unknown) => progress.push(p), done: (d: { scanId: string; result: ScanResult }) => done.push(d) }
    const a = m.start(ok, sink)
    expect(a.error).toBeUndefined()
    expect(m.running).toBe(a.scanId)
    expect(progress).toEqual([{ scanId: a.scanId, phase: 'lendo', done: 1, total: 4 }])
    const b = m.start(ok, sink)
    expect(b.error?.code).toBe('busy')
    expect(b.error?.message).toMatch(/em andamento/)
    finish(empty)
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toEqual([{ scanId: a.scanId, result: empty }])
    expect(m.running).toBeNull()
    expect(m.start(ok, sink).error).toBeUndefined()
  })
  it('cancel aborta o sinal da varredura certa; inválido não começa', async () => {
    let signal: AbortSignal | undefined
    const run = (_r: ScanRequest, o: ScanRunOpts): Promise<ScanResult> => {
      signal = o.signal
      return new Promise((res) => o.signal?.addEventListener('abort', () => res({ ...empty, cancelled: true })))
    }
    const m = new SensitiveScans(run, isFile)
    const done: { scanId: string; result: ScanResult }[] = []
    expect(m.start({ ...ok, toUs: NaN }, { progress: () => {}, done: (d) => done.push(d) }).error?.code).toBe('invalid')
    expect(m.running).toBeNull()
    const a = m.start(ok, { progress: () => {}, done: (d) => done.push(d) })
    expect(m.cancel('outro')).toBe(false)
    expect(signal?.aborted).toBe(false)
    expect(m.cancel(a.scanId)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(done[0].result.cancelled).toBe(true)
  })
  it('falha inesperada do executor vira done com erro (nunca fica preso em busy)', async () => {
    const m = new SensitiveScans(() => Promise.reject(new Error('x')), isFile)
    const done: { scanId: string; result: ScanResult }[] = []
    m.start(ok, { progress: () => {}, done: (d) => done.push(d) })
    await new Promise((r) => setTimeout(r, 0))
    expect(done[0].result.error?.code).toBe('ffmpeg')
    expect(m.running).toBeNull()
  })
})

describe('startScanForSender (achado #2 da revisão final: a varredura segue a vida da página)', () => {
  /** webContents falso: EventEmitter + isDestroyed/send. */
  class FakeWc extends EventEmitter {
    destroyed = false
    sent: [string, unknown][] = []
    isDestroyed(): boolean {
      return this.destroyed
    }
    send(channel: string, payload: unknown): void {
      this.sent.push([channel, payload])
    }
  }
  const EVENTS = ['destroyed', 'render-process-gone', 'did-start-navigation'] as const
  const listeners = (wc: FakeWc): number => EVENTS.reduce((n, e) => n + wc.listenerCount(e), 0)
  const cancellable = (): { run: (r: ScanRequest, o: ScanRunOpts) => Promise<ScanResult>; finish: () => void } => {
    let finish = (): void => {}
    return {
      run: (_r, o) => new Promise((res) => {
        finish = () => res(empty)
        o.signal?.addEventListener('abort', () => res({ ...empty, cancelled: true }))
      }),
      finish: () => finish()
    }
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const ch = { progress: 'p', done: 'd' }

  it('ao terminar, os ouvintes do webContents saem (sem MaxListenersExceededWarning após muitas buscas)', async () => {
    const wc = new FakeWc()
    for (let i = 0; i < 15; i++) {
      const c = cancellable()
      const m = new SensitiveScans(c.run, isFile)
      const r = startScanForSender(m, wc, ok, ch)
      expect(r.error).toBeUndefined()
      expect(listeners(wc)).toBe(3)
      c.finish()
      await tick()
      expect(listeners(wc)).toBe(0)
    }
    expect(wc.sent.filter(([c]) => c === 'd')).toHaveLength(15)
  })
  it('erro imediato (busy/invalid) não deixa ouvinte', () => {
    const wc = new FakeWc()
    const m = new SensitiveScans(cancellable().run, isFile)
    expect(startScanForSender(m, wc, { ...ok, toUs: NaN }, ch).error?.code).toBe('invalid')
    expect(listeners(wc)).toBe(0)
  })
  for (const [name, emit] of [
    ['janela fechada (destroyed)', (wc: FakeWc) => { wc.destroyed = true; wc.emit('destroyed') }],
    ['renderer caiu (render-process-gone)', (wc: FakeWc) => wc.emit('render-process-gone', {}, { reason: 'crashed' })],
    ['recarregou (did-start-navigation do quadro principal)', (wc: FakeWc) => wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'app://x' })]
  ] as const) {
    it(`${name} cancela a varredura e libera a próxima`, async () => {
      const wc = new FakeWc()
      const m = new SensitiveScans(cancellable().run, isFile)
      const r = startScanForSender(m, wc, ok, ch)
      emit(wc)
      await tick()
      expect(m.running).toBeNull()
      expect(listeners(wc)).toBe(0)
      if (!wc.destroyed) expect(wc.sent.find(([c]) => c === 'd')?.[1]).toMatchObject({ scanId: r.scanId, result: { cancelled: true } })
      else expect(wc.sent).toEqual([])
    })
  }
  it('navegação de subquadro ou na mesma página (hash) não cancela', async () => {
    const wc = new FakeWc()
    const c = cancellable()
    const m = new SensitiveScans(c.run, isFile)
    const r = startScanForSender(m, wc, ok, ch)
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'x' })
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: '#a' })
    await tick()
    expect(m.running).toBe(r.scanId)
    c.finish()
    await tick()
    expect(m.running).toBeNull()
  })
})
