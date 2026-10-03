import { describe, expect, it } from 'vitest'
import { audioPipeArgs, fpsRational, gifCapturePipeArgs, gifPaletteArgs, gifPaletteUseArgs, pipeExtension, validatePipeSpec, x264PipeArgs } from './pipeSpec'

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

describe('fallback libx264 (x264)', () => {
  const x264 = { kind: 'x264', width: 1920, height: 1080, fps: 30, videoBitrate: 12_000_000, keyFrameInterval: 60, audio: { kbps: 128, samples: 192_000 } } as const

  it('aceita o pedido e descarta campos desconhecidos', () => {
    expect(validatePipeSpec(x264)).toEqual(x264)
    expect(validatePipeSpec({ ...x264, args: ['-f', 'null'], audio: { ...x264.audio, codec: 'flac' } })).toEqual(x264)
    expect(validatePipeSpec({ ...x264, audio: null })).toEqual({ ...x264, audio: null })
    expect(validatePipeSpec({ ...x264, fps: 29.97 })).toEqual({ ...x264, fps: 29.97 })
  })

  it.each([
    ['largura ímpar', { ...x264, width: 1919 }],
    ['altura acima de 4096', { ...x264, height: 4098 }],
    ['fps 0', { ...x264, fps: 0 }],
    ['fps acima de 240', { ...x264, fps: 241 }],
    ['bitrate abaixo do mínimo', { ...x264, videoBitrate: 50_000 }],
    ['bitrate fracionário', { ...x264, videoBitrate: 1_000_000.5 }],
    ['bitrate acima de 200 Mbps', { ...x264, videoBitrate: 300_000_000 }],
    ['GOP 0', { ...x264, keyFrameInterval: 0 }],
    ['GOP fracionário', { ...x264, keyFrameInterval: 1.5 }],
    ['sem campo de áudio', { ...x264, audio: undefined }],
    ['kbps de áudio fora da faixa', { ...x264, audio: { kbps: 16, samples: 10 } }],
    ['amostras de áudio 0', { ...x264, audio: { kbps: 128, samples: 0 } }],
    ['amostras fracionárias', { ...x264, audio: { kbps: 128, samples: 1.5 } }]
  ])('recusa %s', (_n, spec) => {
    expect(() => validatePipeSpec(spec)).toThrow('Formato de exportação inválido')
  })

  it('extensão mp4', () => {
    expect(pipeExtension(x264)).toBe('mp4')
  })

  it('taxa de quadros racional: inteira, NTSC (×1000/1001) e decimal', () => {
    expect(fpsRational(30)).toBe('30/1')
    expect(fpsRational(60)).toBe('60/1')
    expect(fpsRational(29.97)).toBe('30000/1001')
    expect(fpsRational(30000 / 1001)).toBe('30000/1001')
    expect(fpsRational(23.976)).toBe('24000/1001')
    expect(fpsRational(59.94)).toBe('60000/1001')
    expect(fpsRational(12.5)).toBe('25/2')
  })

  it('argumentos exatos: RGBA do stdin + PCM temporário → H.264 High yuv420p BT.709 limitado, AAC, faststart', () => {
    expect(x264PipeArgs(x264, 'C:/s/v.mp4.part', 'C:/s/v.mp4.audio.part')).toEqual([
      '-hide_banner', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1920x1080', '-framerate', '30/1', '-i', 'pipe:0',
      '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'C:/s/v.mp4.audio.part',
      '-map', '0:v', '-map', '1:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-b:v', '12000000', '-maxrate', '18000000', '-bufsize', '24000000', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', 'C:/s/v.mp4.part'
    ])
  })

  it('sem áudio: só o vídeo (-an), NTSC racional', () => {
    const args = x264PipeArgs({ ...x264, width: 1280, height: 720, fps: 29.97, videoBitrate: 1_000_001, keyFrameInterval: 60, audio: null }, 'o.mp4.part', null)
    expect(args).toEqual([
      '-hide_banner', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1280x720', '-framerate', '30000/1001', '-i', 'pipe:0',
      '-map', '0:v',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-b:v', '1000001', '-maxrate', '1500002', '-bufsize', '2000002', '-g', '60',
      '-an',
      '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', 'o.mp4.part'
    ])
  })
})
