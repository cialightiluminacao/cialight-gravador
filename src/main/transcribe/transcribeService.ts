// Transcrição (legendas automáticas, G2): por trecho da fonte (TranscribeJob), o ffmpeg empacotado extrai
// [fromUs, toUs) para WAV 16 kHz mono numa pasta temporária da execução, o silencedetect (mesmo critério da
// ingestão: −35 dB / 0,35 s) dá os intervalos de fala e o whisper-cli transcreve com a linha de comando do spike
// (docs/research/2026-10-03-whisper-spike.md §7). As palavras voltam em tempo da FONTE (soma job.fromUs).
//
// Uma transcrição por vez. Cancelar (AbortSignal) mata só os processos filhos desta execução (child.kill nos
// handles deles), espera o fechamento e rejeita com TranscribeCancelledError. A pasta temporária é sempre apagada.
// O log recebe só argumentos e o fim do stderr dos processos — nunca o áudio nem o texto transcrito.
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'fs'
import { constants as osConstants, cpus, setPriority as osSetPriority, tmpdir } from 'os'
import { join } from 'path'
import type { Asset } from '@shared/editor/project'
import { parseSilencedetect, speechIntervals, SPEECH_DEFAULTS, type SpeechInterval } from '@shared/editor/speech'
import type { SourceWord } from '@shared/editor/transcribePlan'
import type { TranscribeLanguage, TranscribeProgress, TranscribeRequest, TranscribeResult, WhisperModelId } from '@shared/ipc'
import { resolveAssetInput, type AssetInputDeps } from '../media/assetInput'
import { parseWhisperJson, type WhisperJson } from './whisperJson'
import { WHISPER_MODELS, modelFileIfPresent } from './whisperModels'

export class TranscribeCancelledError extends Error {
  constructor() {
    super('Transcrição cancelada')
    this.name = 'TranscribeCancelledError'
  }
}

export const LOW_VOICE_WARNING = 'Fala muito baixa: legendas sem filtro de silêncio'
export const WHISPER_START_ERROR =
  'Não foi possível iniciar o reconhecimento de fala (whisper). Reinstale o CiaLight Gravador; se o problema continuar, instale o “Microsoft Visual C++ Redistributable 2015–2022 (x64)” e tente de novo.'
/** Códigos de saída do Windows quando o processo nem chega a rodar (DLL ausente, imagem inválida, falha ao iniciar a DLL). */
const START_FAILURE_CODES = new Set([0xc0000135, 0xc000007b, 0xc0000142, -1073741515, -1073741701, -1073741502])
/** Fração do trecho atribuída à extração + silencedetect no progresso (o resto é do whisper). */
const EXTRACT_WEIGHT = 0.05

/** Entrada de um trecho: arquivo, stream de áudio e o nome do asset (mensagens). */
export interface TranscribeInput { path: string; audioMap: string; name: string }

export interface TranscribeDeps {
  /** Arquivo/stream do asset (mesma regra da ingestão); lança com mensagem pt-BR se o asset não existe ou não tem áudio. */
  resolveInput: (projectId: string, assetId: string) => TranscribeInput
  ffmpegPath: () => string
  whisperCliPath: () => string
  modelsDir: () => string
  /** Caminho do modelo baixado e verificado, ou null (padrão: carimbo .ok em modelsDir). */
  modelFile?: (id: WhisperModelId, dir: string) => string | null
  spawn?: typeof nodeSpawn
  tmpRoot?: () => string
  cpuCount?: () => number
  setPriority?: (pid: number, priority: number) => void
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
  /** Observação (testes): cada processo iniciado e a pasta temporária da execução. */
  hooks?: { onChild?: (pid: number, kind: 'ffmpeg' | 'whisper') => void; onTempDir?: (dir: string) => void }
}

/** threads = clamp(floor(núcleos lógicos / 2), 1, 8) — melhor ponto medido no spike. */
export function whisperThreads(logicalCpus: number): number {
  return Math.max(1, Math.min(8, Math.floor(logicalCpus / 2)))
}

/** Linha de comando do spike; o modelo vai relativo (cwd = pasta dos modelos: contorna caminhos não ASCII). */
export function whisperArgs(o: { modelId: WhisperModelId; wav: string; language: TranscribeLanguage; threads: number; outBase: string }): string[] {
  return ['-m', WHISPER_MODELS[o.modelId].file, '-f', o.wav, '-l', o.language, '-t', String(o.threads), '-bs', '1', '-bo', '1', '--dtw', o.modelId, '-nfa', '-np', '-ojf', '-of', o.outBase]
}

const sec = (us: number): string => (us / 1_000_000).toFixed(6)

export function extractArgs(input: TranscribeInput, fromUs: number, toUs: number, wav: string): string[] {
  return ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', sec(fromUs), '-i', input.path, '-t', sec(toUs - fromUs), '-map', input.audioMap, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', wav]
}

export function silenceArgs(wav: string): string[] {
  return ['-hide_banner', '-nostdin', '-i', wav, '-af', `silencedetect=n=${SPEECH_DEFAULTS.thresholdDb}dB:d=${SPEECH_DEFAULTS.minSilenceUs / 1_000_000}`, '-f', 'null', '-']
}

/** Duração (µs) do PCM 16 kHz mono s16 de um WAV: bytes depois do cabeçalho do chunk "data". */
export function wavPcmDurationUs(file: string): number {
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(Math.min(size, 4096))
    readSync(fd, head, 0, head.length, 0)
    if (head.toString('ascii', 0, 4) !== 'RIFF') return 0
    let off = 12
    while (off + 8 <= head.length) {
      const id = head.toString('ascii', off, off + 4)
      const len = head.readUInt32LE(off + 4)
      if (id === 'data') return Math.round((Math.max(0, size - off - 8) / 32_000) * 1_000_000)
      off += 8 + len + (len & 1)
    }
    return 0
  } finally {
    closeSync(fd)
  }
}

/**
 * Asset → entrada da transcrição: imagem ou vídeo sem áudio → erro pt-BR; stream de áudio pela regra da ingestão
 * (resolveAssetInput; padrão '0:a:0').
 */
export function transcribeInputOf(deps: AssetInputDeps, projectId: string, a: Asset | undefined, assetId: string): TranscribeInput {
  if (!a) throw new Error(`Mídia não encontrada no projeto (${assetId}).`)
  if (a.kind === 'image' || (a.kind !== 'audio' && !a.audio)) throw new Error(`“${a.name}” não tem áudio para transcrever.`)
  const input = resolveAssetInput(deps, projectId, a)
  return { path: input.path, audioMap: input.audioMap ?? '0:a:0', name: a.name }
}

interface ChildResult { code: number | null; tail: string; kept: string[] }

export class TranscribeService {
  private running = false
  constructor(private readonly deps: TranscribeDeps) {}

  get busy(): boolean {
    return this.running
  }

  async transcribe(req: TranscribeRequest, onProgress: (p: TranscribeProgress) => void, signal?: AbortSignal): Promise<TranscribeResult> {
    if (this.running) throw new Error('Já existe uma transcrição em andamento. Aguarde terminar ou cancele.')
    this.running = true
    try {
      return await this.run(req, onProgress, signal)
    } finally {
      this.running = false
    }
  }

  private async run(req: TranscribeRequest, onProgress: (p: TranscribeProgress) => void, signal?: AbortSignal): Promise<TranscribeResult> {
    const d = this.deps
    const spec = WHISPER_MODELS[req.modelId]
    if (!spec) throw new Error(`Modelo de transcrição desconhecido: ${String(req.modelId)}`)
    const modelsDir = d.modelsDir()
    if (!(d.modelFile ?? modelFileIfPresent)(req.modelId, modelsDir)) throw new Error(`O modelo de transcrição “${spec.label}” não está baixado. Baixe o modelo para gerar as legendas.`)
    if (signal?.aborted) throw new TranscribeCancelledError()
    const jobs = req.jobs
    const result: TranscribeResult = { words: {}, warnings: [] }
    if (!jobs.length) return result
    // entradas resolvidas antes de qualquer processo: asset ausente/sem áudio falha na hora
    const inputs = jobs.map((j) => {
      const input = d.resolveInput(req.projectId, j.assetId)
      if (!existsSync(input.path)) throw new Error(`Arquivo de mídia não encontrado: “${input.name}”.`)
      return input
    })

    const tmp = mkdtempSync(join((d.tmpRoot ?? tmpdir)(), 'cialight-whisper-'))
    d.hooks?.onTempDir?.(tmp)
    const threads = whisperThreads((d.cpuCount ?? (() => cpus().length))())
    const totalUs = jobs.reduce((s, j) => s + Math.max(0, j.toUs - j.fromUs), 0) || 1
    let doneUs = 0
    const t0 = Date.now()
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]
        const input = inputs[i]
        const durUs = Math.max(0, job.toUs - job.fromUs)
        const progress = (stage: TranscribeProgress['stage'], within: number): void =>
          onProgress({ stage, jobIndex: i, jobCount: jobs.length, fraction: Math.min(1, (doneUs + within * durUs) / totalUs) })

        progress('extract', 0)
        const wav = join(tmp, `job${i}.wav`)
        const ex = await this.runChild(d.ffmpegPath(), extractArgs(input, job.fromUs, job.toUs, wav), 'ffmpeg', signal)
        if (ex.code !== 0 || !existsSync(wav)) {
          d.log?.error(`transcrição: ffmpeg (extração) saiu com código ${ex.code}\n${ex.tail}`)
          throw new Error(`Não foi possível ler o áudio de “${input.name}”.`)
        }
        const wavUs = wavPcmDurationUs(wav)
        if (wavUs < 100_000) {
          // trecho vazio (além do fim do arquivo): nada a transcrever
          doneUs += durUs
          continue
        }
        const sd = await this.runChild(d.ffmpegPath(), silenceArgs(wav), 'ffmpeg', signal, /silence_(start|end)/)
        if (sd.code !== 0) {
          d.log?.error(`transcrição: ffmpeg (silencedetect) saiu com código ${sd.code}\n${sd.tail}`)
          throw new Error(`Não foi possível analisar o áudio de “${input.name}”.`)
        }
        const speech: SpeechInterval[] = speechIntervals(parseSilencedetect(sd.kept.join('\n')), wavUs, SPEECH_DEFAULTS.padUs, 0, 0)

        progress('transcribe', EXTRACT_WEIGHT)
        const outBase = join(tmp, `job${i}`)
        const args = whisperArgs({ modelId: req.modelId, wav, language: req.language, threads, outBase })
        let wr: ChildResult
        try {
          wr = await this.runChild(d.whisperCliPath(), args, 'whisper', signal, undefined, modelsDir)
        } catch (e) {
          if (e instanceof TranscribeCancelledError) throw e
          d.log?.error('transcrição: whisper-cli não iniciou', e)
          throw new Error(WHISPER_START_ERROR)
        }
        if (wr.code !== 0) {
          d.log?.error(`transcrição: whisper-cli saiu com código ${wr.code} (${args.join(' ')})\n${wr.tail}`)
          if (wr.code !== null && START_FAILURE_CODES.has(wr.code)) throw new Error(WHISPER_START_ERROR)
          throw new Error(`A transcrição falhou (whisper, código ${wr.code}). Tente de novo; se continuar, tente o outro modelo.`)
        }
        let json: WhisperJson
        try {
          json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as WhisperJson
        } catch (e) {
          d.log?.error('transcrição: saída JSON do whisper ilegível', e)
          throw new Error('A transcrição falhou: o whisper não devolveu um resultado legível.')
        }
        const parsed = parseWhisperJson(json, speech)
        if (parsed.unfiltered && !result.warnings.includes(LOW_VOICE_WARNING)) result.warnings.push(LOW_VOICE_WARNING)
        const list = (result.words[job.assetId] ??= [])
        for (const w of parsed.words) {
          const startUs = Math.min(job.toUs, w.startUs + job.fromUs)
          const endUs = Math.max(startUs, Math.min(job.toUs, w.endUs + job.fromUs))
          list.push({ ...w, startUs, endUs })
        }
        d.log?.info(`transcrição: trecho ${i + 1}/${jobs.length} (${(durUs / 1e6).toFixed(1)} s) → ${parsed.words.length} palavras, ${parsed.dropped} segmentos descartados`)
        doneUs += durUs
      }
      for (const id of Object.keys(result.words)) result.words[id] = mergeWords(result.words[id])
      onProgress({ stage: 'transcribe', jobIndex: jobs.length - 1, jobCount: jobs.length, fraction: 1 })
      d.log?.info(`transcrição: ${jobs.length} trecho(s), ${(totalUs / 1e6).toFixed(1)} s de áudio em ${((Date.now() - t0) / 1000).toFixed(1)} s (modelo ${req.modelId}, ${threads} threads)`)
      return result
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (e) {
        d.log?.warn(`transcrição: não foi possível apagar ${tmp}`, e)
      }
    }
  }

  /** Roda um processo filho; abortar mata ESTE processo (child.kill), espera o fechamento e rejeita com cancelamento. */
  private runChild(cmd: string, args: string[], kind: 'ffmpeg' | 'whisper', signal: AbortSignal | undefined, keep?: RegExp, cwd?: string): Promise<ChildResult> {
    const d = this.deps
    if (signal?.aborted) return Promise.reject(new TranscribeCancelledError())
    d.log?.info(`transcrição [${kind}]: ${args.join(' ')}`)
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = (d.spawn ?? nodeSpawn)(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      } catch (e) {
        reject(e)
        return
      }
      let tail = ''
      let pending = ''
      const kept: string[] = []
      let cancelled = false
      let settled = false
      const onAbort = (): void => {
        cancelled = true
        try {
          child.kill()
        } catch {
          // já saiu
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (child.pid) {
        d.hooks?.onChild?.(child.pid, kind)
        if (kind === 'whisper') {
          try {
            ;(d.setPriority ?? osSetPriority)(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
          } catch (e) {
            d.log?.warn('transcrição: não foi possível baixar a prioridade do whisper', e)
          }
        }
      }
      child.stderr?.on('data', (b: Buffer) => {
        const text = b.toString('utf8')
        tail = (tail + text).slice(-4000)
        if (keep) {
          const lines = (pending + text).split(/\r?\n/)
          pending = lines.pop() ?? ''
          for (const l of lines) if (keep.test(l)) kept.push(l)
        }
      })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(cancelled ? new TranscribeCancelledError() : e)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (keep && pending && keep.test(pending)) kept.push(pending)
        if (cancelled) reject(new TranscribeCancelledError())
        else resolve({ code, tail, kept })
      })
    })
  }
}

/** Palavras de vários trechos do mesmo asset: ordenadas por início, sem repetir (mesmo início + texto). */
export function mergeWords(words: SourceWord[]): SourceWord[] {
  const sorted = [...words].sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs)
  const out: SourceWord[] = []
  const seen = new Set<string>()
  for (const w of sorted) {
    const k = `${w.startUs}|${w.text}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(w)
  }
  return out
}
