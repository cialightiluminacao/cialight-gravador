import { existsSync, mkdirSync } from 'fs'
import { basename, dirname } from 'path'
import type { Asset } from '@shared/editor/project'
import type { HwEncoder } from '@shared/types'
import type { IngestJob, IngestStep } from '@shared/ipc'
import { probe, type MediaInfo } from './probe'
import { intermediateArgs, needsProxy, proxyArgs } from './proxyPolicy'
import { FfmpegError } from '../export/ffmpegRunner'
import { buildFilmstrip, buildPeaks, buildThumb, CancelledError, runToFile } from './analysis'

// Fila de ingestão: por asset, probe → (proxy | intermediário) em paralelo com filmstrip e peaks.
// Concorrência: 1 job pesado (transcodificação) + 2 leves (probe/filmstrip/peaks).
// Ao terminar um asset emite 'done' com o patch (caminhos relativos à pasta do projeto);
// quem persiste o patch é decidido pelo chamador (ver registro do domínio `media` em ipc.ts).

export type { IngestJob, IngestStep }

/** Arquivo de entrada e streams a usar (o rec.mp4 de uma sessão tem várias faixas). */
export interface IngestInput {
  path: string
  /** ex.: '0:v:1' (webcam da sessão); padrão '0:v:0'. */
  videoMap?: string
  /** ex.: '0:a:1' (áudio do sistema); padrão '0:a:0'. */
  audioMap?: string
  /** Só filmstrip/peaks, sem probe nem proxy (gravações do app: H.264 GOP 1 s). */
  analyzeOnly?: boolean
}

export interface IngestDeps {
  /** Caminho absoluto de um arquivo da pasta do projeto (ProjectStore.filePath). */
  projectFile: (projectId: string, rel: string) => string
  resolveInput: (projectId: string, asset: Asset) => IngestInput
  /** Encoder H.264 para proxy/intermediário (encoderProbeV2 em cache; nunca dispara o probe aqui). */
  encoder: () => HwEncoder
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
}

type ProgressFn = (j: IngestJob) => void
type DoneFn = (projectId: string, assetId: string, patch: Partial<Asset>) => void

/** Semáforo simples com espera cancelável. */
class Slots {
  private free: number
  private waiting: { resolve: () => void; reject: (e: unknown) => void; signal: AbortSignal; onAbort: () => void }[] = []
  constructor(n: number) {
    this.free = n
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new CancelledError())
    const release = (): void => {
      const next = this.waiting.shift()
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort)
        next.resolve()
      } else this.free++
    }
    if (this.free > 0) {
      this.free--
      return Promise.resolve(release)
    }
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => resolve(release),
        reject,
        signal,
        onAbort: () => {
          this.waiting = this.waiting.filter((x) => x !== w)
          reject(new CancelledError())
        }
      }
      signal.addEventListener('abort', w.onAbort, { once: true })
      this.waiting.push(w)
    })
  }
}

/** Asset de arquivo importado a partir do probe; `decodable` provisório até o renderer testar (canDecode). */
export function assetFromInfo(id: string, path: string, st: { size: number; mtimeMs: number }, info: MediaInfo): Asset {
  return {
    id,
    name: basename(path),
    kind: info.kind,
    source: { type: 'file', path, size: st.size, mtimeMs: Math.round(st.mtimeMs) },
    durationUs: info.durationUs,
    ...(info.video ? { video: { ...info.video, decodable: true } } : {}),
    ...(info.audio ? { audio: info.audio } : {}),
    // imagem não tem nada a processar
    status: info.kind === 'image' ? 'ready' : 'processing'
  }
}

export const proxyRel = (assetId: string): string => `proxies/${assetId}.mp4`
export const intermediateRel = (assetId: string): string => `proxies/${assetId}.intermediate.mp4`
export const filmstripRel = (assetId: string): string => `cache/${assetId}.strip.jpg`
export const peaksRel = (assetId: string): string => `cache/${assetId}.peaks.bin`
export const THUMB_REL = 'cache/thumb.jpg'

export class IngestQueue {
  private heavy = new Slots(1)
  private light = new Slots(2)
  /** Execução vigente de cada asset: projectId → assetId → seu AbortController. */
  private active = new Map<string, Map<string, AbortController>>()
  private progressFns: ProgressFn[] = []
  private doneFns: DoneFn[] = []

  constructor(private deps: IngestDeps) {}

  on(ev: 'progress', fn: ProgressFn): void
  on(ev: 'done', fn: DoneFn): void
  on(ev: 'progress' | 'done', fn: ProgressFn | DoneFn): void {
    if (ev === 'progress') this.progressFns.push(fn as ProgressFn)
    else this.doneFns.push(fn as DoneFn)
  }

  /**
   * Enfileira o processamento de um asset (com `video.decodable` já decidido pelo renderer).
   * Se o asset já está em processamento (ex.: relink), a execução anterior é cancelada e esta a
   * substitui: só a execução vigente pode emitir 'done'.
   */
  enqueue(projectId: string, asset: Asset): void {
    let runs = this.active.get(projectId)
    if (!runs) this.active.set(projectId, (runs = new Map()))
    runs.get(asset.id)?.abort()
    const ctl = new AbortController()
    runs.set(asset.id, ctl)
    const current = (): boolean => this.active.get(projectId)?.get(asset.id) === ctl && !ctl.signal.aborted
    void this.run(projectId, asset, ctl.signal)
      .then((patch) => {
        if (current()) this.emitDone(projectId, asset.id, patch)
      })
      .catch((e) => {
        if (current() && !(e instanceof CancelledError)) this.emitDone(projectId, asset.id, { status: 'error', error: messageOf(e) })
      })
      .finally(() => {
        const m = this.active.get(projectId)
        if (m?.get(asset.id) === ctl) m.delete(asset.id)
        if (m && m.size === 0 && this.active.get(projectId) === m) this.active.delete(projectId)
      })
  }

  /** Cancela tudo do projeto (fila e ffmpeg em execução); nenhum 'done' é emitido para eles. */
  cancel(projectId: string): void {
    const runs = this.active.get(projectId)
    if (!runs) return
    this.active.delete(projectId)
    for (const c of runs.values()) c.abort()
  }

  /** Há trabalho pendente ou em execução para o projeto. */
  busy(projectId: string): boolean {
    return (this.active.get(projectId)?.size ?? 0) > 0
  }

  private emitProgress(j: IngestJob): void {
    for (const f of this.progressFns) f(j)
  }

  private emitDone(projectId: string, assetId: string, patch: Partial<Asset>): void {
    for (const f of this.doneFns) f(projectId, assetId, patch)
  }

  private async step<T>(slots: Slots, signal: AbortSignal, job: Omit<IngestJob, 'percent'>, fn: (onProgress: (p: number) => void) => Promise<T>): Promise<T> {
    const release = await slots.acquire(signal)
    try {
      this.emitProgress({ ...job, percent: 0 })
      const r = await fn((percent) => this.emitProgress({ ...job, percent }))
      this.emitProgress({ ...job, percent: 100 })
      return r
    } finally {
      release()
    }
  }

  private out(projectId: string, rel: string): string {
    const file = this.deps.projectFile(projectId, rel)
    mkdirSync(dirname(file), { recursive: true })
    return file
  }

  private async run(projectId: string, asset: Asset, signal: AbortSignal): Promise<Partial<Asset>> {
    const id = { projectId, assetId: asset.id }
    const input = this.deps.resolveInput(projectId, asset)
    if (asset.kind === 'image') return { status: 'ready' }

    let info: MediaInfo | null = null
    if (!input.analyzeOnly) info = await this.step(this.light, signal, { ...id, step: 'probe' }, () => probe(input.path))
    const durationUs = info?.durationUs ?? asset.durationUs ?? 0
    const decision = info ? needsProxy(info, asset.video?.decodable ?? true) : { proxy: false, intermediate: false, reasons: [] }
    if (decision.reasons.length) this.deps.log?.info(`ingestão ${asset.id}: ${decision.reasons.join(', ')}`)

    const patch: Partial<Asset> = {}
    const errors: string[] = []
    const guard = async (what: string, p: Promise<void>): Promise<void> => {
      try {
        await p
      } catch (e) {
        if (signal.aborted || e instanceof CancelledError) throw e
        this.deps.log?.warn(`ingestão ${asset.id}: ${what} falhou`, e)
        errors.push(`${what}: ${messageOf(e)}`)
      }
    }
    const tasks: Promise<void>[] = []

    if (info && (decision.proxy || decision.intermediate)) {
      const intermediate = decision.intermediate
      const rel = intermediate ? intermediateRel(asset.id) : proxyRel(asset.id)
      const mi = info
      tasks.push(
        guard(
          intermediate ? 'intermediário' : 'proxy',
          this.step(this.heavy, signal, { ...id, step: intermediate ? 'intermediate' : 'proxy' }, async (onProgress) => {
            const encoder = this.deps.encoder()
            const out = this.out(projectId, rel)
            const build = (tmp: string): string[] => (intermediate ? intermediateArgs : proxyArgs)(input.path, tmp, mi, encoder)
            await runToFile(build, out, { signal, onProgress }, durationUs, intermediate ? 'intermediário' : 'proxy')
            if (intermediate) patch.intermediate = rel
            else patch.proxy = rel
          })
        )
      )
    }

    if (asset.kind === 'video' && durationUs > 0) {
      tasks.push(
        guard(
          'filmstrip',
          this.step(this.light, signal, { ...id, step: 'filmstrip' }, async (onProgress) => {
            const rel = filmstripRel(asset.id)
            const r = await buildFilmstrip(input.path, this.out(projectId, rel), durationUs, { signal, onProgress, map: input.videoMap })
            patch.filmstrip = rel
            patch.filmstripInfo = { frames: r.frames, everyUs: r.everyUs, tileW: r.tileW, tileH: r.tileH }
            // miniatura do projeto: do primeiro vídeo cujo filmstrip ficar pronto (dois simultâneos
            // gravam .part distintos e o último rename vence — inofensivo)
            const thumb = this.deps.projectFile(projectId, THUMB_REL)
            if (!existsSync(thumb)) {
              try {
                await buildThumb(input.path, thumb, durationUs, { signal, map: input.videoMap })
              } catch (e) {
                if (e instanceof CancelledError) throw e
                this.deps.log?.warn(`miniatura do projeto ${projectId} falhou`, e)
              }
            }
          })
        )
      )
    }

    const hasAudio = asset.kind === 'audio' || !!(info ? info.audio : asset.audio)
    if (hasAudio && durationUs > 0) {
      tasks.push(
        guard(
          'peaks',
          this.step(this.light, signal, { ...id, step: 'peaks' }, async (onProgress) => {
            const rel = peaksRel(asset.id)
            await buildPeaks(input.path, this.out(projectId, rel), { signal, onProgress, map: input.audioMap, durationUs })
            patch.peaks = rel
          })
        )
      )
    }

    // allSettled: um cancelamento não deixa outra tarefa escrevendo depois do retorno
    const settled = await Promise.allSettled(tasks)
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
    if (rejected) throw rejected.reason
    if (asset.video) patch.video = { ...asset.video }
    if (errors.length) return { ...patch, status: 'error', error: errors.join('; ') }
    return { ...patch, status: 'ready', error: undefined }
  }
}

function messageOf(e: unknown): string {
  if (e instanceof FfmpegError) {
    const tail = e.stderrTail.split('\n').filter(Boolean).slice(-2).join(' | ')
    return `${e.message}${tail ? ` — ${tail}` : ''}`
  }
  return e instanceof Error ? e.message : String(e)
}
