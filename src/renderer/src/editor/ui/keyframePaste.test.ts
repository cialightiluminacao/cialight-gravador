import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import { planKeyframePaste } from './keyframePaste'

const S = 1_000_000
/** Blur (região + intensidade), Tarja (sem intensidade) e outro blur em faixa bloqueada, todos em 0–4 s. */
function setup() {
  let p = createEmptyProject('t')
  const blur = ops.addEffect(p, 'blur', 0, { durationUs: 4 * S })
  p = blur.project
  p = ops.addTrack(p, 'video').project
  const solid = ops.addEffect(p, 'solid', 0, { durationUs: 4 * S })
  p = solid.project
  p = ops.addTrack(p, 'video').project
  const other = ops.addEffect(p, 'blur', 0, { durationUs: 4 * S })
  p = ops.updateTrack(other.project, ops.findItem(other.project, other.itemId)!.track.id, { locked: true })
  return { p, blur: blur.itemId, solid: solid.itemId, locked: other.itemId }
}
const strength = { keys: { strength: [{ tUs: 0, value: 1, ease: 'linear' as const }] } }

describe('planKeyframePaste', () => {
  it('cola nos itens sob o playhead que podem receber; aviso "Colado em N de M itens" quando parcial', () => {
    const { p, blur, solid, locked } = setup()
    expect(ops.findItem(p, blur)!.track.id).not.toBe(ops.findItem(p, solid)!.track.id)
    expect(planKeyframePaste(p, [blur], S, strength)).toEqual({ targets: [blur], message: null })
    expect(planKeyframePaste(p, [blur, solid, locked], S, strength)).toEqual({ targets: [blur], message: 'Colado em 1 de 3 itens (1 em faixa bloqueada, 1 sem essas propriedades).' })
  })
  it('nenhum alvo: o motivo', () => {
    const { p, blur, solid, locked } = setup()
    expect(planKeyframePaste(p, [blur], 5 * S, strength).message).toBe('Selecione um item sob o playhead para colar os keyframes.')
    expect(planKeyframePaste(p, [locked], S, strength)).toEqual({ targets: [], message: 'Faixa bloqueada: os keyframes não foram colados.' })
    expect(planKeyframePaste(p, [solid], S, strength).message).toBe('Este item não tem as propriedades dos keyframes copiados.')
    expect(planKeyframePaste(p, [solid, locked], S, strength).message).toBe('Nada colado (1 em faixa bloqueada, 1 sem essas propriedades).')
  })
})
