import { describe, expect, it } from 'vitest'
import { resolveFrame, type MediaLayer } from '@shared/editor/resolve'
import { S, fx, project, tr, track, vclip, vid } from '@shared/editor/__fixtures__/transitionScenes'
import { firstDrawUs, flatLayers } from './layerSources'

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
