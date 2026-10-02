import { spawn, execFile, type ChildProcess } from 'child_process'
import { ffmpegPath, ffprobePath } from './ffmpegPath'
import { log } from '../log'

// Executa o ffmpeg embutido com progresso (-progress pipe:1) e cancelamento.

export interface FfmpegProgress {
  outTimeUs: number
  frame?: number
  speed?: string
  fps?: number
}

export interface RunResult {
  code: number
  stderrTail: string
  cancelled: boolean
}

export class FfmpegError extends Error {
  constructor(message: string, public readonly stderrTail: string, public readonly code: number) {
    super(message)
    this.name = 'FfmpegError'
  }
}

/** Faz o parse de um bloco de linhas key=value do -progress. */
export function parseProgressLines(lines: string[]): FfmpegProgress | null {
  let outTimeUs: number | null = null
  let frame: number | undefined
  let speed: string | undefined
  let fps: number | undefined
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (key === 'out_time_us' || key === 'out_time_ms') {
      // out_time_ms historicamente traz microssegundos também; preferimos out_time_us
      const n = Number(val)
      if (Number.isFinite(n) && n >= 0 && (key === 'out_time_us' || outTimeUs === null)) outTimeUs = n
    } else if (key === 'frame') frame = Number(val)
    else if (key === 'speed') speed = val
    else if (key === 'fps') fps = Number(val)
  }
  if (outTimeUs === null) return null
  return { outTimeUs, frame, speed, fps }
}

/** Mata o ffmpeg e a árvore de filhos (alguns encoders abrem processos próprios). */
export function killTree(child: Pick<ChildProcess, 'pid' | 'kill'>): void {
  try {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } catch {
    child.kill()
  }
}

/** Leitor do stdout com `-progress pipe:1`: blocos que terminam em "progress=continue|end". */
export function progressReader(onProgress?: (p: FfmpegProgress) => void): (d: Buffer) => void {
  let buf = ''
  return (d) => {
    buf += d.toString('utf8')
    let idx: number
    while ((idx = buf.indexOf('progress=')) >= 0) {
      const end = buf.indexOf('\n', idx)
      if (end < 0) break
      const block = buf.slice(0, end)
      buf = buf.slice(end + 1)
      const p = parseProgressLines(block.split(/\r?\n/))
      if (p && onProgress) onProgress(p)
    }
  }
}

/** Últimas 60 linhas não vazias do stderr. */
export function stderrTail(): { push: (d: Buffer) => void; text: () => string } {
  const lines: string[] = []
  return {
    push: (d) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        lines.push(line)
        if (lines.length > 60) lines.shift()
      }
    },
    text: () => lines.join('\n')
  }
}

export function runFfmpeg(args: string[], opts: { onProgress?: (p: FfmpegProgress) => void; signal?: AbortSignal; cwd?: string; label?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath()
    log.info(`ffmpeg${opts.label ? ` [${opts.label}]` : ''}: ${args.join(' ')}`)
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let cancelled = false
    const tail = stderrTail()

    const onAbort = (): void => {
      cancelled = true
      killTree(child)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', progressReader(opts.onProgress))
    child.stderr.on('data', tail.push)
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new FfmpegError(`não foi possível iniciar o ffmpeg: ${e.message}`, '', -1))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      const text = tail.text()
      if (cancelled) {
        resolve({ code: code ?? -1, stderrTail: text, cancelled: true })
        return
      }
      if (code === 0) resolve({ code: 0, stderrTail: text, cancelled: false })
      else reject(new FfmpegError(`ffmpeg saiu com código ${code}`, text, code ?? -1))
    })
  })
}

export interface ProbeStream {
  index: number
  type: 'video' | 'audio'
  codec: string
  profile?: string
  width?: number
  height?: number
  fps?: number
  channels?: number
  sampleRate?: number
  durationMs?: number
  bitrate?: number
}

export interface ProbeResult {
  durationMs: number
  sizeBytes: number
  bitrate: number
  streams: ProbeStream[]
}

function parseFps(r: string | undefined): number | undefined {
  if (!r) return undefined
  const [a, b] = r.split('/').map(Number)
  if (!a || !b) return undefined
  return a / b
}

export function probeFile(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new FfmpegError(`ffprobe falhou: ${err.message}`, String(stderr), -1))
        return
      }
      try {
        const j = JSON.parse(stdout) as { format: Record<string, string>; streams: Record<string, string>[] }
        const streams: ProbeStream[] = []
        for (const s of j.streams ?? []) {
          if (s.codec_type !== 'video' && s.codec_type !== 'audio') continue
          streams.push({
            index: Number(s.index),
            type: s.codec_type,
            codec: s.codec_name,
            profile: s.profile,
            width: s.width ? Number(s.width) : undefined,
            height: s.height ? Number(s.height) : undefined,
            fps: parseFps(s.avg_frame_rate) ?? parseFps(s.r_frame_rate),
            channels: s.channels ? Number(s.channels) : undefined,
            sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
            durationMs: s.duration ? Math.round(Number(s.duration) * 1000) : undefined,
            bitrate: s.bit_rate ? Number(s.bit_rate) : undefined
          })
        }
        const fmt = j.format ?? {}
        resolve({
          durationMs: fmt.duration ? Math.round(Number(fmt.duration) * 1000) : Math.max(0, ...streams.map((s) => s.durationMs ?? 0)),
          sizeBytes: fmt.size ? Number(fmt.size) : 0,
          bitrate: fmt.bit_rate ? Number(fmt.bit_rate) : 0,
          streams
        })
      } catch (e) {
        reject(new FfmpegError(`ffprobe retornou JSON inválido: ${String(e)}`, stdout.slice(0, 500), -1))
      }
    })
  })
}

/** Instantes (s) dos keyframes da primeira faixa de vídeo. */
export function probeKeyframes(file: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        resolve(parseKeyframeTimes(stdout))
      }
    )
  })
}

/** Saída csv=p=0 do ffprobe (um pts_time por linha) → instantes em s. Linha vazia não vira 0 (Number('') === 0). */
export function parseKeyframeTimes(stdout: string): number[] {
  const out: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim().replace(/,$/, '')
    if (!t) continue
    const n = Number(t)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}
