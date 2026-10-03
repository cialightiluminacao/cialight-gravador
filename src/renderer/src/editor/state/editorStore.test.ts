import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import { toast } from 'sonner'
import { createEffectItem, createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { attachEffects } from '@shared/editor/followTransform'
import { EditError, addAsset, addMarker, addMediaFromAsset, addTransition, deleteItems, findItem, moveItems, removeTransition, trimItem, updateItem } from '@shared/editor/ops'
import type { Asset, EffectItem, MediaItem, Project } from '@shared/editor/project'
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
  vi.mocked(toast).mockClear()
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

  it('âncoras: edições transitórias não recalculam a caixa de reserva; o commit da transação recalcula', () => {
    const vid = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 10_000_000, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 }, status: 'ready' } as Asset
    const p = base()
    p.assets = [vid]
    const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', linkId: 'l' } as MediaItem
    const fx = { ...createEffectItem('blur', 0, 10_000_000, { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }), id: 'fx', linkId: 'l' } as EffectItem
    p.tracks = [{ ...p.tracks[0], items: [m] }, { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }]
    st().open(attachEffects(p, 'm', ['fx']))
    const fb = (): unknown => (findItem(st().project!, 'fx')!.item as EffectItem).attach!.fallback
    const f0 = fb()
    st().begin()
    for (const s of [1.5, 2, 3]) st().apply((q) => updateItem<MediaItem>(q, 'm', (d) => { d.visual!.transform.scale = { value: s } }), { transient: true })
    expect(fb()).toBe(f0)
    st().commitTx()
    expect(fb()).not.toEqual(f0)
    // a caixa do commit é a mesma de uma edição direta
    const direct = updateItem<MediaItem>(attachEffects(p, 'm', ['fx']), 'm', (d) => { d.visual!.transform.scale = { value: 3 } })
    expect(fb()).toEqual((findItem(direct, 'fx')!.item as EffectItem).attach!.fallback)
    // função crua fora de transação (proporção do quadro na barra de cima): a caixa também se recalcula
    const f1 = fb()
    st().apply((q) => ({ ...q, canvas: { ...q.canvas, width: 1080, height: 1920 } }))
    expect(fb()).not.toEqual(f1)
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

  it('speechFailed: marca o asset sem dados de fala; nova análise (patch de speech) limpa; fechar zera', () => {
    st().apply((p) => ({ ...p, assets: [asset('x'), asset('y')] }))
    st().setSpeechFailed('x')
    st().setSpeechFailed('y')
    const before = st().speechFailed
    st().setSpeechFailed('x')
    expect(st().speechFailed).toBe(before) // sem mudança: mesmo objeto
    st().applyAssetPatch('x', { name: 'outro' })
    expect(st().speechFailed).toEqual({ x: true, y: true })
    st().applyAssetPatch('x', { speech: 'cache/x.speech.json' })
    expect(st().speechFailed).toEqual({ y: true })
    st().close()
    expect(st().speechFailed).toEqual({})
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

  it('markAudioProcessed registra chave → impressão em todo o histórico, sem entrada de undo', () => {
    st().apply((p) => ({ ...p, assets: [{ ...asset('x'), processedAudio: { 'dn-sh': 'a-1' } }] }))
    st().apply((p) => addMarker(p, 1))
    const pastLen = st().history.past.length
    st().markAudioProcessed('x', 'ln-i16-tp1.5', 'a-1')
    st().markAudioProcessed('x', 'dn-sh', 'a-1')
    expect(st().history.past).toHaveLength(pastLen)
    expect(st().project!.assets[0].processedAudio).toEqual({ 'dn-sh': 'a-1', 'ln-i16-tp1.5': 'a-1' })
    st().undo()
    expect(st().project!.assets[0].processedAudio).toEqual({ 'dn-sh': 'a-1', 'ln-i16-tp1.5': 'a-1' })
    st().markAudioProcessed('zz', 'dn-sh', 'a-1') // asset removido nesse meio tempo: ignora
  })

  it('estado do processamento de áudio e do A/B fica fora do projeto', () => {
    const p = st().project
    st().setAudioJob('x~dn-sh', { percent: 30 })
    st().setAudioBypass(true)
    expect(st().audioJobs).toEqual({ 'x~dn-sh': { percent: 30 } })
    expect(st().audioBypass).toBe(true)
    st().setAudioJob('x~dn-sh', null)
    expect(st().audioJobs).toEqual({})
    expect(st().project).toBe(p)
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

describe('prévia fora do histórico (zoom automático, I1)', () => {
  const withPreview = (): { p0: Project; preview: Project } => {
    const p0 = st().project!
    const preview = addMarker(p0, 42) // qualquer projeto derivado serve: a prévia nunca entra no histórico
    st().setPreview(preview)
    return { p0, preview }
  }
  it('mostrar e cancelar: o projeto e o histórico não mudam (restaura exatamente)', () => {
    const { p0, preview } = withPreview()
    expect(st().preview).toBe(preview)
    expect(st().project).toBe(p0)
    expect(st().history.past).toHaveLength(0)
    expect(st().txBase).toBeNull()
    st().setPreview(null)
    expect(st().project).toBe(p0)
    expect(st().dirty).toBe(false)
  })
  it('edição do inspetor (commit direto) com a prévia aberta: a prévia some e não entra no histórico', () => {
    const { p0 } = withPreview()
    st().apply((p) => addMarker(p, 7))
    expect(st().preview).toBeNull()
    expect(st().history.past).toEqual([p0])
    expect(st().project!.markers.map((m) => m.tUs)).toEqual([7])
  })
  it('gesto transitório (begin/transient/commitTx) com a prévia aberta: as edições valem, a prévia não', () => {
    const { p0 } = withPreview()
    st().begin()
    st().apply((p) => addMarker(p, 1), { transient: true })
    expect(st().preview).toBeNull()
    st().apply((p) => addMarker(p, 2), { transient: true })
    st().commitTx()
    expect(st().history.past).toEqual([p0])
    expect(st().project!.markers.map((m) => m.tUs).sort()).toEqual([1, 2])
  })
  it('desfazer e transient sem transação também descartam; nunca grava a prévia', () => {
    st().apply((p) => addMarker(p, 5))
    withPreview()
    st().undo()
    expect(st().preview).toBeNull()
    expect(st().history.future.every((p) => !p.markers.some((m) => m.tUs === 42))).toBe(true)
    withPreview()
    st().apply((p) => addMarker(p, 9), { transient: true })
    expect(st().preview).toBeNull()
    expect([...st().history.past, st().project!].every((p) => !p.markers.some((m) => m.tUs === 42))).toBe(true)
  })
  it('sem projeto aberto a prévia é ignorada; fechar limpa', () => {
    withPreview()
    st().close()
    expect(st().preview).toBeNull()
    st().setPreview(base())
    expect(st().preview).toBeNull()
  })
})

describe('transição removida pela normalização (toast no commit)', () => {
  const S = 1_000_000
  const vid = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 4 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' } as Asset
  /** A 0–4 s, B 4–8 s com Dissolver na entrada de B. */
  function withTransition(): { a: string; b: string } {
    let p = addAsset(base(), vid)
    const ra = addMediaFromAsset(p, 'v', 0)
    const rb = addMediaFromAsset(ra.project, 'v', 4 * S)
    p = addTransition(rb.project, rb.itemIds[0], 'crossfade')
    st().open(p)
    return { a: ra.itemIds[0], b: rb.itemIds[0] }
  }
  const hasTransition = (id: string): boolean => !!(findItem(st().project!, id)!.item as MediaItem).transitionIn

  it('aparar o fim de A (sem ripple) abre buraco: a transição some com toast que fala do Ctrl+Z', () => {
    const { a, b } = withTransition()
    expect(st().apply((p) => trimItem(p, a, 'end', 3 * S))).toBe(true)
    expect(hasTransition(b)).toBe(false)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast).mock.calls[0][0]).toBe('Transição removida porque os clipes não estão mais encostados')
    expect(vi.mocked(toast).mock.calls[0][1]).toEqual({ description: 'Ctrl+Z desfaz.' })
    st().undo()
    expect(hasTransition(b)).toBe(true)
  })

  it('arraste (transação): nenhum toast nos quadros transitórios, um só no commit', () => {
    const { b } = withTransition()
    st().begin()
    for (let k = 1; k <= 5; k++) st().apply(() => moveItems(st().txBase!, [b], k * 100_000), { transient: true })
    expect(hasTransition(b)).toBe(false)
    expect(toast).not.toHaveBeenCalled()
    st().commitTx()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(st().history.past).toHaveLength(1)
  })

  it('arraste que volta a encostar antes de soltar: nada removido, nenhum toast', () => {
    const { b } = withTransition()
    st().begin()
    st().apply(() => moveItems(st().txBase!, [b], 200_000), { transient: true })
    st().apply(() => moveItems(st().txBase!, [b], 0), { transient: true })
    st().commitTx()
    expect(hasTransition(b)).toBe(true)
    expect(toast).not.toHaveBeenCalled()
  })

  it('removeTransition (pedido do usuário) e apagar o próprio clipe B não avisam', () => {
    const { b } = withTransition()
    st().apply((p) => removeTransition(p, b), { quietTransitions: true })
    expect(hasTransition(b)).toBe(false)
    st().undo()
    st().apply((p) => deleteItems(p, [b], { ripple: false }))
    expect(toast).not.toHaveBeenCalled()
  })

  it('apagar A (o anterior) tira a transição de B: avisa', () => {
    const { a, b } = withTransition()
    st().apply((p) => deleteItems(p, [a], { ripple: false }))
    expect(hasTransition(b)).toBe(false)
    expect(toast).toHaveBeenCalledTimes(1)
  })
})
