import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'fs'
import { join } from 'path'
import { numberedName, sanitizeFileName } from '@shared/filenames'
import { runFfmpeg } from './ffmpegRunner'
import { log } from '../log'

// Arquivo de saída da exportação do editor (main). O render worker gera o MP4 (mdat antes do moov) e o
// renderer manda os bytes por IPC: gravados em `<saída>.part` por posição. No fim, `finalize` remuxa com
// `ffmpeg -c copy -movflags +faststart` para o nome final e apaga o .part; `cancel` apaga o parcial.
// Nunca sobrescreve: nome ocupado ganha " (2)", " (3)"… Uma exportação por vez.

interface Job {
  id: string
  owner: number
  dir: string
  /** Nome pedido (saneado) e o nome livre escolhido na abertura. */
  requested: string
  name: string
  part: string
  fd: number | null
}

export interface EditorExportOpened {
  jobId: string
  /** Caminho final previsto (pode mudar no finalize se o nome for ocupado enquanto exporta). */
  path: string
}

const isTaken = (dir: string) => (name: string): boolean => existsSync(join(dir, name)) || existsSync(join(dir, `${name}.part`))

/** Nome final saneado e com extensão .mp4. */
export function editorExportFileName(fileName: string): string {
  let name = sanitizeFileName(fileName.trim())
  if (!name) name = 'Vídeo'
  if (!/\.mp4$/i.test(name)) name = sanitizeFileName(`${name}.mp4`)
  return name
}

export class EditorExportJobs {
  private readonly jobs = new Map<string, Job>()
  private seq = 0

  /** owner: webContents.id de quem abriu (os jobs dele são cancelados se a janela some). */
  open(outputDir: string, fileName: string, owner = 0): EditorExportOpened {
    if (this.jobs.size > 0) throw new Error('Já existe uma exportação em andamento')
    if (!outputDir) throw new Error('Pasta de destino não definida')
    mkdirSync(outputDir, { recursive: true })
    const requested = editorExportFileName(fileName)
    const name = numberedName(requested, isTaken(outputDir))
    const part = join(outputDir, `${name}.part`)
    const fd = openSync(part, 'w')
    const id = `edx-${Date.now()}-${++this.seq}`
    this.jobs.set(id, { id, owner, dir: outputDir, requested, name, part, fd })
    log.info(`exportação do editor ${id}: ${part}`)
    return { jobId: id, path: join(outputDir, name) }
  }

  write(jobId: string, data: Uint8Array, position: number): void {
    const job = this.must(jobId)
    if (job.fd === null) throw new Error('arquivo da exportação já fechado')
    let off = 0
    while (off < data.byteLength) off += writeSync(job.fd, data, off, data.byteLength - off, position + off)
  }

  close(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job?.fd != null) {
      closeSync(job.fd)
      job.fd = null
    }
  }

  /** Fecha o .part, remuxa com faststart para o nome final e apaga o .part. */
  async finalize(jobId: string): Promise<{ path: string; size: number }> {
    const job = this.must(jobId)
    this.close(jobId)
    // nome ocupado enquanto exportava (outro programa): próximo número livre, sem contar o próprio .part
    const name = numberedName(job.requested, (n) => existsSync(join(job.dir, n)) || (n !== job.name && existsSync(join(job.dir, `${n}.part`))))
    const out = join(job.dir, name)
    try {
      await runFfmpeg(['-hide_banner', '-nostdin', '-n', '-i', job.part, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', out], { label: 'editor: faststart' })
      return { path: out, size: statSync(out).size }
    } catch (e) {
      rmSync(out, { force: true })
      throw e
    } finally {
      rmSync(job.part, { force: true })
      this.jobs.delete(jobId)
    }
  }

  /** Cancela: fecha e apaga o parcial. Idempotente. */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    this.close(jobId)
    rmSync(job.part, { force: true })
    this.jobs.delete(jobId)
    log.info(`exportação do editor ${jobId} cancelada`)
  }

  /** Janela fechada/recarregada ou app saindo: nada de .part órfão. */
  cancelOwnedBy(owner: number | null): void {
    for (const job of [...this.jobs.values()]) if (owner === null || job.owner === owner) this.cancel(job.id)
  }

  private must(jobId: string): Job {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('exportação não encontrada (cancelada?)')
    return job
  }
}
