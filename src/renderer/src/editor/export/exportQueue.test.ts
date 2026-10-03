import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { createEmptyProject } from '@shared/editor/factory'
import { addMarker } from '@shared/editor/ops'
import type { Project } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'
import type { EditorExportProgress } from './editorExport'
import { EditorExportCancelled } from './finalize'
import { ExportQueue, queueProgress, queueSummary, type QueueDeps, type QueueItem, type QueueJob, type QueueRunResult } from './exportQueue'

// Fila de exportações com um executor falso: cada item fica pendurado até o teste resolver/rejeitar.

interface Call {
  job: QueueJob
  signal: AbortSignal
  onProgress: (p: EditorExportProgress) => void
  resolve: (r: QueueRunResult) => void
  reject: (e: unknown) => void
}

const project = (): Project => createEmptyProject('Fila', { width: 64, height: 36, fps: 30, background: '#000000' })

function videoJob(fileName: string, p: Project = project()): QueueJob {
  return { kind: 'video', request: { project: p, width: 64, height: 36, fps: 30, fromUs: 0, toUs: 2_000_000, videoBitrate: 1e6, audioBitrate: 128_000, outputDir: 'C:/saida', fileName } }
}

function setup(extra: Partial<QueueDeps> = {}) {
  const calls: Call[] = []
  const states: { running: boolean; pending: number }[] = []
  const idle: string[] = []
  const started: string[] = []
  let running = 0
  let maxRunning = 0
  const deps: QueueDeps = {
    run: (job, opts) =>
      new Promise<QueueRunResult>((resolve, reject) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        const done = (): void => {
          running--
        }
        calls.push({
          job,
          signal: opts.signal,
          onProgress: opts.onProgress,
          resolve: (r) => {
            done()
            resolve(r)
          },
          reject: (e) => {
            done()
            reject(e)
          }
        })
        // o executor real rejeita com EditorExportCancelled ao abortar
        opts.signal.addEventListener('abort', () => {
          done()
          reject(new EditorExportCancelled())
        })
      }),
    isCancelled: (e) => e instanceof EditorExportCancelled,
    errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
    reportState: (s) => states.push(s),
    beforeItem: (item) => started.push(item.label),
    onIdle: (s) => idle.push(queueSummary(s)),
    ...extra
  }
  const q = new ExportQueue(deps)
  const add = (name: string, durationUs = 2_000_000, job = videoJob(name)): string => q.enqueue({ job, label: name, durationUs, privacy: [] }).id
  const result = (name: string): QueueRunResult => ({ path: `C:/saida/${name}`, size: 100, warnings: [] }) as unknown as QueueRunResult
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const stateOf = (id: string): QueueItem['state'] | undefined => q.items.find((i) => i.id === id)?.state
  return { q, calls, states, idle, started, add, result, flush, stateOf, maxRunning: () => maxRunning }
}

describe('ExportQueue', () => {
  it('executa em ordem, um por vez (nunca dois rodando), e avisa ao terminar', async () => {
    const t = setup()
    const a = t.add('a.mp4')
    const b = t.add('b.mp4')
    const c = t.add('c.mp4')
    expect(t.calls).toHaveLength(1)
    expect([t.stateOf(a), t.stateOf(b), t.stateOf(c)]).toEqual(['running', 'pending', 'pending'])
    for (const [k, name] of ['a.mp4', 'b.mp4', 'c.mp4'].entries()) {
      expect(t.calls[k].job.request.fileName).toBe(name)
      t.calls[k].resolve(t.result(name))
      await t.flush()
    }
    expect(t.calls).toHaveLength(3)
    expect(t.maxRunning()).toBe(1)
    expect(t.started).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    expect(t.q.items.map((i) => i.state)).toEqual(['done', 'done', 'done'])
    expect(t.idle).toEqual(['3 concluídas'])
    expect(t.q.active()).toBe(false)
  })

  it('resumo final (onIdle) que lança não deixa o main "rodando": o estado parado é avisado antes', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const t = setup({
        onIdle: () => {
          throw new Error('toast quebrou')
        }
      })
      t.add('a.mp4')
      t.calls[0].resolve(t.result('a.mp4'))
      await t.flush()
      await t.flush()
      expect(t.states.at(-1)).toEqual({ running: false, pending: 0 })
      expect(t.q.active()).toBe(false)
      expect(unhandled).toEqual([])
      // e a fila continua utilizável
      t.add('b.mp4')
      expect(t.calls).toHaveLength(2)
      expect(t.states.at(-1)).toEqual({ running: true, pending: 0 })
    } finally {
      process.off('unhandledRejection', onUnhandled)
      errors.mockRestore()
    }
  })

  it('posição na fila ao adicionar (a que está rodando conta como 1)', () => {
    const t = setup()
    expect(t.q.enqueue({ job: videoJob('a'), label: 'a', durationUs: 1, privacy: [] }).position).toBe(1)
    expect(t.q.enqueue({ job: videoJob('b'), label: 'b', durationUs: 1, privacy: [] }).position).toBe(2)
    expect(t.q.enqueue({ job: videoJob('c'), label: 'c', durationUs: 1, privacy: [] }).position).toBe(3)
  })

  it('cancelar um pendente: não roda; cancelar o que está rodando aborta e a fila segue com o próximo', async () => {
    const t = setup()
    const a = t.add('a')
    const b = t.add('b')
    const c = t.add('c')
    t.q.cancel(b)
    expect(t.stateOf(b)).toBe('cancelled')
    t.q.cancel(a)
    expect(t.calls[0].signal.aborted).toBe(true)
    await t.flush()
    expect(t.stateOf(a)).toBe('cancelled')
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1].job.request.fileName).toBe('c')
    expect(t.stateOf(c)).toBe('running')
    t.calls[1].resolve(t.result('c'))
    await t.flush()
    expect(t.idle).toEqual(['1 concluída, 2 canceladas'])
  })

  it('erro num item não para a fila; resumo final "3 concluídas, 1 com erro"', async () => {
    const t = setup()
    const ids = ['a', 'b', 'c', 'd'].map((n) => t.add(n))
    t.calls[0].resolve(t.result('a'))
    await t.flush()
    t.calls[1].reject(new Error('disco cheio'))
    await t.flush()
    t.calls[2].resolve(t.result('c'))
    await t.flush()
    t.calls[3].resolve(t.result('d'))
    await t.flush()
    expect(ids.map(t.stateOf)).toEqual(['done', 'error', 'done', 'done'])
    expect(t.q.items[1].message).toBe('disco cheio')
    expect(t.idle).toEqual(['3 concluídas, 1 com erro'])
  })

  it('reordenar: só pendentes trocam de lugar; a ordem nova vale na execução', async () => {
    const t = setup()
    const a = t.add('a')
    const b = t.add('b')
    const c = t.add('c')
    const d = t.add('d')
    t.q.move(d, -1) // d antes de c
    t.q.move(d, -1) // d antes de b
    t.q.move(d, -1) // a está rodando: não passa à frente dele
    t.q.move(a, 1) // o que está rodando não se move
    expect(t.q.items.map((i) => i.id)).toEqual([a, d, b, c])
    t.q.move(b, 1)
    expect(t.q.items.map((i) => i.id)).toEqual([a, d, c, b])
    for (let k = 0; k < 4; k++) {
      t.calls[k].resolve(t.result(String(k)))
      await t.flush()
    }
    expect(t.calls.map((x) => x.job.request.fileName)).toEqual(['a', 'd', 'c', 'b'])
  })

  it('cancelar todas: pendentes cancelados e o atual abortado; limpar concluídas remove os terminados', async () => {
    const t = setup()
    t.add('a')
    t.add('b')
    t.add('c')
    t.q.cancelAll()
    await t.flush()
    expect(t.q.items.map((i) => i.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(t.calls).toHaveLength(1)
    expect(t.q.active()).toBe(false)
    expect(t.idle).toEqual(['3 canceladas'])
    const e = t.add('e')
    expect(t.q.items).toHaveLength(4)
    t.q.clearFinished()
    expect(t.q.items.map((i) => i.id)).toEqual([e])
  })

  it('progresso global e tempo restante: (concluídos + fração do atual) / total; restante = atual + pendentes ÷ velocidade', async () => {
    const t = setup()
    t.add('a', 10_000_000)
    t.add('b', 4_000_000)
    t.add('c', 6_000_000)
    expect(queueProgress(t.q.items)).toEqual({ total: 3, finished: 0, fraction: 0, etaS: null })
    t.calls[0].resolve(t.result('a'))
    await t.flush()
    // b na metade, a 2× tempo real, faltam 1 s dele; c tem 6 s de linha do tempo → 3 s
    t.calls[1].onProgress({ stage: 'render', frame: 60, total: 120, percent: 50, speed: 2, etaS: 1 })
    const p = queueProgress(t.q.items)
    expect(p.total).toBe(3)
    expect(p.finished).toBe(1)
    expect(p.fraction).toBeCloseTo((1 + 0.5) / 3, 10)
    expect(p.etaS).toBeCloseTo(1 + 3, 10)
    // sem velocidade conhecida (finalizando): restante desconhecido
    t.calls[1].onProgress({ stage: 'finalize', frame: 120, total: 120, percent: 99, speed: null, etaS: null })
    expect(queueProgress(t.q.items).etaS).toBeNull()
    // cancelados não contam no total
    t.q.cancel(t.q.items[2].id)
    expect(queueProgress(t.q.items).total).toBe(2)
  })

  it('progresso que chega depois do cancelamento não ressuscita o item', async () => {
    const t = setup()
    const a = t.add('a')
    const late = t.calls[0].onProgress
    t.q.cancel(a)
    await t.flush()
    late({ stage: 'render', frame: 1, total: 2, percent: 50, speed: 1, etaS: 1 })
    expect(t.stateOf(a)).toBe('cancelled')
    expect(t.q.items[0].progress).toBeNull()
  })

  it('estado para o main (confirmação de saída): rodando/pendentes a cada mudança, sem repetir o mesmo', async () => {
    const t = setup()
    t.add('a')
    t.add('b')
    t.add('c')
    t.q.cancel(t.q.items[2].id)
    t.calls[0].resolve(t.result('a'))
    await t.flush()
    t.calls[1].resolve(t.result('b'))
    await t.flush()
    expect(t.states).toEqual([
      { running: true, pending: 0 },
      { running: true, pending: 1 },
      { running: true, pending: 2 },
      { running: true, pending: 1 },
      { running: true, pending: 0 },
      { running: false, pending: 0 }
    ])
  })

  it('outra exportação (quadro PNG) com a trava: a fila espera e começa quando ela solta', async () => {
    vi.useFakeTimers()
    try {
      let busy = true
      const t = setup({ isBusy: () => busy, retryMs: 100 })
      const a = t.add('a')
      expect(t.stateOf(a)).toBe('pending')
      expect(t.calls).toHaveLength(0)
      vi.advanceTimersByTime(100)
      expect(t.calls).toHaveLength(0)
      busy = false
      vi.advanceTimersByTime(100)
      expect(t.stateOf(a)).toBe('running')
      expect(t.calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('instantâneo: editar o projeto do editor depois de enfileirar não muda o item', async () => {
    const st = useEditorStore.getState
    st().close()
    st().open(project())
    const snap = st().project!
    const t = setup()
    const id = t.add('a', 1, videoJob('a', snap))
    expect(st().apply((p) => addMarker(p, 500_000))).toBe(true)
    st().apply((p) => ({ ...p, name: 'Outro nome', tracks: [] }))
    const item = t.q.items.find((i) => i.id === id)!
    expect(st().project).not.toBe(snap)
    expect(item.job.request.project).toBe(snap)
    expect(item.job.request.project.markers).toHaveLength(0)
    expect(item.job.request.project.name).toBe('Fila')
    expect(Object.isFrozen(item.job.request.project)).toBe(true)
    // o executor recebe o instantâneo
    expect(t.calls[0].job.request.project).toBe(snap)
    st().close()
  })
})

describe('queueSummary', () => {
  it('plural, singular e partes vazias omitidas', () => {
    expect(queueSummary({ done: 3, error: 1, cancelled: 0 })).toBe('3 concluídas, 1 com erro')
    expect(queueSummary({ done: 1, error: 0, cancelled: 0 })).toBe('1 concluída')
    expect(queueSummary({ done: 0, error: 2, cancelled: 1 })).toBe('2 com erro, 1 cancelada')
    expect(queueSummary({ done: 2, error: 0, cancelled: 2 })).toBe('2 concluídas, 2 canceladas')
    expect(queueSummary({ done: 0, error: 0, cancelled: 0 })).toBe('nenhuma exportação')
  })
})

beforeEach(() => {
  vi.useRealTimers()
})
