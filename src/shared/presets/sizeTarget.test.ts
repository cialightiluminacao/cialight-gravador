import { describe, expect, it } from 'vitest'
import { needsTwoPass, planForTarget, targetVideoKbps } from './sizeTarget'

describe('targetVideoKbps', () => {
  it('64 MB em 60 s com áudio 96k → 64×8192×0,97/60 − 96 = 8384 (arredondado para baixo)', () => {
    // 64 × 8192 × 0,97 = 508 559,36 kbit → /60 s = 8475,99 → − 96 = 8379,99 → 8379
    expect(targetVideoKbps(64, 60_000, 96)).toBe(8379)
  })
  it('20 MB em 10 min com áudio 96k → 176', () => {
    // 20 × 8192 × 0,97 = 158 924,8 → /600 = 264,87 → − 96 = 168,87 → 168
    expect(targetVideoKbps(20, 600_000, 96)).toBe(168)
  })
  it('duração zero/negativa → 0', () => {
    expect(targetVideoKbps(64, 0, 96)).toBe(0)
    expect(targetVideoKbps(64, -5, 96)).toBe(0)
  })
  it('nunca negativo', () => {
    expect(targetVideoKbps(1, 3_600_000, 96)).toBe(0)
  })
})

describe('planForTarget', () => {
  it('bitrate confortável mantém 720p (limitado à altura da fonte)', () => {
    expect(planForTarget(64, 60_000, 96, 1080)).toEqual({ kbps: 8379, height: 720, warn: null })
    expect(planForTarget(64, 60_000, 96, 480)).toEqual({ kbps: 8379, height: 480, warn: null })
  })
  it('< 700 kbps → 480p sem aviso', () => {
    // 64 MB em 12 min: 508 559,36/720 = 706,3 − 96 = 610
    expect(planForTarget(64, 720_000, 96, 1080)).toEqual({ kbps: 610, height: 480, warn: null })
  })
  it('< 350 kbps → 480p com aviso "document"', () => {
    // 20 MB em 10 min → 168 kbps
    expect(planForTarget(20, 600_000, 96, 1080)).toEqual({ kbps: 168, height: 480, warn: 'document' })
  })
  it('piso de 100 kbps para não gerar bitrate zero', () => {
    expect(planForTarget(1, 3_600_000, 96, 1080)).toEqual({ kbps: 100, height: 480, warn: 'document' })
  })
})

describe('needsTwoPass', () => {
  it('estimativa acima de 98 % do alvo exige 2 passes', () => {
    expect(needsTwoPass(63, 64)).toBe(true)
    expect(needsTwoPass(62.72, 64)).toBe(false)
    expect(needsTwoPass(62.8, 64)).toBe(true)
    expect(needsTwoPass(10, 64)).toBe(false)
  })
})
