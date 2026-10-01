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

  it('falha no remux apaga o .part e a saída que ESTE job criou, nunca um arquivo alheio', async () => {
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      writeFileSync(args[args.length - 1], 'meio')
      throw new Error('ffmpeg falhou')
    })
    const jobs = new EditorExportJobs(plenty)
    const { jobId } = await jobs.open(dir, 'y')
    await expect(jobs.finalize(jobId)).rejects.toThrow('ffmpeg falhou')
    expect(readdirSync(dir)).toEqual([])

    // arquivos alheios (inclusive o criado no último instante, que o ffmpeg -n recusa) nunca são apagados
    const j2 = await jobs.open(dir, 'w')
    writeFileSync(join(dir, 'w.mp4'), 'alheio')
    writeFileSync(join(dir, 'w (2).mp4'), 'alheio 2')
    runFfmpeg.mockImplementationOnce(async () => {
      throw new Error('already exists')
    })
    await expect(jobs.finalize(j2.jobId)).rejects.toThrow()
    expect(readFileSync(join(dir, 'w.mp4'), 'utf8')).toBe('alheio')
    expect(readFileSync(join(dir, 'w (2).mp4'), 'utf8')).toBe('alheio 2')
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
