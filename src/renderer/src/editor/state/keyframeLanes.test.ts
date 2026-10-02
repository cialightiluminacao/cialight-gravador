import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import { useEditorStore } from './editorStore'
import { useCurveEditor, useExpandedItems } from './keyframeLanes'

describe('estado das linhas de keyframes', () => {
  it('abrir um projeto limpa os itens expandidos e fecha o editor de curvas', () => {
    useEditorStore.getState().open(createEmptyProject('a'))
    useExpandedItems.getState().toggle('i1')
    useCurveEditor.getState().open({ itemId: 'i1', path: 'transform.x', tUs: 0, x: 0, y: 0 })
    // editar o mesmo projeto não mexe
    useEditorStore.getState().apply((p) => ({ ...p, name: 'outro nome' }))
    expect(useExpandedItems.getState().ids.has('i1')).toBe(true)
    useEditorStore.getState().open(createEmptyProject('b'))
    expect(useExpandedItems.getState().ids.size).toBe(0)
    expect(useCurveEditor.getState().target).toBeNull()
    // reabrir o mesmo projeto também começa recolhido
    useExpandedItems.getState().toggle('i2')
    useEditorStore.getState().close()
    useEditorStore.getState().open(createEmptyProject('b'))
    expect(useExpandedItems.getState().ids.size).toBe(0)
  })
})
