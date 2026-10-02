import { existsSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { MediaClock } from '@shared/mediaClock'
import { CURSOR_FILE, normalizeContain, normalizeToFrame, type CursorButton, type CursorClick, type CursorSample, type CursorTrackV1, type Rect } from '@shared/cursor'

// Gravador da trilha do cursor (F6), no processo main. Amostra a posição a cada tick (~60 Hz), carimba com o tempo
// de MÍDIA de um MediaClock próprio (pausas removidas, mesma semântica do relógio do renderer: começa/pausa/retoma
// quando o engine de gravação começa/pausa/retoma) e normaliza ao quadro gravado do instante. Fontes de ponto,
// quadro, cliques, relógio e timer são injetadas (teste unitário e fonte sintética do test:capture).

/** Intervalo pedido ao timer: o quantum padrão do Windows é 15,6 ms, então 15 → ~64 Hz e 16 → ~32 Hz (medido). */
export const CURSOR_TICK_MS = 15

export interface CursorRecorderDeps {
  /** Relógio de parede monotônico (ms). */
  now: () => number
  /** Posição do cursor em px FÍSICOS de tela; null = indisponível neste instante. */
  readPoint: () => { x: number; y: number } | null
  /** Quadro gravado (px físicos de tela) neste instante; null = desconhecido (amostra pulada). */
  readFrame: () => Rect | null
  /** Botões clicados desde a última leitura (fonte nativa). Se lançar, os cliques são desligados (só amostras). */
  pollClicks?: () => CursorButton[]
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
  intervalMs?: number
  /** Uma linha de log quando a fonte de cliques falha. */
  onClickSourceError?: (e: unknown) => void
  /** Erro dentro de um tick do timer (ex.: leitura do ponto): engolido para não derrubar o main; avisado uma vez. */
  onTickError?: (e: unknown) => void
}

/**
 * Como o quadro do instante vira coordenada do vídeo: 'stretch' = direto ao quadro (monitor: tamanho fixo);
 * 'contain' = pela caixa do encoder no tamanho do vídeo (janela redimensionada durante a gravação).
 */
export type FrameMapping = 'stretch' | 'contain'

export class CursorRecorder {
  private clock = new MediaClock()
  private samples: CursorSample[] = []
  /** Última amostra repetida de um trecho parado (entra só quando o ponto muda ou na parada). */
  private stillTail: CursorSample | null = null
  private clicks: CursorClick[] = []
  private timer: unknown = null
  private state: 'idle' | 'running' | 'paused' | 'stopped' = 'idle'
  private result: CursorTrackV1 | null = null
  private pollClicks: (() => CursorButton[]) | null
  private tickErrorReported = false

  constructor(
    private deps: CursorRecorderDeps,
    private video: { width: number; height: number },
    private mapping: FrameMapping = 'stretch'
  ) {
    this.pollClicks = deps.pollClicks ?? null
  }

  get isRunning(): boolean {
    return this.state === 'running' || this.state === 'paused'
  }

  /** Instantes de parede das pausas (relógio deste gravador). */
  get pauses(): { startMs: number; endMs: number }[] {
    return this.clock.pauses
  }

  get startedAtMs(): number {
    return this.clock.startedAtMs
  }

  /** Tempo de mídia (ms, inteiro) agora. */
  mediaTimeMs(): number {
    return Math.round(this.clock.mediaTimeMs(this.deps.now()))
  }

  begin(): void {
    if (this.state !== 'idle') return
    this.clock.start(this.deps.now())
    this.state = 'running'
    this.primeClicks()
    this.boundarySample()
    this.startTimer()
  }

  pause(): void {
    if (this.state !== 'running') return
    // amostra de borda protegida: uma leitura que lança não pode deixar o relógio/timer correndo na pausa
    this.boundarySample()
    this.clock.pause(this.deps.now())
    this.state = 'paused'
    this.stopTimer()
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.clock.resume(this.deps.now())
    this.state = 'running'
    // cliques durante a pausa não entram (o vídeo não tem esse trecho)
    this.primeClicks()
    this.startTimer()
  }

  /** Um tick do timer: cliques pendentes (no ponto atual) e uma amostra. */
  tick(): void {
    if (this.state !== 'running') return
    const buttons = this.readClicks()
    for (const b of buttons) this.addClick(b)
    this.sample()
  }

  /** Clique no instante atual; sem `point`, usa a posição atual do cursor. Fora do quadro ou em pausa: descartado. */
  addClick(button: CursorButton, point?: { x: number; y: number }): void {
    if (this.state !== 'running') return
    const p = point ?? this.deps.readPoint()
    const f = this.deps.readFrame()
    if (!p || !f) return
    const u = normalizeToFrame(p, f)
    if (!(u.x >= 0 && u.x <= 1 && u.y >= 0 && u.y <= 1)) return
    const n = this.toVideo(p, f)
    this.clicks.push({ tMs: this.mediaTimeMs(), x: n.x, y: n.y, button })
  }

  /** Encerra (amostra final no instante da parada) e devolve a trilha. Idempotente. */
  stop(): CursorTrackV1 {
    if (this.result) return this.result
    if (this.state === 'running') this.boundarySample()
    this.stopTimer()
    this.clock.stop(this.deps.now())
    if (this.stillTail) this.samples.push(this.stillTail)
    this.stillTail = null
    this.state = 'stopped'
    this.result = { version: 1, width: this.video.width, height: this.video.height, samples: this.samples, clicks: this.clicks }
    return this.result
  }

  private toVideo(p: { x: number; y: number }, f: Rect): { x: number; y: number } {
    return this.mapping === 'contain' ? normalizeContain(p, f, this.video) : normalizeToFrame(p, f)
  }

  private reportTickError(e: unknown): void {
    if (!this.tickErrorReported) this.deps.onTickError?.(e)
    this.tickErrorReported = true
  }

  /** Amostra no início/pausa/parada: nunca lança (as transições de estado vêm depois e precisam acontecer). */
  private boundarySample(): void {
    try {
      this.sample()
    } catch (e) {
      this.reportTickError(e)
    }
  }

  private sample(): void {
    const p = this.deps.readPoint()
    const f = this.deps.readFrame()
    if (!p || !f) return
    const n = this.toVideo(p, f)
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return
    const s: CursorSample = { tMs: this.mediaTimeMs(), x: n.x, y: n.y }
    const last = this.samples[this.samples.length - 1]
    const lastT = this.stillTail?.tMs ?? last?.tMs ?? -1
    if (s.tMs <= lastT) return
    if (last && last.x === s.x && last.y === s.y) {
      this.stillTail = s
      return
    }
    if (this.stillTail) this.samples.push(this.stillTail)
    this.stillTail = null
    this.samples.push(s)
  }

  private readClicks(): CursorButton[] {
    if (!this.pollClicks) return []
    try {
      return this.pollClicks()
    } catch (e) {
      this.pollClicks = null
      this.deps.onClickSourceError?.(e)
      return []
    }
  }

  private primeClicks(): void {
    this.readClicks()
  }

  private startTimer(): void {
    if (this.timer !== null) return
    const set = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.timer = set(() => {
      try {
        this.tick()
      } catch (e) {
        this.reportTickError(e)
      }
    }, this.deps.intervalMs ?? CURSOR_TICK_MS)
  }

  private stopTimer(): void {
    if (this.timer === null) return
    const clear = this.deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
    clear(this.timer)
    this.timer = null
  }
}

/**
 * Grava `<dir>/cursor.json` de forma atômica (tmp + rename). Só escreve se a sessão ainda existe (session.json na
 * pasta): uma gravação descartada não pode ganhar uma pasta órfã só com o cursor.json (a limpeza lista sessões
 * pelo session.json e nunca a apagaria). Devolve se escreveu.
 */
export function writeCursorTrack(dir: string, track: CursorTrackV1): boolean {
  if (!existsSync(join(dir, 'session.json'))) return false
  const file = join(dir, CURSOR_FILE)
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(track), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* melhor esforço */
    }
    throw e
  }
  return true
}
