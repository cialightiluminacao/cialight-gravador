// Taxa da exportação (quadros/s) por janela móvel: a velocidade (× tempo real) e a previsão de tempo restante
// seguem o ritmo dos últimos RATE_WINDOW_MS, não a média desde o 1º quadro (que demora a reagir quando o ritmo muda:
// trecho com efeitos, máquina carregada). Amostras (tempo, quadro); taxa = Δquadros / Δtempo entre a amostra mais
// nova e a âncora (a última amostra com tempo ≤ mais nova − janela; no início, a 1ª). Nada antes de RATE_MIN_SPAN_MS
// ou sem quadro novo → null. Memória: só as amostras da janela (+ a âncora); descarte do início O(1) amortizado.

export const RATE_WINDOW_MS = 10_000
export const RATE_MIN_SPAN_MS = 300

export class RateMeter {
  private ts: number[] = []
  private frames: number[] = []
  private head = 0

  constructor(private readonly windowMs = RATE_WINDOW_MS, private readonly minSpanMs = RATE_MIN_SPAN_MS) {}

  /** Amostra: `tMs` (relógio crescente, ms) e o quadro concluído até então. */
  add(tMs: number, frame: number): void {
    this.ts.push(tMs)
    this.frames.push(frame)
    // a âncora é a última amostra com tempo ≤ tMs − janela: descarta as anteriores a ela
    const limit = tMs - this.windowMs
    while (this.head + 1 < this.ts.length && this.ts[this.head + 1] <= limit) this.head++
    // compacta quando metade do array é descarte (custo amortizado O(1) por amostra)
    if (this.head > 64 && this.head * 2 > this.ts.length) {
      this.ts = this.ts.slice(this.head)
      this.frames = this.frames.slice(this.head)
      this.head = 0
    }
  }

  /** Quadros/s na janela; null sem amostras suficientes (início) ou sem quadro novo. */
  fps(): number | null {
    const last = this.ts.length - 1
    if (last - this.head < 1) return null
    const dt = this.ts[last] - this.ts[this.head]
    const df = this.frames[last] - this.frames[this.head]
    return dt > this.minSpanMs && df > 0 ? (df * 1000) / dt : null
  }

  /** Segundos até `total` a partir de `frame` na taxa atual (≥ 0); null sem taxa. */
  etaS(total: number, frame: number): number | null {
    const f = this.fps()
    return f ? Math.max(0, (total - frame) / f) : null
  }

  /** Amostras guardadas (testes). */
  get size(): number {
    return this.ts.length - this.head
  }
}
