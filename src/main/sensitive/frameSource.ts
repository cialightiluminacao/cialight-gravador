import { spawn, type ChildProcess } from 'child_process'
import type { Us } from '@shared/editor/project'

// Quadros da gravação em MEMÓRIA (ruling R1): o ffmpeg empacotado decodifica o trecho e escreve cinza 8 bits cru no
// stdout; nada de arquivo temporário. Sem import de `electron` (o caminho do ffmpeg é injetado: testes em Node puro).
//
// Tempo de cada quadro: `fps=N:round=up` entrega em cada instante fromUs + k/N o ÚLTIMO quadro da origem com tempo ≤
// esse instante — o quadro que está na tela nele (medido: com `round=near`, o padrão, o filtro entrega o último quadro
// do intervalo centrado no instante, até meio intervalo DEPOIS — 233 ms a 2 qps —, o que desalinharia a caixa do tempo).

export interface RawFrame { tUs: Us; w: number; h: number; data: Uint8Array }

export interface FrameStreamOpts {
  ffmpeg: string
  file: string
  fromUs: Us
  toUs: Us
  fps: number
  /** Tamanho de saída (px). */
  w: number
  h: number
  /** Filtro de escala (sem o fps e o format, que são postos aqui). */
  scale: string
  /** Inclui o quadro em toUs (sub-quadros do refinamento) ou não (amostragem: [fromUs, toUs)). */
  inclusiveEnd: boolean
  /** Faixa de vídeo do arquivo (0:v:N; rec.mp4 da sessão: tela 0, webcam 1 — ruling R23). Padrão 0. */
  stream?: number
  onSpawn?: (pid: number) => void
}

export interface FrameStream {
  frames: AsyncIterable<RawFrame>
  /** Mata o ffmpeg iniciado aqui (só este PID). */
  kill(): void
  /** Termina com o código de saída e o fim do stderr (mensagens do ffmpeg; nunca texto reconhecido). */
  done: Promise<{ code: number | null; stderr: string; killed: boolean }>
  readonly pid: number | undefined
}

const sec = (us: Us): string => (us / 1_000_000).toFixed(6)

/** Quantos quadros o trecho tem na grade fromUs + k·step (k ≥ 0), excluindo ou incluindo toUs. */
export function frameCountFor(fromUs: Us, toUs: Us, fps: number, inclusiveEnd: boolean): number {
  const step = 1_000_000 / fps
  const span = toUs - fromUs
  if (span < 0) return 0
  const n = Math.floor(span / step + 1e-9)
  return inclusiveEnd ? n + 1 : Math.max(0, Math.ceil(span / step - 1e-9))
}

/** Argumentos do ffmpeg do trecho (puro: testado). */
export function frameStreamArgs(o: Omit<FrameStreamOpts, 'ffmpeg' | 'onSpawn' | 'w' | 'h'>): string[] {
  const stepUs = 1_000_000 / o.fps
  // meio passo a mais: o quadro em toUs (inclusivo) sai; sem ele, o último fica antes de toUs
  const durUs = (o.toUs - o.fromUs) + (o.inclusiveEnd ? stepUs / 2 : 0)
  const stream = Number.isInteger(o.stream) && o.stream! >= 0 ? o.stream! : 0
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', sec(o.fromUs), '-i', o.file, '-t', sec(Math.max(1, Math.round(durUs))),
    '-an', '-sn', '-dn', '-map', `0:v:${stream}`, '-vf', `fps=${o.fps}:round=up,${o.scale},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']
}

export function frameStream(o: FrameStreamOpts): FrameStream {
  const stepUs = 1_000_000 / o.fps
  const total = frameCountFor(o.fromUs, o.toUs, o.fps, o.inclusiveEnd)
  const args = frameStreamArgs(o)
  const child: ChildProcess = spawn(o.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid !== undefined) o.onSpawn?.(child.pid)
  let killed = false
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-2000)
  })
  const done = new Promise<{ code: number | null; stderr: string; killed: boolean }>((resolve) => {
    child.on('error', (e) => {
      stderr = `${stderr}\n${e.message}`
      resolve({ code: -1, stderr, killed })
    })
    child.on('close', (code) => resolve({ code, stderr, killed }))
  })
  const frameBytes = o.w * o.h
  async function* frames(): AsyncGenerator<RawFrame> {
    if (!child.stdout || total === 0) return
    let k = 0
    let cur = new Uint8Array(frameBytes)
    let fill = 0
    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        let off = 0
        while (off < chunk.length) {
          const n = Math.min(frameBytes - fill, chunk.length - off)
          cur.set(chunk.subarray(off, off + n), fill)
          fill += n
          off += n
          if (fill === frameBytes) {
            if (k < total) yield { tUs: Math.round(o.fromUs + k * stepUs), w: o.w, h: o.h, data: cur }
            k++
            cur = new Uint8Array(frameBytes)
            fill = 0
          }
        }
        if (k >= total) break
      }
    } finally {
      // consumidor parou (cancelado, erro, ou quadros a mais no fim): o ffmpeg não fica rodando
      if (child.exitCode === null) {
        killed = true
        child.kill()
      }
    }
  }
  return {
    frames: frames(),
    kill: () => {
      if (child.exitCode === null && !child.killed) {
        killed = true
        child.kill()
      }
    },
    done,
    get pid() {
      return child.pid
    }
  }
}

/** Amostragem do OCR: 2 qps, ampliado 2× (lanczos), cinza; [fromUs, toUs). */
export function sampleFrames(o: { ffmpeg: string; file: string; fromUs: Us; toUs: Us; sourceW: number; sourceH: number; fps: number; upscale: number; stream?: number; onSpawn?: (pid: number) => void }): FrameStream {
  const w = o.sourceW * o.upscale, h = o.sourceH * o.upscale
  return frameStream({ ffmpeg: o.ffmpeg, file: o.file, fromUs: o.fromUs, toUs: o.toUs, fps: o.fps, w, h, scale: `scale=${w}:${h}:flags=lanczos`, inclusiveEnd: false, stream: o.stream, onSpawn: o.onSpawn })
}

/** Sub-quadros do refinamento (10 qps) no tamanho da análise; [fromUs, toUs] inclusive. */
export function subFrames(o: { ffmpeg: string; file: string; fromUs: Us; toUs: Us; w: number; h: number; fps: number; stream?: number; onSpawn?: (pid: number) => void }): FrameStream {
  return frameStream({ ffmpeg: o.ffmpeg, file: o.file, fromUs: o.fromUs, toUs: o.toUs, fps: o.fps, w: o.w, h: o.h, scale: `scale=${o.w}:${o.h}:flags=area`, inclusiveEnd: true, stream: o.stream, onSpawn: o.onSpawn })
}
