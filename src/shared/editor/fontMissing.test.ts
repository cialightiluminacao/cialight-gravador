import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import * as ops from './ops'
import type { Project, TextItem } from './project'
import { installedFromWidths, isAlwaysInstalled, missingFontFamilies, replaceFontFamily } from './fontMissing'

const withTexts = (fonts: string[], extra?: (p: Project) => Project): Project => {
  let p = createEmptyProject('t')
  fonts.forEach((f, i) => {
    const r = ops.addText(p, 'title', i * 4_000_000)
    p = ops.updateItem<TextItem>(r.project, r.itemId, (d) => { d.style.font = f })
  })
  return extra ? extra(p) : p
}
const allItems = (p: Project): TextItem[] => p.tracks.flatMap((t) => t.items).filter((i): i is TextItem => i.type === 'text')

describe('installedFromWidths', () => {
  it('largura difere de alguma reserva = instalada', () => {
    expect(installedFromWidths([100, 90], [80, 90])).toBe(true)
    expect(installedFromWidths([80, 91], [80, 90])).toBe(true)
  })
  it('igual a todas as reservas = ausente', () => {
    expect(installedFromWidths([80, 90], [80, 90])).toBe(false)
    expect(installedFromWidths([], [])).toBe(false)
  })
})

describe('isAlwaysInstalled', () => {
  it('genéricas e a fonte do app', () => {
    for (const f of ['sans-serif', 'Serif', 'monospace', 'system-ui', 'Manrope Variable', '"Manrope Variable"']) expect(isAlwaysInstalled(f)).toBe(true)
    expect(isAlwaysInstalled('Fonte X')).toBe(false)
  })
})

describe('missingFontFamilies', () => {
  const none = (): boolean => false
  it('deduplica, ignora desativados e as sempre instaladas', () => {
    let p = withTexts(['Fonte A', 'Fonte A', 'Fonte B', 'Manrope Variable', 'Fonte C'])
    const ids = allItems(p).map((i) => i.id)
    p = ops.setItemEnabled(p, [ids[2]], false)
    p = ops.setItemEnabled(p, [ids[4]], false)
    expect(missingFontFamilies(p, none)).toEqual(['Fonte A'])
    expect(missingFontFamilies(p, (f) => f === 'Fonte A')).toEqual([])
  })
  it('inclui legendas', () => {
    const p = ops.addCaption(createEmptyProject('t'), 0, 'oi').project
    const cap = allItems(p)[0]
    const q = ops.updateItem<TextItem>(p, cap.id, (d) => { d.style.font = 'Fonte Legenda' })
    expect(missingFontFamilies(q, none)).toEqual(['Fonte Legenda'])
  })
})

describe('replaceFontFamily', () => {
  it('troca só a família alvo, em todos os textos (incl. legendas)', () => {
    let p = withTexts(['Fonte A', 'Fonte B', 'Fonte A'])
    const c = ops.addCaption(p, 20_000_000, 'leg')
    p = ops.updateItem<TextItem>(c.project, c.itemId, (d) => { d.style.font = '"Fonte A"' })
    const r = replaceFontFamily(p, 'Fonte A')
    expect(r.changed).toBe(3)
    expect(r.skippedLocked).toBe(0)
    expect(allItems(r.project).map((i) => i.style.font).sort()).toEqual(['Fonte B', 'Manrope Variable', 'Manrope Variable', 'Manrope Variable'])
    expect(allItems(p).filter((i) => i.style.font.includes('Fonte A'))).toHaveLength(3) // imutável
  })
  it('pula faixas bloqueadas e conta', () => {
    let p = withTexts(['Fonte A', 'Fonte A'])
    const tid = p.tracks.find((t) => t.items.length)!.id
    p = ops.updateTrack(p, tid, { locked: true })
    const r = replaceFontFamily(p, 'Fonte A')
    expect(r.changed).toBe(0)
    expect(r.skippedLocked).toBeGreaterThan(0)
    expect(r.project).toBe(p)
  })
  it('um passo de desfazer: é uma única função pura (um apply)', () => {
    const p = withTexts(['Fonte A', 'Fonte A'])
    expect(replaceFontFamily(p, 'Fonte A').project).not.toBe(p)
  })
})
