import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, Project } from './project'
import { MIN_ITEM_US } from './project'
import * as ops from './ops'
import { validateProject } from './schema'
import { micProcessingWarning, narrationAssetName, narrationPlacement, placeNarration } from './narration'

// Narração gravada na timeline: posição do item (compensando as latências medidas do AudioContext) e a faixa "Narração".

const S = 1_000_000
const narr = (id: string, durationUs = 3 * S): Asset => ({ id, name: 'Narração 1', kind: 'audio', source: { type: 'generated', file: `generated/narracao-1.m4a` }, durationUs, audio: { channels: 1, sampleRate: 48000, codec: 'mp4a.40.2' }, status: 'processing' })
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1280, height: 720, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' }

describe('narrationPlacement', () => {
  // relógio da reprodução: bloco 0 agendado em t0 = 10 s do AudioContext, saída com 40 ms de latência, playhead em 5 s
  const clock = { us0: 5 * S, t0S: 10, outputLatencyS: 0.04 }

  it('sample que entrou no grafo junto com o som de us0 nos alto-falantes (t0 + saída + entrada) vai para us0', () => {
    expect(narrationPlacement({ playheadUs: 5 * S, clock, firstSampleS: 10 + 0.04 + 0.01, inputLatencyS: 0.01 })).toEqual({ startUs: 5 * S, inUs: 0 })
  })

  it('gravação que começou depois do relógio: o início anda o mesmo tanto, descontadas as duas latências', () => {
    // 250 ms de grafo depois de t0; o som capturado 10 ms antes, quando o alto-falante tocava 40 ms atrás do grafo
    expect(narrationPlacement({ playheadUs: 5 * S, clock, firstSampleS: 10.25, inputLatencyS: 0.01 })).toEqual({ startUs: 5 * S + 200_000, inUs: 0 })
  })

  it('o que foi capturado antes da timeline começar a andar (quadro parado em us0) fica no arquivo, cortado pelo inUs', () => {
    // 1º sample 120 ms antes do ponto em que us0 soa: item em us0, pulando esses 120 ms
    expect(narrationPlacement({ playheadUs: 5 * S, clock, firstSampleS: 10 + 0.04 + 0.01 - 0.12, inputLatencyS: 0.01 })).toEqual({ startUs: 5 * S, inUs: 120_000 })
  })

  it('sem latência informada (0): só o relógio', () => {
    expect(narrationPlacement({ playheadUs: 5 * S, clock: { ...clock, outputLatencyS: 0 }, firstSampleS: 10.5, inputLatencyS: 0 })).toEqual({ startUs: 5.5 * S, inUs: 0 })
  })

  it('timeline parada (playhead no fim, nada a tocar): começa no playhead', () => {
    expect(narrationPlacement({ playheadUs: 7 * S, clock: null, firstSampleS: 3.2, inputLatencyS: 0.02 })).toEqual({ startUs: 7 * S, inUs: 0 })
  })

  it('microssegundos inteiros', () => {
    const r = narrationPlacement({ playheadUs: 1, clock: { us0: 1, t0S: 0.1, outputLatencyS: 0.0123456 }, firstSampleS: 0.3333333, inputLatencyS: 0.0011111 })
    expect(Number.isInteger(r.startUs) && Number.isInteger(r.inUs)).toBe(true)
  })
})

describe('placeNarration', () => {
  const base = (): Project => ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid), 'v', 0).project

  it('asset + item na faixa nova "Narração" (papel Voz) no início calculado, com o trecho antes do relógio cortado', () => {
    const r = placeNarration(base(), narr('n1'), { startUs: 2 * S, inUs: 100_000 })
    const f = ops.findItem(r.project, r.itemId)!
    expect(f.track).toMatchObject({ id: r.trackId, kind: 'audio', name: 'Narração', role: 'voice' })
    expect(f.item).toMatchObject({ type: 'media', assetId: 'n1', startUs: 2 * S, inUs: 100_000, durationUs: 2.9 * S })
    expect(r.project.assets.map((a) => a.id)).toEqual(['v', 'n1'])
    expect(validateProject(r.project)).toEqual([])
  })

  it('reusa a faixa "Narração" livre no trecho; ocupada ou bloqueada → "Narração 2"', () => {
    let r = placeNarration(base(), narr('n1'), { startUs: 0, inUs: 0 })
    const first = r.trackId
    r = placeNarration(r.project, narr('n2'), { startUs: 5 * S, inUs: 0 })
    expect(r.trackId).toBe(first)
    r = placeNarration(r.project, narr('n3'), { startUs: 6 * S, inUs: 0 })
    expect(ops.findItem(r.project, r.itemId)!.track).toMatchObject({ name: 'Narração 2', role: 'voice' })
    const locked = ops.updateTrack(r.project, first, { locked: true })
    const r4 = placeNarration(ops.updateTrack(locked, r.trackId, { locked: true }), narr('n4'), { startUs: 20 * S, inUs: 0 })
    expect(ops.findItem(r4.project, r4.itemId)!.track.name).toBe('Narração 3')
  })

  it('não usa a faixa de voz da gravação nem a de música (só faixas "Narração")', () => {
    let p = base()
    p = ops.updateTrack(p, p.tracks[1].id, { role: 'voice' })
    const r = placeNarration(p, narr('n1'), { startUs: 30 * S, inUs: 0 })
    expect(ops.findItem(r.project, r.itemId)!.track.name).toBe('Narração')
  })

  it('o corte do início nunca deixa o item menor que um quadro; sem duração conhecida é erro', () => {
    const r = placeNarration(base(), narr('n1', 50_000), { startUs: 0, inUs: 40_000 })
    expect(ops.findItem(r.project, r.itemId)!.item.durationUs).toBeGreaterThanOrEqual(MIN_ITEM_US)
    expect(() => placeNarration(base(), narr('n2', 10_000), { startUs: 0, inUs: 0 })).toThrow(ops.EditError)
    expect(() => placeNarration(base(), { ...narr('n3'), durationUs: null }, { startUs: 0, inUs: 0 })).toThrow(ops.EditError)
  })
})

describe('narrationAssetName', () => {
  it('número do arquivo', () => {
    expect(narrationAssetName('generated/narracao-3.m4a')).toBe('Narração 3')
    expect(narrationAssetName('generated/narracao-12.webm')).toBe('Narração 12')
    expect(narrationAssetName('generated/outro.m4a')).toBe('Narração')
  })
})

describe('micProcessingWarning', () => {
  const off = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  it('tudo desligado ou sem microfone: sem aviso', () => {
    expect(micProcessingWarning(off)).toBeNull()
    expect(micProcessingWarning(null)).toBeNull()
  })
  it('lista o que ficou ligado', () => {
    expect(micProcessingWarning({ ...off, noiseSuppression: true })).toContain('manteve redução de ruído neste microfone')
    expect(micProcessingWarning({ ...off, noiseSuppression: true, autoGainControl: true })).toContain('redução de ruído e ganho automático')
    expect(micProcessingWarning({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })).toContain('redução de ruído, ganho automático e cancelamento de eco')
  })
})
