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

describe('PlaybackController — shuttle J/K/L', () => {
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
    useEditorStore.getState().open(project()) // vídeo de 5 s
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    useEditorStore.getState().close()
  })
  const setup = (): { ctl: PlaybackController; calls: { fromUs: number; frames: number; rate: number }[] } => {
    const render = { requestFrame: vi.fn(async (t: number) => ({ t: 'rendered', seq: 0, tUs: t, ms: 1, missing: [] })) } as unknown as RenderClient
    const calls: { fromUs: number; frames: number; rate: number }[] = []
    // blocos que nunca chegam: o relógio começa pelo fallback (ou na hora, nas taxas mudas)
    const audio = { onError: () => () => {}, cancel: vi.fn(), render: vi.fn((fromUs: number, frames: number, rate = 1) => { calls.push({ fromUs, frames, rate }); return new Promise<AudioBlock | null>(() => {}) }) } as unknown as AudioClient
    return { ctl: new PlaybackController(render, audio, useEditorStore), calls }
  }

  it('L parado toca a 1×; L de novo acelera 2 → 4 → 8 (teto); K pausa e volta a 1×', async () => {
    const { ctl } = setup()
    const rates: number[] = []
    for (let i = 0; i < 5; i++) {
      await ctl.shuttle(1)
      rates.push(ctl.rate)
      expect(useEditorStore.getState().playRate).toBe(ctl.rate)
    }
    expect(rates).toEqual([1, 2, 4, 8, 8])
    ctl.pause()
    expect([ctl.playing, ctl.rate, useEditorStore.getState().playRate]).toEqual([false, 1, 1])
    await ctl.play()
    expect(ctl.rate).toBe(1)
    ctl.dispose()
  })

  it('2×: blocos de áudio pedidos com rate 2, cada um cobrindo 200 ms da timeline em 100 ms', async () => {
    const { ctl, calls } = setup()
    useEditorStore.getState().setPlayhead(1_000_000)
    await ctl.shuttle(1)
    await ctl.shuttle(1)
    const at2 = calls.filter((c) => c.rate === 2)
    expect(at2.length).toBeGreaterThanOrEqual(3)
    expect(at2.slice(0, 3).map((c) => [c.fromUs, c.frames])).toEqual([[1_000_000, 4800], [1_200_000, 4800], [1_400_000, 4800]])
    ctl.dispose()
  })

  it('4×: sem áudio (relógio na hora) e avança 4 s por segundo', async () => {
    const { ctl, calls } = setup()
    await ctl.shuttle(1)
    await ctl.shuttle(1)
    await ctl.shuttle(1)
    calls.length = 0
    const us0 = useEditorStore.getState().playheadUs
    const t0 = ctx.currentTime
    ctx.currentTime = t0 + 0.5
    expect(ctl.clockUs).toBe(us0 + 2_000_000)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toEqual([])
    ctl.dispose()
  })

  it('J toca para trás (1× → 2×…), sem áudio; chega ao início e para nele', async () => {
    const { ctl, calls } = setup()
    useEditorStore.getState().setPlayhead(3_000_000)
    await ctl.shuttle(-1)
    expect(ctl.rate).toBe(-1)
    ctx.currentTime += 1
    expect(ctl.clockUs).toBe(2_000_000)
    await ctl.shuttle(-1)
    expect(ctl.rate).toBe(-2)
    expect(calls).toEqual([])
    ctx.currentTime += 1.5 // de ~2 s a −2×: passa do início
    await vi.advanceTimersByTimeAsync(50)
    expect(ctl.playing).toBe(false)
    expect(useEditorStore.getState().playheadUs).toBe(0)
    ctl.dispose()
  })

  it('direção oposta tocando volta a 1× no outro sentido; seek tocando mantém a taxa; J no início fica parado', async () => {
    const { ctl } = setup()
    await ctl.shuttle(-1)
    expect([ctl.playing, ctl.rate]).toEqual([false, 1]) // no início não há para onde voltar
    useEditorStore.getState().setPlayhead(2_000_000)
    await ctl.shuttle(1)
    await ctl.shuttle(1)
    await ctl.shuttle(-1)
    expect(ctl.rate).toBe(-1)
    await ctl.shuttle(1)
    expect(ctl.rate).toBe(1)
    await ctl.shuttle(1)
    ctl.seek(1_000_000)
    await vi.advanceTimersByTimeAsync(0)
    expect([ctl.playing, ctl.rate]).toEqual([true, 2])
    ctl.dispose()
  })
})
