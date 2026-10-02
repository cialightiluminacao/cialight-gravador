import { existsSync, mkdirSync, promises as fsp, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { numberedName, sanitizeFileName } from '@shared/filenames'
import type { PipeSpec } from '@shared/ipc'
import { runFfmpeg } from './ffmpegRunner'
import { openFfmpegPipe, type FfmpegPipe } from './ffmpegPipe'
import { audioPipeArgs, gifCapturePipeArgs, gifPaletteArgs, gifPaletteUseArgs, pipeExtension, validatePipeSpec } from './pipeSpec'
import { log } from '../log'

// Arquivo de saída da exportação do editor (main). O render worker gera o MP4 (mdat antes do moov) e o
// renderer manda os bytes por IPC: gravados (assíncrono) em `<saída>.part` por posição. No fim, `finalize`
// remuxa com `ffmpeg -c copy -movflags +faststart` para o nome final e apaga o .part; se o remux falhar (não
// cancelado), o .part — um MP4 válido, só sem faststart — vira o arquivo final com um aviso: o render não se
// perde. `cancel` apaga o parcial — e, no meio do remux, interrompe o ffmpeg e apaga a saída deste job.
// Nunca sobrescreve: nome ocupado ganha " (2)", " (3)"… Uma exportação por vez (MP4, pipe ou quadro).
//
// Saídas por pipe (`openPipe`: GIF e só áudio): o renderer manda bytes crus (quadros RGBA / PCM f32) que vão
// para o stdin do ffmpeg (ffmpegPipe, com contrapressão); o main valida o pedido (PipeSpec) e monta os
// argumentos. GIF: passada 1 → FFV1 temporário `<nome>.gif.ffv1.part`; `pipeFinish` gera a paleta
// (`<nome>.gif.palette.part`) e aplica → `<nome>.gif.part` → nome final. Os temporários ficam ao lado do .part
// (a limpeza de .part antigos os alcança) e são apagados sempre — fim, falha ou cancelamento.
// `writeStill` (quadro PNG): `.part` e rename, atômico.

/** Espaço livre exigido = estimativa × isto (o .part e a cópia do remux coexistem no fim). */
export const FREE_SPACE_FACTOR = 2.1

interface PipeState {
  spec: PipeSpec
  ff: FfmpegPipe
  /** Bytes aceitos pelo ffmpeg (GIF: quadros × w·h·4). */
  bytes: number
  /** Temporários deste job (apagados no fim, na falha e no cancelamento). */
  temps: string[]
}

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
  /** Saída por pipe (GIF / só áudio). */
  pipe?: PipeState
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
  /** O remux falhou e o arquivo ficou como o render o gerou (sem faststart). */
  warning?: string
}

export interface EditorExportDeps {
  /** Bytes livres no volume de `dir`. */
  freeBytes?: (dir: string) => Promise<number>
  /** ffmpeg alimentado pelo stdin (testes injetam um falso). */
  openPipe?: (args: string[], opts: { label?: string }) => FfmpegPipe
}

/** Gravações por pipe em voo por job: o renderer espera cada pipeWrite; acima disso o main recusa (memória limitada). */
export const PIPE_MAX_INFLIGHT = 2

/** Cancelamento esperado (pelo usuário, pela janela que fechou ou pela saída do app): não é erro. */
export class ExportCancelledError extends Error {
  constructor() {
    super('cancelado')
    this.name = 'ExportCancelledError'
  }
}

/** Extensões de saída da exportação do editor (o formato decide). */
export type EditorExportExt = 'mp4' | 'gif' | 'png' | 'wav' | 'mp3' | 'm4a'
const MEDIA_EXT = /\.(mp4|mov|m4v|mkv|webm|gif|png|mp3|wav|m4a)$/i

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

/** Nome final saneado e com a extensão do formato (uma extensão de mídia diferente digitada é trocada). */
export function editorExportFileName(fileName: string, ext: EditorExportExt = 'mp4'): string {
  const hasExt = (n: string): boolean => n.toLowerCase().endsWith(`.${ext}`) && n.length > ext.length + 1
  let name = sanitizeFileName(fileName.trim())
  if (hasExt(name)) return name
  name = name.replace(MEDIA_EXT, '').trim()
  if (hasExt(name)) return name
  if (!name) name = 'Vídeo'
  return sanitizeFileName(`${name}.${ext}`)
}

export class EditorExportJobs {
  private readonly jobs = new Map<string, Job>()
  /** Jobs cancelados (os últimos): uma chamada atrasada para eles é cancelamento, não "não encontrada". */
  private readonly cancelledIds = new Set<string>()
  private seq = 0
  private readonly freeBytes: (dir: string) => Promise<number>
  private readonly openFfmpegPipe: (args: string[], opts: { label?: string }) => FfmpegPipe

  constructor(deps: EditorExportDeps = {}) {
    this.freeBytes = deps.freeBytes ?? defaultFreeBytes
    this.openFfmpegPipe = deps.openPipe ?? ((args, opts) => openFfmpegPipe(args, opts))
  }

  get busy(): boolean {
    return this.jobs.size > 0
  }

  /**
   * owner: webContents.id de quem abriu (os jobs dele são cancelados se a janela some).
   * estimateBytes: tamanho estimado; exige estimate × FREE_SPACE_FACTOR livres na pasta.
   */
  async open(outputDir: string, fileName: string, owner = 0, estimateBytes = 0): Promise<EditorExportOpened> {
    const requested = editorExportFileName(fileName)
    const job = await this.reserve(outputDir, estimateBytes, owner, requested)
    const { id, name, part } = job
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
      if (r.cancelled || abort.signal.aborted) throw new ExportCancelledError()
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
      job.createdOut = null
      if (abort.signal.aborted) throw new ExportCancelledError()
      // o remux falhou de verdade: o .part já é um MP4 completo (mdat antes do moov) — vira a saída
      const kept = this.keepPart(job, opts.maxBytes)
      if (!kept) throw e
      log.warn(`exportação do editor ${jobId}: remux falhou; mantido o arquivo sem faststart (${kept.path})`, e)
      return kept
    } finally {
      safeRm(job.part)
      this.jobs.delete(jobId)
      job.remux = null
      release()
    }
  }

  /**
   * Pasta definida, nenhuma exportação em andamento e espaço livre (estimativa × FREE_SPACE_FACTOR); então
   * reserva o job (nome livre) na MESMA tarefa da última checagem: duas aberturas simultâneas nunca passam juntas.
   */
  private async reserve(outputDir: string, estimateBytes: number, owner: number, requested: string): Promise<Job> {
    if (this.jobs.size > 0) throw new Error('Já existe uma exportação em andamento')
    if (!outputDir) throw new Error('Pasta de destino não definida')
    mkdirSync(outputDir, { recursive: true })
    if (estimateBytes > 0) {
      const need = estimateBytes * FREE_SPACE_FACTOR
      const free = await this.freeBytes(outputDir)
      if (free < need) throw new Error(`Espaço insuficiente na pasta de destino: são necessários cerca de ${fmtMB(need)} livres (há ${fmtMB(free)}). Libere espaço ou escolha outra pasta.`)
    }
    if (this.jobs.size > 0) throw new Error('Já existe uma exportação em andamento')
    const name = numberedName(requested, isTaken(outputDir))
    const id = `edx-${Date.now()}-${++this.seq}`
    const job: Job = { id, owner, dir: outputDir, requested, name, part: join(outputDir, `${name}.part`), fh: null, writes: new Set(), remux: null, createdOut: null }
    this.jobs.set(id, job)
    return job
  }

  /** Nome livre no fim (ocupado enquanto exportava: o próximo número, sem contar o próprio .part). */
  private finalName(job: Job): string {
    return numberedName(job.requested, (n) => existsSync(join(job.dir, n)) || (n !== job.name && existsSync(join(job.dir, `${n}.part`))))
  }

  /**
   * Saída por pipe (GIF / só áudio): valida o pedido, reserva o nome e abre o ffmpeg lendo o stdin.
   * estimateBytes: espaço que a exportação ocupa (GIF: inclui o temporário sem perdas).
   */
  async openPipe(outputDir: string, fileName: string, rawSpec: unknown, owner = 0, estimateBytes = 0): Promise<EditorExportOpened> {
    const spec = validatePipeSpec(rawSpec)
    const job = await this.reserve(outputDir, estimateBytes, owner, editorExportFileName(fileName, pipeExtension(spec)))
    const { id, name, part } = job
    const temps = spec.kind === 'gif' ? [join(outputDir, `${name}.ffv1.part`), join(outputDir, `${name}.palette.part`)] : []
    const args = spec.kind === 'gif' ? gifCapturePipeArgs(spec, temps[0]) : audioPipeArgs(spec, part)
    try {
      job.pipe = { spec, ff: this.openFfmpegPipe(args, { label: spec.kind === 'gif' ? 'editor: GIF (quadros)' : `editor: áudio ${spec.format}` }), bytes: 0, temps }
    } catch (e) {
      this.jobs.delete(id)
      throw e
    }
    log.info(`exportação do editor ${id} (${spec.kind}): ${part}`)
    return { jobId: id, path: join(outputDir, name) }
  }

  /**
   * Bytes para o stdin do ffmpeg; resolve quando ele os aceitou (contrapressão). Mais de PIPE_MAX_INFLIGHT em voo
   * no job é recusado (o renderer espera cada um): o main nunca acumula quadros sem limite. owner: só a janela dona.
   */
  async pipeWrite(jobId: string, data: Uint8Array, owner?: number): Promise<void> {
    const job = this.must(jobId, owner)
    const pipe = job.pipe
    if (!pipe) throw new Error('exportação sem pipe')
    if (job.remux) throw new Error('finalização já em andamento')
    if (job.writes.size >= PIPE_MAX_INFLIGHT) throw new Error(`gravações demais em andamento na exportação (máximo ${PIPE_MAX_INFLIGHT}): espere cada pipeWrite`)
    const p = pipe.ff.write(data)
    job.writes.add(p)
    try {
      await p
      pipe.bytes += data.byteLength
    } finally {
      job.writes.delete(p)
    }
  }

  /**
   * Fecha o stdin e espera o ffmpeg; GIF: paleta + paletteuse (onProgress 0–1 pela duração). Renomeia o .part
   * para o nome final. Temporários apagados sempre; falha/cancelamento apaga o .part.
   */
  async pipeFinish(jobId: string, opts: { onProgress?: (fraction: number) => void; owner?: number } = {}): Promise<EditorExportFinalized> {
    const job = this.must(jobId, opts.owner)
    const pipe = job.pipe
    if (!pipe) throw new Error('exportação sem pipe')
    if (job.remux) throw new Error('finalização já em andamento')
    const abort = new AbortController()
    let release: () => void = () => {}
    job.remux = { abort, done: new Promise<void>((r) => (release = r)) }
    abort.signal.addEventListener('abort', () => void pipe.ff.abort())
    let ok = false
    try {
      await Promise.allSettled([...job.writes])
      const r = await pipe.ff.end()
      if (r.cancelled || abort.signal.aborted) throw new ExportCancelledError()
      if (pipe.spec.kind === 'gif') {
        const { width, height, fps } = pipe.spec
        const frames = Math.floor(pipe.bytes / (width * height * 4))
        const durationUs = (frames / fps) * 1e6
        const [lossless, palette] = pipe.temps
        // paleta: lê o arquivo todo (até 20 %); paletteuse: o resto
        const span = (from: number, to: number) => (p: { outTimeUs: number }): void => {
          if (durationUs > 0) opts.onProgress?.(from + (to - from) * Math.min(1, Math.max(0, p.outTimeUs / durationUs)))
        }
        const p1 = await runFfmpeg(gifPaletteArgs(lossless, palette), { label: 'editor: GIF (paleta)', signal: abort.signal, onProgress: span(0, 0.2) })
        if (p1.cancelled || abort.signal.aborted) throw new ExportCancelledError()
        const p2 = await runFfmpeg(gifPaletteUseArgs(lossless, palette, job.part), { label: 'editor: GIF', signal: abort.signal, onProgress: span(0.2, 1) })
        if (p2.cancelled || abort.signal.aborted) throw new ExportCancelledError()
      }
      const out = join(job.dir, this.finalName(job))
      renameSync(job.part, out)
      const size = statSync(out).size
      opts.onProgress?.(1)
      ok = true
      return { path: out, size }
    } finally {
      for (const t of pipe.temps) safeRm(t)
      if (!ok) safeRm(job.part)
      this.jobs.delete(jobId)
      job.remux = null
      release()
    }
  }

  /** Quadro PNG: grava `<nome>.png.part` e renomeia para um nome livre (nunca sobrescreve). owner: a janela que pediu. */
  async writeStill(outputDir: string, fileName: string, png: Uint8Array, owner = 0): Promise<{ path: string; size: number }> {
    const job = await this.reserve(outputDir, png.byteLength, owner, editorExportFileName(fileName, 'png'))
    const { id, part } = job
    try {
      await fsp.writeFile(part, png)
      const out = join(outputDir, this.finalName(job))
      renameSync(part, out)
      return { path: out, size: statSync(out).size }
    } catch (e) {
      safeRm(part)
      throw e
    } finally {
      this.jobs.delete(id)
    }
  }

  /** Renomeia o .part para um nome livre (nunca sobrescreve); null se não deu. */
  private keepPart(job: Job, maxBytes: number | undefined): EditorExportFinalized | null {
    try {
      const name = numberedName(job.requested, (n) => existsSync(join(job.dir, n)) || (n !== job.name && existsSync(join(job.dir, `${n}.part`))))
      const out = join(job.dir, name)
      renameSync(job.part, out)
      const size = statSync(out).size
      if (maxBytes && size > maxBytes) {
        safeRm(out)
        return { path: out, size, oversize: true }
      }
      return { path: out, size, warning: 'O arquivo foi salvo sem a otimização para reprodução on-line (faststart): o passo final falhou, mas o vídeo está completo.' }
    } catch (e) {
      log.warn(`exportação do editor ${job.id}: não foi possível manter o arquivo sem faststart`, e)
      return null
    }
  }

  /** Cancela: interrompe o remux (esperando o ffmpeg sair), fecha e apaga o parcial e a saída deste job. Idempotente. */
  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) return
    this.cancelledIds.add(jobId)
    if (this.cancelledIds.size > 32) this.cancelledIds.delete(this.cancelledIds.values().next().value!)
    if (job.remux) {
      const { abort, done } = job.remux
      abort.abort()
      await done
    }
    if (job.pipe) {
      await job.pipe.ff.abort()
      for (const t of job.pipe.temps) safeRm(t)
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

  /** Job aberto; cancelado → ExportCancelledError; owner (quando dado) tem de ser a janela dona. */
  private must(jobId: string, owner?: number): Job {
    const job = this.jobs.get(jobId)
    if (!job) {
      if (this.cancelledIds.has(jobId)) throw new ExportCancelledError()
      throw new Error('exportação não encontrada (cancelada?)')
    }
    if (owner !== undefined && job.owner !== owner) throw new Error('exportação de outra janela')
    return job
  }
}
