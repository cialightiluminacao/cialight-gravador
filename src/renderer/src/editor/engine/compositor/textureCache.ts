// Cache de texturas das camadas do compositor (spec §13: "caches LRU com limite — texturas 512 MB"). Uma textura
// por chave de camada (`m:<itemId>`, `a:<itemId>`), contada em bytes (w·h·4, RGBA8). Fica entre quadros enquanto
// cabe no orçamento: voltar a um item já visto (seek de ida e volta, imagem estática) reaproveita a textura.
// Depois de cada quadro: descarta as menos usadas recentemente FORA do quadro atual enquanto o total passar do
// orçamento, e as sem uso há mais de TEXTURE_IDLE_FRAMES quadros desenhados. As do quadro atual nunca saem (quadro
// sozinho acima do orçamento conta em overBudgetFrames). O Map fica na ordem do último uso (usar = mover para o
// fim), então o descarte para na primeira entrada que deve ficar: O(descartadas) por quadro.
// Sem WebGL aqui (operações injetadas): testável em node.

export const TEXTURE_BUDGET_BYTES = 512 * 2 ** 20
export const TEXTURE_IDLE_FRAMES = 120

export interface TexOps<T> {
  create(): T
  /** Envia `src` à textura; `sub`: mesmas dimensões do envio anterior (texSubImage2D, sem realocar). */
  upload(tex: T, src: unknown, sub: boolean): void
  delete(tex: T): void
}

export interface TextureCacheStats {
  textureBytes: number
  textureCount: number
  evictions: number
  overBudgetFrames: number
}

interface Entry<T> {
  tex: T
  w: number
  h: number
  /** Fonte imutável (ImageBitmap) do último envio; null = sempre reenviar. */
  src: unknown
  lastFrame: number
}

export class TextureCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly defaultBudget: number
  private readonly idleFrames: number
  private budget: number
  private frame = 0
  private bytes = 0
  private evictions = 0
  private overBudgetFrames = 0

  constructor(private readonly ops: TexOps<T>, opts: { budgetBytes?: number; idleFrames?: number } = {}) {
    this.defaultBudget = opts.budgetBytes ?? TEXTURE_BUDGET_BYTES
    this.budget = this.defaultBudget
    this.idleFrames = opts.idleFrames ?? TEXTURE_IDLE_FRAMES
  }

  beginFrame(): void {
    this.frame++
  }

  /**
   * Textura de `key` com o conteúdo de `src` (w×h px). `immutable`: a fonte não muda depois de criada
   * (ImageBitmap) — a mesma fonte do último envio não é reenviada.
   */
  use(key: string, src: unknown, w: number, h: number, immutable: boolean): T {
    let e = this.entries.get(key)
    if (e) {
      this.entries.delete(key) // reinserida no fim: a ordem do Map é a do último uso
      this.entries.set(key, e)
      e.lastFrame = this.frame
      if (immutable && e.src === src) return e.tex
      const same = e.w === w && e.h === h
      this.ops.upload(e.tex, src, same)
      if (!same) {
        this.bytes += (w * h - e.w * e.h) * 4
        e.w = w
        e.h = h
      }
    } else {
      e = { tex: this.ops.create(), w, h, src: null, lastFrame: this.frame }
      this.entries.set(key, e)
      this.ops.upload(e.tex, src, false)
      this.bytes += w * h * 4
    }
    e.src = immutable ? src : null
    return e.tex
  }

  /** Fim do quadro: descarta as ociosas e, acima do orçamento, as menos usadas recentemente fora do quadro atual. */
  endFrame(): void {
    for (const [key, e] of this.entries) {
      if (e.lastFrame === this.frame) break // daqui em diante só as do quadro atual
      if (this.bytes <= this.budget && this.frame - e.lastFrame <= this.idleFrames) break
      this.drop(key, e)
      this.evictions++
    }
    if (this.bytes > this.budget) this.overBudgetFrames++
  }

  stats(): TextureCacheStats {
    return { textureBytes: this.bytes, textureCount: this.entries.size, evictions: this.evictions, overBudgetFrames: this.overBudgetFrames }
  }

  /** Testes: orçamento menor (null = o padrão); vale a partir do próximo fim de quadro. */
  setBudget(bytes: number | null): void {
    this.budget = bytes ?? this.defaultBudget
  }

  clear(): void {
    for (const [key, e] of this.entries) this.drop(key, e)
  }

  private drop(key: string, e: Entry<T>): void {
    this.ops.delete(e.tex)
    this.entries.delete(key)
    this.bytes -= e.w * e.h * 4
  }
}
