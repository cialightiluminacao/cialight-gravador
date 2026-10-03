import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { findItem } from '@shared/editor/ops'
import { DEFAULT_CURSOR_FX, type Asset, type MediaItem, type Project } from '@shared/editor/project'
import { useEditorStore } from '../../state/editorStore'
import { updateCursorFx } from './cursorFxEdit'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const screen: Asset = {
  id: 'scr', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' }, durationUs: 10_000_000,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 }, status: 'ready', cursor: 'cursor.json'
}
function base(withFx: boolean): Project {
  const p = createEmptyProject('t')
  p.assets = [screen]
  const it: MediaItem = { ...createMediaItem(screen, 0, 'video'), id: 'it' }
  p.tracks[0].items = [withFx ? { ...it, cursorFx: { highlight: { ...DEFAULT_CURSOR_FX.highlight, enabled: true }, cursor: { ...DEFAULT_CURSOR_FX.cursor } } } : it]
  return p
}
const fxOf = (): MediaItem['cursorFx'] => (findItem(st().project!, 'it')!.item as MediaItem).cursorFx

beforeEach(() => {
  st().close()
})

describe('updateCursorFx (inspetor "Cursor e cliques")', () => {
  it('sem cursorFx (importado, regravado pela v1.3): a 1ª mudança cria a partir do padrão — um passo de desfazer', () => {
    st().open(base(false))
    expect(fxOf()).toBeUndefined()
    // gesto de slider: begin → várias mudanças transitórias → commit
    st().begin()
    for (const v of [30, 40, 52]) st().apply((p) => updateCursorFx(p, 'it', (fx) => { fx.highlight.sizePx = v }), { transient: true })
    st().commitTx()
    expect(st().history.past).toHaveLength(1)
    expect(fxOf()).toEqual({ highlight: { ...DEFAULT_CURSOR_FX.highlight, sizePx: 52 }, cursor: DEFAULT_CURSOR_FX.cursor })
    // o padrão compartilhado não foi mexido
    expect(DEFAULT_CURSOR_FX.highlight.sizePx).toBe(28)
    st().undo()
    expect(fxOf()).toBeUndefined()
  })

  it('toggle: uma entrada; com cursorFx existente só o campo muda', () => {
    st().open(base(true))
    expect(st().apply((p) => updateCursorFx(p, 'it', (fx) => { fx.cursor.enabled = true }))).toBe(true)
    expect(st().history.past).toHaveLength(1)
    expect(fxOf()).toEqual({ highlight: { ...DEFAULT_CURSOR_FX.highlight, enabled: true }, cursor: { ...DEFAULT_CURSOR_FX.cursor, enabled: true } })
  })

  it('faixa bloqueada: recusa (EditError → toast, nada muda)', () => {
    const p = base(false)
    p.tracks[0].locked = true
    st().open(p)
    expect(st().apply((q) => updateCursorFx(q, 'it', (fx) => { fx.highlight.enabled = true }))).toBe(false)
    expect(fxOf()).toBeUndefined()
  })
})
