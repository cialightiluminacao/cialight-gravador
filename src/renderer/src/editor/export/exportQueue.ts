// Fila de exportações do editor (renderer). Cada item guarda um INSTANTÂNEO do pedido — o Project do momento em
// que entrou na fila (congelado; editar depois não muda o item), o trecho, o nome, a pasta e as configurações — e
// os avisos de privacidade daquele momento. Os itens rodam estritamente em sequência pelos mesmos pontos de entrada
// da exportação direta (runEditorExport, runGifExport, runAudioExport), que passam pela trava do renderer e pelo
// job único do main: nunca dois ao mesmo tempo. O quadro PNG não entra na fila (é instantâneo e direto).
// Falha num item não para a fila (o item fica com o erro e a fila segue); cancelar o que está rodando aborta pelo
// AbortSignal (o caminho de cancelamento de sempre apaga o parcial) e a fila segue com o próximo. Colisão de nomes
// entre itens: resolvida na hora de rodar pelo main (" (2)", nunca sobrescreve). A fila é PERSISTENTE (G4): o que ainda
// não terminou (pendente/rodando) é informado a `deps.persist` sempre que o CONJUNTO muda (entrar, sair, reordenar,
// começar, terminar, cancelar) — nunca em tique de progresso. Sair confirmado do editor/app INTERROMPE (`interrupt`):
// os itens saem da fila viva para a lista "guardada" (`parked`) e continuam no arquivo, para a oferta de retomar;
// só cancelar de verdade (item/todas) os tira do arquivo. Este módulo é independente de DOM/IPC: o executor e os avisos são
// injetados (exportQueueStore.ts liga os reais; os testes, falsos).
import { freeze } from 'immer'
import type { EditorExportProgress, EditorExportRequest, EditorExportResult } from './editorExport'
import type { AudioExportRequest, FormatExportResult, GifExportRequest } from './formatExport'

export type QueueJob = { kind: 'video'; request: EditorExportRequest } | { kind: 'gif'; request: GifExportRequest } | { kind: 'audio'; request: AudioExportRequest }
export type QueueRunResult = EditorExportResult | FormatExportResult
export type QueueItemState = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface QueueItem {
  readonly id: string
  readonly job: QueueJob
  /** "<arquivo> · <preset> · <duração>". */
  readonly label: string
  /** Duração do trecho (µs): estimativa do tempo restante dos pendentes. */
  readonly durationUs: number
  /** Avisos de privacidade calculados ao enfileirar (texto pronto). */
  readonly privacy: readonly string[]
  readonly state: QueueItemState
  readonly progress: EditorExportProgress | null
  readonly result: QueueRunResult | null
  /** Mensagem do erro (state 'error'). */
  readonly message: string | null
  readonly startedAt: number | null
  readonly endedAt: number | null
  /** Quando entrou na fila (ms); vai para o arquivo. */
  readonly createdAt: number
}

/** Item guardado (interrompido ou lido do arquivo): o suficiente para enfileirar de novo, do zero. */
export interface ParkedEntry {
  job: QueueJob
  label: string
  durationUs: number
  privacy: readonly string[]
  createdAt: number
}

export interface QueueBatchSummary {
  done: number
  error: number
  cancelled: number
  /** Itens que terminaram neste lote (na ordem em que terminaram). */
  items: QueueItem[]
}

export interface QueueDeps {
  run: (job: QueueJob, opts: { signal: AbortSignal; onProgress: (p: EditorExportProgress) => void }) => Promise<QueueRunResult>
  /** Cancelamento esperado (EditorExportCancelled). */
  isCancelled: (e: unknown) => boolean
  errorMessage: (e: unknown) => string
  /** Estado para o main (confirmação de saída). Chamado só quando muda. */
  reportState?: (s: { running: boolean; pending: number }) => void
  /** Antes de cada item começar (pausa a reprodução do editor). */
  beforeItem?: (item: QueueItem) => void
  /** A fila esvaziou depois de processar ao menos um item (resumo final). */
  onIdle?: (summary: QueueBatchSummary) => void
  /** Outra exportação (quadro PNG) com a trava: a fila espera e tenta de novo a cada `retryMs`. */
  isBusy?: () => boolean
  retryMs?: number
  now?: () => number
  /**
   * Conjunto não terminado mudou (ordem da fila: guardados primeiro, depois os vivos). Só depois de `hydrate`:
   * antes disso o arquivo da sessão anterior ainda não foi lido e não pode ser sobrescrito.
   */
  persist?: (entries: readonly ParkedEntry[]) => void
}

export interface EnqueueInput {
  job: QueueJob
  label: string
  durationUs: number
  privacy: readonly string[]
}

const FINISHED: ReadonlySet<QueueItemState> = new Set(['done', 'error', 'cancelled'])
let seq = 0

export class ExportQueue {
  private list: QueueItem[] = []
  private current: { id: string; ac: AbortController } | null = null
  private listeners = new Set<() => void>()
  private retry: ReturnType<typeof setTimeout> | null = null
  private batch: QueueBatchSummary = { done: 0, error: 0, cancelled: 0, items: [] }
  private lastState = ''
  private lastPersist = ''
  private parked: ParkedEntry[] = []
  private parkedRev = 0
  private hydrated = false

  constructor(private readonly deps: QueueDeps) {}

  /** Lista imutável (um array novo a cada mudança). */
  get items(): readonly QueueItem[] {
    return this.list
  }

  /** Há item rodando ou esperando. */
  active(): boolean {
    return !!this.current || this.list.some((i) => i.state === 'pending')
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Enfileira (começa já, se a fila estiver parada). `position`: 1 = o próximo/atual. */
  enqueue(input: EnqueueInput & { createdAt?: number }): { id: string; position: number } {
    const item = this.addItem(input)
    const position = this.list.filter((i) => i.state === 'pending' || i.state === 'running').findIndex((i) => i.id === item.id) + 1
    this.pump()
    this.emit()
    return { id: item.id, position }
  }

  private addItem(input: EnqueueInput & { createdAt?: number }): QueueItem {
    // instantâneo: o Project do editor é imutável (immer); congelar garante que ninguém o altere depois
    freeze(input.job.request.project, true)
    const item: QueueItem = {
      id: `q${++seq}`,
      job: input.job,
      label: input.label,
      durationUs: Math.max(0, Math.round(input.durationUs)),
      privacy: [...input.privacy],
      state: 'pending',
      progress: null,
      result: null,
      message: null,
      startedAt: null,
      endedAt: null,
      createdAt: input.createdAt ?? (this.deps.now ?? Date.now)()
    }
    this.list = [...this.list, item]
    return item
  }

  /** Itens guardados (interrompidos/da sessão anterior) esperando a decisão do usuário. */
  get parkedCount(): number {
    return this.parked.length
  }

  /** Fim da leitura do arquivo: os itens da sessão anterior ficam guardados e a persistência passa a valer. */
  hydrate(entries: readonly ParkedEntry[]): void {
    this.parked = [...this.parked, ...entries]
    this.parkedRev++
    this.hydrated = true
    this.emit()
  }

  /** Retomar: enfileira todos os guardados, em ordem, do zero (o que estava rodando volta a pendente). */
  resume(): number {
    const entries = this.parked
    if (!entries.length) return 0
    this.parked = []
    this.parkedRev++
    // sem emitir entre um e outro: o arquivo nunca perde itens no meio da passagem
    for (const e of entries) this.addItem(e)
    this.pump()
    this.emit()
    return entries.length
  }

  /** Descartar os guardados (o arquivo é esvaziado pelo chamador/persist). */
  discardParked(): void {
    if (!this.parked.length) return
    this.parked = []
    this.parkedRev++
    this.emit()
  }

  /**
   * Sair confirmado: o que roda é interrompido (o parcial é apagado pelo caminho de cancelamento) e tudo que não
   * terminou vai para os guardados — continua no arquivo para retomar depois. Não é "cancelar".
   */
  interrupt(): void {
    const active = this.list.filter((i) => i.state === 'pending' || i.state === 'running')
    if (!active.length) return
    this.parked = [...this.parked, ...active.map((i) => ({ job: i.job, label: i.label, durationUs: i.durationUs, privacy: i.privacy, createdAt: i.createdAt }))]
    this.parkedRev++
    // fora da lista viva já: o item abortando não conta duas vezes; o resultado dele (cancelado) cai no vazio
    this.list = this.list.filter((i) => i.state !== 'pending' && i.state !== 'running')
    this.current?.ac.abort()
    this.pump()
    this.emit()
  }

  /** Pendente → cancelado (não roda); rodando → aborta (o parcial é apagado) e a fila segue. */
  cancel(id: string): void {
    if (this.current?.id === id) {
      this.current.ac.abort()
      return
    }
    const item = this.list.find((i) => i.id === id)
    if (item?.state !== 'pending') return
    this.finish(id, { state: 'cancelled' })
    this.pump()
    this.emit()
  }

  cancelAll(): void {
    for (const i of this.list) if (i.state === 'pending') this.finish(i.id, { state: 'cancelled' })
    this.current?.ac.abort()
    this.pump()
    this.emit()
  }

  /** Troca um pendente com o pendente vizinho (−1 = para cima). O que está rodando e os terminados não se movem. */
  move(id: string, dir: -1 | 1): void {
    const i = this.list.findIndex((x) => x.id === id)
    if (i < 0 || this.list[i].state !== 'pending') return
    let j = i + dir
    while (j >= 0 && j < this.list.length && this.list[j].state !== 'pending') j += dir
    if (j < 0 || j >= this.list.length) return
    // não passa à frente do item rodando (nem de terminados): só entre pendentes
    const lo = Math.min(i, j)
    const hi = Math.max(i, j)
    if (this.list.slice(lo + 1, hi).some((x) => !FINISHED.has(x.state))) return
    const next = [...this.list]
    ;[next[i], next[j]] = [next[j], next[i]]
    this.list = next
    this.emit()
  }

  /** Remove concluídos, com erro e cancelados. */
  clearFinished(): void {
    const next = this.list.filter((i) => !FINISHED.has(i.state))
    if (next.length === this.list.length) return
    this.list = next
    this.emit()
  }

  private patch(id: string, p: Partial<QueueItem>): QueueItem | null {
    let out: QueueItem | null = null
    this.list = this.list.map((i) => (i.id === id ? (out = { ...i, ...p }) : i))
    return out
  }

  private finish(id: string, p: Partial<QueueItem> & { state: 'done' | 'error' | 'cancelled' }): void {
    const item = this.patch(id, { ...p, endedAt: (this.deps.now ?? Date.now)() })
    if (!item) return
    this.batch[p.state === 'done' ? 'done' : p.state === 'error' ? 'error' : 'cancelled']++
    this.batch.items.push(item)
  }

  private pump(): void {
    if (this.current) return
    const next = this.list.find((i) => i.state === 'pending')
    if (!next) {
      if (this.retry) clearTimeout(this.retry)
      this.retry = null
      const b = this.batch
      if (b.items.length) {
        this.batch = { done: 0, error: 0, cancelled: 0, items: [] }
        // estado parado ao main/UI antes do resumo: um onIdle que lance não deixa o main "rodando" (falsa
        // confirmação de saída) nem vira rejeição solta
        this.emit()
        try {
          this.deps.onIdle?.(b)
        } catch (e) {
          console.error('fila de exportações: falha no resumo final', e)
        }
      }
      return
    }
    if (this.deps.isBusy?.()) {
      this.retry ??= setTimeout(() => {
        this.retry = null
        this.pump()
        this.emit()
      }, this.deps.retryMs ?? 250)
      return
    }
    void this.start(next)
  }

  private async start(item: QueueItem): Promise<void> {
    const ac = new AbortController()
    this.current = { id: item.id, ac }
    const running = this.patch(item.id, { state: 'running', startedAt: (this.deps.now ?? Date.now)(), progress: null })
    try {
      if (running) this.deps.beforeItem?.(running)
    } catch {
      // pausar a reprodução não pode impedir a exportação
    }
    const onProgress = (progress: EditorExportProgress): void => {
      if (this.current?.id !== item.id || ac.signal.aborted) return
      this.patch(item.id, { progress })
      this.emit()
    }
    try {
      const result = await this.deps.run(item.job, { signal: ac.signal, onProgress })
      this.finish(item.id, { state: 'done', result })
    } catch (e) {
      if (ac.signal.aborted || this.deps.isCancelled(e)) this.finish(item.id, { state: 'cancelled', progress: null })
      else this.finish(item.id, { state: 'error', message: this.deps.errorMessage(e) })
    } finally {
      this.current = null
      this.pump()
      this.emit()
    }
  }

  private emit(): void {
    this.persistIfChanged()
    const s = { running: !!this.current, pending: this.list.filter((i) => i.state === 'pending').length }
    const key = `${s.running}:${s.pending}`
    if (key !== this.lastState) {
      this.lastState = key
      try {
        this.deps.reportState?.(s)
      } catch {
        // o aviso ao main é melhor esforço
      }
    }
    for (const fn of this.listeners) fn()
  }

  /** Só quando o conjunto não terminado (ids, estados, ordem, guardados) muda — progresso não conta. */
  private persistIfChanged(): void {
    if (!this.hydrated || !this.deps.persist) return
    const active = this.list.filter((i) => i.state === 'pending' || i.state === 'running')
    const key = `${this.parkedRev}|${active.map((i) => `${i.id}:${i.state}`).join(',')}`
    if (key === this.lastPersist) return
    this.lastPersist = key
    const entries: ParkedEntry[] = [...this.parked, ...active.map((i) => ({ job: i.job, label: i.label, durationUs: i.durationUs, privacy: i.privacy, createdAt: i.createdAt }))]
    try {
      this.deps.persist(entries)
    } catch (e) {
      console.error('fila de exportações: falha ao salvar', e)
    }
  }
}

/**
 * Progresso global: (terminados + fração do atual) / total, sem contar cancelados. Tempo restante: o do atual + a
 * duração dos pendentes ÷ a velocidade atual (× tempo real); null sem velocidade conhecida ou sem item rodando.
 */
export function queueProgress(items: readonly QueueItem[]): { total: number; finished: number; fraction: number | null; etaS: number | null } {
  const counted = items.filter((i) => i.state !== 'cancelled')
  const total = counted.length
  const finished = counted.filter((i) => i.state === 'done' || i.state === 'error').length
  const running = counted.find((i) => i.state === 'running')
  const cur = Math.min(1, Math.max(0, (running?.progress?.percent ?? 0) / 100))
  const fraction = total ? (finished + (running ? cur : 0)) / total : null
  const speed = running?.progress?.speed ?? null
  const curEta = running?.progress?.etaS ?? null
  const pendingS = counted.filter((i) => i.state === 'pending').reduce((s, i) => s + i.durationUs / 1e6, 0)
  const etaS = running && speed && speed > 0 && curEta != null ? curEta + pendingS / speed : null
  return { total, finished, fraction, etaS }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "3 concluídas, 1 com erro" (partes zeradas omitidas). */
export function queueSummary(s: { done: number; error: number; cancelled: number }): string {
  const parts = [s.done ? plural(s.done, 'concluída', 'concluídas') : '', s.error ? `${s.error} com erro` : '', s.cancelled ? plural(s.cancelled, 'cancelada', 'canceladas') : ''].filter(Boolean)
  return parts.length ? parts.join(', ') : 'nenhuma exportação'
}
