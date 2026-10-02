import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorTrackV1 } from '@shared/cursor'
import type { Asset } from '@shared/editor/project'

// useCursorTrack sem DOM (vitest em Node): um mínimo de runtime de hooks (useState/useEffect com deps e limpeza)
// no lugar do React e o store do editor como um seletor sobre um estado de teste. Cada render() é um "commit":
// roda o componente e depois os efeitos cujas deps mudaram (limpando os anteriores), como o React faz.
const rt = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: void | (() => void) }[],
  si: 0,
  ei: 0,
  pending: [] as (() => void)[],
  project: null as { assets: Asset[] } | null
}))

vi.mock('react', () => ({
  useState: <T,>(init: T | (() => T)) => {
    const i = rt.si++
    if (!(i in rt.states)) rt.states[i] = typeof init === 'function' ? (init as () => T)() : init
    return [rt.states[i] as T, (v: T) => void (rt.states[i] = v)]
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = rt.ei++
    const prev = rt.effects[i]
    if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps![k]))) return
    rt.pending.push(() => {
      if (typeof prev?.cleanup === 'function') prev.cleanup()
      rt.effects[i] = { deps, cleanup: fn() }
    })
  }
}))
vi.mock('../state/editorStore', () => ({
  useEditorStore: <T,>(sel: (s: { project: { assets: Asset[] } | null }) => T): T => sel({ project: rt.project })
}))

const read = vi.fn<(sessionId: string) => Promise<CursorTrackV1 | null>>()
;(globalThis as unknown as { window: unknown }).window = { api: { cursor: { readCursorTrack: (id: string) => read(id) } } }

const { useCursorTrack } = await import('./cursorTracks')

function render(assetId: string | null): CursorTrackV1 | null {
  rt.si = 0
  rt.ei = 0
  rt.pending = []
  const out = useCursorTrack(assetId)
  for (const f of rt.pending) f()
  return out
}
function unmount(): void {
  for (const e of rt.effects) if (typeof e?.cleanup === 'function') e.cleanup()
  rt.states = []
  rt.effects = []
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const deferred = (): { promise: Promise<CursorTrackV1 | null>; resolve: (t: CursorTrackV1 | null) => void } => {
  let resolve!: (t: CursorTrackV1 | null) => void
  const promise = new Promise<CursorTrackV1 | null>((r) => (resolve = r))
  return { promise, resolve }
}
const trackOf = (w: number): CursorTrackV1 => ({ version: 1, width: w, height: 10, samples: [{ tMs: 0, x: 0, y: 0 }], clicks: [] })
const screen = (id: string, sessionId: string, cursor = true): Asset => ({
  id, name: id, kind: 'video', source: { type: 'session', sessionId, stream: 'screen' }, durationUs: 1, status: 'ready', ...(cursor ? { cursor: 'cursor.json' } : {})
})

describe('useCursorTrack', () => {
  let n = 0
  let sid: (s: string) => string // sessões novas por teste (o cache do app é compartilhado entre testes)
  beforeEach(() => {
    unmount()
    read.mockReset()
    const k = ++n
    sid = (s) => `${s}-${k}`
  })

  it('carrega uma vez, devolve a trilha e ela fica compartilhada (outro componente já a tem no 1º render)', async () => {
    const A = trackOf(1)
    rt.project = { assets: [screen('a', sid('A'))] }
    read.mockResolvedValue(A)
    expect(render('a')).toBeNull() // carregando
    await flush()
    expect(render('a')).toBe(A)
    unmount()
    expect(render('a')).toBe(A) // outro "componente": cache
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('troca de gravação A → B: nunca mostra a trilha de A para B, nem quando A responde atrasada', async () => {
    const A = trackOf(1), B = trackOf(2)
    rt.project = { assets: [screen('a', sid('A')), screen('b', sid('B'))] }
    const dA = deferred(), dB = deferred()
    read.mockImplementation((s) => (s === sid('A') ? dA.promise : dB.promise))
    expect(render('a')).toBeNull()
    expect(render('b')).toBeNull() // trocou antes de A chegar
    dA.resolve(A)
    await flush()
    expect(render('b')).toBeNull() // A chegou atrasada: não vale para B
    dB.resolve(B)
    await flush()
    expect(render('b')).toBe(B)
    expect(render('a')).toBe(A) // A ficou no cache
    expect(render('b')).toBe(B)
  })

  it('A carregada e mostrada → troca para B (carregando, depois sem trilha): null, nunca A', async () => {
    const A = trackOf(1)
    rt.project = { assets: [screen('a', sid('A')), screen('b', sid('B'))] }
    const dB = deferred()
    read.mockImplementation((s) => (s === sid('A') ? Promise.resolve(A) : dB.promise))
    render('a')
    await flush()
    expect(render('a')).toBe(A)
    expect(render('b')).toBeNull() // B carregando
    dB.resolve(null)
    await flush()
    expect(render('b')).toBeNull() // B sem trilha
    expect(render('a')).toBe(A)
  })

  it('sem trilha (IPC devolve null ou falha): null; asset sem `cursor`, que não é tela ou inexistente: null sem IPC', async () => {
    rt.project = {
      assets: [
        screen('nula', sid('N')),
        screen('falha', sid('F')),
        screen('semFlag', sid('S'), false),
        { ...screen('cam', sid('C')), source: { type: 'session', sessionId: sid('C'), stream: 'webcam' } }
      ]
    }
    read.mockImplementation(async (s) => {
      if (s === sid('F')) throw new Error('ipc')
      return null
    })
    for (const id of ['nula', 'falha']) {
      unmount()
      expect(render(id)).toBeNull()
      await flush()
      expect(render(id)).toBeNull()
    }
    for (const id of ['semFlag', 'cam', 'nao-existe', null]) {
      unmount()
      expect(render(id)).toBeNull()
    }
    expect(read.mock.calls.map(([s]) => s).sort()).toEqual([sid('F'), sid('N')].sort())
    rt.project = null
    unmount()
    expect(render('nula')).toBeNull() // sem projeto aberto
  })
})
