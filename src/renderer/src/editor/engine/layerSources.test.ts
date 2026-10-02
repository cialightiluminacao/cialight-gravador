import { describe, expect, it } from 'vitest'
import { resolveFrame, type MediaLayer } from '@shared/editor/resolve'
import { S, fx, project, tr, track, vclip, vid } from '@shared/editor/__fixtures__/transitionScenes'
import { assignSlots, decodedLayers, firstDrawUs, flatLayers } from './layerSources'

// A [0, 4 s) e B [4 s, 8 s) do MESMO asset (trechos diferentes), crossfade de 1 s: janela [3,5 s, 4,5 s)
const scene = (bOver: Parameters<typeof vclip>[4] = {}) =>
  project(
    [
      track('V1', 'video', [vclip('A', 'a', 0, 4 * S, { inUs: 2 * S }), vclip('B', 'a', 4 * S, 4 * S, { inUs: 10 * S, transitionIn: tr('crossfade', S), ...bOver })]),
      track('FX', 'video', [fx('f', 'solid', 0, 4 * S, { linkId: 'LA' })]),
      track('PIP', 'video', [vclip('P', 'a', 0, 8 * S, { inUs: 0 })])
    ],
    [vid('a')]
  )

describe('flatLayers', () => {
  it('desce em from/to da transição, na ordem de desenho (mesmo asset em A e B = duas camadas de mídia)', () => {
    const layers = resolveFrame(scene(), 3_800_000)
    expect(layers[0].kind).toBe('transition')
    const flat = flatLayers(layers)
    const media = flat.filter((l): l is MediaLayer => l.kind === 'media')
    expect(media.map((l) => l.itemId)).toEqual(['A', 'B', 'P'])
    // A toca até o corte; B congelado no primeiro quadro (inUs) antes do corte
    expect(media[0].srcUs).toBe(2 * S + 3_800_000)
    expect(media[1].srcUs).toBe(10 * S)
    expect(flat.some((l) => l.kind === 'transition')).toBe(false)
  })

  it('sem transição: a própria lista', () => {
    const layers = resolveFrame(scene(), 1 * S)
    expect(flatLayers(layers)).toEqual(layers)
  })
})

describe('firstDrawUs', () => {
  it('B de uma transição ativa é desenhado desde o início da janela (corte − d/2)', () => {
    const p = scene()
    const [v1, , pip] = p.tracks
    expect(firstDrawUs(v1, v1.items[1])).toBe(3_500_000)
    expect(firstDrawUs(v1, v1.items[0])).toBe(0)
    expect(firstDrawUs(pip, pip.items[0])).toBe(0)
  })

  it('par com um lado desativado ou faixa oculta: corte seco (início do item)', () => {
    const off = scene({ enabled: false })
    expect(firstDrawUs(off.tracks[0], off.tracks[0].items[1])).toBe(4 * S)
    const p = scene()
    const hidden = { ...p.tracks[0], hidden: true }
    expect(firstDrawUs(hidden, hidden.items[1])).toBe(4 * S)
  })
})

describe('assignSlots / decodedLayers', () => {
  const L = (itemId: string, assetId = 'a'): { itemId: string; assetId: string } => ({ itemId, assetId })

  it('sem histórico: slots na ordem de desenho, por asset', () => {
    const s = assignSlots([L('A'), L('X', 'x'), L('B')], new Map())
    expect([...s]).toEqual([['A', { assetId: 'a', slot: 0 }], ['X', { assetId: 'x', slot: 0 }], ['B', { assetId: 'a', slot: 1 }]])
  })

  it('o item mantém o slot do quadro anterior (B do mesmo asset não troca de iterador no fim da janela)', () => {
    const inWindow = assignSlots([L('A'), L('B')], new Map())
    expect(inWindow.get('B')!.slot).toBe(1)
    const after = assignSlots([L('B')], inWindow)
    expect(after.get('B')!.slot).toBe(1)
    // item novo pega o menor slot livre, sem roubar o de quem já tinha
    const next = assignSlots([L('C'), L('B')], after)
    expect(next.get('B')!.slot).toBe(1)
    expect(next.get('C')!.slot).toBe(0)
  })

  it('slot de outro asset no histórico não vale', () => {
    const prev = new Map([['A', { assetId: 'b', slot: 3 }]])
    expect(assignSlots([L('A')], prev).get('A')!.slot).toBe(0)
  })

  it('decodedLayers: só mídia de vídeo decodificada com asset disponível', () => {
    const p = scene()
    const flat = flatLayers(resolveFrame(p, 3_800_000))
    expect(decodedLayers(p.assets, flat)).toEqual([L('A'), L('B'), L('P')])
    const missing = { ...p.assets[0], status: 'missing' as const }
    expect(decodedLayers([missing], flat)).toEqual([])
  })
})
