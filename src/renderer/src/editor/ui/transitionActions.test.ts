import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
  return { toast }
})

import { toast } from 'sonner'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Asset, MediaItem, Project, TextItem } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'
import { addShapeAt, addTextAt, addTransitionNearPlayhead, addTransitionTo, removeSelectedTransition, runShortcut, setTransitionDurationTo } from './editorActions'

const S = 1_000_000
const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const vid = (id: string, dur: number): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' })

/** V1: A 0–4 s | B 4–8 s (encostados). */
function pair(): { p: Project; a: string; b: string } {
  const p0 = ops.addAsset(createEmptyProject('t'), vid('v', 4 * S))
  const ra = ops.addMediaFromAsset(p0, 'v', 0)
  const rb = ops.addMediaFromAsset(ra.project, 'v', 4 * S)
  return { p: rb.project, a: ra.itemIds[0], b: rb.itemIds[0] }
}
const trOf = (id: string): MediaItem['transitionIn'] => (ops.findItem(st().project!, id)!.item as MediaItem).transitionIn

let ids: { a: string; b: string }
beforeEach(() => {
  const { p, a, b } = pair()
  ids = { a, b }
  st().close()
  st().open(p)
  vi.mocked(toast).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('seleção de transição no store', () => {
  it('selecionar a transição limpa os itens; selecionar itens limpa a transição', () => {
    st().select([ids.a])
    st().selectTransition(ids.b)
    expect(st().selectedTransition).toBe(ids.b)
    expect(st().selection).toEqual([])
    st().select([ids.a])
    expect(st().selectedTransition).toBeNull()
    st().selectTransition(ids.b)
    st().select([ids.a], 'toggle')
    expect(st().selectedTransition).toBeNull()
    st().selectTransition(null)
    expect(st().selectedTransition).toBeNull()
  })
  it('abrir outro projeto zera a seleção de transição', () => {
    st().selectTransition(ids.b)
    st().open(pair().p)
    expect(st().selectedTransition).toBeNull()
  })
})

describe('transições: ações', () => {
  it('Ctrl+T (addCrossfade) põe o Dissolver no corte mais próximo, seleciona a transição e é UM passo', () => {
    const past = st().history.past.length
    st().setPlayhead(3.9 * S)
    expect(runShortcut('addCrossfade', null)).toBe(true)
    expect(trOf(ids.b)).toEqual({ kind: 'crossfade', durationUs: 500_000 })
    expect(st().selectedTransition).toBe(ids.b)
    expect(st().history.past.length).toBe(past + 1)
    st().undo()
    expect(trOf(ids.b)).toBeUndefined()
  })
  it('sem corte elegível (um clipe só): toast que explica e nada muda', () => {
    st().apply((p) => ops.deleteItems(p, [ids.b], { ripple: false }))
    const past = st().history.past.length
    expect(addTransitionNearPlayhead('dipBlack')).toBe(false)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(toast).mock.calls[0][0])).toContain('Mergulho no preto')
    expect(st().history.past.length).toBe(past)
  })
  it('trocar o tipo mantém a duração; erro de regra vira toast (primeiro clipe)', () => {
    expect(addTransitionTo(ids.b, 'wipeL')).toBe(true)
    expect(setTransitionDurationTo(ids.b, 1.5 * S)).toBe(true)
    expect(addTransitionTo(ids.b, 'blur')).toBe(true)
    expect(trOf(ids.b)).toEqual({ kind: 'blur', durationUs: 1.5 * S })
    expect(addTransitionTo(ids.a, 'crossfade')).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/encostados/))
  })
  it('duração acima do máximo é limitada e avisa (nenhuma ação silenciosa)', () => {
    addTransitionTo(ids.b, 'crossfade')
    expect(setTransitionDurationTo(ids.b, 30 * S)).toBe(true)
    expect(trOf(ids.b)!.durationUs).toBe(2 * S) // metade de 4 s
    expect(vi.mocked(toast).mock.calls.at(-1)![0]).toMatch(/limitada a 2 s/)
    expect(setTransitionDurationTo(ids.b, 10_000)).toBe(true)
    expect(trOf(ids.b)!.durationUs).toBe(100_000)
  })
  it('Delete remove a transição selecionada (um passo) e não apaga clipes; sem transição, Delete apaga o item', () => {
    addTransitionTo(ids.b, 'crossfade')
    const past = st().history.past.length
    expect(runShortcut('delete', null)).toBe(true)
    expect(trOf(ids.b)).toBeUndefined()
    expect(st().selectedTransition).toBeNull()
    expect(ops.findItem(st().project!, ids.b)).toBeTruthy()
    expect(st().history.past.length).toBe(past + 1)
    // seleção velha (a transição já foi desfeita): o Delete segue para o item selecionado
    st().selectTransition(ids.b)
    expect(removeSelectedTransition()).toBe(false)
    st().select([ids.a])
    runShortcut('delete', null)
    expect(ops.findItem(st().project!, ids.a)).toBeNull()
  })
})

describe('texto e forma da biblioteca', () => {
  it('T (addTitle) cria o Título no playhead, selecionado, em um passo; undo desfaz', () => {
    st().setPlayhead(2 * S)
    const past = st().history.past.length
    expect(runShortcut('addTitle', null)).toBe(true)
    const id = st().selection[0]
    const f = ops.findItem(st().project!, id)!
    expect(f.item).toMatchObject({ type: 'text', text: 'Título', startUs: 2 * S })
    expect(st().history.past.length).toBe(past + 1)
    st().undo()
    expect(ops.findItem(st().project!, id)).toBeNull()
  })
  it('soltar com ponto: o centro vai para o ponto no mesmo passo de desfazer; forma idem', () => {
    const past = st().history.past.length
    const t = addTextAt('subtitle', S, { at: { x: 0.2, y: 0.3 } })!
    const s = addShapeAt('spotlight', S, { at: { x: 0.7, y: 0.4 } })!
    expect(st().history.past.length).toBe(past + 2)
    const tt = ops.findItem(st().project!, t)!.item as TextItem
    expect(tt.visual.transform.x).toEqual({ value: 0.2 })
    expect(tt.visual.transform.y).toEqual({ value: 0.3 })
    const ss = ops.findItem(st().project!, s)!.item
    expect(ss).toMatchObject({ type: 'shape', shape: 'ellipse', spotlight: { dim: 0.6 }, name: 'Holofote' }) // a linha do tempo mostra o nome do modelo
  })
})
