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
