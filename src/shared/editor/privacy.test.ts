import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject } from './factory'
import type { EffectItem, Project } from './project'
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
    expect(w).toEqual([{ itemId: fx.id, kind: 'weakBlur', message: 'Blur fraco pode ser revertido; use intensidade ≥ 50 ou Tarja' }])
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
  it('feather > 0,4 com força < 50', () => {
    // pixelizar: abaixo de 50 sem ser "fraco" (< 30), então só o aviso de borda
    const fx = createEffectItem('pixelate', 0, 10 * S)
    expect(kinds(withFx({ ...fx, feather: 0.5, strength: { value: 45 } }))).toEqual(['feather'])
    expect(kinds(withFx({ ...fx, feather: 0.5, strength: { value: 50 } }))).toEqual([])
    expect(kinds(withFx({ ...fx, feather: 0.4, strength: { value: 45 } }))).toEqual([])
    expect(kinds(withFx({ ...fx, feather: 0.5, strength: { value: 20 } }))).toEqual(['weakPixelate', 'feather'])
    expect(kinds(withFx({ ...createEffectItem('blur', 0, 10 * S), feather: 0.5, strength: { value: 45 } }))).toEqual(['weakBlur', 'feather'])
  })
})
