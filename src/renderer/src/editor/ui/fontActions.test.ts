import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: vi.fn() }))

import { toast } from 'sonner'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Project, TextItem } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'
import { fontReplaceToast, replaceProjectFont } from './fontActions'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

function withTexts(fonts: string[], lock = false): Project {
  let p = createEmptyProject('t')
  fonts.forEach((f, i) => {
    const r = ops.addText(p, 'title', i * 4_000_000)
    p = ops.updateItem<TextItem>(r.project, r.itemId, (d) => { d.style.font = f })
  })
  if (lock) for (const t of p.tracks) if (t.items.length) p = ops.updateTrack(p, t.id, { locked: true })
  return p
}

beforeEach(() => {
  st().close()
  vi.mocked(toast).mockClear()
})

describe('fontReplaceToast', () => {
  it('trocado / trocado com bloqueadas / só bloqueadas / nada', () => {
    expect(fontReplaceToast(true, 0)).toEqual({ title: 'Fonte trocada para Manrope', description: 'Ctrl+Z desfaz.' })
    expect(fontReplaceToast(true, 2)?.description).toBe('Ctrl+Z desfaz. Textos em faixas bloqueadas não foram alterados.')
    expect(fontReplaceToast(false, 2)).toEqual({ title: 'Nenhum texto foi alterado', description: 'Os textos com essa fonte estão em faixas bloqueadas.' })
    expect(fontReplaceToast(false, 0)).toBeNull()
  })
})

describe('replaceProjectFont', () => {
  it('todos os textos da família em faixas bloqueadas: nada muda e o toast diz isso (nunca "Fonte trocada")', () => {
    const p = withTexts(['Fonte A', 'Fonte A'], true)
    st().open(p)
    replaceProjectFont('Fonte A')
    expect(st().project).toBe(p)
    expect(st().canUndo).toBe(false)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('Nenhum texto foi alterado', { description: 'Os textos com essa fonte estão em faixas bloqueadas.' })
  })
  it('troca de verdade: "Fonte trocada para Manrope" e um passo de desfazer', () => {
    st().open(withTexts(['Fonte A']))
    replaceProjectFont('Fonte A')
    expect(st().canUndo).toBe(true)
    expect(toast).toHaveBeenCalledWith('Fonte trocada para Manrope', { description: 'Ctrl+Z desfaz.' })
  })
})
