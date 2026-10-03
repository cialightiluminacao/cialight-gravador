import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'

vi.mock('../log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('./ffmpegPath', () => ({ ffmpegPath: () => 'ffmpeg.exe', ffprobePath: () => 'ffprobe.exe' }))

const { openFfmpegPipe } = await import('./ffmpegPipe')
const { FfmpegError } = await import('./ffmpegRunner')

/** Filho falso: stdin com highWaterMark pequeno e gravações que só terminam quando o teste "consome". */
function fakeChild(hwm = 4) {
  const held: (() => void)[] = []
  const received: number[] = []
  const child = new EventEmitter() as EventEmitter & { pid: number; stdin: Writable; stdout: PassThrough; stderr: PassThrough; spawnArgs?: unknown[] }
  child.pid = 4242
  child.stdin = new Writable({
    highWaterMark: hwm,
    write(chunk: Buffer, _enc, cb) {
      received.push(...chunk)
      held.push(() => cb())
    }
  })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  /** O ffmpeg "lê" tudo o que está pendente no stdin. */
  const consume = (): void => {
    while (held.length) held.shift()!()
  }
  const exit = (code: number): void => {
    child.stdout.end()
    child.stderr.end()
    child.emit('close', code)
  }
  return { child, consume, exit, received }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function open(f: ReturnType<typeof fakeChild>, onProgress?: (p: { outTimeUs: number }) => void) {
  const kill = vi.fn(() => f.exit(1))
  const spawn = vi.fn(() => f.child)
  const pipe = openFfmpegPipe(['-i', 'pipe:0', 'out'], { onProgress, label: 'teste' }, { spawn: spawn as never, kill })
  return { pipe, kill, spawn }
}

describe('openFfmpegPipe', () => {
  it('abre o ffmpeg com stdin em pipe e sem janela', () => {
    const f = fakeChild()
    const { spawn } = open(f)
    expect(spawn).toHaveBeenCalledWith('ffmpeg.exe', ['-i', 'pipe:0', 'out'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  })

  it('contrapressão: write() false → só resolve depois do drain', async () => {
    const f = fakeChild(4)
    const { pipe } = open(f)
    await pipe.write(new Uint8Array([1, 2])) // abaixo do limite: aceito na hora
    let done = false
    const p = pipe.write(new Uint8Array([3, 4, 5, 6])).then(() => (done = true))
    await tick()
    await tick()
    expect(done).toBe(false) // buffer cheio: espera o ffmpeg ler
    f.consume()
    await p
    expect(done).toBe(true)
    expect(f.received).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('end(): fecha o stdin e resolve com o código 0; progresso lido do -progress', async () => {
    const f = fakeChild()
    const seen: number[] = []
    const { pipe } = open(f, (p) => seen.push(p.outTimeUs))
    let stdinEnded = false
    f.child.stdin.on('finish', () => (stdinEnded = true))
    await pipe.write(new Uint8Array([1]))
    f.child.stdout.write('frame=1\nout_time_us=500000\nprogress=continue\n')
    const r = pipe.end()
    f.consume()
    await tick()
    expect(stdinEnded).toBe(true)
    f.exit(0)
    await expect(r).resolves.toEqual({ code: 0, stderrTail: '', cancelled: false })
    expect(seen).toEqual([500000])
  })

  it('ffmpeg que morre: a gravação em espera e as próximas rejeitam com FfmpegError e o stderr', async () => {
    const f = fakeChild(2)
    const { pipe } = open(f)
    const waiting = pipe.write(new Uint8Array([1, 2, 3, 4]))
    f.child.stderr.write('Invalid data found\n')
    await tick()
    f.exit(1)
    await expect(waiting).rejects.toBeInstanceOf(FfmpegError)
    await expect(pipe.write(new Uint8Array([5]))).rejects.toThrow(/código 1/)
    await expect(pipe.end()).rejects.toMatchObject({ stderrTail: 'Invalid data found' })
  })

  it('abort(): mata a árvore, espera o processo sair e rejeita gravações pendentes; idempotente', async () => {
    const f = fakeChild(2)
    const { pipe, kill } = open(f)
    const waiting = pipe.write(new Uint8Array([1, 2, 3, 4]))
    await pipe.abort()
    expect(kill).toHaveBeenCalledTimes(1)
    await expect(waiting).rejects.toThrow()
    await pipe.abort()
    expect(kill).toHaveBeenCalledTimes(1) // já saiu: não mata de novo
    await expect(pipe.write(new Uint8Array([1]))).rejects.toThrow('cancelado')
    await expect(pipe.end()).resolves.toMatchObject({ cancelled: true })
  })

  it('erro ao iniciar (spawn error): gravações rejeitam e o end rejeita com a causa', async () => {
    const f = fakeChild()
    const { pipe } = open(f)
    f.child.emit('error', new Error('ENOENT'))
    await expect(pipe.write(new Uint8Array([1]))).rejects.toThrow(/não foi possível iniciar o ffmpeg: ENOENT/)
    await expect(pipe.end()).rejects.toThrow(/ENOENT/)
  })

  it('EPIPE no stdin (ffmpeg fechou a entrada) não derruba o processo', async () => {
    const f = fakeChild()
    open(f)
    expect(() => f.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
  })
})
