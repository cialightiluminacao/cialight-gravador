import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import { addAsset, addMediaFromAsset } from '@shared/editor/ops'
import type { Asset, Project } from '@shared/editor/project'
import {
  audioBlocks,
  audioEstimateBytes,
  audioFrameCount,
  audioOnlyBlocker,
  audioPipeSpec,
  gifDiskBytes,
  gifEstimateBytes,
  gifPipeSpec,
  gifSize,
  gifWidthOptions,
  stillFileName,
  validateGif,
  GIF_MAX_US
} from './formatPlan'
import { outputFileName } from './exportPresets'
import { frameCount } from './exportPlan'

const HD = { width: 1920, height: 1080 }

describe('GIF', () => {
  it('larguras 320/480/640, nunca acima da do projeto', () => {
    expect(gifWidthOptions(HD)).toEqual([320, 480, 640])
    expect(gifWidthOptions({ width: 500, height: 500 })).toEqual([320, 480])
    expect(gifWidthOptions({ width: 300, height: 200 })).toEqual([300])
    expect(gifWidthOptions({ width: 301, height: 200 })).toEqual([300])
  })

  it('altura pela proporção do projeto, par', () => {
    expect(gifSize(480, HD)).toEqual({ width: 480, height: 270 })
    expect(gifSize(320, HD)).toEqual({ width: 320, height: 180 })
    expect(gifSize(640, { width: 1080, height: 1920 })).toEqual({ width: 640, height: 1138 })
    expect(gifSize(480, { width: 1000, height: 333 })).toEqual({ width: 480, height: 160 })
    // pedido acima da largura do projeto: fica na do projeto
    expect(gifSize(640, { width: 500, height: 500 })).toEqual({ width: 500, height: 500 })
  })

  it('estimativa aproximada = w·h·fps·duração·0,08 bytes', () => {
    expect(gifEstimateBytes(480, 270, 12, 4_000_000)).toBe(Math.round(480 * 270 * 12 * 4 * 0.08))
    expect(gifEstimateBytes(480, 270, 12, 0)).toBe(0)
  })

  it('espaço em disco inclui o temporário sem perdas (quadros RGBA)', () => {
    const frames = frameCount(1_000_000, 5_000_000, 12)
    expect(gifDiskBytes(480, 270, 12, 1_000_000, 5_000_000)).toBe(frames * 480 * 270 * 4 + gifEstimateBytes(480, 270, 12, 4_000_000))
  })

  it('limite de 30 s (bloqueio), aviso acima de 15 MB, vazio bloqueia', () => {
    expect(validateGif(480, 270, 12, GIF_MAX_US)).toEqual({ blocker: null, warnings: [] })
    expect(validateGif(480, 270, 12, GIF_MAX_US + 1).blocker).toBe('GIF limitado a 30 s — use I/O para escolher um trecho')
    expect(validateGif(480, 270, 12, 0).blocker).toBe('A linha do tempo está vazia.')
    // 640×360×15×30 s×0,08 ≈ 7,9 MB: sem aviso; vertical 640×1138 ≈ 25 MB: aviso
    expect(validateGif(640, 360, 15, 30_000_000).warnings).toEqual([])
    const big = validateGif(640, 1138, 15, 30_000_000)
    expect(big.blocker).toBeNull()
    expect(big.warnings).toEqual([expect.stringMatching(/^GIF grande: cerca de 25(,\d)? MB \(estimativa aproximada\)/)])
  })

  it('pedido do pipe', () => {
    expect(gifPipeSpec(480, 270, 12)).toEqual({ kind: 'gif', width: 480, height: 270, fps: 12, loop: true })
  })
})

describe('só áudio', () => {
  it('quadros totais = round(duração·48 kHz) — exato', () => {
    expect(audioFrameCount(1_000_000, 5_000_000)).toBe(192_000)
    expect(audioFrameCount(0, 1_000_010)).toBe(48_000)
    expect(audioFrameCount(0, 1_000_011)).toBe(48_001)
    expect(audioFrameCount(5, 5)).toBe(0)
  })

  it('blocos de 100 ms a partir do início do trecho, o último encurtado (mesma grade da exportação de vídeo)', () => {
    const b = audioBlocks(1_000_000, 1_250_000)
    expect(b).toEqual([
      { fromUs: 1_000_000, frames: 4800 },
      { fromUs: 1_100_000, frames: 4800 },
      { fromUs: 1_200_000, frames: 2400 }
    ])
    const long = audioBlocks(1_000_000, 5_000_000)
    expect(long).toHaveLength(40)
    expect(long.reduce((s, x) => s + x.frames, 0)).toBe(192_000)
    expect(audioBlocks(0, 1_000_011).map((x) => x.frames).reduce((s, f) => s + f, 0)).toBe(48_001)
  })

  it('estimativa: WAV = 4 bytes por quadro + cabeçalho; mp3/m4a pela taxa', () => {
    expect(audioEstimateBytes('wav', 4_000_000)).toBe(192_000 * 4 + 44)
    expect(audioEstimateBytes('mp3', 4_000_000)).toBe(96_000)
    expect(audioEstimateBytes('m4a', 4_000_000)).toBe(96_000)
  })

  it('pedido do pipe: wav sem taxa; mp3/m4a a 192 kbps', () => {
    expect(audioPipeSpec('wav')).toEqual({ kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2 })
    expect(audioPipeSpec('mp3')).toEqual({ kind: 'audio', format: 'mp3', sampleRate: 48000, channels: 2, kbps: 192 })
    expect(audioPipeSpec('m4a')).toEqual({ kind: 'audio', format: 'm4a', sampleRate: 48000, channels: 2, kbps: 192 })
  })

  it('bloqueio sem áudio audível', () => {
    const empty = createEmptyProject('x', { width: 1920, height: 1080, fps: 30, background: '#000000' })
    expect(audioOnlyBlocker(empty)).toBe('Não há áudio para exportar')
    const a: Asset = {
      id: 'a1', name: 'tom.m4a', kind: 'audio', source: { type: 'file', path: 'C:/x/tom.m4a', size: 1, mtimeMs: 1 }, durationUs: 2_000_000,
      audio: { channels: 2, sampleRate: 48000, codec: 'aac' }, status: 'ready'
    } as Asset
    const withAudio: Project = addMediaFromAsset(addAsset(empty, a), a.id, 0).project
    expect(audioOnlyBlocker(withAudio)).toBeNull()
    const muted: Project = { ...withAudio, tracks: withAudio.tracks.map((t) => (t.kind === 'audio' ? { ...t, muted: true } : t)) }
    expect(audioOnlyBlocker(muted)).toBe('Não há áudio para exportar')
  })
})

describe('quadro PNG', () => {
  it('nome padrão "<projeto> - 00m12s.png"', () => {
    expect(stillFileName('Aula 1', 12_400_000)).toBe('Aula 1 - 00m12s.png')
    expect(stillFileName('Aula 1', 0)).toBe('Aula 1 - 00m00s.png')
    expect(stillFileName('Aula 1', 125_999_999)).toBe('Aula 1 - 02m05s.png')
    expect(stillFileName('Aula: 1/2', 3_723_000_000)).toBe('Aula- 1-2 - 1h02m03s.png')
    expect(stillFileName('   ', 1_000_000)).toBe('Vídeo - 00m01s.png')
  })
})

describe('outputFileName com os novos formatos', () => {
  it('troca a extensão de mídia pela do formato', () => {
    expect(outputFileName('Aula.mp4', 'gif')).toBe('Aula.gif')
    expect(outputFileName('Aula.gif', 'png')).toBe('Aula.png')
    expect(outputFileName('Aula', 'm4a')).toBe('Aula.m4a')
    expect(outputFileName('Aula.wav', 'mp3')).toBe('Aula.mp3')
  })
})
