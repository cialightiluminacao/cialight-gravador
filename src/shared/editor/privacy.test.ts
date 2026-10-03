import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import type { Asset, EffectItem, MediaItem, Project } from './project'
import { privacyWarnings } from './privacy'

const S = 1_000_000
function withFx(fx: EffectItem): Project {
  const p = createEmptyProject('t')
  p.tracks[0].items = [fx]
  return p
}
const kinds = (p: Project, from = 0, to = 10 * S): string[] => privacyWarnings(p, from, to).map((w) => w.kind)

describe('privacyWarnings', () => {
  it('sem avisos para os presets padrão', () => {
    for (const id of ['blur', 'pixelate', 'solid', 'blurFace', 'blurText', 'blurAllExcept'] as const) {
      expect(kinds(withFx(createEffectItem(id, 0, 10 * S)))).toEqual([])
    }
  })
  it('blur fraco (< 50), com a mensagem exata', () => {
    const fx = { ...createEffectItem('blur', 0, 10 * S), strength: { value: 49 } }
    const w = privacyWarnings(withFx(fx), 0, 10 * S)
    expect(w).toEqual([{ itemId: fx.id, kind: 'weakBlur', message: 'Blur fraco pode ser revertido; use intensidade ≥ 50 ou Tarja', tUs: 0 }])
    expect(kinds(withFx({ ...fx, strength: { value: 50 } }))).toEqual([])
  })
  it('pixelate fraco (< 30)', () => {
    const fx = createEffectItem('pixelate', 0, 10 * S)
    expect(kinds(withFx({ ...fx, strength: { value: 29 } }))).toEqual(['weakPixelate'])
    expect(kinds(withFx({ ...fx, strength: { value: 30 } }))).toEqual([])
  })
  it('solid nunca gera aviso de força', () => {
    expect(kinds(withFx({ ...createEffectItem('solid', 0, 10 * S), strength: { value: 0 } }))).toEqual([])
  })
  it('avalia em keyframes e nas bordas do trecho', () => {
    const fx = { ...createEffectItem('blur', 0, 10 * S), strength: { value: 60, keys: [{ tUs: 0, value: 60, ease: 'linear' as const }, { tUs: 5 * S, value: 10, ease: 'linear' as const }, { tUs: 10 * S, value: 60, ease: 'linear' as const }] } }
    const p = withFx(fx)
    expect(kinds(p)).toEqual(['weakBlur'])
    expect(kinds(p, 0, S)).toEqual([]) // 60→10 só chega a 50 em 1 s
    expect(kinds(p, 4 * S, 6 * S)).toEqual(['weakBlur'])
  })
  it('borda de início fraca sem key interno', () => {
    const fx = { ...createEffectItem('blur', 0, 10 * S), strength: { value: 60, keys: [{ tUs: 0, value: 20, ease: 'linear' as const }, { tUs: 4 * S, value: 60, ease: 'linear' as const }] } }
    expect(kinds(withFx(fx), 0, 10 * S)).toEqual(['weakBlur'])
    expect(kinds(withFx(fx), 4 * S, 10 * S)).toEqual([])
  })
  it('efeito desativado no intervalo; fora do intervalo não conta', () => {
    const fx = { ...createEffectItem('blur', 2 * S, 3 * S), enabled: false }
    const p = withFx(fx)
    expect(privacyWarnings(p, 0, 10 * S)).toMatchObject([{ itemId: fx.id, kind: 'disabled' }])
    expect(kinds(p, 6 * S, 9 * S)).toEqual([])
    expect(kinds(p, 0, 2 * S)).toEqual([])
  })
  it('faixa oculta conta como desativado', () => {
    const p = withFx(createEffectItem('blur', 0, 5 * S))
    p.tracks[0].hidden = true
    expect(kinds(p)).toEqual(['disabled'])
  })
  it('borda suave larga não gera aviso (cresce para fora; invertido, para dentro: a área escondida fica coberta)', () => {
    const fx = createEffectItem('pixelate', 0, 10 * S)
    expect(kinds(withFx({ ...fx, feather: 0.9, strength: { value: 35 } }))).toEqual([])
    expect(kinds(withFx({ ...createEffectItem('blurAllExcept', 0, 10 * S), feather: 1 }))).toEqual([])
  })
  it('invertido: piso 50 com mensagem própria; o preset (80) não avisa', () => {
    const inv = createEffectItem('blurAllExcept', 0, 10 * S)
    expect(inv.strength.value).toBe(80)
    expect(privacyWarnings(withFx({ ...inv, strength: { value: 49 } }), 0, 10 * S)).toEqual([
      { itemId: inv.id, kind: 'weakBlur', message: 'Blur fraco fora da região pode ser revertido; use intensidade ≥ 50', tUs: 0 }
    ])
    expect(kinds(withFx({ ...inv, strength: { value: 50 } }))).toEqual([])
  })
  it('tUs: "Revisar" vai ao instante mais fraco (key no meio), não ao começo', () => {
    const fx = { ...createEffectItem('blur', 2 * S, 8 * S), strength: { value: 80, keys: [{ tUs: 0, value: 80, ease: 'linear' as const }, { tUs: 3 * S, value: 20, ease: 'linear' as const }, { tUs: 8 * S, value: 80, ease: 'linear' as const }] } }
    expect(privacyWarnings(withFx(fx), 0, 10 * S)).toMatchObject([{ kind: 'weakBlur', tUs: 5 * S }])
    // o trecho começa depois do key: o mais fraco é a borda do trecho
    expect(privacyWarnings(withFx(fx), 6 * S, 10 * S)).toMatchObject([{ kind: 'weakBlur', tUs: 6 * S }])
    const off = { ...createEffectItem('blur', 2 * S, 3 * S), enabled: false }
    expect(privacyWarnings(withFx(off), 3 * S, 10 * S)).toMatchObject([{ kind: 'disabled', tUs: 3 * S }])
  })
})

describe('privacyWarnings: mídia acima do efeito (covered)', () => {
  const asset: Asset = { id: 'a1', name: 'a1', kind: 'video', source: { type: 'file', path: 'C:/a.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
  /** Efeito na faixa 0 e um clipe na faixa 1 (acima), em [start, start+dur), com escala/posição dadas. */
  function stack(fx: EffectItem, clip: Partial<MediaItem> & { scale?: number; x?: number; y?: number } = {}): Project {
    const p = withFx(fx)
    p.assets = [asset]
    const base = createMediaItem(asset, clip.startUs ?? 0, 'video')
    const v = base.visual!
    const m: MediaItem = { ...base, durationUs: clip.durationUs ?? 4 * S, ...(clip.enabled === false ? { enabled: false } : {}), visual: { ...v, transform: { ...v.transform, x: { value: clip.x ?? 0.5 }, y: { value: clip.y ?? 0.5 }, scale: { value: clip.scale ?? 1 } } } }
    p.tracks.splice(1, 0, { id: 't_up', kind: 'video', name: 'Vídeo 2', muted: false, hidden: false, locked: false, volume: 1, items: [m] })
    return p
  }
  const blur = (): EffectItem => createEffectItem('blur', 2 * S, 6 * S, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
  it('clipe visível acima no mesmo trecho → aviso com a mensagem e o início da sobreposição', () => {
    const fx = blur()
    expect(privacyWarnings(stack(fx), 0, 10 * S)).toEqual([{ itemId: fx.id, kind: 'covered', message: 'Há mídia acima deste efeito; ela não será borrada', tUs: 2 * S }])
    expect(privacyWarnings(stack(fx, { startUs: 5 * S }), 0, 10 * S)).toMatchObject([{ kind: 'covered', tUs: 5 * S }])
  })
  it('sem aviso: fora do trecho, desativado, faixa oculta, faixa de baixo ou em outro lugar do quadro', () => {
    expect(kinds(stack(blur(), { startUs: 8 * S }))).toEqual([])
    expect(kinds(stack(blur(), { enabled: false }))).toEqual([])
    const hidden = stack(blur()); hidden.tracks[1].hidden = true
    expect(kinds(hidden)).toEqual([])
    // efeito numa faixa acima do clipe
    const above = stack(blur())
    above.tracks = [above.tracks[1], above.tracks[0], ...above.tracks.slice(2)]
    expect(kinds(above)).toEqual([])
    // miniatura no canto (25 %, canto superior esquerdo) longe da região central
    expect(kinds(stack(blur(), { scale: 0.25, x: 0.125, y: 0.125 }))).toEqual([])
    expect(kinds(stack(blur(), { scale: 0.25, x: 0.45, y: 0.45 }))).toEqual(['covered'])
  })
  it('invertido ou região animada: qualquer mídia acima no trecho conta (sem teste de espaço)', () => {
    const inv = createEffectItem('blurAllExcept', 2 * S, 6 * S)
    expect(kinds(stack(inv, { scale: 0.25, x: 0.125, y: 0.125 }))).toEqual(['covered'])
    const moving = { ...blur(), region: { ...blur().region, x: { value: 0.5, keys: [{ tUs: 0, value: 0.5, ease: 'linear' as const }, { tUs: S, value: 0.6, ease: 'linear' as const }] } } }
    expect(kinds(stack(moving, { scale: 0.25, x: 0.125, y: 0.125 }))).toEqual(['covered'])
  })
})

describe('privacyWarnings: clipe se move sob efeito vinculado (transformedUnderEffect)', () => {
  const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
  const lin = (a: number, b: number) => ({ value: a, keys: [{ tUs: 0, value: a, ease: 'linear' as const }, { tUs: 10 * S, value: b, ease: 'linear' as const }] })
  type Edit = (m: MediaItem, fx: EffectItem) => void
  /** Clipe 10 s na faixa 0 + blur vinculado (região 0,3/0,3 de 0,1×0,1) na faixa de efeitos acima. */
  function scene(edit?: Edit, link = true): Project {
    const p = createEmptyProject('t')
    p.assets = [vid]
    const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', ...(link ? { linkId: 'l1' } : {}) } as MediaItem
    const base = createEffectItem('blur', 0, 10 * S)
    const fx: EffectItem = { ...base, id: 'fx', ...(link ? { linkId: 'l1' } : {}), region: { ...base.region, x: { value: 0.3 }, y: { value: 0.3 }, w: { value: 0.1 }, h: { value: 0.1 }, rotation: { value: 0 } } }
    edit?.(m, fx)
    p.tracks = [
      { id: 'tv', kind: 'video', name: 'Vídeo 1', muted: false, hidden: false, locked: false, volume: 1, items: [m] },
      { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
    ]
    return p
  }
  const tue = (p: Project, from = 0, to = 10 * S) => privacyWarnings(p, from, to).filter((w) => w.kind === 'transformedUnderEffect')

  it('dispara: zoom (escala animada) com região parada', () => {
    const w = tue(scene((m) => { m.visual!.transform.scale = lin(1, 2) }))
    expect(w).toHaveLength(1)
    expect(w[0].itemId).toBe('fx')
    expect(w[0].tUs).toBeGreaterThan(0)
    // a 0,3/0,3 (440 px do centro), 1 % do quadro (19,2 px) sai em s = 1 + 19,2/440,6 → t ≈ 0,436 s (bisseção)
    expect(Math.abs(w[0].tUs - 435_800)).toBeLessThan(2000)
    expect(w[0].message).toMatch(/movimento|zoom/i)
  })
  it('dispara: zoom centrado com região no centro (o conteúdo cresce além da região)', () => {
    expect(tue(scene((m, fx) => { m.visual!.transform.scale = lin(1, 2); fx.region.x = { value: 0.5 }; fx.region.y = { value: 0.5 } }))).toHaveLength(1)
  })
  it('dispara: pan (x/y), rotação e animação de entrada com movimento (slide)', () => {
    expect(tue(scene((m) => { m.visual!.transform.x = lin(0.5, 0.7) }))).toHaveLength(1)
    expect(tue(scene((m) => { m.visual!.transform.y = lin(0.5, 0.4) }))).toHaveLength(1)
    expect(tue(scene((m) => { m.visual!.transform.rotation = lin(0, 20) }))).toHaveLength(1)
    const slide = tue(scene((m) => { m.visual!.animIn = { preset: 'slideL', durationUs: S } }))
    expect(slide).toHaveLength(1)
    expect(slide[0].tUs).toBeLessThan(S)
  })
  it('dispara: região animada que não acompanha o clipe (keys "não ajustados")', () => {
    expect(tue(scene((m, fx) => { m.visual!.transform.scale = lin(1, 2); fx.region.x = lin(0.3, 0.6) }))).toHaveLength(1)
  })
  it('não dispara: região que acompanha o zoom (centro e tamanho seguem o mesmo ponto do conteúdo)', () => {
    // zoom 1→2 em torno do centro: o ponto 0,3 vai para 0,5 + s·(0,3 − 0,5); a região dobra junto
    expect(tue(scene((m, fx) => {
      m.visual!.transform.scale = lin(1, 2)
      fx.region.x = lin(0.3, 0.1); fx.region.y = lin(0.3, 0.1); fx.region.w = lin(0.1, 0.2); fx.region.h = lin(0.1, 0.2)
    }))).toEqual([])
  })
  it('não dispara: região que acompanha o pan', () => {
    expect(tue(scene((m, fx) => { m.visual!.transform.x = lin(0.5, 0.7); fx.region.x = lin(0.3, 0.5) }))).toEqual([])
  })
  it('não dispara: clipe parado, só fade, efeito sem vínculo, fora do trecho ou desativado', () => {
    expect(tue(scene())).toEqual([])
    expect(tue(scene((m) => { m.visual!.animIn = { preset: 'fade', durationUs: S }; m.visual!.animOut = { preset: 'fade', durationUs: S } }))).toEqual([])
    expect(tue(scene((m) => { m.visual!.transform.scale = lin(1, 2) }, false))).toEqual([])
    // movimento só em [8,10) s, consulta em [0,2) s
    const late = scene((m) => { m.visual!.transform.x = { value: 0.5, keys: [{ tUs: 8 * S, value: 0.5, ease: 'linear' }, { tUs: 10 * S, value: 0.8, ease: 'linear' }] } })
    expect(tue(late, 0, 2 * S)).toEqual([])
    expect(tue(late, 0, 10 * S)).toHaveLength(1)
    // a referência é o início do trecho em comum: consultar só o fim (já deslocado) também avisa
    expect(tue(late, 9 * S, 10 * S)).toEqual([expect.objectContaining({ tUs: 9 * S })])
    const off = scene((m, fx) => { m.visual!.transform.scale = lin(1, 2); fx.enabled = false })
    expect(privacyWarnings(off, 0, 10 * S).map((w) => w.kind)).toEqual(['disabled'])
    // opacidade animada não move o conteúdo
    expect(tue(scene((m) => { m.visual!.transform.opacity = lin(1, 0.2) }))).toEqual([])
    // desfoque de entrada/saída não move o conteúdo
    expect(tue(scene((m) => { m.visual!.animIn = { preset: 'blur', durationUs: S }; m.visual!.animOut = { preset: 'blur', durationUs: S } }))).toEqual([])
  })
  it('dispara: animações de entrada/saída com geometria (zoom, pop, girar, quicar) com região parada vinculada e não ancorada', () => {
    const zoom = tue(scene((m) => { m.visual!.animIn = { preset: 'zoom', durationUs: S } }))
    expect(zoom).toEqual([expect.objectContaining({ itemId: 'fx', kind: 'transformedUnderEffect', mediaItemId: 'm' })])
    expect(zoom[0].tUs).toBeLessThan(S)
    for (const preset of ['pop', 'rotate', 'bounce'] as const) {
      expect(tue(scene((m) => { m.visual!.animIn = { preset, durationUs: S } }))).toHaveLength(1)
      // na saída: a partir do começo dela
      const out = tue(scene((m) => { m.visual!.animOut = { preset, durationUs: S } }))
      expect(out).toHaveLength(1)
      expect(out[0].tUs).toBeGreaterThanOrEqual(9 * S)
    }
  })
  it('corte animado conta como movimento: região parada dispara', () => {
    expect(tue(scene((m) => { m.visual!.crop.l = lin(0, 0.5) }))).toHaveLength(1)
    expect(tue(scene((m) => { m.visual!.crop.b = lin(0, 0.3) }))).toHaveLength(1)
  })
  it('corte animado com região que acompanha (fit esticar: x = (U − l)/(1 − l)) não dispara', () => {
    // ponto U = 0,75 da fonte e largura 0,1 da fonte; keys da região a cada 0,5 s (entre eles, < 1 % do quadro)
    const keys = (f: (l: number) => number) => ({ value: f(0), keys: Array.from({ length: 21 }, (_, i) => ({ tUs: i * S / 2, value: f(0.5 * i / 20), ease: 'linear' as const })) })
    const follow = scene((m, fx) => {
      m.visual!.fit = 'fill'
      m.visual!.crop.l = lin(0, 0.5)
      fx.region.x = keys((l) => (0.75 - l) / (1 - l))
      fx.region.w = keys((l) => 0.1 / (1 - l))
    })
    expect(tue(follow)).toEqual([])
    // a mesma região parada dispara
    expect(tue(scene((m) => { m.visual!.fit = 'fill'; m.visual!.crop.l = lin(0, 0.5) }))).toHaveLength(1)
  })
  it('corte parado não atrapalha: zoom com região que acompanha continua sem aviso (com espelho também)', () => {
    const follow = (mirror: boolean) => scene((m, fx) => {
      m.visual!.crop = { l: { value: 0.2 }, t: { value: 0.1 }, r: { value: 0 }, b: { value: 0 } }
      m.visual!.mirror = mirror
      m.visual!.transform.scale = lin(1, 2)
      fx.region.x = lin(0.3, 0.1); fx.region.y = lin(0.3, 0.1); fx.region.w = lin(0.1, 0.2); fx.region.h = lin(0.1, 0.2)
    })
    expect(tue(follow(false))).toEqual([])
    expect(tue(follow(true))).toEqual([])
  })
})

describe('privacyWarnings: movimento avaliado por intervalo (zoom automático + Seguir conteúdo)', () => {
  const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
  const lin = (...ks: [number, number][]) => ({ value: ks[0][1], keys: ks.map(([tUs, value]) => ({ tUs, value, ease: 'linear' as const })) })
  /** Clipe de 10 s com zoom automático em 1–3 s (escala 1→1,8→1,8→1) e um blur de 5–8 s (ou de 0–10 s). */
  function scene(opts: { link: boolean; fxStart: number; fxEnd: number; tracked: boolean }): Project {
    const p = createEmptyProject('t')
    p.assets = [vid]
    const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', ...(opts.link ? { linkId: 'l1' } : {}) } as MediaItem
    m.visual!.transform.scale = lin([0, 1], [S, 1], [1.5 * S, 1.8], [2.5 * S, 1.8], [3 * S, 1])
    const base = createEffectItem('blur', opts.fxStart, opts.fxEnd)
    const x = opts.tracked ? lin([0, 0.3], [S, 0.35], [2 * S, 0.4]) : { value: 0.3 }
    const fx: EffectItem = { ...base, id: 'fx', ...(opts.link ? { linkId: 'l1' } : {}), region: { ...base.region, x, y: { value: 0.3 }, w: { value: 0.1 }, h: { value: 0.1 }, rotation: { value: 0 } } }
    p.tracks = [
      { id: 'tv', kind: 'video', name: 'Vídeo 1', muted: false, hidden: false, locked: false, volume: 1, items: [m] },
      { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
    ]
    return p
  }
  const of = (p: Project, kind: string) => privacyWarnings(p, 0, 10 * S).filter((w) => w.kind === kind)
  it('blur rastreado em 5–8 s com o clipe parado ali: sem transformedUnderEffect (nem unlinkedOverMoving)', () => {
    expect(of(scene({ link: true, fxStart: 5 * S, fxEnd: 8 * S, tracked: true }), 'transformedUnderEffect')).toEqual([])
    expect(of(scene({ link: false, fxStart: 5 * S, fxEnd: 8 * S, tracked: true }), 'unlinkedOverMoving')).toEqual([])
  })
  it('blur parado sobre o trecho do zoom (1–3 s): continua avisando, com tUs dentro do zoom', () => {
    const w = of(scene({ link: true, fxStart: 0, fxEnd: 10 * S, tracked: false }), 'transformedUnderEffect')
    expect(w).toHaveLength(1)
    expect(w[0].tUs).toBeGreaterThanOrEqual(S)
    expect(w[0].tUs).toBeLessThan(3 * S)
  })
  it('blur parado só sobre 1–3 s: avisa; clipe não vinculado: unlinkedOverMoving', () => {
    const w = of(scene({ link: true, fxStart: S, fxEnd: 3 * S, tracked: false }), 'transformedUnderEffect')
    expect(w).toHaveLength(1)
    expect(w[0].tUs).toBeGreaterThanOrEqual(S)
    expect(w[0].tUs).toBeLessThan(3 * S)
    const u = of(scene({ link: false, fxStart: S, fxEnd: 3 * S, tracked: false }), 'unlinkedOverMoving')
    expect(u).toHaveLength(1)
    expect(u[0].tUs).toBeLessThan(3 * S)
  })
})
