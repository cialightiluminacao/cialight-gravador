import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
// ffmpeg falso: "remuxa" copiando a entrada (-i) para a saída (último argumento)
const runFfmpeg = vi.fn(async (args: string[]) => {
  copyFileSync(args[args.indexOf('-i') + 1], args[args.length - 1])
  return { code: 0, stderr: '' }
})
vi.mock('./ffmpegRunner', () => ({ runFfmpeg: (args: string[]) => runFfmpeg(args) }))

const { EditorExportJobs, editorExportFileName } = await import('./editorExportJob')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edx-'))
  runFfmpeg.mockClear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('EditorExportJobs', () => {
  it('grava por posição no .part e finaliza com faststart no nome final (sem .part)', async () => {
    const jobs = new EditorExportJobs()
    const { jobId, path } = jobs.open(dir, 'Meu vídeo')
    expect(path).toBe(join(dir, 'Meu vídeo.mp4'))
    expect(existsSync(`${path}.part`)).toBe(true)
    jobs.write(jobId, new Uint8Array([4, 5, 6]), 3)
    jobs.write(jobId, new Uint8Array([1, 2, 3]), 0)
    const r = await jobs.finalize(jobId)
    expect(r).toEqual({ path, size: 6 })
    expect([...readFileSync(path)]).toEqual([1, 2, 3, 4, 5, 6])
    expect(readdirSync(dir)).toEqual(['Meu vídeo.mp4'])
    const args = runFfmpeg.mock.calls[0][0]
    expect(args).toEqual(expect.arrayContaining(['-c', 'copy', '-movflags', '+faststart', '-n']))
  })

  it('nunca sobrescreve: nome ocupado ganha " (2)", " (3)"', async () => {
    writeFileSync(join(dir, 'x.mp4'), 'antigo')
    writeFileSync(join(dir, 'x (2).mp4'), 'antigo')
    const jobs = new EditorExportJobs()
    const { jobId, path } = jobs.open(dir, 'x.mp4')
    expect(path).toBe(join(dir, 'x (3).mp4'))
    // ocupado durante a exportação: o finalize pega o próximo
    writeFileSync(path, 'outro programa')
    jobs.write(jobId, new Uint8Array([9]), 0)
    const r = await jobs.finalize(jobId)
    expect(r.path).toBe(join(dir, 'x (4).mp4'))
    expect(readFileSync(join(dir, 'x.mp4'), 'utf8')).toBe('antigo')
    expect(readFileSync(join(dir, 'x (3).mp4'), 'utf8')).toBe('outro programa')
  })

  it('cancelar apaga o parcial; uma exportação por vez', () => {
    const jobs = new EditorExportJobs()
    const a = jobs.open(dir, 'a')
    expect(() => jobs.open(dir, 'b')).toThrow(/em andamento/)
    jobs.write(a.jobId, new Uint8Array([1]), 0)
    jobs.cancel(a.jobId)
    jobs.cancel(a.jobId)
    expect(readdirSync(dir)).toEqual([])
    expect(() => jobs.write(a.jobId, new Uint8Array([1]), 0)).toThrow()
    const b = jobs.open(dir, 'b', 7)
    jobs.cancelOwnedBy(8)
    expect(existsSync(`${b.path}.part`)).toBe(true)
    jobs.cancelOwnedBy(7)
    expect(readdirSync(dir)).toEqual([])
  })

  it('falha no remux apaga o .part e a saída incompleta', async () => {
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      writeFileSync(args[args.length - 1], 'meio')
      throw new Error('ffmpeg falhou')
    })
    const jobs = new EditorExportJobs()
    const { jobId } = jobs.open(dir, 'y')
    await expect(jobs.finalize(jobId)).rejects.toThrow('ffmpeg falhou')
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('editorExportFileName', () => {
  it('saneia e garante .mp4', () => {
    expect(editorExportFileName('a:b?')).toBe('ab.mp4')
    expect(editorExportFileName('Video.MP4')).toBe('Video.MP4')
    expect(editorExportFileName('   ')).toBe('Vídeo.mp4')
  })
})
