// Watchdog do render do preview (spec §13): tocando, se nenhum `rendered` chega em 5 s o worker travou
// (decoder/GPU pendurado) e é reiniciado. Puro (relógio injetável); quem chama `check` periodicamente e
// reinicia é o motor do editor (editorEngine.ts).

export const RENDER_STALL_MS = 5000

export class RenderWatchdog {
  private last = 0
  private wasPlaying = false

  constructor(
    private readonly timeoutMs = RENDER_STALL_MS,
    private readonly now: () => number = () => performance.now()
  ) {}

  /** Chegou um quadro renderizado. */
  rendered(): void {
    this.last = this.now()
  }

  /**
   * Chamado periodicamente com o estado da reprodução; true = travou (reinicie). Começar a tocar e cada
   * disparo dão um prazo inteiro novo (o worker reiniciado também precisa abrir os decoders).
   */
  check(playing: boolean): boolean {
    const t = this.now()
    if (!playing) {
      this.wasPlaying = false
      return false
    }
    if (!this.wasPlaying) {
      this.wasPlaying = true
      this.last = t
      return false
    }
    if (t - this.last < this.timeoutMs) return false
    this.last = t
    return true
  }
}
