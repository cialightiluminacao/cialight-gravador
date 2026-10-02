// Guarda só o valor mais recente e o aplica depois (agendado) ou na hora (flush). Usado pelo audio worker para os
// projetos: durante um arrasto chegam vários por segundo e cada um monta planos; os que foram superados antes de
// aplicados são descartados, então os pedidos de bloco não esperam atrás de planos velhos.
export class LatestOnly<T> {
  private pending: { v: T } | null = null
  private scheduled = false

  constructor(
    private readonly apply: (v: T) => void,
    private readonly schedule: (fn: () => void) => void = (fn) => setTimeout(fn, 0)
  ) {}

  push(v: T): void {
    this.pending = { v }
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => {
      this.scheduled = false
      this.flush()
    })
  }

  /** Aplica o pendente agora (se houver). */
  flush(): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    this.apply(p.v)
  }

  drop(): void {
    this.pending = null
  }
}
