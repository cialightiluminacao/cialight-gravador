import { describe, expect, it } from 'vitest'
import { addTrack, addText, updateItem, findItem } from '@shared/editor/ops'
import { createEmptyProject } from '@shared/editor/factory'
import type { Project, TextItem } from '@shared/editor/project'
import { planTextEditEntry, resolveTextEditRequest } from './textEditEntry'

function base(): { p: Project; a: string; b: string } {
  let p = createEmptyProject('t')
  const r1 = addText(p, 'title', 1_000_000)
  p = r1.project
  const r2 = addText(p, 'title', 5_000_000)
  return { p: r2.project, a: r1.itemId, b: r2.itemId }
}

describe('planTextEditEntry', () => {
  it('um texto selecionado sob o playhead: abre sem mover', () => {
    const { p, a } = base()
    expect(planTextEditEntry(p, [a], 1_500_000)).toEqual({ kind: 'edit', itemId: a })
  })
  it('fora do playhead: leva o cursor ao início do item', () => {
    const { p, a, b } = base()
    expect(planTextEditEntry(p, [a], 0)).toEqual({ kind: 'edit', itemId: a, seekUs: 1_000_000 })
    const end = findItem(p, b)!.item
    expect(planTextEditEntry(p, [b], end.startUs + end.durationUs)).toEqual({ kind: 'edit', itemId: b, seekUs: end.startUs })
  })
  it('nada, vários ou não-texto: nulo', () => {
    const { p, a, b } = base()
    expect(planTextEditEntry(p, [], 0)).toBeNull()
    expect(planTextEditEntry(p, [a, b], 1_500_000)).toBeNull()
    expect(planTextEditEntry(p, ['nao-existe'], 0)).toBeNull()
  })
  it('desativado ou em faixa oculta: nulo; bloqueada: aviso; contagem: aviso', () => {
    const { p, a } = base()
    expect(planTextEditEntry(updateItem<TextItem>(p, a, (d) => { d.enabled = false }), [a], 1_500_000)).toBeNull()
    const track = findItem(p, a)!.track
    const hidden = { ...p, tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, hidden: true } : t)) }
    expect(planTextEditEntry(hidden, [a], 1_500_000)).toBeNull()
    const locked = { ...p, tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, locked: true } : t)) }
    expect(planTextEditEntry(locked, [a], 1_500_000)).toEqual({ kind: 'locked', trackName: track.name })
    const counter = updateItem<TextItem>(p, a, (d) => { d.counter = { from: 0, to: 10, decimals: 0 } as never })
    expect(planTextEditEntry(counter, [a], 1_500_000)).toEqual({ kind: 'counter' })
  })
  it('legenda (faixa de legendas) também vale', () => {
    let p = createEmptyProject('t')
    const t = addTrack(p, 'video', undefined, 'Legendas', 'captions')
    p = t.project
    const r = addText(p, 'caption', 0, { trackId: t.trackId })
    expect(planTextEditEntry(r.project, [r.itemId], 0)).toEqual({ kind: 'edit', itemId: r.itemId })
  })
})

describe('resolveTextEditRequest (o pedido de Enter/F2 nunca fica pendente)', () => {
  const ok = { exists: true, playing: false, playheadInside: true, hasBox: true, tool: null } as const
  it('tudo certo: abre', () => {
    expect(resolveTextEditRequest(ok)).toEqual({ kind: 'open' })
  })
  it('playhead fora do item depois do seek (seek sem efeito, ex.: narração gravando): descarta com motivo', () => {
    const r = resolveTextEditRequest({ ...ok, playheadInside: false })
    expect(r.kind).toBe('drop')
    expect(r.kind === 'drop' && r.why).toMatch(/narração/)
  })
  it('ferramenta ativa (desenhar/zoom/reenquadrar): descarta dizendo qual', () => {
    expect(resolveTextEditRequest({ ...ok, tool: 'drawing' })).toEqual({ kind: 'drop', why: 'Saia de “Desenhar região” (B) para editar o texto.' })
    expect(resolveTextEditRequest({ ...ok, tool: 'zooming' })).toEqual({ kind: 'drop', why: 'Saia da ferramenta Zoom (Z) para editar o texto.' })
    expect(resolveTextEditRequest({ ...ok, tool: 'reframing' })).toEqual({ kind: 'drop', why: 'Feche o reenquadramento para editar o texto.' })
  })
  it('sem caixa no quadro, tocando ou texto apagado: descarta', () => {
    expect(resolveTextEditRequest({ ...ok, hasBox: false })).toEqual({ kind: 'drop', why: 'O texto não aparece no quadro do cursor de reprodução.' })
    expect(resolveTextEditRequest({ ...ok, playing: true }).kind).toBe('drop')
    expect(resolveTextEditRequest({ ...ok, exists: false }).kind).toBe('drop')
  })
  it('nunca devolve "esperar": toda combinação abre ou descarta', () => {
    for (const exists of [true, false]) for (const playing of [true, false]) for (const playheadInside of [true, false]) for (const hasBox of [true, false])
      for (const tool of [null, 'drawing', 'zooming', 'reframing'] as const) {
        const r = resolveTextEditRequest({ exists, playing, playheadInside, hasBox, tool })
        expect(r.kind === 'open' ? exists && !playing && playheadInside && hasBox && !tool : true).toBe(true)
        expect(['open', 'drop']).toContain(r.kind)
      }
  })
})
