import { describe, expect, it } from 'vitest'
import { ANIM_PRESETS } from '@shared/editor/project'
import { CURVE_PRESETS } from './curveMath'
import { cardTitle, clampAnimUs, EASE_OPTIONS, easeOptionId, maxAnimUs, PRESET_CARDS, sideAnim, thumbKeyframes } from './animThumbs'

describe('painel de animações', () => {
  it('um cartão por preset do modelo', () => {
    expect(PRESET_CARDS.map((c) => c.preset).sort()).toEqual([...ANIM_PRESETS].sort())
  })
  it('miniatura: keyframes pela conta do resolve (a entrada começa no estado inicial e termina em repouso)', () => {
    const k = thumbKeyframes('t', 'zoom', 'in', 'linear')
    expect(k.startsWith('@keyframes t{0%{opacity:0;transform:translate(0%,0%) scale(0.8) rotate(0deg)')).toBe(true)
    expect(k).toContain('45%{opacity:1;transform:translate(0%,0%) scale(1) rotate(0deg);filter:blur(0px)}')
    expect(k.endsWith('100%{opacity:1;transform:translate(0%,0%) scale(1) rotate(0deg);filter:blur(0px)}}')).toBe(true)
    // saída do deslizar: some pela esquerda e fica fora
    expect(thumbKeyframes('s', 'slideL', 'out')).toContain('100%{opacity:1;transform:translate(-100%,0%)')
    // combinação: entra, repousa e sai
    const both = thumbKeyframes('b', 'blur', 'both', 'linear')
    expect(both).toContain('0%{opacity:0;transform:translate(0%,0%) scale(1) rotate(0deg);filter:blur(3px)}')
    expect(both).toContain('35%{opacity:1;transform:translate(0%,0%) scale(1) rotate(0deg);filter:blur(0px)}')
    expect(both).toContain('100%{opacity:0;transform:translate(0%,0%) scale(1) rotate(0deg);filter:blur(3px)}')
  })
  it('curvas: as do editor de curvas sem "segurar", depois da padrão da animação', () => {
    expect(EASE_OPTIONS.map((o) => o.label)).toEqual(['Padrão da animação', ...CURVE_PRESETS.filter((c) => c.ease !== 'hold').map((c) => c.label)])
    expect(EASE_OPTIONS.find((o) => o.id === 'overshoot')!.ease).toEqual(CURVE_PRESETS.find((c) => c.id === 'overshoot')!.ease)
  })
  it('dica do cartão pela aba: entrada, saída e as duas na combinação; "Quicar"', () => {
    const c = PRESET_CARDS.find((x) => x.preset === 'slideL')!
    expect(cardTitle(c, 'in')).toBe('Entrada: entra deslizando pela esquerda do quadro')
    expect(cardTitle(c, 'out')).toBe('Saída: sai deslizando pela esquerda do quadro')
    expect(cardTitle(c, 'both')).toBe('Entrada: entra deslizando pela esquerda do quadro. Saída: sai deslizando pela esquerda do quadro')
    expect(PRESET_CARDS.find((x) => x.preset === 'bounce')!.label).toBe('Quicar')
  })
  it('curva: id do seletor; bezier fora da lista = personalizada', () => {
    expect(easeOptionId(undefined)).toBe('default')
    expect(easeOptionId('inOut')).toBe('inOut')
    expect(easeOptionId({ bezier: [0.34, 1.56, 0.64, 1] })).toBe('overshoot')
    expect(easeOptionId({ bezier: [0.1, 0.2, 0.3, 0.4] })).toBe('custom')
  })
  it('duração: até o item inteiro; na combinação, metade; mínimo 50 ms', () => {
    expect(maxAnimUs(3_000_000, 'in')).toBe(3_000_000)
    expect(maxAnimUs(3_000_000, 'both')).toBe(1_500_000)
    expect(clampAnimUs(2_000_000, 3_000_000, 'both')).toBe(1_500_000)
    expect(clampAnimUs(10, 3_000_000, 'out')).toBe(50_000)
  })
  it('combinação só aparece selecionada com entrada e saída iguais', () => {
    const a = { preset: 'pop' as const, durationUs: 500_000 }
    expect(sideAnim({ animIn: a, animOut: { ...a } }, 'both')).toEqual(a)
    expect(sideAnim({ animIn: a, animOut: { ...a, ease: 'linear' } }, 'both')).toBeNull()
    expect(sideAnim({ animIn: a }, 'both')).toBeNull()
    expect(sideAnim({ animIn: a }, 'in')).toBe(a)
  })
})
