import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, MediaItem, Project } from './project'
import * as ops from './ops'
import { gainAt, planAudio, shuttleSegments, SHUTTLE_AUDIO_MAX_RATE, type AudioSegment } from './audioPlan'

const S = 1_000_000
const vid = (): Asset => ({ id: 'a1', name: 'a1', kind: 'video', source: { type: 'file', path: 'C:/a.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })

function base(): { p: Project; a: string } {
  const r = ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid()), 'a1', 0)
  return { p: r.project, a: r.itemIds[1] }
}

describe('planAudio', () => {
  it('usa o item de áudio; faixa muda some', () => {
    const { p } = base()
    const segs = planAudio(p)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ assetId: 'a1', startUs: 0, durationUs: 10 * S, srcInUs: 0, speed: 1 })
    expect(planAudio(ops.updateTrack(p, p.tracks[1].id, { muted: true }))).toEqual([])
  })
  it('volume de faixa 0,5 × item 0,5 → 0,25', () => {
    const { p, a } = base()
    const q = ops.updateItem<MediaItem>(ops.updateTrack(p, p.tracks[1].id, { volume: 0.5 }), a, (d) => { d.audio.volume = { value: 0.5 } })
    expect(gainAt(planAudio(q)[0], 5 * S)).toBeCloseTo(0.25)
  })
  it('fadeIn/fadeOut em rampa linear', () => {
    const { p, a } = base()
    const q = ops.updateItem<MediaItem>(p, a, (d) => { d.audio.fadeInUs = S; d.audio.fadeOutUs = 2 * S })
    const s = planAudio(q)[0]
    expect(gainAt(s, 0)).toBe(0)
    expect(gainAt(s, 0.5 * S)).toBeCloseTo(0.5)
    expect(gainAt(s, 5 * S)).toBe(1)
    expect(gainAt(s, 9 * S)).toBeCloseTo(0.5)
    expect(gainAt(s, 10 * S)).toBe(0)
  })
  it('keyframes de volume entram no envelope', () => {
    const { p, a } = base()
    const q = ops.updateItem<MediaItem>(p, a, (d) => { d.audio.volume = { value: 1, keys: [{ tUs: 2 * S, value: 0.2, ease: 'linear' }] } })
    const s = planAudio(q)[0]
    expect(s.gain.some((g) => g.tUs === 2 * S && Math.abs(g.gain - 0.2) < 1e-9)).toBe(true)
  })
  it('vídeo com audio.enabled=false não gera segmento', () => {
    const { p } = base()
    expect(planAudio(p).every((s) => s.itemId !== p.tracks[0].items[0].id)).toBe(true)
  })
  it('item de mídia com enabled:false não entra no plano', () => {
    const { p, a } = base()
    const off = ops.setItemEnabled(p, [a], false)
    expect(planAudio(off)).toEqual([])
    expect(planAudio(ops.setItemEnabled(off, [a], true))).toHaveLength(1)
  })
  describe('modo do segmento', () => {
    const at = (speed: number, over: { preservePitch?: boolean; keepFastAudio?: boolean; reverse?: boolean } = {}): string => {
      const { p, a } = base()
      const q = ops.updateItem<MediaItem>(p, a, (d) => {
        d.speed = speed
        d.durationUs = Math.round((10 * S) / speed)
        d.reverse = over.reverse ?? false
        d.audio.preservePitch = over.preservePitch ?? true
        if (over.keepFastAudio !== undefined) d.audio.keepFastAudio = over.keepFastAudio
      })
      return planAudio(q)[0].mode
    }
    it('1× copia', () => {
      expect(at(1)).toBe('copy')
      expect(at(1, { preservePitch: false })).toBe('copy')
    })
    it('preservePitch até 4× (inclusive) e câmera lenta → stretch', () => {
      for (const v of [0.1, 0.5, 1.5, 2, 4]) expect(at(v)).toBe('stretch')
    })
    it('acima de 4× com preservePitch → mute, salvo keepFastAudio', () => {
      expect(at(4.01)).toBe('mute')
      expect(at(8)).toBe('mute')
      expect(at(16, { keepFastAudio: false })).toBe('mute')
      expect(at(8, { keepFastAudio: true })).toBe('stretch')
    })
    it('sem preservePitch → resample (o tom muda), em qualquer velocidade', () => {
      for (const v of [0.5, 2, 8]) expect(at(v, { preservePitch: false })).toBe('resample')
    })
    it('reverso: 1× copia, até 4× reamostra; acima de 4× com preservePitch fica mudo (salvo keepFastAudio)', () => {
      expect(at(1, { reverse: true })).toBe('copy')
      expect(at(2, { reverse: true })).toBe('resample')
      expect(at(8, { reverse: true })).toBe('mute')
      expect(at(8, { reverse: true, keepFastAudio: true })).toBe('resample')
      expect(at(8, { reverse: true, preservePitch: false })).toBe('resample')
    })
  })
})

describe('shuttleSegments (J/K/L: áudio do preview em taxa ≠ 1)', () => {
  const seg = (over: Partial<AudioSegment> = {}): AudioSegment => ({
    itemId: 'i', assetId: 'a1', startUs: 3 * S, durationUs: 4 * S, srcInUs: S, speed: 1, reverse: false, preservePitch: true, keepFastAudio: false, mode: 'copy',
    gain: [{ tUs: 3 * S, gain: 0 }, { tUs: 4 * S, gain: 1 }, { tUs: 7 * S, gain: 1 }], ...over
  })
  it('1× devolve os mesmos segmentos', () => {
    const s = [seg()]
    expect(shuttleSegments(s, 1)).toBe(s)
  })
  it('2× para frente: tempos da timeline ÷ 2, velocidade × 2 e esticado (tom preservado) — mesma fonte em cada instante', () => {
    const [o] = shuttleSegments([seg()], 2)
    expect(o).toMatchObject({ startUs: 1_500_000, durationUs: 2 * S, speed: 2, mode: 'stretch', srcInUs: S })
    expect(o.gain).toEqual([{ tUs: 1_500_000, gain: 0 }, { tUs: 2 * S, gain: 1 }, { tUs: 3_500_000, gain: 1 }])
    // instante t da timeline ↔ t/2 no tempo do shuttle: a fonte lida é a mesma
    const t = 5 * S
    expect(o.srcInUs + (t / 2 - o.startUs) * o.speed).toBe(S + (t - 3 * S))
    // trecho esticado continua esticado; reamostrado (sem preservePitch) passa a esticar também
    expect(shuttleSegments([seg({ speed: 1.5, mode: 'stretch' })], 2)[0]).toMatchObject({ speed: 3, mode: 'stretch' })
    expect(shuttleSegments([seg({ speed: 1.5, mode: 'resample', preservePitch: false })], 2)[0]).toMatchObject({ speed: 3, mode: 'stretch' })
  })
  it('mudo continua mudo; acima de 4× efetivo fica mudo salvo keepFastAudio (respeitado no shuttle); reverso reamostra', () => {
    expect(shuttleSegments([seg({ mode: 'mute', speed: 8 })], 2)[0].mode).toBe('mute')
    expect(shuttleSegments([seg({ speed: 3, mode: 'stretch' })], 2)[0].mode).toBe('mute')
    expect(shuttleSegments([seg({ speed: 3, mode: 'stretch', keepFastAudio: true })], 2)[0]).toMatchObject({ speed: 6, mode: 'stretch' })
    expect(shuttleSegments([seg({ speed: 6, mode: 'stretch', keepFastAudio: true })], 2)[0]).toMatchObject({ speed: 12, mode: 'stretch' })
    expect(shuttleSegments([seg({ speed: 3, mode: 'resample', preservePitch: false, keepFastAudio: true })], 2)[0]).toMatchObject({ speed: 6, mode: 'stretch' })
    const { p, a } = base()
    const keep = ops.updateItem<MediaItem>(p, a, (d) => { d.audio.keepFastAudio = true })
    expect([planAudio(p)[0].keepFastAudio, planAudio(keep)[0].keepFastAudio]).toEqual([false, true])
    expect(shuttleSegments([seg({ reverse: true, mode: 'copy' })], 2)[0]).toMatchObject({ speed: 2, mode: 'resample', reverse: true })
  })
  it('acima de 2× ou para trás o shuttle é mudo (lança: quem chama não pede áudio)', () => {
    expect(SHUTTLE_AUDIO_MAX_RATE).toBe(2)
    expect(() => shuttleSegments([seg()], 4)).toThrow()
    expect(() => shuttleSegments([seg()], -1)).toThrow()
  })
})
