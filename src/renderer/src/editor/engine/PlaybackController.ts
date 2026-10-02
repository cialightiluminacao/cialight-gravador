// Controle de reprodução do editor. O AudioContext é o relógio mestre: o áudio é mixado no audio
// worker em blocos de 100 ms agendados com 300 ms de antecedência (AudioBufferSourceNode em
// t0 + k·0,1 s), e o vídeo segue o relógio do áudio a cada rAF:
//   tUs = us0 + (ctx.currentTime − t0 − latênciaDeSaída)·1e6·taxa
// A thread principal só agenda nós; decodificação e mixagem ficam no worker.
// Shuttle (J/K/L): taxa 1, 2, 4, 8 para frente e −1, −2, −4, −8 para trás. Até 2× para frente o áudio vem esticado
// (tom preservado: cada bloco de 100 ms cobre 100·taxa ms da timeline); acima disso e para trás é mudo e o relógio
// começa na hora (sem esperar bloco).
import { SHUTTLE_AUDIO_MAX_RATE } from '@shared/editor/audioPlan'
import { projectDurationUs } from '@shared/editor/ops'
import type { Project, Us } from '@shared/editor/project'
import type { RenderClient } from './RenderClient'
import type { AudioBlock, AudioClient } from './audio/AudioClient'
import { SR } from './audio/mixer'
import type { useEditorStore } from '../state/editorStore'

const BLOCK_US = 100_000
const BLOCK_FRAMES = (BLOCK_US * SR) / 1e6 // 4800
const AHEAD_S = 0.3
const PUMP_MS = 25
/** Sem nenhum bloco de áudio até aqui (worker travado/mídia com erro): o relógio começa assim mesmo. */
const CLOCK_FALLBACK_MS = 500
/** Taxa máxima do shuttle (L/J apertados de novo dobram até aqui). */
export const MAX_SHUTTLE_RATE = 8

/** Próxima taxa do shuttle ao apertar L (dir 1) ou J (dir −1): parado ou no outro sentido → 1×; no mesmo, dobra até 8×. */
export function nextShuttleRate(current: number | null, dir: 1 | -1): number {
  if (current === null || Math.sign(current) !== dir) return dir
  return dir * Math.min(MAX_SHUTTLE_RATE, Math.abs(current) * 2)
}

/** O shuttle toca som nesta taxa? (até 2× para frente) */
export const shuttleHasAudio = (rate: number): boolean => rate > 0 && rate <= SHUTTLE_AUDIO_MAX_RATE

interface Scheduled { atS: number; endS: number; l: number; r: number }
/** Nó agendado: bloco da timeline em fromUs, tocando a partir de startS (tempo do AudioContext). */
export interface ScheduledInfo { fromUs: Us; startS: number; offsetS: number }

export class PlaybackController {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private volume = 1
  private gen = 0
  private active = false
  private t0 = 0 // ctx.currentTime do início (bloco 0)
  private us0: Us = 0 // posição da timeline em t0
  private endUs: Us = 0 // limite no sentido da reprodução: fim (taxa > 0) ou início (taxa < 0)
  private playRate = 1
  private nextBlock = 0 // próximo bloco a pedir
  private started = false // t0 definido (1º bloco chegou)
  private readonly nodes = new Set<AudioBufferSourceNode>()
  private scheduled: Scheduled[] = []
  private raf = 0
  private pumpTimer: ReturnType<typeof setInterval> | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  private frameInFlight = false
  /** Erros de áudio (mídia que não abre/decodifica, contexto que não inicia); a UI mostra como toast. */
  readonly errors: string[] = []
  private readonly errorListeners = new Set<(message: string, assetId?: string) => void>()
  private readonly scheduleListeners = new Set<(s: ScheduledInfo) => void>()

  constructor(
    private readonly render: RenderClient,
    private readonly audio: AudioClient,
    private readonly store: typeof useEditorStore
  ) {
    this.audio.onError((message, assetId) => this.fail(message, assetId))
  }

  /** assetId presente quando a falha é de uma mídia específica. */
  onError(cb: (message: string, assetId?: string) => void): () => void {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  /** Cada AudioBufferSourceNode agendado (diagnóstico/testes). */
  onSchedule(cb: (s: ScheduledInfo) => void): () => void {
    this.scheduleListeners.add(cb)
    return () => this.scheduleListeners.delete(cb)
  }

  /** ctx.currentTime (0 sem contexto). */
  get contextTime(): number {
    return this.ctx?.currentTime ?? 0
  }

  get playing(): boolean {
    return this.active
  }

  /** Taxa da reprodução atual (1 parado/Espaço; shuttle ±1, ±2, ±4, ±8). */
  get rate(): number {
    return this.playRate
  }

  /** Posição da timeline pelo relógio do áudio (null fora da reprodução ou antes do 1º bloco). */
  get clockUs(): Us | null {
    if (!this.active || !this.started || !this.ctx) return null
    // durante a latência de saída o relógio fica em us0 (o som ainda não saiu)
    const elapsedUs = Math.max(0, Math.round((this.ctx.currentTime - this.t0 - this.latencyS()) * 1e6))
    return this.us0 + Math.round(elapsedUs * this.playRate)
  }

  /** Pico (0–1) por canal do bloco que está soando (VU); zeros fora da reprodução. */
  get levels(): { l: number; r: number } {
    if (!this.active || !this.ctx) return { l: 0, r: 0 }
    const now = this.ctx.currentTime - this.latencyS()
    while (this.scheduled.length && this.scheduled[0].endS <= now) this.scheduled.shift() // já tocados
    const cur = this.scheduled[0]
    return cur && cur.atS <= now ? { l: cur.l, r: cur.r } : { l: 0, r: 0 }
  }

  /** Toca a `rate`× a partir do playhead (Espaço: 1×; shuttle: ±1, ±2, ±4, ±8). */
  async play(rate = 1): Promise<void> {
    if (this.active) return
    const st = this.store.getState()
    const p = st.project
    if (!p) return
    let us0 = st.playheadUs
    let end = rate > 0 ? this.endFor(p, us0) : this.startFor(us0)
    if (rate > 0 && us0 >= end) {
      // no fim: recomeça do ponto de entrada (ou do início)
      us0 = st.inUs !== null && st.inUs < projectDurationUs(p) ? st.inUs : 0
      end = this.endFor(p, us0)
    }
    if (rate > 0 ? us0 >= end : us0 <= end) {
      this.playRate = 1 // nada a tocar nesse sentido: parado a 1×
      return
    }
    const gen = ++this.gen
    this.active = true
    this.started = false
    this.us0 = us0
    this.endUs = end
    this.playRate = rate
    this.nextBlock = 0
    this.scheduled = []
    this.store.getState().setPlayhead(us0)
    this.store.getState().setPlaying(true, rate)
    try {
      await this.ensureCtx().resume()
    } catch (err) {
      if (gen === this.gen) this.stop() // também desliga `playing` na store
      this.fail(`não foi possível iniciar o áudio (${err instanceof Error ? err.message : String(err)})`)
      return
    }
    if (gen !== this.gen) return
    this.pump(gen)
    this.pumpTimer = setInterval(() => this.pump(gen), PUMP_MS)
    // shuttle mudo: nenhum bloco vai chegar, o relógio começa agora
    if (!shuttleHasAudio(rate)) {
      this.startClock(gen)
      return
    }
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      if (gen === this.gen && !this.started) this.startClock(gen)
    }, CLOCK_FALLBACK_MS)
  }

  /** Pausa (K) e volta a taxa para 1×. */
  pause(): void {
    if (!this.active) {
      this.playRate = 1
      return
    }
    const at = this.clampToLimit(this.clockUs ?? this.us0)
    this.stop()
    this.playRate = 1
    this.store.getState().setPlayhead(at)
    void this.render.requestFrame(at, false)
  }

  /**
   * J (dir −1) / L (dir 1): parado ou no outro sentido toca a 1× nesse sentido; no mesmo sentido dobra a taxa até 8×.
   * Troca de taxa recomeça a agenda do ponto atual do relógio.
   */
  async shuttle(dir: 1 | -1): Promise<void> {
    const rate = nextShuttleRate(this.active ? this.playRate : null, dir)
    if (this.active) {
      if (rate === this.playRate) return
      const at = this.clampToLimit(this.clockUs ?? this.us0)
      this.stop()
      this.playRate = 1 // se não houver para onde ir (início/fim), fica parado a 1×
      this.store.getState().setPlayhead(at)
    }
    await this.play(rate)
  }

  /** Para a agenda, limpa os nós agendados e mostra o quadro em `us`; se estava tocando, continua de lá (na mesma taxa). */
  seek(us: Us): void {
    const wasPlaying = this.active
    const t = Math.max(0, Math.round(us))
    this.stop()
    this.store.getState().setPlayhead(t)
    void this.render.requestFrame(t, false)
    if (wasPlaying) void this.play(this.playRate)
  }

  /** Volume master do preview (0–1); não afeta a exportação. */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    if (this.master) this.master.gain.value = this.volume
  }

  dispose(): void {
    this.stop()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.master = null
  }

  // ---- internos ----

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' })
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  private latencyS(): number {
    return this.ctx ? this.ctx.outputLatency || this.ctx.baseLatency || 0 : 0
  }

  /** Fim da reprodução: ponto de saída (se à frente) ou fim do projeto. */
  private endFor(p: Project, fromUs: Us): Us {
    const out = this.store.getState().outUs
    return out !== null && out > fromUs ? out : projectDurationUs(p)
  }

  /** Limite da reprodução para trás: ponto de entrada (se atrás) ou o início. */
  private startFor(fromUs: Us): Us {
    const inUs = this.store.getState().inUs
    return inUs !== null && inUs < fromUs ? inUs : 0
  }

  /** Posição presa ao limite no sentido da reprodução. */
  private clampToLimit(t: Us): Us {
    return this.playRate > 0 ? Math.min(this.endUs, t) : Math.max(this.endUs, t)
  }

  private fail(message: string, assetId?: string): void {
    console.warn(`[áudio] ${message}`)
    this.errors.push(message)
    for (const l of this.errorListeners) l(message, assetId)
  }

  private stop(): void {
    this.gen++
    this.audio.cancel()
    const wasActive = this.active
    this.active = false
    this.started = false
    if (this.pumpTimer !== null) clearInterval(this.pumpTimer)
    this.pumpTimer = null
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer)
    this.fallbackTimer = null
    cancelAnimationFrame(this.raf)
    for (const n of this.nodes) {
      try {
        n.stop()
      } catch {
        // nó ainda não iniciado em alguns navegadores: ignorar
      }
      n.disconnect()
    }
    this.nodes.clear()
    this.scheduled = []
    if (wasActive) this.store.getState().setPlaying(false)
  }

  /** Pede blocos até cobrir AHEAD_S à frente do relógio (antes do 1º bloco: os primeiros AHEAD_S). */
  private pump(gen: number): void {
    const ctx = this.ctx
    if (gen !== this.gen || !ctx) return
    // fim detectado também aqui: sem rAF (janela oculta/minimizada) a reprodução ainda para
    if (this.finishIfEnded()) return
    const rate = this.playRate
    if (!shuttleHasAudio(rate)) return // shuttle mudo: o relógio anda sem blocos
    const elapsed = this.started ? ctx.currentTime - this.t0 : 0
    while (this.nextBlock * (BLOCK_US / 1e6) < elapsed + AHEAD_S) {
      const k = this.nextBlock
      // cada bloco de 100 ms de relógio cobre 100·rate ms da timeline
      const fromUs = this.us0 + Math.round(k * BLOCK_US * rate)
      if (fromUs >= this.endUs) return
      const frames = Math.min(BLOCK_FRAMES, Math.round(((this.endUs - fromUs) * SR) / 1e6 / rate))
      if (frames <= 0) return
      this.nextBlock++
      void this.audio.render(fromUs, frames, rate).then((b) => this.onBlock(gen, k, b))
    }
  }

  private onBlock(gen: number, k: number, b: AudioBlock | null): void {
    const ctx = this.ctx
    if (gen !== this.gen || !ctx) return
    if (!this.started) this.startClock(gen) // 1º bloco pronto: o relógio começa agora
    if (!b) return // erro do worker: silêncio neste bloco, o relógio segue
    const n = b.pcm.length / 2
    const buf = ctx.createBuffer(2, n, SR)
    const L = buf.getChannelData(0)
    const R = buf.getChannelData(1)
    let pl = 0, pr = 0
    for (let i = 0; i < n; i++) {
      const l = b.pcm[i * 2], r = b.pcm[i * 2 + 1]
      L[i] = l
      R[i] = r
      if (Math.abs(l) > pl) pl = Math.abs(l)
      if (Math.abs(r) > pr) pr = Math.abs(r)
    }
    const at = this.t0 + (k * BLOCK_US) / 1e6
    const dur = n / SR
    const now = ctx.currentTime
    const late = now - at
    if (late >= dur) return // perdido por inteiro
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.connect(this.master ?? ctx.destination)
    // atrasado: começa agora, pulando o trecho já passado (nunca sobrepõe o bloco seguinte)
    const startS = late > 0 ? now : at
    const offsetS = late > 0 ? late : 0
    node.start(startS, offsetS)
    for (const l of this.scheduleListeners) l({ fromUs: b.fromUs, startS, offsetS })
    node.onended = () => {
      node.disconnect()
      this.nodes.delete(node)
    }
    this.nodes.add(node)
    this.scheduled.push({ atS: at, endS: at + dur, l: pl, r: pr })
    this.scheduled.sort((x, y) => x.atS - y.atS)
  }

  /** Define t0 (relógio começa agora) e inicia o laço de vídeo. Blocos que chegarem depois entram atrasados (com offset). */
  private startClock(gen: number): void {
    const ctx = this.ctx
    if (gen !== this.gen || !ctx || this.started) return
    this.t0 = ctx.currentTime
    this.started = true
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer)
    this.fallbackTimer = null
    this.raf = requestAnimationFrame(() => this.tick(gen))
  }

  /** Chegou ao fim (ou ao início, para trás): para, deixa o playhead no limite, volta a 1× e mostra o quadro. */
  private finishIfEnded(): boolean {
    const t = this.clockUs
    if (t === null || (this.playRate > 0 ? t < this.endUs : t > this.endUs)) return false
    const end = this.endUs
    this.stop()
    this.playRate = 1
    this.store.getState().setPlayhead(end)
    void this.render.requestFrame(end, false)
    return true
  }

  private tick(gen: number): void {
    if (gen !== this.gen) return
    const t = this.clockUs
    if (t === null || this.finishIfEnded()) return
    this.store.getState().setPlayhead(t)
    if (!this.frameInFlight) {
      // um pedido de quadro por vez: se o render atrasar, o próximo rAF pede o tempo mais recente
      this.frameInFlight = true
      void this.render.requestFrame(t, true).finally(() => {
        this.frameInFlight = false
      })
    }
    this.raf = requestAnimationFrame(() => this.tick(gen))
  }
}
