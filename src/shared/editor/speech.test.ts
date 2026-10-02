import { describe, expect, it } from 'vitest'
import type { Asset } from './project'
import { audioAnalysisComplete, parseEbur128, parseSilencedetect, speechFromFile, speechIntervals, type SpeechFile } from './speech'

// Saídas reais do ffmpeg 8.1 (stderr), capturadas com os mesmos filtros da ingestão.
// Ruído rosa em 1–2,5 s, 4–5 s e 6,2–8 s num arquivo de 10 s.
const SILENCE_REAL = `Input #0, lavfi, from 'anoisesrc=color=pink:r=48000:a=0.3:d=10,volume=...':
  Duration: N/A, start: 0.000000, bitrate: 768 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_start: 0
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_end: 1.002667 | silence_duration: 1.002667
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_start: 2.517333
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_end: 4.010667 | silence_duration: 1.493333
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_start: 5.013312
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_end: 6.208021 | silence_duration: 1.194708
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_start: 8.021333
[Parsed_silencedetect_0 @ 000001760db8eb00] silence_end: 10 | silence_duration: 1.978667
[out#0/null @ 000001760db8ef40] video:0KiB audio:938KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:10.00 bitrate=N/A speed=1.29e+03x elapsed=0:00:00.00
`

const EBUR_REAL = `[Parsed_ebur128_1 @ 000001d2efbd1280] Summary:

  Integrated loudness:
    I:         -41.1 LUFS
    Threshold: -51.1 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -61.1 LUFS
    LRA low:   -41.1 LUFS
    LRA high:  -41.1 LUFS

  True peak:
    Peak:      -38.1 dBFS
[out#0/null @ 000001d2efbd1b00] video:0KiB audio:469KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
`

// áudio mudo (anullsrc): o ffmpeg imprime I: -70.0 LUFS e Peak: -inf dBFS
const EBUR_SILENT = EBUR_REAL.replace('I:         -41.1 LUFS', 'I:         -70.0 LUFS').replace('Peak:      -38.1 dBFS', 'Peak:       -inf dBFS')

describe('parseSilencedetect', () => {
  it('saída real: 4 silêncios em microssegundos inteiros', () => {
    expect(parseSilencedetect(SILENCE_REAL)).toEqual([
      { fromUs: 0, toUs: 1_002_667 },
      { fromUs: 2_517_333, toUs: 4_010_667 },
      { fromUs: 5_013_312, toUs: 6_208_021 },
      { fromUs: 8_021_333, toUs: 10_000_000 }
    ])
  })
  it('CRLF (Windows) dá o mesmo resultado', () => {
    expect(parseSilencedetect(SILENCE_REAL.replace(/\n/g, '\r\n'))).toEqual(parseSilencedetect(SILENCE_REAL))
  })
  it('silêncio que começa e nunca termina (EOF): toUs null', () => {
    const cut = SILENCE_REAL.split('\n').filter((l) => !l.includes('silence_end: 10')).join('\n')
    expect(parseSilencedetect(cut).at(-1)).toEqual({ fromUs: 8_021_333, toUs: null })
  })
  it('início negativo (offset do stream) vira 0; silence_end sem start é ignorado', () => {
    expect(parseSilencedetect('[silencedetect @ 0] silence_start: -0.00133\n[silencedetect @ 0] silence_end: 1.5 | silence_duration: 1.5')).toEqual([{ fromUs: 0, toUs: 1_500_000 }])
    expect(parseSilencedetect('[silencedetect @ 0] silence_end: 1.5 | silence_duration: 1.5')).toEqual([])
  })
  it('sem silêncio: lista vazia', () => {
    expect(parseSilencedetect('size=N/A time=00:00:05.00')).toEqual([])
  })
})

describe('speechIntervals', () => {
  const silences = parseSilencedetect(SILENCE_REAL)
  const D = 10_000_000
  it('complemento dos silêncios com padding de 120 ms', () => {
    expect(speechIntervals(silences, D, 120_000, 100_000, 250_000)).toEqual([
      { fromUs: 882_667, toUs: 2_637_333 },
      { fromUs: 3_890_667, toUs: 5_133_312 },
      { fromUs: 6_088_021, toUs: 8_141_333 }
    ])
  })
  it('silêncio final aberto (toUs null) vai até a duração', () => {
    expect(speechIntervals([{ fromUs: 4_000_000, toUs: null }], D, 0, 0, 0)).toEqual([{ fromUs: 0, toUs: 4_000_000 }])
  })
  it('mescla lacunas menores que 250 ms (depois do padding)', () => {
    // fala 0–1 s, silêncio 1–1,4 s, fala 1,4–3 s: com padding de 120 ms a lacuna cai a 160 ms → une
    const r = speechIntervals([{ fromUs: 1_000_000, toUs: 1_400_000 }, { fromUs: 3_000_000, toUs: null }], 5_000_000, 120_000, 100_000, 250_000)
    expect(r).toEqual([{ fromUs: 0, toUs: 3_120_000 }])
  })
  it('lacuna de exatamente 250 ms não mescla', () => {
    // silêncio de 490 ms − 240 ms de padding = lacuna de 250 ms
    const r = speechIntervals([{ fromUs: 1_000_000, toUs: 1_490_000 }, { fromUs: 3_000_000, toUs: null }], 5_000_000, 120_000, 0, 250_000)
    expect(r).toHaveLength(2)
  })
  it('descarta fala mais curta que minSpeech (estalo isolado) e respeita os limites do arquivo', () => {
    const r = speechIntervals([{ fromUs: 0, toUs: 1_000_000 }, { fromUs: 1_050_000, toUs: 3_000_000 }], 3_000_000, 120_000, 100_000, 250_000)
    expect(r).toEqual([])
    const edge = speechIntervals([{ fromUs: 500_000, toUs: 1_000_000 }], 1_500_000, 120_000, 100_000, 250_000)
    expect(edge[0].fromUs).toBe(0)
    expect(edge[1].toUs).toBe(1_500_000)
  })
  it('sem silêncios: tudo é fala; duração zero: nada', () => {
    expect(speechIntervals([], 2_000_000, 120_000, 100_000, 250_000)).toEqual([{ fromUs: 0, toUs: 2_000_000 }])
    expect(speechIntervals([], 0, 120_000, 100_000, 250_000)).toEqual([])
  })
  it('tudo silêncio: nenhuma fala', () => {
    expect(speechIntervals([{ fromUs: 0, toUs: D }], D, 120_000, 100_000, 250_000)).toEqual([])
  })
})

describe('parseEbur128', () => {
  it('resumo real', () => {
    expect(parseEbur128(EBUR_REAL)).toEqual({ integrated: -41.1, truePeak: -38.1, lra: 0 })
    expect(parseEbur128(EBUR_REAL.replace(/\n/g, '\r\n'))).toEqual({ integrated: -41.1, truePeak: -38.1, lra: 0 })
  })
  it('áudio mudo: -inf vira o piso (-120 dBFS)', () => {
    expect(parseEbur128(EBUR_SILENT)).toEqual({ integrated: -70, truePeak: -120, lra: 0 })
  })
  it('sem resumo: null', () => {
    expect(parseEbur128('nada aqui')).toBeNull()
  })
})

describe('speechFromFile', () => {
  const file: SpeechFile = { version: 1, thresholdDb: -35, minSilenceUs: 350_000, silences: parseSilencedetect(SILENCE_REAL), durationUs: 10_000_000 }
  it('padrão: padding 120 ms, fala mínima 100 ms, mescla 250 ms', () => {
    expect(speechFromFile(file)).toEqual(speechIntervals(file.silences, 10_000_000, 120_000, 100_000, 250_000))
    expect(speechFromFile(file)).toHaveLength(3)
  })
  it('o chamador ajusta os parâmetros sem reanalisar (sem padding; mescla de 2 s une tudo)', () => {
    expect(speechFromFile(file, { padUs: 0 })[0]).toEqual({ fromUs: 1_002_667, toUs: 2_517_333 })
    expect(speechFromFile(file, { mergeGapUs: 2_000_000 })).toHaveLength(1)
  })
  it('silêncio aberto no arquivo (toUs null) vai até durationUs; sobrevive ao JSON', () => {
    const open: SpeechFile = { ...file, silences: [{ fromUs: 8_000_000, toUs: null }] }
    const back = JSON.parse(JSON.stringify(open)) as SpeechFile
    expect(speechFromFile(back, { padUs: 0 })).toEqual([{ fromUs: 0, toUs: 8_000_000 }])
  })
})

describe('audioAnalysisComplete', () => {
  const base: Asset = { id: 'a', name: 'a', kind: 'video', source: { type: 'file', path: 'x', size: 1, mtimeMs: 1 }, durationUs: 1_000_000, status: 'ready', audio: { channels: 2, sampleRate: 48000, codec: 'aac' } }
  const loud = { integrated: -23, truePeak: -1, lra: 4 }
  it('com áudio exige fala e loudness', () => {
    expect(audioAnalysisComplete(base)).toBe(false)
    expect(audioAnalysisComplete({ ...base, speech: 's' })).toBe(false)
    expect(audioAnalysisComplete({ ...base, speech: 's', loudness: loud })).toBe(true)
    expect(audioAnalysisComplete({ ...base, kind: 'audio', audio: undefined })).toBe(false)
  })
  it('sem áudio (vídeo mudo, imagem): sempre completo', () => {
    expect(audioAnalysisComplete({ ...base, audio: undefined })).toBe(true)
    expect(audioAnalysisComplete({ ...base, kind: 'image', audio: undefined })).toBe(true)
  })
})
