import { describe, expect, it } from 'vitest'
import { averageGopUs, parseFfprobe } from './probe'

// Saídas reais de `ffprobe -v error -print_format json -show_format -show_streams`, reduzidas.
const phone = {
  streams: [
    {
      index: 0, codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080,
      r_frame_rate: '60/1', avg_frame_rate: '2997000/100649', duration: '10.066667',
      side_data_list: [{ side_data_type: 'Display Matrix', displaymatrix: '\n00000000:            0       65536           0\n', rotation: -90 }]
    },
    { index: 1, codec_name: 'aac', codec_type: 'audio', sample_rate: '48000', channels: 2, r_frame_rate: '0/0', avg_frame_rate: '0/0', duration: '10.048000' }
  ],
  format: { filename: 'C:\\v\\VID_20260901.mp4', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.066667' }
}

const mp3 = {
  streams: [
    { index: 0, codec_name: 'mp3', codec_type: 'audio', sample_rate: '44100', channels: 2, r_frame_rate: '0/0', avg_frame_rate: '0/0', duration: '6.024000' },
    // capa embutida: não é vídeo
    { index: 1, codec_name: 'mjpeg', codec_type: 'video', width: 500, height: 500, r_frame_rate: '90000/1', avg_frame_rate: '0/0', disposition: { attached_pic: 1 } }
  ],
  format: { format_name: 'mp3', duration: '6.024000' }
}

const png = {
  streams: [{ index: 0, codec_name: 'png', codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '25/1', avg_frame_rate: '25/1' }],
  format: { format_name: 'png_pipe' }
}

describe('parseFfprobe', () => {
  it('celular H.264: displaymatrix −90 → rotation 90, VFR, duração', () => {
    const i = parseFfprobe(phone, 'C:\\v\\VID_20260901.mp4')
    expect(i.kind).toBe('video')
    expect(i.durationUs).toBe(10_066_667)
    expect(i.video).toMatchObject({ width: 1920, height: 1080, codec: 'h264', rotation: 90 })
    expect(i.video!.fps).toBeCloseTo(29.776, 2)
    expect(i.vfr).toBe(true)
    expect(i.audio).toEqual({ channels: 2, sampleRate: 48000, codec: 'aac' })
    expect(i.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2')
  })

  it('cor declarada da faixa de vídeo (sem marcação → campos nulos)', () => {
    const j = structuredClone(phone) as { streams: Record<string, unknown>[] }
    Object.assign(j.streams[0], { color_space: 'smpte170m', color_primaries: 'smpte170m', color_transfer: 'smpte170m', color_range: 'tv' })
    expect(parseFfprobe(j, 'a.mp4').color).toEqual({ space: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', range: 'tv' })
    expect(parseFfprobe(phone, 'a.mp4').color).toEqual({ space: null, primaries: null, transfer: null, range: null })
  })

  it('tags.rotate é usado quando não há displaymatrix', () => {
    const j = structuredClone(phone) as { streams: Record<string, unknown>[] }
    delete j.streams[0].side_data_list
    j.streams[0].tags = { rotate: '270' }
    j.streams[0].avg_frame_rate = '30/1'
    j.streams[0].r_frame_rate = '30/1'
    const i = parseFfprobe(j, 'a.mp4')
    expect(i.video!.rotation).toBe(270)
    expect(i.vfr).toBe(false)
  })

  it('mp3 com capa → áudio sem vídeo', () => {
    const i = parseFfprobe(mp3, 'C:\\m\\musica.mp3')
    expect(i.kind).toBe('audio')
    expect(i.video).toBeUndefined()
    expect(i.durationUs).toBe(6_024_000)
    expect(i.audio).toEqual({ channels: 2, sampleRate: 44100, codec: 'mp3' })
    expect(i.vfr).toBe(false)
  })

  it('png → imagem sem duração', () => {
    const i = parseFfprobe(png, 'C:\\img\\Logo.PNG')
    expect(i.kind).toBe('image')
    expect(i.durationUs).toBeNull()
    expect(i.video).toMatchObject({ width: 1920, height: 1080, codec: 'png', rotation: 0 })
    expect(i.audio).toBeUndefined()
  })

  it('sem stream reconhecível lança', () => {
    expect(() => parseFfprobe({ streams: [], format: {} }, 'x.mp4')).toThrow()
  })
})

describe('averageGopUs', () => {
  it('média dos intervalos entre keyframes', () => {
    expect(averageGopUs([0, 2, 4, 6])).toBe(2_000_000)
    expect(averageGopUs([0, 0.5, 1.0])).toBe(500_000)
  })
  it('um único keyframe → 10 s', () => {
    expect(averageGopUs([0])).toBe(10_000_000)
    expect(averageGopUs([])).toBe(10_000_000)
  })
})
