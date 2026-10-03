import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { ffmpegPath } from './ffmpegPath'
import { FfmpegError, killTree, progressReader, stderrTail, type FfmpegProgress, type RunResult } from './ffmpegRunner'
import { log } from '../log'

// ffmpeg alimentado pelo stdin (bytes → stdin), genérico: quadros RGBA do GIF, PCM do "só áudio" e (Task 5)
// quadros do fallback libx264. Contrapressão: `write` só resolve quando o stdin aceitou o pedaço (write() false
// → espera o 'drain'); quem produz espera cada write antes de gerar mais. ffmpeg que morre faz as gravações
// pendentes e as próximas rejeitarem com o stderr. `abort` mata a árvore (taskkill, como o runFfmpeg) e só
// resolve depois que o processo saiu: nunca fica processo órfão nem arquivo preso.

export interface FfmpegPipe {
  /** Resolve quando o stdin do ffmpeg aceitou o pedaço; rejeita se o ffmpeg morreu ou foi cancelado. */
  write(chunk: Uint8Array): Promise<void>
  /** Fecha o stdin e espera o ffmpeg terminar (código ≠ 0 → FfmpegError; cancelado → cancelled: true). */
  end(): Promise<RunResult>
  /** Mata o ffmpeg (árvore) e espera ele sair. Idempotente. */
  abort(): Promise<void>
}

export interface FfmpegPipeDeps {
  spawn?: (bin: string, args: string[], opts: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams
  kill?: (child: ChildProcessWithoutNullStreams) => void
}

export function openFfmpegPipe(args: string[], opts: { onProgress?: (p: FfmpegProgress) => void; label?: string } = {}, deps: FfmpegPipeDeps = {}): FfmpegPipe {
  const bin = ffmpegPath()
  log.info(`ffmpeg (pipe)${opts.label ? ` [${opts.label}]` : ''}: ${args.join(' ')}`)
  const child = (deps.spawn ?? nodeSpawn)(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const kill = deps.kill ?? killTree
  const tail = stderrTail()
  let cancelled = false
  let startError: FfmpegError | null = null
  let exitCode: number | null = null
  let exited = false
  let ending: Promise<RunResult> | null = null
  // gravações esperando drain/callback: rejeitadas quando o processo sai
  const waiters = new Set<(e: Error) => void>()

  const deadError = (): Error =>
    cancelled ? new Error('cancelado') : (startError ?? new FfmpegError(exited ? `ffmpeg saiu com código ${exitCode}` : 'o ffmpeg fechou a entrada', tail.text(), exitCode ?? -1))

  const closed = new Promise<void>((resolve) => {
    const done = (): void => {
      if (exited) return
      exited = true
      for (const w of [...waiters]) w(deadError())
      waiters.clear()
      resolve()
    }
    child.on('error', (e: Error) => {
      startError ??= new FfmpegError(`não foi possível iniciar o ffmpeg: ${e.message}`, '', -1)
      done()
    })
    child.on('close', (code: number | null) => {
      exitCode = code ?? -1
      done()
    })
  })
  child.stdout.on('data', progressReader(opts.onProgress))
  child.stderr.on('data', tail.push)
  // EPIPE quando o ffmpeg fecha/morre com dados no caminho: vira rejeição das gravações (via close), nunca exceção solta
  child.stdin.on('error', (e: Error) => log.warn(`ffmpeg (pipe)${opts.label ? ` [${opts.label}]` : ''}: stdin`, e.message))

  return {
    write(chunk) {
      if (cancelled || exited || startError || ending) return Promise.reject(deadError())
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (e?: Error): void => {
          if (settled) return
          settled = true
          waiters.delete(fail)
          child.stdin.off('drain', onDrain)
          if (e) reject(e)
          else resolve()
        }
        const fail = (e: Error): void => settle(e)
        const onDrain = (): void => settle()
        waiters.add(fail)
        const ok = child.stdin.write(chunk, (err) => {
          if (err) settle(exited || cancelled ? deadError() : err)
        })
        if (ok) settle()
        else child.stdin.once('drain', onDrain)
      })
    },

    end() {
      ending ??= (async () => {
        if (!exited) child.stdin.end()
        await closed
        const text = tail.text()
        if (cancelled) return { code: exitCode ?? -1, stderrTail: text, cancelled: true }
        if (startError) throw startError
        if (exitCode === 0) return { code: 0, stderrTail: text, cancelled: false }
        throw new FfmpegError(`ffmpeg saiu com código ${exitCode}`, text, exitCode ?? -1)
      })()
      return ending
    },

    async abort() {
      if (!exited && !cancelled) {
        cancelled = true
        child.stdin.destroy()
        kill(child)
      }
      cancelled = true
      await closed
    }
  }
}
