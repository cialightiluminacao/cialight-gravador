import { describe, expect, it } from 'vitest'
import { audioPipeArgs, gifCapturePipeArgs, gifPaletteArgs, gifPaletteUseArgs, pipeExtension, validatePipeSpec } from './pipeSpec'

const gif = { kind: 'gif', width: 480, height: 270, fps: 12, loop: true } as const

describe('validatePipeSpec', () => {
  it('aceita GIF e áudio válidos (kbps padrão 192 em mp3/m4a)', () => {
    expect(validatePipeSpec(gif)).toEqual(gif)
    expect(validatePipeSpec({ kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2 })).toEqual({ kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2 })
    expect(validatePipeSpec({ kind: 'audio', format: 'mp3', sampleRate: 48000, channels: 2 })).toEqual({ kind: 'audio', format: 'mp3', sampleRate: 48000, channels: 2, kbps: 192 })
    expect(validatePipeSpec({ kind: 'audio', format: 'm4a', sampleRate: 48000, channels: 2, kbps: 256 })).toEqual({ kind: 'audio', format: 'm4a', sampleRate: 48000, channels: 2, kbps: 256 })
  })

  it('descarta campos desconhecidos (nada de argumentos crus do renderer)', () => {
    expect(validatePipeSpec({ ...gif, args: ['-f', 'null'] })).toEqual(gif)
    expect(validatePipeSpec({ kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2, kbps: 999, extra: '-i x' })).toEqual({ kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2 })
  })

  it.each([
    ['nulo', null],
    ['tipo desconhecido', { kind: 'x264', width: 2, height: 2 }],
    ['largura ímpar', { ...gif, width: 481 }],
    ['altura zero', { ...gif, height: 0 }],
    ['largura acima de 4096', { ...gif, width: 4098 }],
    ['largura como texto', { ...gif, width: '480' }],
    ['fps fracionário', { ...gif, fps: 12.5 }],
    ['fps 0', { ...gif, fps: 0 }],
    ['fps acima de 30', { ...gif, fps: 60 }],
    ['sem loop', { ...gif, loop: false }],
    ['formato de áudio desconhecido', { kind: 'audio', format: 'flac', sampleRate: 48000, channels: 2 }],
    ['taxa de amostragem diferente', { kind: 'audio', format: 'wav', sampleRate: 44100, channels: 2 }],
    ['mono', { kind: 'audio', format: 'wav', sampleRate: 48000, channels: 1 }],
    ['kbps fora da faixa', { kind: 'audio', format: 'mp3', sampleRate: 48000, channels: 2, kbps: 32 }],
    ['kbps não inteiro', { kind: 'audio', format: 'm4a', sampleRate: 48000, channels: 2, kbps: 192.5 }]
  ])('recusa %s', (_n, spec) => {
    expect(() => validatePipeSpec(spec)).toThrow('Formato de exportação inválido')
  })
})

describe('argumentos do ffmpeg', () => {
  it('extensão pelo formato', () => {
    expect(pipeExtension(gif)).toBe('gif')
    expect(pipeExtension({ kind: 'audio', format: 'm4a', sampleRate: 48000, channels: 2 })).toBe('m4a')
  })

  it('GIF, passada 1: RGBA cru do stdin → FFV1 sem perdas (temporário)', () => {
    expect(gifCapturePipeArgs(gif, 'C:/s/x.gif.ffv1.part')).toEqual([
      '-hide_banner', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '480x270', '-framerate', '12', '-i', 'pipe:0',
      '-an', '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-f', 'matroska', '-progress', 'pipe:1', '-nostats', 'C:/s/x.gif.ffv1.part'
    ])
  })

  it('GIF, passada 2: palettegen (stats_mode=diff) → paleta PNG temporária', () => {
    expect(gifPaletteArgs('C:/s/x.gif.ffv1.part', 'C:/s/x.gif.palette.part')).toEqual([
      '-hide_banner', '-nostdin', '-y', '-i', 'C:/s/x.gif.ffv1.part', '-vf', 'palettegen=stats_mode=diff', '-frames:v', '1', '-update', '1',
      '-c:v', 'png', '-f', 'image2', '-progress', 'pipe:1', '-nostats', 'C:/s/x.gif.palette.part'
    ])
  })

  it('GIF, passada 3: paletteuse (sierra2_4a, diff_mode=rectangle), loop infinito → .gif.part', () => {
    expect(gifPaletteUseArgs('C:/s/x.gif.ffv1.part', 'C:/s/x.gif.palette.part', 'C:/s/x.gif.part')).toEqual([
      '-hide_banner', '-nostdin', '-y', '-i', 'C:/s/x.gif.ffv1.part', '-i', 'C:/s/x.gif.palette.part',
      '-lavfi', '[0:v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle', '-loop', '0', '-f', 'gif', '-progress', 'pipe:1', '-nostats', 'C:/s/x.gif.part'
    ])
  })

  const pcmIn = ['-hide_banner', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-vn']
  const tail = (out: string): string[] => ['-progress', 'pipe:1', '-nostats', out]
  it('WAV: PCM 16 bits 48 kHz', () => {
    expect(audioPipeArgs({ kind: 'audio', format: 'wav', sampleRate: 48000, channels: 2 }, 'o.wav.part')).toEqual([...pcmIn, '-c:a', 'pcm_s16le', '-f', 'wav', ...tail('o.wav.part')])
  })
  it('MP3: LAME 192 kbps', () => {
    expect(audioPipeArgs({ kind: 'audio', format: 'mp3', sampleRate: 48000, channels: 2, kbps: 192 }, 'o.mp3.part')).toEqual([...pcmIn, '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', ...tail('o.mp3.part')])
  })
  it('M4A: AAC 192 kbps com faststart', () => {
    expect(audioPipeArgs({ kind: 'audio', format: 'm4a', sampleRate: 48000, channels: 2, kbps: 192 }, 'o.m4a.part')).toEqual([
      ...pcmIn, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'ipod', ...tail('o.m4a.part')
    ])
  })
})
