import { describe, expect, it } from 'vitest'
import { audioProcessArgs, denoiseArgs, denoiseFilter, DENOISE_DELAY_SAMPLES, loudnormApplyFilter, loudnormMeasureArgs, parseLoudnormJson } from './audioProcess'

const JSON_OUT = `[Parsed_loudnorm_1 @ 000001]
{
	"input_i" : "-30.12",
	"input_tp" : "-14.03",
	"input_lra" : "1.20",
	"input_thresh" : "-40.31",
	"output_i" : "-16.02",
	"output_tp" : "-1.50",
	"output_lra" : "1.10",
	"output_thresh" : "-26.20",
	"normalization_type" : "dynamic",
	"target_offset" : "0.02"
}
[out#0/null @ 0000] video:0KiB audio:4500KiB`

describe('denoise (RNNoise via arnndn)', () => {
  it('modelo relativo ao cwd (sem escapar caminho do Windows no filtergraph) e compensa o atraso de 480 amostras', () => {
    expect(DENOISE_DELAY_SAMPLES).toBe(480)
    expect(denoiseFilter()).toBe('arnndn=m=sh.rnnn,atrim=start_sample=480,asetpts=PTS-480/SR/TB,apad=pad_len=480')
  })
  it('denoiseArgs: faixa escolhida, linha do tempo a partir de 0 em 48 kHz, AAC em m4a, progresso no stdout', () => {
    const a = denoiseArgs('C:\\rec.mp4', '0:a:1', 'C:\\p\\generated\\x.part.m4a')
    expect(a.slice(0, 7)).toEqual(['-hide_banner', '-nostdin', '-y', '-i', 'C:\\rec.mp4', '-map', '0:a:1'])
    expect(a[a.indexOf('-af') + 1]).toBe(`aresample=48000:first_pts=0,${denoiseFilter()}`)
    expect(a).toContain('-vn')
    expect(a.slice(-10)).toEqual(['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', 'C:\\p\\generated\\x.part.m4a'])
  })
})

describe('loudnorm em duas passadas', () => {
  it('parse do JSON da 1ª passada', () => {
    expect(parseLoudnormJson(JSON_OUT)).toEqual({ i: -30.12, tp: -14.03, lra: 1.2, thresh: -40.31, offset: 0.02 })
    expect(parseLoudnormJson('sem json')).toBeNull()
    // trilha silenciosa: -inf → não há o que normalizar
    expect(parseLoudnormJson(JSON_OUT.replace('"-30.12"', '"-inf"'))).toBeNull()
  })
  it('1ª passada mede depois do denoise (cadeia inteira) com print_format=json', () => {
    const a = loudnormMeasureArgs('in.wav', '0:a:0', { denoise: true, normalize: true }, { dualMono: false })
    expect(a[a.indexOf('-af') + 1]).toBe(`aresample=48000:first_pts=0,${denoiseFilter()},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`)
    expect(a.slice(-3)).toEqual(['-f', 'null', '-'])
  })
  it('2ª passada: valores medidos, linear=true, alvo −16 LUFS / −1,5 dBTP e volta a 48 kHz', () => {
    const m = { i: -30.12, tp: -14.03, lra: 1.2, thresh: -40.31, offset: 0.02 }
    expect(loudnormApplyFilter(m, { dualMono: false })).toBe(
      'loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-30.12:measured_TP=-14.03:measured_LRA=1.2:measured_thresh=-40.31:offset=0.02:linear=true:print_format=summary,aresample=48000'
    )
  })
  it('fonte mono: dual_mono (o mixer toca o mono nos dois canais) nas duas passadas', () => {
    const m = { i: -30, tp: -14, lra: 1, thresh: -40, offset: 0 }
    expect(loudnormApplyFilter(m, { dualMono: true })).toContain(':dual_mono=true')
    const a = loudnormMeasureArgs('in.wav', '0:a:0', { denoise: false, normalize: true }, { dualMono: true })
    expect(a[a.indexOf('-af') + 1]).toBe('aresample=48000:first_pts=0,loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true:print_format=json')
  })
  it('audioProcessArgs: denoise antes da normalização; sem medida (trilha muda) só a cadeia sem loudnorm', () => {
    const m = { i: -30, tp: -14, lra: 1, thresh: -40, offset: 0 }
    const both = audioProcessArgs('in', '0:a:0', 'out.m4a', { denoise: true, normalize: true }, m, { dualMono: false })
    expect(both[both.indexOf('-af') + 1]).toBe(`aresample=48000:first_pts=0,${denoiseFilter()},${loudnormApplyFilter(m, { dualMono: false })}`)
    const silent = audioProcessArgs('in', '0:a:0', 'out.m4a', { denoise: false, normalize: true }, null, { dualMono: false })
    expect(silent[silent.indexOf('-af') + 1]).toBe('aresample=48000:first_pts=0')
  })
})
