import { existsSync, mkdirSync, promises as fsp, rmSync, statSync } from 'fs'
import { join } from 'path'
import { numberedName, sanitizeFileName } from '@shared/filenames'
import { runFfmpeg } from './ffmpegRunner'
import { log } from '../log'

// Arquivo de saída da exportação do editor (main). O render worker gera o MP4 (mdat antes do moov) e o
// renderer manda os bytes por IPC: gravados (assíncrono) em `<saída>.part` por posição. No fim, `finalize`
// remuxa com `ffmpeg -c copy -movflags +faststart` para o nome final e apaga o .part; `cancel` apaga o
// parcial — e, no meio do remux, interrompe o ffmpeg e apaga também a saída que este job criou.
// Nunca sobrescreve: nome ocupado ganha " (2)", " (3)"… Uma exportação por vez.

/** Espaço livre exigido = estimativa × isto (o .part e a cópia do remux coexistem no fim). */
export const FREE_SPACE_FACTOR = 2.1

interface Job {
  id: string
  owner: number
  dir: string
  /** Nome pedido (saneado) e o nome livre escolhido na abertura. */
  requested: string
  name: string
  part: string
  fh: fsp.FileHandle | null
  /** Escritas em curso (o close/cancel espera). */
  writes: Set<Promise<unknown>>
  /** Remux em curso: abort + promessa que só resolve depois que o ffmpeg saiu. */
  remux: { abort: AbortController; done: Promise<void> } | null
  /** Saída criada por este job (só ela pode ser apagada num cancelamento/falha). */
  createdOut: string | null
}

export interface EditorExportOpened {
  jobId: string
  /** Caminho final previsto (pode mudar no finalize se o nome for ocupado enquanto exporta). */
  path: string
}

export interface EditorExportFinalized {
  path: string
  size: number
  /** finalize com maxBytes: a saída passou do limite e foi apagada (o renderer refaz com bitrate menor). */
  oversize?: boolean
}

export interface EditorExportDeps {
  /** Bytes livres no volume de `dir`. */
  freeBytes?: (dir: string) => Promise<number>
}

const isTaken = (dir: string) => (name: string): boolean => existsSync(join(dir, name)) || existsSync(join(dir, `${name}.part`))

/** rmSync que nunca lança (arquivo preso pelo antivírus/Explorer não pode derrubar o fluxo). */
function safeRm(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (e) {
    log.warn(`não foi possível apagar ${path}`, e)
  }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const st = await fsp.statfs(dir)
  return st.bavail * st.bsize
}

const fmtMB = (b: number): string => `${Math.ceil(b / 1048576).toLocaleString('pt-BR')} MB`

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
  private readonly freeBytes: (dir: string) => Promise<number>

  constructor(deps: EditorExportDeps = {}) {
    this.freeBytes = deps.freeBytes ?? defaultFreeBytes
  }

  get busy(): boolean {
    return this.jobs.size > 0
  }

  /**
   * owner: webContents.id de quem abriu (os jobs dele são cancelados se a janela some).
   * estimateBytes: tamanho estimado; exige estimate × FREE_SPACE_FACTOR livres na pasta.
   */
  async open(outputDir: string, fileName: string, owner = 0, estimateBytes = 0): Promise<EditorExportOpened> {
    if (this.jobs.size > 0) throw new Error('Já existe uma exportação em andamento')
    if (!outputDir) throw new Error('Pasta de destino não definida')
    mkdirSync(outputDir, { recursive: true })
    if (estimateBytes > 0) {
      const need = estimateBytes * FREE_SPACE_FACTOR
      const free = await this.freeBytes(outputDir)
      if (free < need) throw new Error(`Espaço insuficiente na pasta de destino: são necessários cerca de ${fmtMB(need)} livres (há ${fmtMB(free)}). Libere espaço ou escolha outra pasta.`)
    }
    if (this.jobs.size > 0) throw new Error('Já existe uma exportação em andamento')
    const requested = editorExportFileName(fileName)
    const name = numberedName(requested, isTaken(outputDir))
    const part = join(outputDir, `${name}.part`)
    const id = `edx-${Date.now()}-${++this.seq}`
    const job: Job = { id, owner, dir: outputDir, requested, name, part, fh: null, writes: new Set(), remux: null, createdOut: null }
    this.jobs.set(id, job) // reserva antes do await: outra abertura simultânea já vê o job
    try {
      job.fh = await fsp.open(part, 'w')
    } catch (e) {
      this.jobs.delete(id)
      throw e
    }
    log.info(`exportação do editor ${id}: ${part}`)
    return { jobId: id, path: join(outputDir, name) }
  }

  async write(jobId: string, data: Uint8Array, position: number): Promise<void> {
    const job = this.must(jobId)
    const fh = job.fh
    if (!fh) throw new Error('arquivo da exportação já fechado')
    const p = (async () => {
      let off = 0
      while (off < data.byteLength) off += (await fh.write(data, off, data.byteLength - off, position + off)).bytesWritten
    })()
    job.writes.add(p)
    try {
      await p
    } finally {
      job.writes.delete(p)
    }
  }

  async close(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (job) await this.closeHandle(job)
  }

  /**
   * Fecha o .part, remuxa com faststart para o nome final e apaga o .part. `onProgress` 0–1 pelo -progress
   * do ffmpeg (durationUs = duração do vídeo). Com `maxBytes`, saída maior que isso é apagada (oversize).
   */
  async finalize(jobId: string, opts: { durationUs?: number; maxBytes?: number; onProgress?: (fraction: number) => void } = {}): Promise<EditorExportFinalized> {
    const job = this.must(jobId)
    if (job.remux) throw new Error('finalização já em andamento')
    await this.closeHandle(job)
    // nome ocupado enquanto exportava (outro programa): próximo número livre, sem contar o próprio .part
    const name = numberedName(job.requested, (n) => existsSync(join(job.dir, n)) || (n !== job.name && existsSync(join(job.dir, `${n}.part`))))
    const out = join(job.dir, name)
    const abort = new AbortController()
    let release: () => void = () => {}
    job.remux = { abort, done: new Promise<void>((r) => (release = r)) }
    const existedBefore = existsSync(out)
    try {
      const r = await runFfmpeg(
        ['-hide_banner', '-nostdin', '-n', '-i', job.part, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', out],
        {
          label: 'editor: faststart',
          signal: abort.signal,
          onProgress: (p) => {
            if (opts.durationUs && opts.durationUs > 0) opts.onProgress?.(Math.min(1, Math.max(0, p.outTimeUs / opts.durationUs)))
          }
        }
      )
      if (!existedBefore && existsSync(out)) job.createdOut = out
      if (r.cancelled || abort.signal.aborted) throw new Error('cancelado')
      const size = statSync(out).size
      if (opts.maxBytes && size > opts.maxBytes) {
        safeRm(out)
        log.info(`exportação do editor ${jobId}: ${size} bytes > alvo ${opts.maxBytes}; saída apagada`)
        return { path: out, size, oversize: true }
      }
      job.createdOut = null // concluída: a saída é do usuário
      return { path: out, size }
    } catch (e) {
      if (!existedBefore && existsSync(out)) job.createdOut = out
      if (job.createdOut) safeRm(job.createdOut)
      throw e
    } finally {
      safeRm(job.part)
      this.jobs.delete(jobId)
      job.remux = null
      release()
    }
  }

  /** Cancela: interrompe o remux (esperando o ffmpeg sair), fecha e apaga o parcial e a saída deste job. Idempotente. */
  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) return
    if (job.remux) {
      const { abort, done } = job.remux
      abort.abort()
      await done
    }
    await this.closeHandle(job)
    safeRm(job.part)
    if (job.createdOut) safeRm(job.createdOut)
    this.jobs.delete(jobId)
    log.info(`exportação do editor ${jobId} cancelada`)
  }

  /** Janela fechada/recarregada ou app saindo (owner null = todos): nada de .part órfão. */
  async cancelOwnedBy(owner: number | null): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((j) => owner === null || j.owner === owner).map((j) => this.cancel(j.id)))
  }

  private async closeHandle(job: Job): Promise<void> {
    await Promise.allSettled([...job.writes])
    const fh = job.fh
    job.fh = null
    if (fh) await fh.close().catch(() => {})
  }

  private must(jobId: string): Job {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('exportação não encontrada (cancelada?)')
    return job
  }
}
