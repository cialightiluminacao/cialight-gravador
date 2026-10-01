// Watchdog do render do preview (spec §13): tocando, se um pedido de quadro fica 5 s sem `rendered` o worker
// travou (decoder/GPU pendurado) e é reiniciado. Só conta prazo com pedido pendente: tocando com o rAF
// suspenso (janela minimizada) ninguém pede quadros e isso não é travamento. Puro (relógio injetável); quem chama `check` periodicamente e
// reinicia é o motor do editor (editorEngine.ts).

export const RENDER_STALL_MS = 5000

export class RenderWatchdog {
  private last = 0
  private armed = false

  constructor(
    private readonly timeoutMs = RENDER_STALL_MS,
    private readonly now: () => number = () => performance.now()
  ) {}

  /** Chegou um quadro renderizado. */
  rendered(): void {
    this.last = this.now()
  }

  /**
   * Chamado periodicamente com o estado da reprodução e se há pedido de quadro sem resposta; true = travou
   * (reinicie). Armar (tocando com pedido pendente) e cada disparo dão um prazo inteiro novo (o worker
   * reiniciado também precisa abrir os decoders).
   */
  check(playing: boolean, pending: boolean): boolean {
    const t = this.now()
    if (!playing || !pending) {
      this.armed = false
      return false
    }
    if (!this.armed) {
      this.armed = true
      this.last = t
      return false
    }
    if (t - this.last < this.timeoutMs) return false
    this.last = t
    return true
  }
}
