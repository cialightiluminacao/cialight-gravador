// Orçamento de memória dos filmstrips na linha do tempo (spec §13: "caches LRU com limite — filmstrips 200 MB").
// Cada filmstrip é uma sprite (arquivo em cache/ do projeto) mostrada por CSS background; o Chromium guarda a imagem
// decodificada enquanto algum elemento a usa. Aqui as sprites são admitidas pelo tamanho decodificado
// ((quadros·tileW)·tileH·4 bytes): itens visíveis (Filmstrip montado) pedem admissão; acima do orçamento saem
// primeiro as admitidas fora da tela, da menos recentemente visível para a mais; se só as montadas já passam do
// orçamento, as pedidas há mais tempo ficam sem sprite (cor do item + listras discretas) até haver espaço. Sprite
// descartada sai do DOM (sem background-image) e o Chromium pode liberar a imagem.
// Custo O(1) amortizado por montagem/desmontagem (Maps na ordem de recência); nada roda durante o arraste: o hook
// só lê o estado da chave e o efeito depende só da chave e do tamanho (invariante 6).
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { FilmstripInfo } from '@shared/editor/project'

export const FILMSTRIP_BUDGET_BYTES = 200 * 2 ** 20

/** Tamanho decodificado (RGBA) da sprite: (quadros·tileW)·tileH·4. */
export function filmstripBytes(fs: Pick<FilmstripInfo, 'frames' | 'tileW' | 'tileH'>): number {
  return fs.frames * fs.tileW * fs.tileH * 4
}

export interface FilmstripStats {
  /** bytes das sprites admitidas (montadas ou não) */
  bytes: number
  count: number
  /** sprites que perderam a admissão (fora da tela descartadas ou montadas que cederam lugar) */
  evictions: number
  /** pedidos de itens montados que ficaram sem sprite (recusados ou que cederam lugar) */
  denied: number
}

interface Entry {
  key: string
  bytes: number
  mounts: number
  admitted: boolean
}

export class FilmstripBudget {
  private readonly entries = new Map<string, Entry>()
  /** admitidas sem item montado, na ordem da última visibilidade (as primeiras saem antes) */
  private readonly idle = new Map<string, Entry>()
  /** admitidas e montadas, na ordem do último pedido (as primeiras cedem lugar antes) */
  private readonly shown = new Map<string, Entry>()
  /** montadas sem sprite, na ordem em que ficaram sem (as primeiras entram antes) */
  private readonly waiting = new Map<string, Entry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private bytes = 0
  private evictions = 0
  private denied = 0

  constructor(private readonly budget = FILMSTRIP_BUDGET_BYTES) {}

  /** Um item montado mostra a sprite `key` (o pedido mais recente). */
  acquire(key: string, bytes: number): void {
    let e = this.entries.get(key)
    if (!e) {
      e = { key, bytes, mounts: 0, admitted: false }
      this.entries.set(key, e)
    }
    e.mounts++
    if (e.admitted) {
      this.idle.delete(key)
      this.shown.delete(key)
      this.shown.set(key, e)
      return
    }
    this.waiting.delete(key)
    if (this.admit(e, true)) {
      this.shown.set(key, e)
      this.notify(key)
    } else {
      this.waiting.set(key, e)
      this.denied++
    }
  }

  /** Um item que mostrava `key` foi desmontado (saiu da tela, mudou de sprite, foi apagado). */
  release(key: string): void {
    const e = this.entries.get(key)
    if (!e || e.mounts === 0) return
    e.mounts--
    if (e.mounts > 0) return
    if (!e.admitted) {
      this.waiting.delete(key)
      this.entries.delete(key)
      return
    }
    this.shown.delete(key)
    this.idle.set(key, e)
    // espaço que pode ser liberado: as que esperam entram (na ordem em que ficaram sem), até a 1ª que não couber
    for (const w of this.waiting.values()) {
      if (!this.admit(w, false)) break
      this.waiting.delete(w.key)
      this.shown.set(w.key, w)
      this.notify(w.key)
    }
  }

  admitted(key: string): boolean {
    return this.entries.get(key)?.admitted ?? false
  }

  /** Estado para o render (antes do efeito que pede a admissão): admitida, ou nova que cabe sem descartar nada. */
  canShow(key: string, bytes: number): boolean {
    const e = this.entries.get(key)
    return e ? e.admitted : this.bytes + bytes <= this.budget
  }

  subscribe(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key)
    }
  }

  stats(): FilmstripStats {
    return { bytes: this.bytes, count: this.idle.size + this.shown.size, evictions: this.evictions, denied: this.denied }
  }

  /**
   * Abre espaço para `e` descartando as fora da tela (menos recentemente visíveis primeiro) e, com `preempt`, as
   * montadas pedidas há mais tempo (vão para a espera). Sprite maior que o orçamento inteiro: recusada sem descartar.
   */
  private admit(e: Entry, preempt: boolean): boolean {
    if (e.bytes > this.budget) return false
    for (const v of this.idle.values()) {
      if (this.bytes + e.bytes <= this.budget) break
      this.idle.delete(v.key)
      this.entries.delete(v.key)
      this.drop(v)
    }
    if (preempt) {
      for (const v of this.shown.values()) {
        if (this.bytes + e.bytes <= this.budget) break
        this.shown.delete(v.key)
        this.waiting.set(v.key, v)
        this.drop(v)
        this.denied++
      }
    }
    if (this.bytes + e.bytes > this.budget) return false
    e.admitted = true
    this.bytes += e.bytes
    return true
  }

  private drop(v: Entry): void {
    v.admitted = false
    this.bytes -= v.bytes
    this.evictions++
    this.notify(v.key)
  }

  private notify(key: string): void {
    const set = this.listeners.get(key)
    if (set) for (const cb of [...set]) cb()
  }
}

/** Orçamento da janela (uma linha do tempo por vez; sprites de projetos fechados saem pela recência). */
export const filmstripBudget = new FilmstripBudget()

/**
 * Sprite `key` (null: sem filmstrip) de `bytes` decodificados pode ser mostrada? Pede a admissão enquanto o
 * componente estiver montado; re-renderiza só quando o estado desta sprite muda.
 */
export function useFilmstripAdmission(key: string | null, bytes: number, budget: FilmstripBudget = filmstripBudget): boolean {
  const subscribe = useCallback((cb: () => void) => (key ? budget.subscribe(key, cb) : () => {}), [key, budget])
  const shown = useSyncExternalStore(subscribe, () => (key ? budget.canShow(key, bytes) : false))
  useEffect(() => {
    if (!key) return
    budget.acquire(key, bytes)
    return () => budget.release(key)
  }, [key, bytes, budget])
  return shown
}
