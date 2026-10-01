import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import type { Item, Project } from '@shared/editor/project'
import { itemLabel } from './itemLabel'

describe('itemLabel', () => {
  const p: Project = { ...createEmptyProject('x'), assets: [{ id: 'a', name: 'clipe.mp4', kind: 'video', source: { type: 'generated', file: 'a' }, durationUs: 1, status: 'ready' }] }
  it('nome do item > nome da mídia > tipo em pt-BR', () => {
    expect(itemLabel(p, { id: 'i', type: 'annotations', name: 'Minhas notas' } as Item)).toBe('Minhas notas')
    expect(itemLabel(p, { id: 'i', type: 'media', assetId: 'a' } as Item)).toBe('clipe.mp4')
    expect(itemLabel(p, { id: 'i', type: 'annotations' } as Item)).toBe('Anotações')
  })
})
