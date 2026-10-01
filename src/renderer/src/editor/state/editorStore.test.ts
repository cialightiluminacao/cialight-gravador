import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { toast } from 'sonner'
import { createEmptyProject } from '@shared/editor/factory'
import { EditError, addMarker } from '@shared/editor/ops'
import type { Asset, Project } from '@shared/editor/project'
import { flushAutosave, startAutosave, useEditorStore } from './editorStore'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const asset = (id: string, name = 'a'): Asset => ({ id, name } as unknown as Asset)

function base(): Project {
  return { ...createEmptyProject('t'), updatedAt: '2000-01-01T00:00:00.000Z' }
}

beforeEach(() => {
  st().close()
  st().open(base())
  vi.mocked(toast.error).mockClear()
})

describe('editorStore', () => {
  it('open inicializa sem sujeira', () => {
    expect(st().project).toBe(st().history.present)
    expect(st().dirty).toBe(false)
    expect(st().canUndo).toBe(false)
  })

  it('apply gera 1 entrada, atualiza updatedAt e marca dirty', () => {
    const p0 = st().project!
    expect(st().apply((p) => addMarker(p, 1000))).toBe(true)
    expect(st().history.past).toHaveLength(1)
    expect(st().project!.markers).toHaveLength(1)
    expect(st().project!.updatedAt).not.toBe(p0.updatedAt)
    expect(st().dirty).toBe(true)
    expect(st().canUndo).toBe(true)
  })

  it('undo/redo restauram snapshot sem mexer em updatedAt e mantêm dirty', () => {
    const p0 = st().project!
    st().apply((p) => addMarker(p, 1000))
    const p1 = st().project!
    st().undo()
    expect(st().project).toBe(p0)
    expect(st().canRedo).toBe(true)
    expect(st().dirty).toBe(true)
    st().redo()
    expect(st().project).toBe(p1)
  })

  it('transação: 200 transient + commitTx = 1 passo de undo', () => {
    const p0 = st().project!
    st().begin()
    for (let i = 0; i < 200; i++) st().apply((p) => addMarker(p, i), { transient: true })
    expect(st().history.past).toHaveLength(0)
    expect(st().project!.markers).toHaveLength(200)
    st().commitTx()
    expect(st().txBase).toBeNull()
    expect(st().history.past).toHaveLength(1)
    st().undo()
    expect(st().project).toBe(p0)
    expect(st().canUndo).toBe(false)
  })

  it('commitTx sem mudanças não cria entrada', () => {
    st().begin()
    st().commitTx()
    expect(st().history.past).toHaveLength(0)
    expect(st().dirty).toBe(false)
  })

  it('cancelTx restaura txBase', () => {
    const p0 = st().project!
    st().begin()
    st().apply((p) => addMarker(p, 5), { transient: true })
    st().cancelTx()
    expect(st().project).toBe(p0)
    expect(st().txBase).toBeNull()
    expect(st().history.past).toHaveLength(0)
  })

  it('apply que lança EditError retorna false, avisa e não altera', () => {
    const p0 = st().project!
    const ok = st().apply(() => { throw new EditError('invalid', 'Nope') })
    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('Nope')
    expect(st().project).toBe(p0)
    expect(st().dirty).toBe(false)
  })

  it('apply relança erros que não são EditError', () => {
    expect(() => st().apply(() => { throw new TypeError('bug') })).toThrow('bug')
  })

  it('applyAssetPatch não cria histórico e corrige past/present/future', () => {
    st().apply((p) => ({ ...p, assets: [asset('x', 'orig')] }))
    st().apply((p) => addMarker(p, 1))
    st().apply((p) => addMarker(p, 2))
    st().undo() // future tem 1 snapshot
    const pastLen = st().history.past.length
    st().applyAssetPatch('x', { name: 'novo' })
    const h = st().history
    expect(h.past).toHaveLength(pastLen)
    expect(st().project!.assets[0].name).toBe('novo')
    expect(h.future[0].assets[0].name).toBe('novo')
    expect(h.past[h.past.length - 1].assets[0].name).toBe('novo')
    // o snapshot sem o asset (anterior) não quebra
    expect(h.past[0].assets).toHaveLength(0)
    expect(st().dirty).toBe(true)
    st().undo()
    expect(st().project!.assets[0].name).toBe('novo')
    expect(st().project).toBe(st().history.present)
  })

  it('setIngest adiciona e remove', () => {
    st().setIngest('a', { step: 'proxy', percent: 10 })
    expect(st().ingest.a).toEqual({ step: 'proxy', percent: 10 })
    st().setIngest('a', null)
    expect(st().ingest.a).toBeUndefined()
  })

  it('select set/add/toggle', () => {
    st().select(['a'])
    st().select(['b'], 'add')
    expect(st().selection).toEqual(['a', 'b'])
    st().select(['a'], 'toggle')
    expect(st().selection).toEqual(['b'])
    st().select(['c'], 'set')
    expect(st().selection).toEqual(['c'])
  })

  it('setZoom mantém o âncora na mesma posição de tela', () => {
    st().setZoom(100)
    st().setScroll(0)
    st().setZoom(200, 1_000_000) // âncora em 1s a 100px da borda; deve continuar a 100px
    expect(st().zoomPxPerSec).toBe(200)
    expect(st().scrollUs).toBe(500_000)
  })
})

describe('transações (casos de borda)', () => {
  it('undo durante tx apenas cancela a tx', () => {
    st().apply((p) => addMarker(p, 1))
    const p1 = st().project!
    st().begin()
    st().apply((p) => addMarker(p, 2), { transient: true })
    st().undo()
    expect(st().project).toBe(p1)
    expect(st().txBase).toBeNull()
    expect(st().history.past).toHaveLength(1)
  })

  it('redo é ignorado durante tx', () => {
    st().apply((p) => addMarker(p, 1))
    st().undo()
    st().begin()
    st().redo()
    expect(st().canRedo).toBe(true)
    expect(st().project!.markers).toHaveLength(0)
  })

  it('apply não-transient durante tx fecha a tx em 1 entrada', () => {
    const p0 = st().project!
    st().begin()
    st().apply((p) => addMarker(p, 1), { transient: true })
    st().apply((p) => addMarker(p, 2))
    expect(st().txBase).toBeNull()
    expect(st().history.past).toEqual([p0])
    expect(st().project!.markers).toHaveLength(2)
  })

  it('transient sem tx aberta vira commit real', () => {
    st().apply((p) => addMarker(p, 1), { transient: true })
    expect(st().history.past).toHaveLength(1)
    expect(st().dirty).toBe(true)
  })

  it('commitTx atualiza updatedAt', () => {
    const p0 = st().project!
    st().begin()
    st().apply((p) => addMarker(p, 1), { transient: true })
    expect(st().project!.updatedAt).toBe(p0.updatedAt)
    st().commitTx()
    expect(st().project!.updatedAt).not.toBe(p0.updatedAt)
  })
})

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('chama save uma vez após 1 s de 5 mudanças e limpa dirty', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(save)
    for (let i = 0; i < 5; i++) {
      st().apply((p) => addMarker(p, i))
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(st().project)
    expect(st().dirty).toBe(false)
    expect(st().lastSavedAt).not.toBeNull()
    stop()
  })

  it('flushAutosave salva imediatamente o pendente', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(save)
    st().apply((p) => addMarker(p, 1))
    await flushAutosave()
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(1)
    stop()
  })

  it('unsubscribe cancela o timer', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(save)
    st().apply((p) => addMarker(p, 1))
    stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
  })

  it('falha no save mantém dirty', async () => {
    const save = vi.fn().mockRejectedValue(new Error('disk'))
    const stop = startAutosave(save)
    st().apply((p) => addMarker(p, 1))
    await vi.advanceTimersByTimeAsync(1100)
    expect(st().dirty).toBe(true)
    expect(st().saving).toBe(false)
    stop()
  })

  it('timer disparando no meio de uma tx não persiste estado não commitado', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(save)
    st().apply((p) => addMarker(p, 1))
    await vi.advanceTimersByTimeAsync(900)
    st().begin()
    st().apply((p) => addMarker(p, 2), { transient: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
    expect(st().dirty).toBe(true)
    st().cancelTx() // volta ao estado commitado, ainda sujo: reagenda
    await vi.advanceTimersByTimeAsync(1100)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].markers).toHaveLength(1)
    expect(st().dirty).toBe(false)
    stop()
  })

  it('flush durante tx não salva', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stop = startAutosave(save)
    st().apply((p) => addMarker(p, 1))
    st().begin()
    await flushAutosave()
    expect(save).not.toHaveBeenCalled()
    stop()
  })

  it('flush após save falho tenta de novo', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined)
    const stop = startAutosave(save)
    st().apply((p) => addMarker(p, 1))
    await vi.advanceTimersByTimeAsync(1100)
    expect(st().dirty).toBe(true)
    await flushAutosave()
    expect(save).toHaveBeenCalledTimes(2)
    expect(st().dirty).toBe(false)
    stop()
  })

  it('toast de erro uma vez por sequência de falhas', async () => {
    vi.mocked(toast.error).mockClear()
    const save = vi.fn().mockRejectedValue(new Error('disk'))
    const stop = startAutosave(save)
    st().apply((p) => addMarker(p, 1))
    await vi.advanceTimersByTimeAsync(1100)
    st().apply((p) => addMarker(p, 2))
    await vi.advanceTimersByTimeAsync(1100)
    expect(save).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Não foi possível salvar o projeto: disk')
    stop()
  })
})
