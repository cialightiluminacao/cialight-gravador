// Cache LRU das rasterizações de texto/forma do compositor (F5). Limites por número de entradas e por bytes
// estimados de textura (w·h·4); a entrada expulsa vai para `onEvict` (o compositor apaga a textura GL dela).

/** Limites do compositor: ≤ 64 entradas e ≤ 64 MB estimados de textura. */
export const RASTER_CACHE_MAX_ENTRIES = 64
export const RASTER_CACHE_MAX_BYTES = 64 * 1024 * 1024

export interface RasterCacheOpts<V> {
  maxEntries?: number
  maxBytes?: number
  onEvict?: (value: V, key: string) => void
}

export class RasterCache<V> {
  private readonly map = new Map<string, { value: V; bytes: number }>()
  private total = 0
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly onEvict: (value: V, key: string) => void

  constructor(opts: RasterCacheOpts<V> = {}) {
    this.maxEntries = opts.maxEntries ?? RASTER_CACHE_MAX_ENTRIES
    this.maxBytes = opts.maxBytes ?? RASTER_CACHE_MAX_BYTES
    this.onEvict = opts.onEvict ?? (() => {})
  }

  get size(): number {
    return this.map.size
  }

  /** Bytes estimados do que está no cache. */
  get bytes(): number {
    return this.total
  }

  /** Entrada por chave; o acesso a torna a mais recente. */
  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  /**
   * Guarda (substitui a de mesma chave, que é expulsa) e expulsa as menos recentes até caber nos limites. Uma entrada
   * maior que `maxBytes` sozinha fica (é a que vai ser desenhada agora) e expulsa todas as outras.
   */
  set(key: string, value: V, bytes: number): void {
    this.delete(key)
    this.map.set(key, { value, bytes })
    this.total += bytes
    for (const [k, e] of this.map) {
      if (this.map.size <= this.maxEntries && this.total <= this.maxBytes) break
      if (k === key) continue
      this.map.delete(k)
      this.total -= e.bytes
      this.onEvict(e.value, k)
    }
  }

  delete(key: string): void {
    const e = this.map.get(key)
    if (!e) return
    this.map.delete(key)
    this.total -= e.bytes
    this.onEvict(e.value, key)
  }

  clear(): void {
    for (const k of [...this.map.keys()]) this.delete(k)
  }
}
