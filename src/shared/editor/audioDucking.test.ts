import { describe, expect, it } from 'vitest'
import { createEmptyProject, createMediaItem } from './factory'
import type { Asset, MediaItem, Project, Track } from './project'
import type { SpeechInterval } from './speech'
import * as ops from './ops'
import { AUDIO_MIX_DEFAULTS, duckEnvelope, gainAt, planAudio, voiceAssetIds, type AudioSegment } from './audioPlan'

// Ducking: envelope de ganho nas faixas de música a partir da fala das faixas de voz (puro).

const S = 1_000_000
const DUCK = Math.pow(10, -12 / 20)
const aud = (id: string, durS: number): Asset => ({
  id, name: id, kind: 'audio', source: { type: 'file', path: `C:/${id}.m4a`, size: 1, mtimeMs: 1 }, durationUs: durS * S,
  audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready', speech: `cache/${id}.speech.json`
})

/** Voz (asset v, 20 s) e música (asset m, 30 s) em faixas com papel; `voice` ajusta o item de voz; `extraVoice` cria uma 2ª faixa de voz. */
function proj(voice: Partial<MediaItem> = {}, extraVoice?: Partial<MediaItem>): Project {
  const assets = [aud('v', 20), aud('m', 30), aud('v2', 20)]
  const item = (id: string, a: Asset, over: Partial<MediaItem>): MediaItem => ({ ...createMediaItem(a, 0, 'audio'), id, durationUs: 20 * S, ...over })
  const track = (id: string, name: string, role: Track['role'], items: MediaItem[]): Track => ({ id, kind: 'audio', name, muted: false, hidden: false, locked: false, volume: 1, role, items })
  const tracks: Track[] = [track('t_voz', 'Voz', 'voice', [item('i_v', assets[0], voice)]), track('t_mus', 'Música', 'music', [item('i_m', assets[1], { durationUs: 30 * S })])]
  if (extraVoice) tracks.push(track('t_voz2', 'Voz 2', 'voice', [item('i_v2', assets[2], extraVoice)]))
  return { ...createEmptyProject('t'), assets, tracks }
}
const music = (p: Project, speech: Record<string, SpeechInterval[]>): AudioSegment => planAudio(p, { speech }).find((s) => s.itemId === 'i_m')!
const sp = (...iv: [number, number][]): SpeechInterval[] => iv.map(([a, b]) => ({ fromUs: Math.round(a * S), toUs: Math.round(b * S) }))
const g = (s: AudioSegment, t: number): number => gainAt(s, Math.round(t * S))
const flat = (s: AudioSegment): boolean => s.gain.every((x) => x.gain === 1)
/** Ganho monotônico (dir 1 = não decresce, −1 = não cresce) em passos de 10 ms. */
function monotonic(s: AudioSegment, from: number, to: number, dir: 1 | -1): boolean {
  let prev = g(s, from)
  for (let t = from; t <= to + 1e-9; t += 0.01) {
    const v = g(s, t)
    if (dir * (v - prev) < -1e-9) return false
    prev = v
  }
  return true
}

describe('ducking (planAudio com intervalos de fala)', () => {
  it('música sem voz (ou sem dados de fala) = ganho 1', () => {
    const p = proj()
    expect(flat(music(p, {}))).toBe(true)
    expect(flat(planAudio(p).find((s) => s.itemId === 'i_m')!)).toBe(true)
    const noVoice = { ...p, tracks: p.tracks.filter((t) => t.role !== 'voice') }
    expect(flat(music(noVoice, { v: sp([2, 4]) }))).toBe(true)
  })

  it('voz começando no meio de um bloco de 100 ms: rampa de 250 ms até o início da fala, −12 dB durante, hold de 300 ms e soltura de 400 ms', () => {
    const s = music(proj(), { v: sp([2.05, 4]) })
    expect(g(s, 1.7)).toBe(1)
    expect(g(s, 1.8)).toBeCloseTo(1, 9)
    expect(g(s, 1.925)).toBeCloseTo((1 + DUCK) / 2, 6)
    expect(g(s, 2.05)).toBeCloseTo(DUCK, 9)
    expect(g(s, 3)).toBeCloseTo(DUCK, 9)
    expect(g(s, 4.3)).toBeCloseTo(DUCK, 9) // fim da fala + hold
    expect(g(s, 4.5)).toBeCloseTo((1 + DUCK) / 2, 6)
    expect(g(s, 4.7)).toBeCloseTo(1, 9)
    expect(g(s, 6)).toBe(1)
    expect(monotonic(s, 1.7, 2.05, -1)).toBe(true)
    expect(monotonic(s, 4.3, 4.8, 1)).toBe(true)
  })

  it('pausa mais curta que o hold não solta (sem bombear)', () => {
    const s = music(proj(), { v: sp([2, 3], [3.25, 5]) })
    for (let t = 2; t <= 5.3; t += 0.05) expect(g(s, t)).toBeCloseTo(DUCK, 9)
  })

  it('pausa longa: solta depois do hold e volta a abaixar antes da fala seguinte', () => {
    const s = music(proj(), { v: sp([2, 3], [5, 6]) })
    expect(g(s, 3.3)).toBeCloseTo(DUCK, 9)
    expect(g(s, 3.7)).toBeCloseTo(1, 9)
    expect(g(s, 4.5)).toBeCloseTo(1, 9)
    expect(g(s, 4.75)).toBeCloseTo(1, 9)
    expect(g(s, 5)).toBeCloseTo(DUCK, 9)
    expect(monotonic(s, 3.3, 3.7, 1)).toBe(true)
    expect(monotonic(s, 4.75, 5, -1)).toBe(true)
  })

  it('pausa entre o hold e hold + ataque: a soltura e o ataque seguinte se cruzam sem degrau (máximo dos dois)', () => {
    // fim da fala 3 s → hold até 3,3 s; próxima fala 3,45 s → ataque desde 3,2 s
    const s = music(proj(), { v: sp([2, 3], [3.45, 5]) })
    expect(g(s, 3.3)).toBeCloseTo(DUCK, 9)
    expect(g(s, 3.45)).toBeCloseTo(DUCK, 9)
    const mid = g(s, 3.36)
    expect(mid).toBeGreaterThan(DUCK)
    expect(mid).toBeLessThan(1)
    expect(monotonic(s, 3.3, 3.36, 1)).toBe(true)
    expect(monotonic(s, 3.4, 3.45, -1)).toBe(true)
  })

  it('múltiplas vozes: união dos intervalos das faixas de voz', () => {
    const s = music(proj({}, {}), { v: sp([2, 3]), v2: sp([6, 7]) })
    expect(g(s, 2.5)).toBeCloseTo(DUCK, 9)
    expect(g(s, 6.5)).toBeCloseTo(DUCK, 9)
    expect(g(s, 4.5)).toBe(1)
    // sobrepostas: uma só região
    const o = music(proj({}, {}), { v: sp([2, 4]), v2: sp([3, 6]) })
    for (let t = 2; t <= 6.3; t += 0.1) expect(g(o, t)).toBeCloseTo(DUCK, 9)
  })

  it('trim (inUs), velocidade e reverso do item de voz mapeiam a fala da fonte para a timeline', () => {
    // fala da fonte em [4 s, 6 s); item lendo a partir de 2 s da fonte, a 2×, começando em 1 s → fala em [2 s, 3 s)
    const fast = music(proj({ startUs: 1 * S, inUs: 2 * S, speed: 2, durationUs: 9 * S }), { v: sp([4, 6]) })
    expect(g(fast, 2)).toBeCloseTo(DUCK, 9)
    expect(g(fast, 3.2)).toBeCloseTo(DUCK, 9)
    expect(g(fast, 1.7)).toBe(1)
    expect(g(fast, 3.8)).toBeCloseTo(1, 9)
    // reverso: item [0, 10 s) lendo a fonte [0, 10 s) de trás para frente → fala da fonte [1 s, 2 s) em [8 s, 9 s)
    const rev = music(proj({ durationUs: 10 * S, reverse: true }), { v: sp([1, 2]) })
    expect(g(rev, 8.5)).toBeCloseTo(DUCK, 9)
    expect(g(rev, 1.5)).toBe(1)
    // fala fora do trecho usado (trim) não abaixa
    expect(flat(music(proj({ inUs: 5 * S, durationUs: 5 * S }), { v: sp([1, 2]) }))).toBe(true)
    // fala que atravessa o corte fica presa ao item: [inUs, …)
    const cut = music(proj({ startUs: 3 * S, inUs: 5 * S, durationUs: 5 * S }), { v: sp([4, 6]) })
    expect(g(cut, 3)).toBeCloseTo(DUCK, 9)
    expect(g(cut, 2.7)).toBeCloseTo(1, 9) // o ataque antecipa a rampa antes do item
    expect(g(cut, 4.3)).toBeCloseTo(DUCK, 9)
    expect(g(cut, 4.7)).toBeCloseTo(1, 9)
  })

  it('voz em faixa muda, sem papel de voz, item desativado, áudio desligado, congelado ou mudo pela velocidade não abaixa; ducking desligado também não', () => {
    const speech = { v: sp([2, 4]) }
    const p = proj()
    expect(flat(music(ops.updateTrack(p, 't_voz', { muted: true }), speech))).toBe(true)
    expect(flat(music(ops.updateTrack(p, 't_voz', { role: 'sfx' }), speech))).toBe(true)
    expect(flat(music(ops.setItemEnabled(p, ['i_v'], false), speech))).toBe(true)
    expect(flat(music(ops.updateItem<MediaItem>(p, 'i_v', (d) => { d.audio.enabled = false }), speech))).toBe(true)
    expect(flat(music(proj({ speed: 8, durationUs: 2 * S }), { v: sp([1, 2]) }))).toBe(true)
    expect(flat(music({ ...p, audioMix: { ...AUDIO_MIX_DEFAULTS, enabled: false } }, speech))).toBe(true)
  })

  it('intensidade, ataque e soltura do projeto; multiplica o volume da música; a voz não é afetada', () => {
    const p0 = proj()
    const p = ops.updateItem<MediaItem>({ ...p0, audioMix: { ...AUDIO_MIX_DEFAULTS, duckingDb: -6, attackMs: 100, releaseMs: 1000 } }, 'i_m', (d) => { d.audio.volume = { value: 0.5 } })
    const s = music(p, { v: sp([2, 4]) })
    const d6 = Math.pow(10, -6 / 20)
    expect(g(s, 1.85)).toBeCloseTo(0.5, 9)
    expect(g(s, 1.95)).toBeCloseTo((0.5 * (1 + d6)) / 2, 6)
    expect(g(s, 3)).toBeCloseTo(0.5 * d6, 9)
    expect(g(s, 4.8)).toBeCloseTo((0.5 * (1 + d6)) / 2, 6)
    expect(g(s, 5.3)).toBeCloseTo(0.5, 9)
    const voice = planAudio(p, { speech: { v: sp([2, 4]) } }).find((x) => x.itemId === 'i_v')!
    expect(flat(voice)).toBe(true)
  })

  it('fade da música e envelope de ducking se multiplicam', () => {
    const p = ops.updateItem<MediaItem>(proj(), 'i_m', (d) => { d.audio.fadeInUs = 4 * S })
    const s = music(p, { v: sp([2, 3]) })
    expect(g(s, 1)).toBeCloseTo(0.25, 9)
    expect(g(s, 2.5)).toBeCloseTo((2.5 / 4) * DUCK, 6)
  })

  it('segmentos levam a faixa (medidores por faixa); o envelope fica dentro do segmento', () => {
    const q = ops.updateItem<MediaItem>(proj(), 'i_m', (d) => { d.startUs = 3 * S; d.durationUs = 10 * S })
    const s = music(q, { v: sp([2, 4]) })
    expect(s.trackId).toBe('t_mus')
    expect(s.gain[0].tUs).toBe(3 * S)
    expect(s.gain[s.gain.length - 1].tUs).toBe(13 * S)
    expect(g(s, 3)).toBeCloseTo(DUCK, 9)
    expect(s.gain.every((x, i) => i === 0 || x.tUs >= s.gain[i - 1].tUs)).toBe(true)
  })

  it('duckEnvelope: pontos em µs inteiros, união com hold, rampas', () => {
    const env = duckEnvelope([{ fromUs: 2 * S, toUs: 3 * S }, { fromUs: 3.2 * S, toUs: 4 * S }], AUDIO_MIX_DEFAULTS)
    expect(env[0]).toEqual({ tUs: 1.75 * S, gain: 1 })
    expect(env[env.length - 1]).toEqual({ tUs: 4.7 * S, gain: 1 })
    expect(env.filter((x) => x.gain === 1)).toHaveLength(2)
    expect(env.every((x) => Number.isInteger(x.tUs))).toBe(true)
    expect(duckEnvelope([], AUDIO_MIX_DEFAULTS)).toEqual([])
  })

  it('voiceAssetIds: assets cuja fala o ducking precisa (voz audível, com speech, ducking ligado)', () => {
    const p = proj({}, {})
    expect(voiceAssetIds(p).sort()).toEqual(['v', 'v2'])
    expect(voiceAssetIds(ops.updateTrack(p, 't_voz2', { muted: true }))).toEqual(['v'])
    expect(voiceAssetIds({ ...p, audioMix: { ...AUDIO_MIX_DEFAULTS, enabled: false } })).toEqual([])
    // sem faixa de música não há o que abaixar
    expect(voiceAssetIds({ ...p, tracks: p.tracks.filter((t) => t.role !== 'music') })).toEqual([])
  })
})
