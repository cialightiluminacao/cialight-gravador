import { existsSync, mkdirSync } from 'fs'
import { basename, dirname } from 'path'
import type { Asset } from '@shared/editor/project'
import { audioProcessKey, processedAudioRel, type AudioProcessOpts } from '@shared/editor/audioProcess'
import type { HwEncoder } from '@shared/types'
import type { IngestJob, IngestStep } from '@shared/ipc'
import { probe, type MediaInfo } from './probe'
import { audioIntermediateArgs, intermediateArgs, needsProxy, proxyArgs } from './proxyPolicy'
import { FfmpegError } from '../export/ffmpegRunner'
import { runWithEncoderFallback } from '../export/encoderFallback'
import { buildFilmstrip, buildLoudness, buildPeaks, buildSpeech, buildThumb, CancelledError, runToFile } from './analysis'
import { processAudioFile } from './audioProcess'

// Fila de ingestão: por asset, probe → (proxy | intermediário) em paralelo com filmstrip, peaks, fala e loudness.
// Concorrência: 1 job pesado (transcodificação) + 2 leves (probe/filmstrip/peaks/fala/loudness).
// Ao terminar um asset emite 'done' com o patch (caminhos relativos à pasta do projeto);
// quem persiste o patch é decidido pelo chamador (ver registro do domínio `media` em ipc.ts).
// "Processar áudio" (redução de ruído/normalização, processAudio): job pesado por (asset, chave), à parte das
// execuções de ingestão do asset (uma não cancela a outra); devolve o arquivo gerado em vez de emitir 'done'.

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
  /**
   * Encoders H.264 para proxy/intermediário, em ordem de tentativa (encoderFallbackChain do encoderProbeV2 em
   * cache; nunca dispara o probe aqui): falha do ffmpeg com um tenta o próximo, terminando em libx264.
   */
  encoders: () => HwEncoder[]
  /** Pasta do modelo RNNoise (resources/models/rnnoise) para a redução de ruído. */
  rnnoiseDir?: () => string
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
/** Intermediário de mídia só de áudio (AAC). */
export const audioIntermediateRel = (assetId: string): string => `proxies/${assetId}.intermediate.m4a`
export const filmstripRel = (assetId: string): string => `cache/${assetId}.strip.jpg`
export const peaksRel = (assetId: string): string => `cache/${assetId}.peaks.bin`
export const speechRel = (assetId: string): string => `cache/${assetId}.speech.json`
export const THUMB_REL = 'cache/thumb.jpg'

export class IngestQueue {
  private heavy = new Slots(1)
  private light = new Slots(2)
  /** Execução vigente de cada asset: projectId → assetId → seu AbortController. */
  private active = new Map<string, Map<string, AbortController>>()
  /** processAudio em curso: projectId|assetId|chave → promessa (pedidos repetidos compartilham a execução). */
  private audioRuns = new Map<string, Promise<{ key: string; rel: string }>>()
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
   * `analyzeAudio`: só fala + loudness (sem probe, proxy nem filmstrip/peaks), para completar assets já prontos; o
   * patch traz só o que foi medido e nunca mexe no status (falha vira aviso no log).
   */
  enqueue(projectId: string, asset: Asset, opts: { analyzeAudio?: boolean } = {}): void {
    let runs = this.active.get(projectId)
    if (!runs) this.active.set(projectId, (runs = new Map()))
    runs.get(asset.id)?.abort()
    const ctl = new AbortController()
    runs.set(asset.id, ctl)
    const current = (): boolean => this.active.get(projectId)?.get(asset.id) === ctl && !ctl.signal.aborted
    void (opts.analyzeAudio ? this.runAudioAnalysis(projectId, asset, ctl.signal) : this.run(projectId, asset, ctl.signal))
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

  /**
   * Versão pré-processada da faixa de áudio do asset (generated/<id>.audio-<chave>.m4a, ver audioProcess.ts). Cache por
   * (asset, parâmetros): arquivo já existente volta na hora. Job pesado; cancelado por `cancel(projectId)`
   * (rejeita com CancelledError). Quem grava `processedAudio` no projeto é o chamador (renderer, escritor único).
   */
  processAudio(projectId: string, asset: Asset, opts: AudioProcessOpts): Promise<{ key: string; rel: string }> {
    const key = audioProcessKey(opts)
    if (!key) return Promise.reject(new Error('nada a processar no áudio'))
    if (!(asset.kind === 'audio' || asset.audio)) return Promise.reject(new Error('mídia sem áudio'))
    const rel = processedAudioRel(asset.id, key)
    const out = this.out(projectId, rel)
    if (existsSync(out)) return Promise.resolve({ key, rel })
    const id = `${projectId}|${asset.id}|${key}`
    const pending = this.audioRuns.get(id)
    if (pending) return pending

    let input: IngestInput
    try {
      input = this.deps.resolveInput(projectId, asset)
    } catch (e) {
      return Promise.reject(e)
    }
    let runs = this.active.get(projectId)
    if (!runs) this.active.set(projectId, (runs = new Map()))
    const runKey = `${asset.id}~audio~${key}`
    const ctl = new AbortController()
    runs.set(runKey, ctl)
    const job = { projectId, assetId: asset.id, step: 'audioProcess' as const, key }
    const p = this.step(this.heavy, ctl.signal, job, (onProgress) =>
      processAudioFile(input.path, input.audioMap ?? '0:a:0', out, opts, {
        modelDir: this.deps.rnnoiseDir?.() ?? '',
        durationUs: asset.durationUs ?? 0,
        dualMono: asset.audio?.channels === 1,
        signal: ctl.signal,
        onProgress
      })
    )
      .then(() => ({ key, rel }))
      .finally(() => {
        this.audioRuns.delete(id)
        const m = this.active.get(projectId)
        if (m?.get(runKey) === ctl) m.delete(runKey)
        if (m && m.size === 0 && this.active.get(projectId) === m) this.active.delete(projectId)
      })
    this.audioRuns.set(id, p)
    return p
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

  /** Transcodificação com a cadeia de encoders: falha do ffmpeg (não cancelamento) tenta o próximo. */
  private async withEncoders(assetId: string, signal: AbortSignal, run: (encoder: HwEncoder) => Promise<void>): Promise<void> {
    await runWithEncoderFallback(this.deps.encoders(), run, {
      retryable: (e) => e instanceof FfmpegError && !signal.aborted,
      onFallback: (from, to, e) => this.deps.log?.warn(`ingestão ${assetId}: encoder ${from} falhou (${messageOf(e)}); tentando ${to}`)
    })
  }

  /**
   * Fala + loudness da faixa de áudio do asset (mic/sistema da sessão: -map 0:a:N), jobs leves e NÃO essenciais:
   * falha (que não seja cancelamento) só vira aviso no log; o campo fica ausente e o status do asset não muda.
   */
  private audioAnalysisTasks(projectId: string, asset: Asset, input: IngestInput, durationUs: number, signal: AbortSignal, patch: Partial<Asset>): Promise<void>[] {
    const id = { projectId, assetId: asset.id }
    const soft = async (what: string, p: Promise<void>): Promise<void> => {
      try {
        await p
      } catch (e) {
        if (signal.aborted || e instanceof CancelledError) throw e
        this.deps.log?.warn(`ingestão ${asset.id}: ${what} falhou (opcional; segue sem ele)`, e)
      }
    }
    return [
      soft(
        'fala',
        this.step(this.light, signal, { ...id, step: 'speech' }, async (onProgress) => {
          const rel = speechRel(asset.id)
          await buildSpeech(input.path, this.out(projectId, rel), durationUs, { signal, onProgress, map: input.audioMap })
          patch.speech = rel
        })
      ),
      soft(
        'loudness',
        this.step(this.light, signal, { ...id, step: 'loudness' }, async (onProgress) => {
          patch.loudness = await buildLoudness(input.path, durationUs, { signal, onProgress, map: input.audioMap })
        })
      )
    ]
  }

  /** Modo `analyzeAudio`: só as análises de áudio de um asset que já está pronto. */
  private async runAudioAnalysis(projectId: string, asset: Asset, signal: AbortSignal): Promise<Partial<Asset>> {
    const hasAudio = asset.kind === 'audio' || !!asset.audio
    const durationUs = asset.durationUs ?? 0
    const patch: Partial<Asset> = {}
    if (!hasAudio || !(durationUs > 0)) return patch
    const settled = await Promise.allSettled(this.audioAnalysisTasks(projectId, asset, this.deps.resolveInput(projectId, asset), durationUs, signal, patch))
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
    if (rejected) throw rejected.reason
    return patch
  }

  private async run(projectId: string, asset: Asset, signal: AbortSignal): Promise<Partial<Asset>> {
    const id = { projectId, assetId: asset.id }
    const input = this.deps.resolveInput(projectId, asset)
    if (asset.kind === 'image') return { status: 'ready' }

    let info: MediaInfo | null = null
    if (!input.analyzeOnly) info = await this.step(this.light, signal, { ...id, step: 'probe' }, () => probe(input.path))
    const durationUs = info?.durationUs ?? asset.durationUs ?? 0
    const decision = info ? needsProxy(info, asset.video?.decodable ?? true, asset.audio?.decodable ?? true) : { proxy: false, intermediate: false, reasons: [] }
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

    if (info && decision.intermediate) {
      const mi = info
      const audioOnly = !!decision.audioOnly
      const rel = audioOnly && mi.kind === 'audio' ? audioIntermediateRel(asset.id) : intermediateRel(asset.id)
      tasks.push(
        guard(
          'intermediário',
          this.step(this.heavy, signal, { ...id, step: 'intermediate' }, async (onProgress) => {
            const out = this.out(projectId, rel)
            const opts = { signal, onProgress }
            if (!audioOnly) {
              await this.withEncoders(asset.id, signal, (encoder) => runToFile((tmp) => intermediateArgs(input.path, tmp, mi, encoder), out, opts, durationUs, 'intermediário'))
            } else {
              try {
                await runToFile((tmp) => audioIntermediateArgs(input.path, tmp, mi), out, opts, durationUs, 'intermediário de áudio')
              } catch (e) {
                // vídeo que não cabe no MP4 sem recodificar (ex.: VP8): intermediário completo
                if (mi.kind === 'audio' || signal.aborted || e instanceof CancelledError) throw e
                this.deps.log?.warn(`ingestão ${asset.id}: cópia do vídeo falhou; recodificando`, e)
                await this.withEncoders(asset.id, signal, (encoder) => runToFile((tmp) => intermediateArgs(input.path, tmp, mi, encoder), out, opts, durationUs, 'intermediário'))
              }
            }
            patch.intermediate = rel
          })
        )
      )
    }
    if (info && decision.proxy) {
      const mi = info
      const rel = proxyRel(asset.id)
      tasks.push(
        guard(
          'proxy',
          this.step(this.heavy, signal, { ...id, step: 'proxy' }, async (onProgress) => {
            const out = this.out(projectId, rel)
            await this.withEncoders(asset.id, signal, (encoder) => runToFile((tmp) => proxyArgs(input.path, tmp, mi, encoder), out, { signal, onProgress }, durationUs, 'proxy'))
            patch.proxy = rel
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
            const source = info?.video ? { color: info.color, width: info.video.width, height: info.video.height } : null
            const r = await buildFilmstrip(input.path, this.out(projectId, rel), durationUs, { signal, onProgress, map: input.videoMap, source })
            patch.filmstrip = rel
            patch.filmstripInfo = { frames: r.frames, everyUs: r.everyUs, tileW: r.tileW, tileH: r.tileH }
            // miniatura do projeto: do primeiro vídeo cujo filmstrip ficar pronto (dois simultâneos
            // gravam .part distintos e o último rename vence — inofensivo)
            const thumb = this.deps.projectFile(projectId, THUMB_REL)
            if (!existsSync(thumb)) {
              try {
                await buildThumb(input.path, thumb, durationUs, { signal, map: input.videoMap, source })
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
      tasks.push(...this.audioAnalysisTasks(projectId, asset, input, durationUs, signal, patch))
    }

    // allSettled: um cancelamento não deixa outra tarefa escrevendo depois do retorno
    const settled = await Promise.allSettled(tasks)
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
    if (rejected) throw rejected.reason
    if (asset.video) patch.video = { ...asset.video }
    if (asset.audio) patch.audio = { ...asset.audio }
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
