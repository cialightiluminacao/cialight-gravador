import { describe, expect, it } from 'vitest'
import { PRESETS } from './presets'
import { buildFfmpegArgs, type ArgsInput } from './ffmpegArgs'

const REC = 'C:\\Brutos\\2026-08-18T14-32-05\\rec.mp4'
const COMPOSED = 'C:\\Brutos\\2026-08-18T14-32-05\\composed.mp4'
const OUT_DIR = 'C:\\Users\\Eduardo\\Videos\\CiaLight Gravador'
const BASE = 'Gravação 2026-08-18 14-32'
const OUT = `${OUT_DIR}\\${BASE}.mp4`
const HEAD = ['-hide_banner', '-nostdin', '-y']
const TAIL = ['-progress', 'pipe:1', '-nostats']
const AAC = (k: number): string[] => ['-c:a', 'aac', '-b:a', `${k}k`, '-ar', '48000', '-ac', '2']
const AMIX = 'amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95'

function base(over: Partial<ArgsInput> = {}): ArgsInput {
  return {
    preset: PRESETS.high,
    encoder: 'libx264',
    inputVideo: REC,
    inputAudio: REC,
    hasWebcamTrack: false,
    micTrackIdx: 0,
    systemTrackIdx: 1,
    audioMode: 'mix',
    micOffsetMs: 0,
    trimStartMs: 0,
    trimEndMs: null,
    durationMs: 120_000,
    srcWidth: 1920,
    srcHeight: 1080,
    srcFps: 30,
    reels: false,
    targetSizeMB: null,
    outDir: OUT_DIR,
    baseName: BASE,
    ...over
  }
}

describe('buildFfmpegArgs — small (WhatsApp / e-mail)', () => {
  it('libx264 com alvo 64 MB e twoPassKbps → 2 passes em libx264 com -b:v/-maxrate/-bufsize, sem -crf', () => {
    const plan = buildFfmpegArgs(
      base({
        preset: PRESETS.small,
        encoder: 'h264_nvenc', // ignorado: 2-pass é sempre libx264
        srcFps: 60,
        trimStartMs: 1500,
        trimEndMs: 90_000,
        targetSizeMB: 64,
        twoPassKbps: 1200
      })
    )
    const passLog = 'C:\\Brutos\\2026-08-18T14-32-05\\ffmpeg2pass'
    const vf = "[0:v:0]scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,fps=30,format=yuv420p[v]"
    const x264 = [
      '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'slow',
      '-b:v', '1200k', '-maxrate', '1800k', '-bufsize', '3600k',
      '-bf', '0', '-g', '60', '-keyint_min', '60'
    ]
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].label).toBe('pass1')
    expect(plan.steps[0].passLogPrefix).toBe(passLog)
    expect(plan.steps[0].args).toEqual([
      ...HEAD, '-ss', '1.500', '-to', '90.000', '-i', REC,
      '-filter_complex', vf, '-map', '[v]', ...x264,
      '-pass', '1', '-passlogfile', passLog, '-an', ...TAIL, '-f', 'mp4', 'NUL'
    ])
    expect(plan.steps[1].label).toBe('pass2')
    expect(plan.steps[1].outFile).toBe(OUT)
    expect(plan.steps[1].passLogPrefix).toBe(passLog)
    expect(plan.steps[1].args).toEqual([
      ...HEAD, '-ss', '1.500', '-to', '90.000', '-i', REC,
      '-filter_complex', `${vf};[0:a:0][0:a:1]${AMIX}[a]`,
      '-map', '[v]', '-map', '[a]', ...x264, '-pass', '2', '-passlogfile', passLog,
      ...AAC(96), '-movflags', '+faststart', ...TAIL, OUT
    ])
    expect(plan.outputs).toEqual([OUT])
  })

  it('targetHeight 480 (planForTarget) reduz a escala no 2-pass', () => {
    const plan = buildFfmpegArgs(base({ preset: PRESETS.small, targetSizeMB: 20, twoPassKbps: 400, targetHeight: 480 }))
    expect(plan.steps[1].args).toContain(`[0:v:0]scale='min(854,iw)':'min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,format=yuv420p[v];[0:a:0][0:a:1]${AMIX}[a]`)
  })

  it('sem twoPassKbps → um passo em CRF 28 com -maxrate 1500k -bufsize 3000k -bf 0 -g 60', () => {
    const plan = buildFfmpegArgs(base({ preset: PRESETS.small, targetSizeMB: 64 }))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].label).toBe('encode')
    expect(plan.steps[0].passLogPrefix).toBeUndefined()
    expect(plan.steps[0].args).toEqual([
      ...HEAD, '-i', REC,
      '-filter_complex', `[0:v:0]scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,format=yuv420p[v];[0:a:0][0:a:1]${AMIX}[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'slow', '-crf', '28', '-maxrate', '1500k', '-bufsize', '3000k',
      '-bf', '0', '-g', '60', '-keyint_min', '60',
      ...AAC(96), '-movflags', '+faststart', ...TAIL, OUT
    ])
  })

  it('fonte 720p30 não recebe scale nem fps; nvenc usa -cq 30 -bf 0 -profile:v main', () => {
    const args = buildFfmpegArgs(base({ preset: PRESETS.small, srcWidth: 1280, srcHeight: 720, srcFps: 30, encoder: 'h264_nvenc' })).steps[0].args
    expect(args).toContain(`[0:v:0]format=yuv420p[v];[0:a:0][0:a:1]${AMIX}[a]`)
    const i = args.indexOf('-c:v')
    expect(args.slice(i, i + 24)).toEqual([
      '-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '30', '-b:v', '0', '-bf', '0',
      '-b_ref_mode', 'middle', '-spatial-aq', '1', '-temporal-aq', '1', '-profile:v', 'main', '-g', '60'
    ])
  })
})

describe('buildFfmpegArgs — high (YouTube / Drive / Instagram)', () => {
  it('nvenc com composed.mp4 + rec.mp4, mic com offset +250 ms', () => {
    const plan = buildFfmpegArgs(base({ encoder: 'h264_nvenc', inputVideo: COMPOSED, micOffsetMs: 250 }))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].args).toEqual([
      ...HEAD, '-i', COMPOSED, '-i', REC,
      '-filter_complex', `[0:v:0]format=yuv420p[v];[1:a:0]adelay=250:all=1[mic];[mic][1:a:1]${AMIX}[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-bf', '2',
      '-b_ref_mode', 'middle', '-spatial-aq', '1', '-temporal-aq', '1', '-profile:v', 'high', '-g', '15',
      ...AAC(192), '-movflags', '+faststart', ...TAIL, OUT
    ])
  })

  it('corte com duas entradas aplica -ss/-to antes de cada -i', () => {
    const plan = buildFfmpegArgs(base({ inputVideo: COMPOSED, trimStartMs: 2000, trimEndMs: 62_000 }))
    expect(plan.steps[0].args.slice(0, 15)).toEqual([
      ...HEAD, '-ss', '2.000', '-to', '62.000', '-i', COMPOSED, '-ss', '2.000', '-to', '62.000', '-i', REC
    ])
  })

  it('libx264 a 60 fps: -crf 20 -bf 2 -g 30 -keyint_min 30 -flags +cgop', () => {
    const plan = buildFfmpegArgs(base({ srcFps: 60 }))
    expect(plan.steps[0].args).toEqual([
      ...HEAD, '-i', REC,
      '-filter_complex', `[0:v:0]format=yuv420p[v];[0:a:0][0:a:1]${AMIX}[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '20', '-bf', '2', '-g', '30', '-keyint_min', '30', '-flags', '+cgop',
      ...AAC(192), '-movflags', '+faststart', ...TAIL, OUT
    ])
  })

  it('reels 9:16 → scale+pad 1080×1920 (h264_mf)', () => {
    const plan = buildFfmpegArgs(base({ reels: true, encoder: 'h264_mf' }))
    expect(plan.steps[0].args).toEqual([
      ...HEAD, '-i', REC,
      '-filter_complex',
      `[0:v:0]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v];[0:a:0][0:a:1]${AMIX}[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', '70', '-profile:v', '100', '-g', '15', // h264_mf só aceita o perfil numérico (100 = High)
      ...AAC(192), '-movflags', '+faststart', ...TAIL, OUT
    ])
  })
})

describe('buildFfmpegArgs — max (tutorial interno)', () => {
  it('qsv a 60 fps; reels é ignorado (só o preset alto suporta); micOnly com offset negativo → atrim', () => {
    const plan = buildFfmpegArgs(
      base({ preset: PRESETS.max, encoder: 'h264_qsv', srcFps: 60, reels: true, audioMode: 'micOnly', micOffsetMs: -400 })
    )
    expect(plan.steps[0].args).toEqual([
      ...HEAD, '-i', REC,
      '-filter_complex', '[0:v:0]format=yuv420p[v];[0:a:0]atrim=start=0.4,asetpts=PTS-STARTPTS[a]',
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'h264_qsv', '-preset', 'slower', '-global_quality', '19', '-look_ahead', '1', '-look_ahead_depth', '20',
      '-bf', '2', '-profile:v', 'high', '-g', '120',
      ...AAC(256), '-movflags', '+faststart', ...TAIL, OUT
    ])
  })
  it('AMD AMF: quantizador constante pelo hwCq do preset', () => {
    const args = buildFfmpegArgs(base({ preset: PRESETS.max, encoder: 'h264_amf' })).steps[0].args
    const i = args.indexOf('-c:v')
    expect(args.slice(i, i + 18)).toEqual([
      '-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '19', '-qp_b', '19', '-bf', '2', '-profile:v', 'high', '-g', '60'
    ])
  })
  it('libx264 → -crf 17 sem -flags +cgop, gop 2 s', () => {
    const args = buildFfmpegArgs(base({ preset: PRESETS.max })).steps[0].args
    const i = args.indexOf('-c:v')
    expect(args.slice(i, i + 12)).toEqual([
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '17', '-bf', '2', '-g', '60'
    ])
    expect(args).not.toContain('+cgop')
  })
})

describe('buildFfmpegArgs — áudio (audioMode / faixas ausentes)', () => {
  it('mix com só uma faixa → anull direto', () => {
    const args = buildFfmpegArgs(base({ systemTrackIdx: null })).steps[0].args
    expect(args).toContain('[0:v:0]format=yuv420p[v];[0:a:0]anull[a]')
  })
  it('mix com mic ausente e sistema em a:0', () => {
    const args = buildFfmpegArgs(base({ micTrackIdx: null, systemTrackIdx: 0 })).steps[0].args
    expect(args).toContain('[0:v:0]format=yuv420p[v];[0:a:0]anull[a]')
  })
  it('systemOnly usa só a faixa do sistema (offset do mic irrelevante)', () => {
    const args = buildFfmpegArgs(base({ audioMode: 'systemOnly', micOffsetMs: 300 })).steps[0].args
    expect(args).toContain('[0:v:0]format=yuv420p[v];[0:a:1]anull[a]')
  })
  it('micOnly com offset positivo → adelay', () => {
    const args = buildFfmpegArgs(base({ audioMode: 'micOnly', micOffsetMs: 120 })).steps[0].args
    expect(args).toContain('[0:v:0]format=yuv420p[v];[0:a:0]adelay=120:all=1[a]')
  })
  it('mix com offset negativo do mic → atrim antes do amix', () => {
    const args = buildFfmpegArgs(base({ micOffsetMs: -1000 })).steps[0].args
    expect(args).toContain(`[0:v:0]format=yuv420p[v];[0:a:0]atrim=start=1,asetpts=PTS-STARTPTS[mic];[mic][0:a:1]${AMIX}[a]`)
  })
  it('faixa pedida ausente → -an, sem -map [a] nem -c:a', () => {
    const args = buildFfmpegArgs(base({ audioMode: 'systemOnly', systemTrackIdx: null })).steps[0].args
    expect(args).toEqual([
      ...HEAD, '-i', REC, '-filter_complex', '[0:v:0]format=yuv420p[v]', '-map', '[v]',
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '20', '-bf', '2', '-g', '15', '-keyint_min', '15', '-flags', '+cgop',
      '-an', '-movflags', '+faststart', ...TAIL, OUT
    ])
  })
  it('sem nenhuma faixa → -an', () => {
    const args = buildFfmpegArgs(base({ micTrackIdx: null, systemTrackIdx: null })).steps[0].args
    expect(args).toContain('-an')
    expect(args).not.toContain('[a]')
  })
  it("audioMode 'separate' fora do preset separado é tratado como mix", () => {
    const args = buildFfmpegArgs(base({ audioMode: 'separate' })).steps[0].args
    expect(args).toContain(`[0:v:0]format=yuv420p[v];[0:a:0][0:a:1]${AMIX}[a]`)
  })
})

describe('buildFfmpegArgs — cutOnly (só cortar)', () => {
  it('-c:v copy com -avoid_negative_ts make_zero, corte -ss antes do -i, áudio AAC 192k mixado', () => {
    const plan = buildFfmpegArgs(base({ preset: PRESETS.cutOnly, trimStartMs: 2000, encoder: 'h264_nvenc' }))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].label).toBe('encode')
    expect(plan.steps[0].args).toEqual([
      ...HEAD, '-ss', '2.000', '-i', REC,
      '-filter_complex', `[0:a:0][0:a:1]${AMIX}[a]`,
      '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', '-avoid_negative_ts', 'make_zero',
      ...AAC(192), '-movflags', '+faststart', ...TAIL, OUT
    ])
    expect(plan.outputs).toEqual([OUT])
  })
  it('sem áudio → -an e sem -filter_complex', () => {
    const args = buildFfmpegArgs(base({ preset: PRESETS.cutOnly, micTrackIdx: null, systemTrackIdx: null })).steps[0].args
    expect(args).toEqual([
      ...HEAD, '-i', REC, '-map', '0:v:0', '-c:v', 'copy', '-avoid_negative_ts', 'make_zero', '-an',
      '-movflags', '+faststart', ...TAIL, OUT
    ])
  })
})

describe('buildFfmpegArgs — separate (edição posterior)', () => {
  const tela = `${OUT_DIR}\\${BASE} - tela.mp4`
  const webcam = `${OUT_DIR}\\${BASE} - webcam.mp4`
  const mic = `${OUT_DIR}\\${BASE} - mic.wav`
  const sistema = `${OUT_DIR}\\${BASE} - sistema.wav`
  const combinado = `${OUT_DIR}\\${BASE} - combinado.mkv`

  it('5 passos com webcam, mic e sistema, corte aplicado em todos', () => {
    const plan = buildFfmpegArgs(base({ preset: PRESETS.separate, hasWebcamTrack: true, trimStartMs: 0, trimEndMs: 30_000 }))
    const cut = ['-to', '30.000']
    expect(plan.steps.map((s) => s.label)).toEqual(['tela', 'webcam', 'mic', 'sistema', 'combinado'])
    expect(plan.steps.map((s) => s.outFile)).toEqual([tela, webcam, mic, sistema, combinado])
    expect(plan.outputs).toEqual([tela, webcam, mic, sistema, combinado])
    expect(plan.steps[0].args).toEqual([...HEAD, ...cut, '-i', REC, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', ...TAIL, tela])
    expect(plan.steps[1].args).toEqual([...HEAD, ...cut, '-i', REC, '-map', '0:v:1', '-c', 'copy', '-movflags', '+faststart', ...TAIL, webcam])
    expect(plan.steps[2].args).toEqual([...HEAD, ...cut, '-i', REC, '-map', '0:a:0', '-c:a', 'pcm_s16le', ...TAIL, mic])
    expect(plan.steps[3].args).toEqual([...HEAD, ...cut, '-i', REC, '-map', '0:a:1', '-c:a', 'pcm_s16le', ...TAIL, sistema])
    expect(plan.steps[4].args).toEqual([
      ...HEAD, ...cut, '-i', REC, '-map', '0:v:0', '-map', '0:a:0', '-map', '0:a:1', '-c', 'copy',
      '-disposition:a:0', 'default', '-metadata:s:a:0', 'title=Microfone', '-metadata:s:a:1', 'title=Sistema', ...TAIL, combinado
    ])
  })
  it('sem webcam e só sistema → tela, sistema e combinado (título Sistema em a:0)', () => {
    const plan = buildFfmpegArgs(base({ preset: PRESETS.separate, micTrackIdx: null, systemTrackIdx: 0 }))
    expect(plan.steps.map((s) => s.label)).toEqual(['tela', 'sistema', 'combinado'])
    expect(plan.steps[2].args).toEqual([
      ...HEAD, '-i', REC, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
      '-disposition:a:0', 'default', '-metadata:s:a:0', 'title=Sistema', ...TAIL, combinado
    ])
  })
  it('sem áudio → tela e combinado (sem disposition/metadata)', () => {
    const plan = buildFfmpegArgs(base({ preset: PRESETS.separate, micTrackIdx: null, systemTrackIdx: null }))
    expect(plan.steps.map((s) => s.label)).toEqual(['tela', 'combinado'])
    expect(plan.steps[1].args).toEqual([...HEAD, '-i', REC, '-map', '0:v:0', '-c', 'copy', ...TAIL, combinado])
  })
  it('vídeo e áudio em arquivos diferentes → combinado usa duas entradas', () => {
    const plan = buildFfmpegArgs(base({ preset: PRESETS.separate, inputVideo: COMPOSED }))
    expect(plan.steps[0].args).toEqual([...HEAD, '-i', COMPOSED, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', ...TAIL, tela])
    expect(plan.steps[1].args).toEqual([...HEAD, '-i', REC, '-map', '0:a:0', '-c:a', 'pcm_s16le', ...TAIL, mic])
    expect(plan.steps[3].args).toEqual([
      ...HEAD, '-i', COMPOSED, '-i', REC, '-map', '0:v:0', '-map', '1:a:0', '-map', '1:a:1', '-c', 'copy',
      '-disposition:a:0', 'default', '-metadata:s:a:0', 'title=Microfone', '-metadata:s:a:1', 'title=Sistema', ...TAIL, combinado
    ])
  })
})

describe('buildFfmpegArgs — caminhos', () => {
  it('outDir com barra final ou com "/" é normalizado', () => {
    expect(buildFfmpegArgs(base({ outDir: 'C:\\out\\' })).outputs).toEqual([`C:\\out\\${BASE}.mp4`])
    expect(buildFfmpegArgs(base({ outDir: 'C:/out' })).outputs).toEqual([`C:/out/${BASE}.mp4`])
  })
})
