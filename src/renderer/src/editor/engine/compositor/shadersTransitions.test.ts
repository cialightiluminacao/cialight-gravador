import { describe, expect, it } from 'vitest'
import { TRANSITION_KINDS } from '@shared/testing/transitionOracle'
import { FS_TRANSITION, TRANSITION_MODES, transitionBlurPx } from './shadersTransitions'

describe('transições do compositor', () => {
  it('todo TransitionKind tem modo do shader', () => {
    for (const k of TRANSITION_KINDS) expect(TRANSITION_MODES[k], k).toBeDefined()
    expect(Object.keys(TRANSITION_MODES).sort()).toEqual([...TRANSITION_KINDS].sort())
  })

  it('deslizar: A sai na direção do nome (uv GL, y para cima); cortina anda no sentido do nome', () => {
    expect(TRANSITION_MODES.slideL.dir).toEqual([-1, 0])
    expect(TRANSITION_MODES.slideR.dir).toEqual([1, 0])
    expect(TRANSITION_MODES.slideU.dir).toEqual([0, 1])
    expect(TRANSITION_MODES.slideD.dir).toEqual([0, -1])
    expect(TRANSITION_MODES.wipeL.dir).toEqual([-1, 0])
    expect(TRANSITION_MODES.dipWhite.color).toEqual([1, 1, 1])
  })

  it('blur: 24·sin(πp) px na referência de 1080, proporcional à altura de saída', () => {
    expect(transitionBlurPx(0, 1080)).toBe(0)
    expect(transitionBlurPx(1, 1080)).toBeCloseTo(0, 9)
    expect(transitionBlurPx(0.5, 1080)).toBeCloseTo(24, 9)
    expect(transitionBlurPx(0.5, 540)).toBeCloseTo(12, 9)
    expect(transitionBlurPx(0.25, 1080)).toBeCloseTo(24 * Math.SQRT1_2, 9)
  })

  it('shader GLSL ES 3.0 com as constantes interpoladas (sem ${} sobrando)', () => {
    expect(FS_TRANSITION.startsWith('#version 300 es')).toBe(true)
    expect(FS_TRANSITION).not.toContain('${')
    expect(FS_TRANSITION).toContain('1.0 + 0.50 * p')
    expect(FS_TRANSITION).toContain('0.85 + 0.15 * p')
  })
})
