import { describe, expect, it } from 'vitest'
import { pausedPlayheadSelector } from './pausedPlayhead'

describe('pausedPlayheadSelector', () => {
  it('tocando devolve o último playhead parado (sem re-render a 60 Hz); ao pausar, o atual', () => {
    const sel = pausedPlayheadSelector(0)
    expect(sel({ playing: false, playheadUs: 100 })).toBe(100)
    expect(sel({ playing: true, playheadUs: 200 })).toBe(100)
    expect(sel({ playing: true, playheadUs: 300 })).toBe(100)
    expect(sel({ playing: false, playheadUs: 350 })).toBe(350)
  })
})
