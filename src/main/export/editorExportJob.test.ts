import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
type Opts = { signal?: AbortSignal; onProgress?: (p: { outTimeUs: number }) => void }
// ffmpeg falso: "remuxa" copiando a entrada (-i) para a saída (último argumento)
const runFfmpeg = vi.fn(async (args: string[], opts: Opts) => {
  void opts
  copyFileSync(args[args.indexOf('-i') + 1], args[args.length - 1])
  return { code: 0, stderrTail: '', cancelled: false }
})
vi.mock('./ffmpegRunner', () => ({ runFfmpeg: (args: string[], opts: Opts) => runFfmpeg(args, opts) }))

const { EditorExportJobs, editorExportFileName, FREE_SPACE_FACTOR } = await import('./editorExportJob')

let dir: string
const plenty = { freeBytes: async () => 1e15 }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edx-'))
  runFfmpeg.mockClear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('EditorExportJobs', () => {
  it('grava por posição no .part e finaliza com faststart no nome final (sem .part), com progresso do remux', async () => {
    runFfmpeg.mockImplementationOnce(async (args: string[], opts: Opts) => {
      opts.onProgress?.({ outTimeUs: 1_000_000 })
      copyFileSync(args[args.indexOf('-i') + 1], args[args.length - 1])
      return { code: 0, stderrTail: '', cancelled: false }
    })
    const jobs = new EditorExportJobs(plenty)
    const { jobId, path } = await jobs.open(dir, 'Meu vídeo')
    expect(path).toBe(join(dir, 'Meu vídeo.mp4'))
    expect(existsSync(`${path}.part`)).toBe(true)
    await Promise.all([jobs.write(jobId, new Uint8Array([4, 5, 6]), 3), jobs.write(jobId, new Uint8Array([1, 2, 3]), 0)])
    const fractions: number[] = []
    const r = await jobs.finalize(jobId, { durationUs: 2_000_000, onProgress: (f) => fractions.push(f) })
    expect(r).toEqual({ path, size: 6 })
    expect(fractions).toEqual([0.5])
    expect([...readFileSync(path)]).toEqual([1, 2, 3, 4, 5, 6])
    expect(readdirSync(dir)).toEqual(['Meu vídeo.mp4'])
    expect(runFfmpeg.mock.calls[0][0]).toEqual(expect.arrayContaining(['-c', 'copy', '-movflags', '+faststart', '-n']))
    expect(runFfmpeg.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('nunca sobrescreve: nome ocupado ganha " (2)", " (3)"', async () => {
    writeFileSync(join(dir, 'x.mp4'), 'antigo')
    writeFileSync(join(dir, 'x (2).mp4'), 'antigo')
    const jobs = new EditorExportJobs(plenty)
    const { jobId, path } = await jobs.open(dir, 'x.mp4')
    expect(path).toBe(join(dir, 'x (3).mp4'))
    writeFileSync(path, 'outro programa') // ocupado durante a exportação: o finalize pega o próximo
    await jobs.write(jobId, new Uint8Array([9]), 0)
    const r = await jobs.finalize(jobId)
    expect(r.path).toBe(join(dir, 'x (4).mp4'))
    expect(readFileSync(join(dir, 'x.mp4'), 'utf8')).toBe('antigo')
    expect(readFileSync(join(dir, 'x (3).mp4'), 'utf8')).toBe('outro programa')
  })

  it('cancelar apaga o parcial; uma exportação por vez; cancelOwnedBy', async () => {
    const jobs = new EditorExportJobs(plenty)
    const a = await jobs.open(dir, 'a')
    await expect(jobs.open(dir, 'b')).rejects.toThrow(/em andamento/)
    await jobs.write(a.jobId, new Uint8Array([1]), 0)
    await jobs.cancel(a.jobId)
    await jobs.cancel(a.jobId)
    expect(readdirSync(dir)).toEqual([])
    await expect(jobs.write(a.jobId, new Uint8Array([1]), 0)).rejects.toThrow()
    const b = await jobs.open(dir, 'b', 7)
    await jobs.cancelOwnedBy(8)
    expect(existsSync(`${b.path}.part`)).toBe(true)
    await jobs.cancelOwnedBy(7)
    expect(readdirSync(dir)).toEqual([])
  })

  it('cancelar durante o remux: interrompe o ffmpeg, espera ele sair e apaga .part e a saída criada', async () => {
    let started: () => void = () => {}
    const remuxStarted = new Promise<void>((r) => (started = r))
    runFfmpeg.mockImplementationOnce(async (args: string[], opts: Opts) => {
      writeFileSync(args[args.length - 1], 'meio do remux')
      started()
      await new Promise<void>((r) => opts.signal!.addEventListener('abort', () => setTimeout(r, 20)))
      return { code: 1, stderrTail: '', cancelled: true }
    })
    const jobs = new EditorExportJobs(plenty)
    const { jobId } = await jobs.open(dir, 'z')
    await jobs.write(jobId, new Uint8Array([1]), 0)
    const fin = jobs.finalize(jobId)
    fin.catch(() => {})
    await remuxStarted
    await jobs.cancel(jobId)
    expect(readdirSync(dir)).toEqual([])
    await expect(fin).rejects.toThrow('cancelado')
    expect(jobs.busy).toBe(false)
  })

  it('falha no remux (ex.: antivírus segurando o arquivo) não perde o render: o .part vira o arquivo final, com aviso', async () => {
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      writeFileSync(args[args.length - 1], 'meio')
      throw new Error('ffmpeg falhou')
    })
    const jobs = new EditorExportJobs(plenty)
    const { jobId, path } = await jobs.open(dir, 'y')
    await jobs.write(jobId, new Uint8Array([1, 2, 3]), 0)
    const r = await jobs.finalize(jobId)
    expect(r.path).toBe(path)
    expect(r.size).toBe(3)
    expect(r.warning).toMatch(/otimização/)
    expect([...readFileSync(path)]).toEqual([1, 2, 3]) // o render, não a saída pela metade do ffmpeg
    expect(readdirSync(dir)).toEqual(['y.mp4'])

    // arquivos alheios (inclusive o criado no último instante, que o ffmpeg -n recusa) nunca são apagados nem sobrescritos
    const j2 = await jobs.open(dir, 'w')
    writeFileSync(join(dir, 'w.mp4'), 'alheio')
    writeFileSync(join(dir, 'w (2).mp4'), 'alheio 2')
    await jobs.write(j2.jobId, new Uint8Array([7]), 0)
    runFfmpeg.mockImplementationOnce(async () => {
      throw new Error('already exists')
    })
    const r2 = await jobs.finalize(j2.jobId)
    expect(r2.path).toBe(join(dir, 'w (3).mp4'))
    expect(readFileSync(join(dir, 'w.mp4'), 'utf8')).toBe('alheio')
    expect(readFileSync(join(dir, 'w (2).mp4'), 'utf8')).toBe('alheio 2')
    expect([...readFileSync(r2.path)]).toEqual([7])
  })

  it('maxBytes: saída maior que o alvo é apagada e volta oversize', async () => {
    const jobs = new EditorExportJobs(plenty)
    const { jobId, path } = await jobs.open(dir, 'grande')
    await jobs.write(jobId, new Uint8Array(100), 0)
    const r = await jobs.finalize(jobId, { maxBytes: 50 })
    expect(r).toEqual({ path, size: 100, oversize: true })
    expect(readdirSync(dir)).toEqual([])
  })

  it('espaço livre: exige estimativa × 2,1', async () => {
    const jobs = new EditorExportJobs({ freeBytes: async () => 200 * 1048576 })
    await expect(jobs.open(dir, 'a', 0, 100 * 1048576)).rejects.toThrow(/Espaço insuficiente.*cerca de 210 MB.*há 200 MB/)
    expect(readdirSync(dir)).toEqual([])
    expect(jobs.busy).toBe(false)
    const ok = await jobs.open(dir, 'a', 0, Math.floor((200 * 1048576) / FREE_SPACE_FACTOR))
    await jobs.cancel(ok.jobId)
  })
})

describe('editorExportFileName', () => {
  it('saneia e garante .mp4', () => {
    expect(editorExportFileName('a:b?')).toBe('ab.mp4')
    expect(editorExportFileName('Video.MP4')).toBe('Video.MP4')
    expect(editorExportFileName('   ')).toBe('Vídeo.mp4')
  })
})

describe('editorExportFileName com formato', () => {
  it('o formato decide a extensão; extensão de mídia errada digitada é trocada', () => {
    expect(editorExportFileName('Clipe', 'gif')).toBe('Clipe.gif')
    expect(editorExportFileName('Clipe.mp4', 'gif')).toBe('Clipe.gif')
    expect(editorExportFileName('Clipe.GIF', 'gif')).toBe('Clipe.GIF')
    expect(editorExportFileName('Trilha.wav', 'mp3')).toBe('Trilha.mp3')
    expect(editorExportFileName('Trilha.m4a', 'wav')).toBe('Trilha.wav')
    expect(editorExportFileName('Quadro.png.mp4', 'png')).toBe('Quadro.png')
    expect(editorExportFileName('v1.2 final', 'm4a')).toBe('v1.2 final.m4a')
    expect(editorExportFileName('Vídeo.mov', 'mp4')).toBe('Vídeo.mp4')
    expect(editorExportFileName('', 'png')).toBe('Vídeo.png')
  })
})

/** ffmpeg por pipe falso: guarda os bytes e, no end, grava-os no arquivo de saída (último argumento). */
function fakePipe(args: string[]) {
  const chunks: number[] = []
  let aborted = false
  return {
    args,
    write: vi.fn(async (c: Uint8Array) => {
      if (aborted) throw new Error('cancelado')
      chunks.push(...c)
    }),
    end: vi.fn(async () => {
      writeFileSync(args[args.length - 1], Buffer.from(chunks))
      return { code: 0, stderrTail: '', cancelled: aborted }
    }),
    abort: vi.fn(async () => {
      aborted = true
    })
  }
}

describe('EditorExportJobs — saídas por pipe (GIF / só áudio)', () => {
  const gifSpec = { kind: 'gif', width: 4, height: 2, fps: 12, loop: true } as const
  const wavSpec = { kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2 } as const
  let pipes: ReturnType<typeof fakePipe>[]
  const deps = () => ({
    ...plenty,
    openPipe: (args: string[]) => {
      const p = fakePipe(args)
      pipes.push(p)
      return p
    }
  })
  beforeEach(() => {
    pipes = []
  })

  it('só áudio: grava pelo pipe em <nome>.wav.part e finaliza no nome final, sem sobras', async () => {
    const jobs = new EditorExportJobs(deps())
    const { jobId, path } = await jobs.openPipe(dir, 'Trilha.mp4', wavSpec)
    expect(path).toBe(join(dir, 'Trilha.wav'))
    expect(pipes[0].args[pipes[0].args.length - 1]).toBe(join(dir, 'Trilha.wav.part'))
    expect(pipes[0].args).toEqual(expect.arrayContaining(['-c:a', 'pcm_s16le']))
    expect(jobs.busy).toBe(true)
    await jobs.pipeWrite(jobId, new Uint8Array([1, 2]))
    await jobs.pipeWrite(jobId, new Uint8Array([3]))
    const r = await jobs.pipeFinish(jobId)
    expect(r).toEqual({ path, size: 3 })
    expect(readdirSync(dir)).toEqual(['Trilha.wav'])
    expect(jobs.busy).toBe(false)
  })

  it('GIF: passada 1 no FFV1 temporário, paleta e paletteuse (com progresso) → .gif; temporários apagados', async () => {
    const calls: string[][] = []
    runFfmpeg.mockImplementation(async (args: string[], opts: Opts) => {
      calls.push(args)
      opts.onProgress?.({ outTimeUs: 1_000_000 / 12 })
      writeFileSync(args[args.length - 1], args.includes('gif') ? 'GIF89a' : 'paleta')
      return { code: 0, stderrTail: '', cancelled: false }
    })
    try {
      const jobs = new EditorExportJobs(deps())
      const { jobId, path } = await jobs.openPipe(dir, 'Clipe', gifSpec, 0)
      expect(path).toBe(join(dir, 'Clipe.gif'))
      const lossless = join(dir, 'Clipe.gif.ffv1.part')
      expect(pipes[0].args[pipes[0].args.length - 1]).toBe(lossless)
      // 2 quadros de 4×2 RGBA
      await jobs.pipeWrite(jobId, new Uint8Array(32))
      await jobs.pipeWrite(jobId, new Uint8Array(32))
      const fractions: number[] = []
      const r = await jobs.pipeFinish(jobId, { onProgress: (f) => fractions.push(f) })
      expect(r).toEqual({ path, size: 6 })
      expect(calls.map((a) => a.includes('palettegen=stats_mode=diff'))).toEqual([true, false])
      expect(calls[1]).toEqual(expect.arrayContaining(['-i', lossless, '-i', join(dir, 'Clipe.gif.palette.part'), '-loop', '0']))
      expect(calls[1][calls[1].length - 1]).toBe(join(dir, 'Clipe.gif.part'))
      // 2 quadros a 12 fps: progresso relativo à duração, crescente e no fim 1
      expect(fractions.length).toBeGreaterThan(1)
      expect(fractions[fractions.length - 1]).toBe(1)
      expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
      expect(readdirSync(dir)).toEqual(['Clipe.gif'])
    } finally {
      runFfmpeg.mockImplementation(async (args: string[]) => {
        copyFileSync(args[args.indexOf('-i') + 1], args[args.length - 1])
        return { code: 0, stderrTail: '', cancelled: false }
      })
    }
  })

  it('uma exportação por vez (vale entre MP4, pipe e quadro); cancelar mata o ffmpeg e apaga parcial e temporários', async () => {
    const jobs = new EditorExportJobs(deps())
    const { jobId } = await jobs.openPipe(dir, 'g', gifSpec)
    await expect(jobs.open(dir, 'x')).rejects.toThrow(/em andamento/)
    await expect(jobs.openPipe(dir, 'y', wavSpec)).rejects.toThrow(/em andamento/)
    await expect(jobs.writeStill(dir, 'q', new Uint8Array([1]))).rejects.toThrow(/em andamento/)
    await jobs.pipeWrite(jobId, new Uint8Array(32))
    writeFileSync(join(dir, 'g.gif.ffv1.part'), 'temporário')
    await jobs.cancel(jobId)
    expect(pipes[0].abort).toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
    expect(jobs.busy).toBe(false)
    await expect(jobs.pipeWrite(jobId, new Uint8Array(1))).rejects.toThrow()
  })

  it('cancelar durante a paleta: interrompe o ffmpeg e não sobra nada', async () => {
    let started: () => void = () => {}
    const paletteStarted = new Promise<void>((r) => (started = r))
    runFfmpeg.mockImplementationOnce(async (args: string[], opts: Opts) => {
      writeFileSync(args[args.length - 1], 'meia paleta')
      started()
      await new Promise<void>((r) => opts.signal!.addEventListener('abort', () => setTimeout(r, 20)))
      return { code: 1, stderrTail: '', cancelled: true }
    })
    const jobs = new EditorExportJobs(deps())
    const { jobId } = await jobs.openPipe(dir, 'c', gifSpec)
    await jobs.pipeWrite(jobId, new Uint8Array(32))
    const fin = jobs.pipeFinish(jobId)
    fin.catch(() => {})
    await paletteStarted
    await jobs.cancel(jobId)
    await expect(fin).rejects.toThrow('cancelado')
    expect(readdirSync(dir)).toEqual([])
    expect(jobs.busy).toBe(false)
  })

  it('ffmpeg que falha na finalização: erro com a causa, sem .part nem temporários', async () => {
    const failing = (args: string[]) => ({
      ...fakePipe(args),
      end: async () => {
        writeFileSync(args[args.length - 1], 'x')
        throw new Error('ffmpeg saiu com código 1')
      }
    })
    const jobs = new EditorExportJobs({ ...plenty, openPipe: failing })
    const { jobId } = await jobs.openPipe(dir, 'f', wavSpec)
    await expect(jobs.pipeFinish(jobId)).rejects.toThrow(/código 1/)
    expect(readdirSync(dir)).toEqual([])
    expect(jobs.busy).toBe(false)
  })

  it('pedido inválido é recusado no main', async () => {
    const jobs = new EditorExportJobs(deps())
    await expect(jobs.openPipe(dir, 'a', { kind: 'gif', width: 3, height: 2, fps: 12, loop: true })).rejects.toThrow('Formato de exportação inválido')
    expect(jobs.busy).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('espaço livre também vale para o pipe', async () => {
    const jobs = new EditorExportJobs({ freeBytes: async () => 100, openPipe: (a: string[]) => fakePipe(a) })
    await expect(jobs.openPipe(dir, 'a', wavSpec, 0, 1000)).rejects.toThrow(/Espaço insuficiente/)
    expect(jobs.busy).toBe(false)
  })
})

describe('EditorExportJobs.writeStill', () => {
  it('grava atômico (.part → nome final), nunca sobrescreve, extensão .png', async () => {
    writeFileSync(join(dir, 'Projeto - 00m12s.png'), 'antigo')
    const jobs = new EditorExportJobs(plenty)
    const r = await jobs.writeStill(dir, 'Projeto - 00m12s.mp4', new Uint8Array([137, 80, 78, 71]))
    expect(r).toEqual({ path: join(dir, 'Projeto - 00m12s (2).png'), size: 4 })
    expect(readFileSync(join(dir, 'Projeto - 00m12s.png'), 'utf8')).toBe('antigo')
    expect([...readFileSync(r.path)]).toEqual([137, 80, 78, 71])
    expect(readdirSync(dir).sort()).toEqual(['Projeto - 00m12s (2).png', 'Projeto - 00m12s.png'])
    expect(jobs.busy).toBe(false)
  })
})
