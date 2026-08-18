import { MediaClock } from '@shared/mediaClock'
import type { PipKeyframe, Session, Stroke } from '@shared/types'

// Registra os eventos da sessão (PiP, traços, pausas, marcadores) carimbados com o
// tempo de mídia e cuida do autosave (throttle). Puro: sem DOM, sem IPC — recebe
// `now()` e `save()` por injeção para ser testável.

export interface SessionRecorderDeps {
  now: () => number
  save: (session: Session) => void | Promise<void>
  autosaveMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

export class SessionRecorder {
  readonly clock = new MediaClock()
  private timer: unknown = null
  private dirty = false
  private lastPipShape: PipKeyframe['shape']

  constructor(
    public session: Session,
    private deps: SessionRecorderDeps
  ) {
    this.lastPipShape = session.pip[session.pip.length - 1]?.shape ?? 'circle'
  }

  private nowMedia(): number {
    return Math.round(this.clock.mediaTimeMs(this.deps.now()))
  }

  begin(): void {
    this.clock.start(this.deps.now())
    // o keyframe inicial da PiP passa a valer em t=0
    if (this.session.pip.length) this.session.pip = [{ ...this.session.pip[this.session.pip.length - 1], tMs: 0 }]
    this.session.state = 'recording'
    this.markDirty(true)
  }

  pause(): void {
    this.clock.pause(this.deps.now())
    this.syncPauses()
    this.markDirty(true)
  }

  resume(): void {
    this.clock.resume(this.deps.now())
    this.syncPauses()
    this.markDirty(true)
  }

  private syncPauses(): void {
    const start = this.clock.startedAtMs
    this.session.pauses = this.clock.pauses.map((p) => ({ startMs: Math.round(p.startMs - start), endMs: Math.round(p.endMs - start) }))
  }

  mediaTimeMs(): number {
    return this.nowMedia()
  }

  /** Converte um instante de parede (performance.now() de outra janela, mesmo relógio monotônico) em tempo de mídia. */
  mediaTimeAt(wallMs: number): number {
    return Math.max(0, Math.round(this.clock.mediaTimeMs(wallMs)))
  }

  addPipKeyframe(k: Omit<PipKeyframe, 'tMs'>): PipKeyframe {
    const kf: PipKeyframe = { ...k, tMs: this.nowMedia() }
    const last = this.session.pip[this.session.pip.length - 1]
    // se o último keyframe tem o mesmo tMs (ex.: arrasto rápido), substitui
    if (last && last.tMs === kf.tMs) this.session.pip[this.session.pip.length - 1] = kf
    else this.session.pip.push(kf)
    this.lastPipShape = kf.shape
    this.markDirty()
    return kf
  }

  get currentPip(): PipKeyframe | null {
    return this.session.pip[this.session.pip.length - 1] ?? null
  }

  get pipShape(): PipKeyframe['shape'] {
    return this.lastPipShape
  }

  /** Traço vindo da overlay (já com tMs de mídia nos pontos e no traço). Substitui se o id já existir. */
  upsertStroke(stroke: Stroke): void {
    const i = this.session.strokes.findIndex((s) => s.id === stroke.id)
    if (i >= 0) this.session.strokes[i] = stroke
    else this.session.strokes.push(stroke)
    this.markDirty()
  }

  /** Desfaz o último traço visível (marca erasedAtMs). Retorna o id ou null. */
  undoLastStroke(): string | null {
    const t = this.nowMedia()
    for (let i = this.session.strokes.length - 1; i >= 0; i--) {
      const s = this.session.strokes[i]
      if (s.erasedAtMs !== undefined) continue
      const clearedAfter = this.session.clearEvents.some((c) => s.tMs < c.tMs && c.tMs <= t)
      if (clearedAfter) continue
      s.erasedAtMs = t
      this.markDirty()
      return s.id
    }
    return null
  }

  clearStrokes(): void {
    this.session.clearEvents.push({ tMs: this.nowMedia() })
    this.markDirty()
  }

  addMarker(label?: string): void {
    this.session.markers.push({ tMs: this.nowMedia(), label })
    this.markDirty()
  }

  /** Traços atualmente visíveis (para sincronizar as overlays após desfazer/apagar). */
  visibleStrokes(): Stroke[] {
    const t = this.nowMedia()
    return this.session.strokes.filter((s) => s.erasedAtMs === undefined && !this.session.clearEvents.some((c) => s.tMs < c.tMs && c.tMs <= t))
  }

  stop(): Session {
    this.clock.stop(this.deps.now())
    this.syncPauses()
    this.session.durationMs = this.nowMedia()
    this.session.state = 'stopped'
    this.dirty = true
    this.flush()
    return this.session
  }

  abort(): void {
    this.session.state = 'aborted'
    this.dirty = true
    this.flush()
  }

  private markDirty(immediate = false): void {
    this.dirty = true
    if (immediate) {
      this.flush()
      return
    }
    if (this.timer !== null) return
    const setT = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = setT(() => {
      this.timer = null
      this.flush()
    }, this.deps.autosaveMs ?? 5000)
  }

  flush(): void {
    if (this.timer !== null) {
      const clearT = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
      clearT(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    void this.deps.save(this.session)
  }
}
