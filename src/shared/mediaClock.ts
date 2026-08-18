/**
 * Relógio de mídia: `t_media = t_wall − Σ pausas`.
 *
 * Fonte única de timestamps para keyframes da PiP, traços e eventos da sessão.
 * Todos os métodos recebem o instante de parede (`nowMs`, ex.: `performance.now()`
 * ou `Date.now()`) como argumento — a classe não consulta relógio algum, o que a
 * torna determinística e testável.
 */

export interface PauseInterval {
  /** Instante de parede em que a pausa começou. */
  startMs: number
  /** Instante de parede em que a pausa terminou (resume ou stop). */
  endMs: number
}

export class MediaClock {
  private started = false
  private startMs = 0
  private stoppedAtMs: number | null = null
  private closedPauses: PauseInterval[] = []
  private openPauseStartMs: number | null = null

  /** Inicia (ou reinicia) o relógio no instante `nowMs`. */
  start(nowMs: number): void {
    this.started = true
    this.startMs = nowMs
    this.stoppedAtMs = null
    this.closedPauses = []
    this.openPauseStartMs = null
  }

  /** Abre uma pausa. Ignorado se não iniciado, já pausado ou já parado. */
  pause(nowMs: number): void {
    if (!this.started || this.stoppedAtMs !== null || this.openPauseStartMs !== null) return
    this.openPauseStartMs = Math.max(nowMs, this.startMs)
  }

  /** Fecha a pausa aberta. Ignorado se não houver pausa aberta. */
  resume(nowMs: number): void {
    if (this.openPauseStartMs === null) return
    this.closedPauses.push({ startMs: this.openPauseStartMs, endMs: Math.max(nowMs, this.openPauseStartMs) })
    this.openPauseStartMs = null
  }

  /** Encerra o relógio: fecha pausa aberta (se houver) e congela o tempo de mídia em `nowMs`. */
  stop(nowMs: number): void {
    if (!this.started || this.stoppedAtMs !== null) return
    if (this.openPauseStartMs !== null) this.resume(nowMs)
    this.stoppedAtMs = Math.max(nowMs, this.startMs)
  }

  /** Tempo de mídia (ms) correspondente ao instante de parede `nowMs`. Antes de `start()` é 0. */
  mediaTimeMs(nowMs: number): number {
    if (!this.started) return 0
    // Referência efetiva: durante a pausa, o tempo congela no início dela; após stop, no instante do stop.
    let ref = nowMs
    if (this.stoppedAtMs !== null) ref = Math.min(ref, this.stoppedAtMs)
    if (this.openPauseStartMs !== null) ref = Math.min(ref, this.openPauseStartMs)
    ref = Math.max(ref, this.startMs)
    let paused = 0
    for (const p of this.closedPauses) {
      if (p.startMs >= ref) break
      paused += Math.min(p.endMs, ref) - p.startMs
    }
    return ref - this.startMs - paused
  }

  /** Cópia das pausas já fechadas (a pausa aberta não aparece até `resume()`/`stop()`). */
  get pauses(): PauseInterval[] {
    return this.closedPauses.map((p) => ({ ...p }))
  }

  get isPaused(): boolean {
    return this.openPauseStartMs !== null
  }

  /** Instante de parede do `start()` (0 se nunca iniciado). */
  get startedAtMs(): number {
    return this.startMs
  }

  get isRunning(): boolean {
    return this.started && this.stoppedAtMs === null
  }
}
