import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { addAsset, insertItems } from '@shared/editor/ops'
import type { Asset } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'
import { PlaybackController } from './PlaybackController'
import type { RenderClient } from './RenderClient'
import type { AudioBlock, AudioClient } from './audio/AudioClient'

// Relógio de reprodução sem áudio: se nenhum bloco chegar (worker travado em mídia que não abre),
// o relógio começa sozinho após um tempo curto, para projetos só de vídeo/com erro tocarem.

class FakeCtx {
  currentTime = 0
  outputLatency = 0
  baseLatency = 0
  destination = {}
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createBuffer = vi.fn()
  createBufferSource = vi.fn()
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }))
}

let ctx: FakeCtx
let rafQueue: (() => void)[] = []

function project() {
  const asset: Asset = { id: 'a1', name: 'v.mp4', kind: 'video', source: { type: 'generated', file: 'v.mp4' }, durationUs: 5_000_000, status: 'ready', video: { width: 640, height: 360, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 } }
  let p = addAsset(createEmptyProject('t'), asset)
  p = insertItems(p, p.tracks[0].id, [createMediaItem(asset, 0, 'video')], 'overwrite')
  return p
}

describe('PlaybackController — relógio sem blocos de áudio', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ctx = new FakeCtx()
    rafQueue = []
    vi.stubGlobal('AudioContext', function () {
      return ctx
    })
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    useEditorStore.getState().open(project())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    useEditorStore.getState().close()
  })

  it('começa o relógio após o tempo limite quando o audio worker não responde', async () => {
    const frames: number[] = []
    const render = { requestFrame: vi.fn(async (t: number) => { frames.push(t); return { t: 'rendered', seq: 0, tUs: t, ms: 1, missing: [] } }) } as unknown as RenderClient
    const audio = { onError: () => () => {}, cancel: vi.fn(), render: vi.fn(() => new Promise<AudioBlock | null>(() => {})) } as unknown as AudioClient
    const ctl = new PlaybackController(render, audio, useEditorStore)
    await ctl.play()
    expect(ctl.clockUs).toBeNull()

    await vi.advanceTimersByTimeAsync(600)
    ctx.currentTime = 1
    expect(ctl.clockUs).not.toBeNull()
    // o rAF agendado avança o playhead e pede quadros
    rafQueue.shift()?.()
    expect(useEditorStore.getState().playheadUs).toBeGreaterThan(0)
    expect(frames.length).toBeGreaterThan(0)
    ctl.dispose()
  })

  it('não dispara o fallback depois de pausar', async () => {
    const render = { requestFrame: vi.fn(async () => ({ t: 'rendered' })) } as unknown as RenderClient
    const audio = { onError: () => () => {}, cancel: vi.fn(), render: vi.fn(() => new Promise<AudioBlock | null>(() => {})) } as unknown as AudioClient
    const ctl = new PlaybackController(render, audio, useEditorStore)
    await ctl.play()
    ctl.pause()
    await vi.advanceTimersByTimeAsync(600)
    expect(ctl.clockUs).toBeNull()
    expect(rafQueue.length).toBe(0)
    ctl.dispose()
  })
})
