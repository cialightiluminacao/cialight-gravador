import { describe, expect, it, vi } from 'vitest'
import { SessionRecorder } from './sessionRecorder'
import type { Session } from '@shared/types'
import { DEFAULT_PIP } from '@shared/defaults'

function makeSession(): Session {
  return {
    version: 1,
    id: 's',
    createdAt: '',
    state: 'recording',
    source: { kind: 'screen', id: 'screen:0:0', name: 'M', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    video: { width: 1920, height: 1080, fps: 30, codec: 'avc1.640028', bitrate: 12e6 },
    systemAudio: true,
    tracks: { screen: 0 },
    pauses: [],
    pip: [{ ...DEFAULT_PIP, tMs: 999 }],
    strokes: [],
    clearEvents: [],
    markers: [],
    engine: 'webcodecs',
    files: { rec: 'rec.mp4' }
  }
}

function setup(): { rec: SessionRecorder; tick: (ms: number) => void; save: ReturnType<typeof vi.fn>; timers: { fn: () => void; ms: number }[] } {
  let now = 1000
  const save = vi.fn()
  const timers: { fn: () => void; ms: number }[] = []
  const rec = new SessionRecorder(makeSession(), {
    now: () => now,
    save,
    autosaveMs: 5000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {}
  })
  return { rec, tick: (ms) => (now += ms), save, timers }
}

describe('SessionRecorder', () => {
  it('begin zera o keyframe inicial da PiP e salva imediatamente', () => {
    const { rec, save } = setup()
    rec.begin()
    expect(rec.session.pip).toEqual([{ ...DEFAULT_PIP, tMs: 0 }])
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keyframes e traços recebem tempo de mídia descontando pausas', () => {
    const { rec, tick } = setup()
    rec.begin()
    tick(2000)
    rec.addPipKeyframe({ x: 0.1, y: 0.1, w: 0.2, h: 0.3, shape: 'rounded', visible: true })
    tick(1000)
    rec.pause()
    tick(3000) // pausado
    rec.resume()
    tick(500)
    rec.addPipKeyframe({ x: 0.2, y: 0.2, w: 0.2, h: 0.3, shape: 'rounded', visible: true })
    expect(rec.session.pip.map((k) => k.tMs)).toEqual([0, 2000, 3500])
    expect(rec.session.pauses).toEqual([{ startMs: 3000, endMs: 6000 }])
    expect(rec.mediaTimeMs()).toBe(3500)
  })

  it('keyframe no mesmo instante substitui o anterior', () => {
    const { rec, tick } = setup()
    rec.begin()
    tick(100)
    rec.addPipKeyframe({ x: 0.1, y: 0.1, w: 0.2, h: 0.3, shape: 'circle', visible: true })
    rec.addPipKeyframe({ x: 0.5, y: 0.5, w: 0.2, h: 0.3, shape: 'circle', visible: true })
    expect(rec.session.pip.length).toBe(2)
    expect(rec.session.pip[1].x).toBe(0.5)
  })

  it('undo marca erasedAtMs e clear registra evento; visibleStrokes reflete', () => {
    const { rec, tick } = setup()
    rec.begin()
    tick(1000)
    rec.upsertStroke({ id: 'a', tMs: 1000, tool: 'pen', points: [{ x: 0, y: 0, tMs: 1000 }], color: '#f00', width: 4 })
    tick(1000)
    rec.upsertStroke({ id: 'b', tMs: 2000, tool: 'arrow', points: [{ x: 0, y: 0, tMs: 2000 }], color: '#f00', width: 4 })
    tick(500)
    expect(rec.undoLastStroke()).toBe('b')
    expect(rec.visibleStrokes().map((s) => s.id)).toEqual(['a'])
    tick(500)
    rec.clearStrokes()
    expect(rec.visibleStrokes()).toEqual([])
    expect(rec.undoLastStroke()).toBeNull()
  })

  it('autosave é agrupado (throttle) e stop grava duração', () => {
    const { rec, tick, save, timers } = setup()
    rec.begin()
    save.mockClear()
    tick(10)
    rec.addPipKeyframe({ x: 0.1, y: 0.1, w: 0.2, h: 0.3, shape: 'circle', visible: true })
    rec.addPipKeyframe({ x: 0.2, y: 0.1, w: 0.2, h: 0.3, shape: 'circle', visible: true })
    expect(save).not.toHaveBeenCalled()
    expect(timers.length).toBe(1)
    timers[0].fn()
    expect(save).toHaveBeenCalledTimes(1)
    tick(5000)
    const s = rec.stop()
    expect(s.state).toBe('stopped')
    expect(s.durationMs).toBe(5010)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
