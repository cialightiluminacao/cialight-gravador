import { describe, expect, it } from 'vitest'
import { estimateBytes, exportMediaIssues, exportRange, frameCount, missingMediaWarnings, outputSize, presetVideoBitrate, resizeBitrate, targetBitrate, WHATSAPP_MAX_BPS } from './exportPlan'
import { addAsset, addMediaFromAsset, updateTrack } from '@shared/editor/ops'
import { createEmptyProject } from '@shared/editor/factory'
import type { Asset, Project } from '@shared/editor/project'

const MiB = 1024 * 1024

describe('targetBitrate', () => {
  it('64 MB em 60 s com áudio de 128 kbps e margem de 4 %', () => {
    // 64·1 048 576·8·0,96 / 60 − 128 000
    expect(targetBitrate(64, 60_000_000, 128)).toBe(Math.floor((64 * MiB * 8 * 0.96) / 60 - 128_000))
    expect(targetBitrate(64, 60_000_000, 128)).toBe(8_461_934)
  })
  it('vídeo + áudio cabem no alvo com a margem', () => {
    const dur = 300_000_000
    const v = targetBitrate(64, dur, 128)
    expect(estimateBytes(v, 128_000, dur)).toBeLessThanOrEqual(64 * MiB * 0.96)
    expect(estimateBytes(v, 128_000, dur)).toBeGreaterThan(64 * MiB * 0.95)
  })
  it('nunca abaixo do piso (vídeo longo demais) nem com duração inválida', () => {
    expect(targetBitrate(64, 10 * 3600 * 1e6, 128)).toBe(100_000)
    expect(targetBitrate(64, 0, 128)).toBe(100_000)
  })
})

describe('frameCount', () => {
  it('ceil da duração em quadros', () => {
    expect(frameCount(0, 7_000_000, 30)).toBe(210)
    expect(frameCount(2_000_000, 9_000_000, 30)).toBe(210)
    expect(frameCount(0, 7_010_000, 30)).toBe(211)
    expect(frameCount(0, 1, 30)).toBe(1)
    expect(frameCount(0, 0, 30)).toBe(0)
    expect(frameCount(5, 3, 30)).toBe(0)
  })
  it('tolera o arredondamento de frameToUs (91 quadros = 3 033 333 µs)', () => {
    expect(frameCount(0, 3_033_333, 30)).toBe(91)
    expect(frameCount(0, 3_033_334, 30)).toBe(91)
    expect(frameCount(0, 10_010_000, 29.97)).toBe(300)
  })
})

describe('outputSize', () => {
  const c = (width: number, height: number): { width: number; height: number } => ({ width, height })
  it('Alta 1080p e WhatsApp cabem na caixa mantendo a proporção (pares)', () => {
    expect(outputSize('high1080', c(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('high1080', c(1280, 720))).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('high1080', c(1080, 1920))).toEqual({ width: 1080, height: 1920 })
    expect(outputSize('high1080', c(1080, 1080))).toEqual({ width: 1080, height: 1080 })
    expect(outputSize('whatsapp', c(1920, 1080))).toEqual({ width: 1280, height: 720 })
    expect(outputSize('whatsapp', c(1080, 1350))).toEqual({ width: 720, height: 900 })
  })
  it('Original: resolução do projeto (par)', () => {
    expect(outputSize('original', c(2560, 1440))).toEqual({ width: 2560, height: 1440 })
    expect(outputSize('original', c(1001, 777))).toEqual({ width: 1002, height: 778 })
  })
  it('Vertical 9:16: 1080×1920 só para projeto 9:16', () => {
    expect(outputSize('vertical', c(720, 1280))).toEqual({ width: 1080, height: 1920 })
    expect(outputSize('vertical', c(1920, 1080))).toBeNull()
  })
})

describe('presetVideoBitrate', () => {
  it('Alta: 12 Mbps a 30 fps, 20 Mbps a 60 fps; Original 20 Mbps', () => {
    expect(presetVideoBitrate('high1080', 30, 10_000_000)).toBe(12_000_000)
    expect(presetVideoBitrate('high1080', 60, 10_000_000)).toBe(20_000_000)
    expect(presetVideoBitrate('vertical', 30, 10_000_000)).toBe(12_000_000)
    expect(presetVideoBitrate('original', 30, 10_000_000)).toBe(20_000_000)
  })
  it('WhatsApp: bitrate calculado para 64 MB, limitado em vídeos curtos', () => {
    expect(presetVideoBitrate('whatsapp', 30, 600_000_000)).toBe(targetBitrate(64, 600_000_000, 128))
    expect(presetVideoBitrate('whatsapp', 30, 10_000_000)).toBe(WHATSAPP_MAX_BPS)
  })
})

describe('exportRange', () => {
  it('tudo, ou I–O quando definidos e válidos', () => {
    expect(exportRange(9_000_000, null, null, 'inout')).toEqual({ fromUs: 0, toUs: 9_000_000 })
    expect(exportRange(9_000_000, 1_000_000, 4_000_000, 'all')).toEqual({ fromUs: 0, toUs: 9_000_000 })
    expect(exportRange(9_000_000, 1_000_000, 4_000_000, 'inout')).toEqual({ fromUs: 1_000_000, toUs: 4_000_000 })
    expect(exportRange(9_000_000, 1_000_000, null, 'inout')).toEqual({ fromUs: 1_000_000, toUs: 9_000_000 })
    expect(exportRange(9_000_000, null, 4_000_000, 'inout')).toEqual({ fromUs: 0, toUs: 4_000_000 })
    expect(exportRange(9_000_000, 5_000_000, 4_000_000, 'inout')).toEqual({ fromUs: 0, toUs: 9_000_000 })
  })
})

describe('resizeBitrate', () => {
  it('2ª passada do tamanho-alvo: bitrate × (alvo/obtido) × 0,97, com piso', () => {
    expect(resizeBitrate(8_000_000, 64 * MiB, 80 * MiB)).toBe(Math.floor(8_000_000 * (64 / 80) * 0.97))
    expect(resizeBitrate(8_000_000, 64 * MiB, 80 * MiB)).toBe(6_208_000)
    expect(resizeBitrate(200_000, 1, 1e9)).toBe(100_000)
  })
})

describe('exportMediaIssues (pré-checagem da exportação)', () => {
  const S = 1_000_000
  const asset = (id: string, status: Asset['status'], kind: Asset['kind'] = 'video'): Asset => ({
    id, name: `${id}.mp4`, kind, source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: 4 * S, status,
    ...(kind === 'video' ? { video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 0, decodable: true, gopUs: S } } : {}),
    audio: { channels: 2, sampleRate: 48000, codec: 'aac' }
  })
  function project(): Project {
    let p = createEmptyProject('t')
    for (const a of [asset('ok', 'ready'), asset('gone', 'missing'), asset('busy', 'processing'), asset('bad', 'error'), asset('late', 'missing')]) p = addAsset(p, a)
    p = addMediaFromAsset(p, 'ok', 0).project // 0–4 s
    p = addMediaFromAsset(p, 'gone', 4 * S).project // 4–8 s
    p = addMediaFromAsset(p, 'busy', 8 * S).project // 8–12 s
    p = addMediaFromAsset(p, 'bad', 12 * S).project // 12–16 s
    p = addMediaFromAsset(p, 'late', 16 * S).project // 16–20 s
    return p
  }
  it('lista os assets usados no intervalo que estão ausentes, em processamento ou com erro (uma vez cada)', () => {
    expect(exportMediaIssues(project(), 0, 20 * S).map((i) => [i.assetId, i.status])).toEqual([['gone', 'missing'], ['busy', 'processing'], ['bad', 'error'], ['late', 'missing']])
  })
  it('só o intervalo exportado conta', () => {
    expect(exportMediaIssues(project(), 0, 4 * S)).toEqual([])
    expect(exportMediaIssues(project(), 3 * S, 9 * S).map((i) => i.assetId)).toEqual(['gone', 'busy'])
  })
  it('faixas ocultas/mudas não entram', () => {
    let p = project()
    for (const t of p.tracks) p = updateTrack(p, t.id, t.kind === 'video' ? { hidden: true } : { muted: true })
    expect(exportMediaIssues(p, 0, 20 * S)).toEqual([])
  })
})

describe('missingMediaWarnings', () => {
  it('um aviso por mídia que saiu como "mídia indisponível", com a quantidade de quadros', () => {
    const p = { assets: [{ id: 'a', name: 'tela.mp4' }, { id: 'b', name: 'cam.mp4' }] }
    const w = missingMediaWarnings(p, [{ assetId: 'a', frames: 1 }, { assetId: 'b', frames: 120 }, { assetId: 'x', frames: 3 }])
    expect(w).toHaveLength(3)
    expect(w[0]).toContain('“tela.mp4”')
    expect(w[0]).toContain('1 quadro ')
    expect(w[1]).toContain('120 quadros')
    expect(w[2]).toContain('“x”')
  })
})
