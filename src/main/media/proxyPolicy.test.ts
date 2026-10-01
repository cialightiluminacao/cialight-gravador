import { describe, expect, it } from 'vitest'
import { derivedComplete, intermediateArgs, needsProxy, proxyArgs } from './proxyPolicy'
import type { Asset } from '@shared/editor/project'
import type { MediaInfo } from './probe'

function video(over: Partial<NonNullable<MediaInfo['video']>> = {}, rest: Partial<MediaInfo> = {}): MediaInfo {
  return {
    durationUs: 6_000_000,
    kind: 'video',
    video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 0, gopUs: 1_000_000, ...over },
    audio: { channels: 2, sampleRate: 48000, codec: 'aac' },
    vfr: false,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    ...rest
  }
}

const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('needsProxy', () => {
  it('gravação do app (H.264, GOP 1 s, 1080p, CFR) não precisa de nada', () => {
    expect(needsProxy(video(), true)).toEqual({ proxy: false, intermediate: false, reasons: [] })
  })
  it('não decodificável → intermediário, sem proxy separado', () => {
    expect(needsProxy(video({ codec: 'hevc' }), false)).toEqual({ proxy: false, intermediate: true, reasons: ['undecodable'] })
  })
  it('não decodificável e 4K: ainda só o intermediário', () => {
    const r = needsProxy(video({ codec: 'hevc', width: 3840, height: 2160 }), false)
    expect(r).toEqual({ proxy: false, intermediate: true, reasons: ['undecodable', 'highRes'] })
  })
  it('GOP > 2 s → proxy', () => {
    expect(needsProxy(video({ gopUs: 10_000_000 }), true)).toEqual({ proxy: true, intermediate: false, reasons: ['longGop'] })
    expect(needsProxy(video({ gopUs: 2_000_000 }), true).proxy).toBe(false)
  })
  it('altura > 1440 → proxy', () => {
    expect(needsProxy(video({ width: 3840, height: 2160 }), true)).toEqual({ proxy: true, intermediate: false, reasons: ['highRes'] })
    expect(needsProxy(video({ width: 2560, height: 1440 }), true).proxy).toBe(false)
  })
  it('VFR → proxy', () => {
    expect(needsProxy(video({}, { vfr: true }), true)).toEqual({ proxy: true, intermediate: false, reasons: ['vfr'] })
  })
  it('áudio e imagem nunca precisam', () => {
    expect(needsProxy({ durationUs: 1, kind: 'audio', audio: { channels: 2, sampleRate: 44100, codec: 'mp3' }, vfr: false, formatName: 'mp3' }, false).proxy).toBe(false)
    expect(needsProxy(video({ codec: 'png' }, { kind: 'image', durationUs: null }), true)).toEqual({ proxy: false, intermediate: false, reasons: [] })
  })
})

describe('proxyArgs', () => {
  it('30 fps: -g 15, -bf 0, 720p, yuv420p, AAC 128k, faststart', () => {
    const a = proxyArgs('in.mp4', 'out.mp4', video({ gopUs: 10_000_000 }), 'libx264')
    expect(valueAfter(a, '-g')).toBe('15')
    expect(valueAfter(a, '-bf')).toBe('0')
    expect(valueAfter(a, '-vf')).toContain('scale=-2:720')
    expect(valueAfter(a, '-pix_fmt')).toBe('yuv420p')
    expect(valueAfter(a, '-c:a')).toBe('aac')
    expect(valueAfter(a, '-b:a')).toBe('128k')
    expect(valueAfter(a, '-movflags')).toBe('+faststart')
    expect(a).not.toContain('-fps_mode')
    expect(a[a.length - 1]).toBe('out.mp4')
    expect(valueAfter(a, '-i')).toBe('in.mp4')
  })
  it('60 fps → -g 30; VFR → -fps_mode cfr com -r', () => {
    const a = proxyArgs('in.mp4', 'out.mp4', video({ fps: 59.94 }, { vfr: true }), 'libx264')
    expect(valueAfter(a, '-g')).toBe('30')
    expect(valueAfter(a, '-fps_mode')).toBe('cfr')
    expect(valueAfter(a, '-r')).toBe('59.94')
  })
  it('fonte menor que 720 não é ampliada', () => {
    const a = proxyArgs('in.mp4', 'out.mp4', video({ width: 854, height: 480 }, { vfr: true }), 'libx264')
    expect(valueAfter(a, '-vf')).toContain('scale=-2:480')
  })
  it('rotação 90/270: o lado curto (largura após autorotate) vira 720', () => {
    const a = proxyArgs('in.mp4', 'out.mp4', video({ width: 3840, height: 2160, rotation: 90 }), 'libx264')
    expect(valueAfter(a, '-vf')).toContain('scale=720:-2')
  })
  it('sem áudio → -an', () => {
    const a = proxyArgs('in.mp4', 'out.mp4', video({}, { audio: undefined }), 'libx264')
    expect(a).toContain('-an')
    expect(a).not.toContain('-c:a')
  })
  it('encoder de hardware usado quando informado', () => {
    expect(valueAfter(proxyArgs('i', 'o', video(), 'h264_nvenc'), '-c:v')).toBe('h264_nvenc')
    expect(valueAfter(proxyArgs('i', 'o', video(), 'h264_qsv'), '-c:v')).toBe('h264_qsv')
  })
})

describe('intermediateArgs', () => {
  it('mesma resolução, -crf 18 (libx264), GOP 1 s', () => {
    const a = intermediateArgs('in.mov', 'out.mp4', video({ codec: 'hevc', width: 3840, height: 2160 }), 'libx264')
    expect(valueAfter(a, '-crf')).toBe('18')
    expect(valueAfter(a, '-g')).toBe('30')
    expect(a.join(' ')).not.toContain('scale=')
    expect(valueAfter(a, '-pix_fmt')).toBe('yuv420p')
  })
  it('nvenc usa -cq 19', () => {
    const a = intermediateArgs('in.mov', 'out.mp4', video({ codec: 'hevc' }), 'h264_nvenc')
    expect(valueAfter(a, '-cq')).toBe('19')
    expect(valueAfter(a, '-c:v')).toBe('h264_nvenc')
  })
})

describe('derivedComplete', () => {
  const base: Asset = {
    id: 'a', name: 'a', kind: 'video', source: { type: 'file', path: 'x', size: 1, mtimeMs: 1 }, durationUs: 6_000_000, status: 'ready',
    video: { width: 1920, height: 1080, fps: 30, codec: 'h264', rotation: 0, decodable: true, gopUs: 1_000_000 },
    audio: { channels: 2, sampleRate: 48000, codec: 'aac' }
  }
  it('vídeo sem proxy necessário: filmstrip + peaks bastam', () => {
    expect(derivedComplete({ ...base, filmstrip: 'f', peaks: 'p' })).toBe(true)
    expect(derivedComplete({ ...base, filmstrip: 'f' })).toBe(false)
    expect(derivedComplete({ ...base, peaks: 'p' })).toBe(false)
    expect(derivedComplete({ ...base, audio: undefined, filmstrip: 'f' })).toBe(true)
  })
  it('GOP longo exige proxy; não decodificável exige intermediário', () => {
    const long = { ...base, filmstrip: 'f', peaks: 'p', video: { ...base.video!, gopUs: 10_000_000 } }
    expect(derivedComplete(long)).toBe(false)
    expect(derivedComplete({ ...long, proxy: 'x' })).toBe(true)
    const undec = { ...base, filmstrip: 'f', peaks: 'p', video: { ...base.video!, decodable: false } }
    expect(derivedComplete(undec)).toBe(false)
    expect(derivedComplete({ ...undec, intermediate: 'i' })).toBe(true)
  })
  it('áudio precisa de peaks; imagem sempre completa', () => {
    expect(derivedComplete({ ...base, kind: 'audio', video: undefined })).toBe(false)
    expect(derivedComplete({ ...base, kind: 'audio', video: undefined, peaks: 'p' })).toBe(true)
    expect(derivedComplete({ ...base, kind: 'image', durationUs: null })).toBe(true)
  })
})
