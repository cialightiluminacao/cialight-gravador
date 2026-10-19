import { expect, it } from 'vitest'
import { libraryAssets } from './mediaLibrary'
import type { Asset } from '@shared/editor/project'
it('searches names without accents and sorts filenames numerically without changing the source', () => {
  const make = (name: string, durationUs: number): Asset => ({ id: name, name, kind: 'audio', durationUs, source: { type: 'file', path: name, size: durationUs, mtimeMs: 0 }, status: 'ready' })
  const assets = [make('Áudio 10.m4a', 10), make('Áudio 2.m4a', 2), make('Outro.wav', 1)]
  expect(libraryAssets(assets, 'audio', 'name', false).map(a => a.name)).toEqual(['Áudio 2.m4a', 'Áudio 10.m4a'])
  expect(libraryAssets(assets, '', 'duration', true).map(a => a.durationUs)).toEqual([10, 2, 1])
  expect(assets[0].name).toBe('Áudio 10.m4a')
})
