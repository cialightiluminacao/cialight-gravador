import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() } }))
vi.mock('../engine/contentTracking', () => {
  class TrackingCancelled extends Error {}
  return { runContentTracking: vi.fn(), TrackingCancelled }
})

import { toast } from 'sonner'
import { createEffectItem, createEmptyProject } from '@shared/editor/factory'
import { addMarker, applyTrackedRegion, findItem } from '@shared/editor/ops'
import type { EffectItem, EffectRegion, Project } from '@shared/editor/project'
import { runContentTracking, TrackingCancelled, type ContentTrackingResult } from '../engine/contentTracking'
import { useEditorStore } from '../state/editorStore'
import { mergeStripSamples, stripRuns, useTrackStrips } from '../state/trackStrips'
import { CONTINUE_HINT, followContent, useTrackJobs } from './followContent'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

function base(fx: Partial<EffectItem> = {}): Project {
  const item = { ...createEffectItem('blurText', 0, 2_000_000, { x: 0.3, y: 0.3, w: 0.2, h: 0.1 }), id: 'fx', ...fx }
  return { ...createEmptyProject('t'), tracks: [{ id: 'tfx', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [item] }] }
}

const tracked: EffectRegion = {
  shape: 'rect',
  x: { value: 0.3, keys: [{ tUs: 0, value: 0.3, ease: 'linear' }, { tUs: 1_000_000, value: 0.5, ease: 'linear' }] },
  y: { value: 0.3 },
  w: { value: 0.22, keys: [{ tUs: 0, value: 0.22, ease: 'linear' }, { tUs: 1_000_000, value: 0.4, ease: 'linear' }] },
  h: { value: 0.12 },
  rotation: { value: 0 }
}

const out = (lost: { tUs: number }[] = []): ContentTrackingResult => ({
  region: tracked,
  lost,
  recovered: [],
  samples: [{ tUs: 0, confidence: 1, state: 'ok' }, { tUs: 1_000_000, confidence: lost.length ? 0.2 : 0.9, state: lost.length ? 'lost' : 'ok' }],
  results: [],
  geometry: { analysisW: 480, analysisH: 270, canvasW: 1920, canvasH: 1080 },
  fromUs: 0
})

beforeEach(() => {
  st().close()
  useTrackStrips.getState().clear()
  vi.mocked(runContentTracking).mockReset()
  for (const f of Object.values(toast)) vi.mocked(f).mockClear()
})

describe('followContent', () => {
  it('aplica a região como UM passo de desfazer; a faixa de confiança fica presa à região gravada', async () => {
    st().open(base())
    vi.mocked(runContentTracking).mockResolvedValue(out())
    await followContent('fx')
    expect(st().history.past).toHaveLength(1)
    const fx = findItem(st().project!, 'fx')!.item as EffectItem
    expect(fx.region).toEqual(tracked)
    expect(useTrackStrips.getState().strips.fx.region).toBe(fx.region)
    expect(toast.success).toHaveBeenCalled()
    expect(useTrackJobs.getState().jobs).toEqual({})
    st().undo()
    expect((findItem(st().project!, 'fx')!.item as EffectItem).region).toEqual((base().tracks[0].items[0] as EffectItem).region)
  })

  it('perda: toast com o instante (normal: região ampliada; invertido: buraco fechado)', async () => {
    st().open(base())
    vi.mocked(runContentTracking).mockResolvedValue(out([{ tUs: 1_250_000 }]))
    await followContent('fx')
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe('Rastreamento perdido em 00:01,2 — a região foi ampliada até o fim; reposicione e use “Seguir conteúdo” de novo a partir daí')
    st().close()
    st().open(base({ invert: true }))
    vi.mocked(runContentTracking).mockResolvedValue(out([{ tUs: 1_250_000 }]))
    await followContent('fx')
    expect(vi.mocked(toast.warning).mock.calls[1][0]).toBe('Rastreamento perdido em 00:01,2 — o buraco foi fechado até o fim; reposicione e use “Seguir conteúdo” de novo a partir daí')
  })

  it('cancelar: nada aplicado, nenhum passo no histórico', async () => {
    st().open(base())
    const p0 = st().project
    vi.mocked(runContentTracking).mockRejectedValue(new TrackingCancelled())
    await followContent('fx')
    expect(st().project).toBe(p0)
    expect(st().history.past).toHaveLength(0)
    expect(toast.info).toHaveBeenCalled()
  })

  it('o projeto mudou durante a análise: nada aplicado', async () => {
    st().open(base())
    vi.mocked(runContentTracking).mockImplementation(async () => {
      st().apply((p) => addMarker(p, 10))
      return out()
    })
    await followContent('fx')
    expect(st().history.past).toHaveLength(1) // só o marcador
    expect((findItem(st().project!, 'fx')!.item as EffectItem).region).not.toEqual(tracked)
    expect(toast.warning).toHaveBeenCalled()
  })

  it('ancorado / faixa bloqueada: recusa antes de analisar (motivo pt-BR)', async () => {
    st().open(base({ attach: { mediaItemId: 'm' } }))
    await followContent('fx')
    expect(runContentTracking).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('O efeito já está ancorado ao clipe; desancore para seguir o conteúdo')
    const locked = base()
    locked.tracks[0].locked = true
    st().close()
    st().open(locked)
    await followContent('fx')
    expect(runContentTracking).not.toHaveBeenCalled()
  })
})

describe('Continuar daqui / Continuar rastreamento (G4)', () => {
  const tracked2: EffectRegion = {
    shape: 'rect',
    x: { value: 0.3, keys: [{ tUs: 0, value: 0.3, ease: 'linear' }, { tUs: 1_200_000, value: 0.6, ease: 'linear' }, { tUs: 2_000_000, value: 0.7, ease: 'linear' }] },
    y: { value: 0.3 },
    w: { value: 0.22 },
    h: { value: 0.12 },
    rotation: { value: 0 }
  }

  it('o toast da perda leva a "Continuar daqui": playhead na perda, efeito selecionado e a dica', async () => {
    st().open(base())
    st().select([])
    vi.mocked(runContentTracking).mockResolvedValue(out([{ tUs: 1_250_000 }]))
    await followContent('fx')
    const opts = vi.mocked(toast.warning).mock.calls[0][1] as { action: { label: string; onClick: () => void } }
    expect(opts.action.label).toBe('Continuar daqui')
    expect(useTrackStrips.getState().strips.fx.lossUs).toBe(1_250_000)
    opts.action.onClick()
    expect(st().playheadUs).toBe(1_250_000)
    expect(st().selection).toEqual(['fx'])
    expect(toast.info).toHaveBeenCalledWith(CONTINUE_HINT)
    expect(CONTINUE_HINT).toBe('Ajuste a região sobre o conteúdo e clique em “Continuar rastreamento”.')
  })

  it('"Continuar rastreamento": UM passo de desfazer; Ctrl+Z volta exatamente à região ajustada antes; a faixa junta as amostras', async () => {
    st().open(base())
    vi.mocked(runContentTracking).mockResolvedValue(out([{ tUs: 1_000_000 }]))
    await followContent('fx')
    // o usuário reposiciona a região no instante da perda (edição normal, o seu próprio passo)
    st().setPlayhead(1_200_000)
    const adjusted: EffectRegion = { ...tracked, x: { value: 0.3, keys: [...tracked.x.keys!, { tUs: 1_200_000, value: 0.6, ease: 'linear' }] } }
    expect(st().apply((p) => applyTrackedRegion(p, 'fx', adjusted))).toBeTruthy()
    const before = st().project!
    const pastBefore = st().history.past.length
    vi.mocked(runContentTracking).mockResolvedValue({ ...out(), region: tracked2, samples: [{ tUs: 1_200_000, confidence: 0.95, state: 'ok' }, { tUs: 1_600_000, confidence: 0.96, state: 'ok' }], fromUs: 1_200_000, recovered: [] })
    await followContent('fx', { resume: true })
    expect(vi.mocked(runContentTracking).mock.calls.at(-1)![0].fromUs).toBe(1_200_000)
    expect(st().history.past.length).toBe(pastBefore + 1)
    expect((findItem(st().project!, 'fx')!.item as EffectItem).region).toEqual(tracked2)
    const strip = useTrackStrips.getState().strips.fx
    expect(strip.samples.map((x) => x.tUs)).toEqual([0, 1_000_000, 1_200_000, 1_600_000])
    expect(strip.lossUs).toBeNull()
    expect(toast.success).toHaveBeenCalled()
    st().undo()
    expect(st().project).toEqual(before)
    expect((findItem(st().project!, 'fx')!.item as EffectItem).region).toEqual(adjusted)
  })

  it('perda breve recuperada: sem toast de perda, o sucesso cita o trecho recuperado', async () => {
    st().open(base())
    vi.mocked(runContentTracking).mockResolvedValue({ ...out(), recovered: [{ fromUs: 500_000, toUs: 733_333 }] })
    await followContent('fx')
    expect(toast.warning).not.toHaveBeenCalled()
    const desc = (vi.mocked(toast.success).mock.calls[0][1] as { description: string }).description
    expect(desc).toContain('Uma perda breve foi recuperada automaticamente (00:00,5)')
  })

  it('mergeStripSamples: antes do ponto de partida ficam, dali em diante as novas', () => {
    const a = [{ tUs: 0, confidence: 1, state: 'ok' as const }, { tUs: 100, confidence: 0.1, state: 'lost' as const }, { tUs: 200, confidence: 0.1, state: 'lost' as const }]
    const b = [{ tUs: 150, confidence: 0.9, state: 'ok' as const }, { tUs: 250, confidence: 0.9, state: 'ok' as const }]
    expect(mergeStripSamples(a, b, 150)).toEqual([a[0], a[1], ...b])
  })
})

describe('stripRuns', () => {
  it('junta amostras seguidas do mesmo estado; a última vai até o fim do item', () => {
    const s = [
      { tUs: 0, confidence: 1, state: 'ok' as const },
      { tUs: 100, confidence: 0.9, state: 'ok' as const },
      { tUs: 200, confidence: 0.7, state: 'weak' as const },
      { tUs: 300, confidence: 0.1, state: 'lost' as const },
      { tUs: 400, confidence: 0.1, state: 'lost' as const }
    ]
    expect(stripRuns(s, 1000)).toEqual([{ fromUs: 0, toUs: 200, state: 'ok' }, { fromUs: 200, toUs: 300, state: 'weak' }, { fromUs: 300, toUs: 1000, state: 'lost' }])
  })
})
