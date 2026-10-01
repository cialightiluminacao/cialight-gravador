// Controle de reprodução do editor. O AudioContext é o relógio mestre: o áudio é mixado no audio
// worker em blocos de 100 ms agendados com 300 ms de antecedência (AudioBufferSourceNode em
// t0 + k·0,1 s), e o vídeo segue o relógio do áudio a cada rAF:
//   tUs = us0 + (ctx.currentTime − t0 − latênciaDeSaída)·1e6
// A thread principal só agenda nós; decodificação e mixagem ficam no worker.
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
// Bloco que chega mais atrasado que isso começa no ponto atual (offset), sem deslocar o relógio.
const LATE_TOLERANCE_S = 0.005

interface Scheduled { atS: number; endS: number; l: number; r: number }

export class PlaybackController {
  private ctx: AudioContext | null = null
  private gen = 0
  private active = false
  private t0 = 0 // ctx.currentTime do início (bloco 0)
  private us0: Us = 0 // posição da timeline em t0
  private endUs: Us = 0
  private nextBlock = 0 // próximo bloco a pedir
  private started = false // t0 definido (1º bloco chegou)
  private readonly nodes = new Set<AudioBufferSourceNode>()
  private scheduled: Scheduled[] = []
  private raf = 0
  private pumpTimer: ReturnType<typeof setInterval> | null = null
  private frameInFlight = false

  constructor(
    private readonly render: RenderClient,
    private readonly audio: AudioClient,
    private readonly store: typeof useEditorStore
  ) {}

  get playing(): boolean {
    return this.active
  }

  /** Posição da timeline pelo relógio do áudio (null fora da reprodução ou antes do 1º bloco). */
  get clockUs(): Us | null {
    if (!this.active || !this.started || !this.ctx) return null
    return Math.max(this.us0, this.us0 + Math.round((this.ctx.currentTime - this.t0 - this.latencyS()) * 1e6))
  }

  /** Pico (0–1) por canal do bloco que está soando (VU); zeros fora da reprodução. */
  get levels(): { l: number; r: number } {
    if (!this.active || !this.ctx) return { l: 0, r: 0 }
    const now = this.ctx.currentTime - this.latencyS()
    while (this.scheduled.length && this.scheduled[0].endS <= now) this.scheduled.shift() // já tocados
    const cur = this.scheduled[0]
    return cur && cur.atS <= now ? { l: cur.l, r: cur.r } : { l: 0, r: 0 }
  }

  async play(): Promise<void> {
    if (this.active) return
    const st = this.store.getState()
    const p = st.project
    if (!p) return
    let us0 = st.playheadUs
    let end = this.endFor(p, us0)
    if (us0 >= end) {
      // no fim: recomeça do ponto de entrada (ou do início)
      us0 = st.inUs !== null && st.inUs < projectDurationUs(p) ? st.inUs : 0
      end = this.endFor(p, us0)
    }
    if (us0 >= end) return
    const gen = ++this.gen
    this.active = true
    this.started = false
    this.us0 = us0
    this.endUs = end
    this.nextBlock = 0
    this.scheduled = []
    this.store.getState().setPlayhead(us0)
    this.store.getState().setPlaying(true)
    const ctx = this.ensureCtx()
    await ctx.resume()
    if (gen !== this.gen) return
    this.pump(gen)
    this.pumpTimer = setInterval(() => this.pump(gen), PUMP_MS)
  }

  pause(): void {
    if (!this.active) return
    const at = Math.min(this.endUs, this.clockUs ?? this.us0)
    this.stop()
    this.store.getState().setPlayhead(at)
    void this.render.requestFrame(at, false)
  }

  /** Para a agenda, limpa os nós agendados e mostra o quadro em `us`; se estava tocando, continua de lá. */
  seek(us: Us): void {
    const wasPlaying = this.active
    const t = Math.max(0, Math.round(us))
    this.stop()
    this.store.getState().setPlayhead(t)
    void this.render.requestFrame(t, false)
    if (wasPlaying) void this.play()
  }

  dispose(): void {
    this.stop()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  // ---- internos ----

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' })
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

  private stop(): void {
    this.gen++
    const wasActive = this.active
    this.active = false
    this.started = false
    if (this.pumpTimer !== null) clearInterval(this.pumpTimer)
    this.pumpTimer = null
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
    const elapsed = this.started ? ctx.currentTime - this.t0 : 0
    while (this.nextBlock * (BLOCK_US / 1e6) < elapsed + AHEAD_S) {
      const k = this.nextBlock
      const fromUs = this.us0 + k * BLOCK_US
      if (fromUs >= this.endUs) return
      const frames = Math.min(BLOCK_FRAMES, Math.round(((this.endUs - fromUs) * SR) / 1e6))
      if (frames <= 0) return
      this.nextBlock++
      void this.audio.render(fromUs, frames).then((b) => this.onBlock(gen, k, b))
    }
  }

  private onBlock(gen: number, k: number, b: AudioBlock | null): void {
    const ctx = this.ctx
    if (gen !== this.gen || !ctx) return
    if (!this.started) {
      // 1º bloco pronto: o relógio começa agora
      this.t0 = ctx.currentTime
      this.started = true
      this.raf = requestAnimationFrame(() => this.tick(gen))
    }
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
    const late = ctx.currentTime - at
    if (late >= dur) return // perdido por inteiro
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.connect(ctx.destination)
    if (late > LATE_TOLERANCE_S) node.start(ctx.currentTime, late)
    else node.start(at)
    node.onended = () => {
      node.disconnect()
      this.nodes.delete(node)
    }
    this.nodes.add(node)
    this.scheduled.push({ atS: at, endS: at + dur, l: pl, r: pr })
    this.scheduled.sort((x, y) => x.atS - y.atS)
  }

  private tick(gen: number): void {
    if (gen !== this.gen) return
    const t = this.clockUs
    if (t === null) return
    if (t >= this.endUs) {
      const end = this.endUs
      this.stop()
      this.store.getState().setPlayhead(end)
      void this.render.requestFrame(end, false)
      return
    }
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
