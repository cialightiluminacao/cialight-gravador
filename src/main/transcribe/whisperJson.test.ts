import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseWhisperJson, type WhisperJson } from './whisperJson'
import { scoreWords } from './wordScore'

const fx = (name: string): string => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
const json = JSON.parse(fx('whisper-ptbr.json')) as WhisperJson
const truth = JSON.parse(fx('whisper-ptbr.truth.json')) as { durationUs: number; words: { text: string; startUs: number; endUs: number }[] }
const ALL = [{ fromUs: 0, toUs: 80_000_000 }]

const tok = (text: string, fromMs: number, dtw: number, p = 0.9): { text: string; offsets: { from: number; to: number }; p: number; t_dtw: number } => ({ text, offsets: { from: fromMs, to: fromMs }, p, t_dtw: dtw })
const seg = (fromMs: number, toMs: number, text: string, tokens: ReturnType<typeof tok>[]): WhisperJson['transcription'][number] => ({ offsets: { from: fromMs, to: toMs }, text, tokens })

describe('parseWhisperJson — fixture real (base, 74,56 s)', () => {
  it('≥ 95 % das palavras corretas e p90 do erro de início ≤ 0,3 s', () => {
    const r = parseWhisperJson(json, ALL)
    const s = scoreWords(truth.words, r.words)
    expect(s.accuracy).toBeGreaterThanOrEqual(0.95)
    expect(s.startErrP90Us).toBeLessThanOrEqual(300_000)
    expect(r.dropped).toBe(0)
    expect(r.unfiltered).toBe(false)
  })

  it('palavras em µs inteiros, ordenadas, com fim ≥ início e sem tokens especiais', () => {
    const { words } = parseWhisperJson(json, ALL)
    expect(words.length).toBeGreaterThan(100)
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      expect(Number.isInteger(w.startUs) && Number.isInteger(w.endUs)).toBe(true)
      expect(w.endUs).toBeGreaterThanOrEqual(w.startUs)
      expect(w.text).not.toMatch(/\[_/)
      if (i > 0) expect(w.startUs).toBeGreaterThanOrEqual(words[i - 1].startUs)
    }
    // tokens sem espaço continuam a palavra ("lumin" + "arias")
    expect(words.map((w) => w.text)).toContain('luminarias')
    // 1ª palavra do segmento = offsets.from do token (110 ms); as demais = t_dtw do token anterior (" dia": 30 cs)
    expect(words[0]).toMatchObject({ text: 'Bom', startUs: 110_000 })
    expect(words[1]).toMatchObject({ text: 'dia', startUs: 300_000 })
    expect(words[0].endUs).toBe(words[1].startUs)
  })
})

describe('parseWhisperJson — regras', () => {
  it('JSON vazio ou sem transcription → nenhuma palavra', () => {
    expect(parseWhisperJson({ transcription: [] }, ALL).words).toEqual([])
    expect(parseWhisperJson({} as WhisperJson, ALL).words).toEqual([])
  })

  it('segmento só de anotação ([Música], (risos), ♪…♪) é descartado, com ou sem fala detectada', () => {
    const j: WhisperJson = {
      transcription: [
        seg(0, 2000, ' [Música]', [tok('[_BEG_]', 0, -1), tok(' [', 0, 10), tok('Mús', 100, 50), tok('ica', 200, 90), tok(']', 300, 120)]),
        seg(2000, 3000, ' (risos) ♪ lá ♪', [tok(' (', 2000, 210), tok('ris', 2100, 230), tok('os', 2200, 250), tok(')', 2300, 260)]),
        seg(3000, 4000, ' Olá mundo', [tok(' Olá', 3000, 320), tok(' mundo', 3300, 360)])
      ]
    }
    for (const speech of [ALL, []]) {
      const r = parseWhisperJson(j, speech)
      expect(r.words.map((w) => w.text)).toEqual(['Olá', 'mundo'])
      expect(r.dropped).toBe(2)
    }
  })

  it('tokens especiais ([_BEG_], [_TT_n], <|…|>) são ignorados e não contam como palavra anterior', () => {
    const j: WhisperJson = { transcription: [seg(1000, 2000, ' Um dois', [tok('[_BEG_]', 1000, -1), tok(' Um', 1100, 130), tok('<|pt|>', 1200, 140), tok(' dois', 1300, 160), tok('[_TT_100]', 2000, -1)])] }
    const r = parseWhisperJson(j, ALL)
    expect(r.words).toEqual([
      { text: 'Um', startUs: 1_100_000, endUs: 1_300_000, prob: 0.9 },
      { text: 'dois', startUs: 1_300_000, endUs: 2_000_000, prob: 0.9 }
    ])
  })

  it('com fala detectada: segmento com < 50 % dos tokens (t_dtw) na fala é descartado', () => {
    const speech = [{ fromUs: 0, toUs: 1_000_000 }]
    const j: WhisperJson = {
      transcription: [
        seg(0, 1000, ' fala real', [tok(' fala', 100, 40), tok(' real', 400, 80)]),
        // alucinação no silêncio: t_dtw em 5 s e 6 s (fora da fala)
        seg(4000, 7000, ' e aí pessoal', [tok(' e', 4000, 500), tok(' aí', 5000, 600), tok(' pessoal', 6000, 650)])
      ]
    }
    const r = parseWhisperJson(j, speech)
    expect(r.words.map((w) => w.text)).toEqual(['fala', 'real'])
    expect(r.dropped).toBe(1)
    expect(r.unfiltered).toBe(false)
  })

  it('com fala detectada: palavra que começa fora da fala vai ao início da próxima fala; inícios não decrescentes', () => {
    const speech = [{ fromUs: 0, toUs: 1_000_000 }, { fromUs: 3_000_000, toUs: 5_000_000 }]
    // " depois" começa (t_dtw do token anterior) em 1,5 s, dentro da pausa → 3 s
    const j: WhisperJson = { transcription: [seg(0, 5000, ' antes depois agora', [tok(' antes', 200, 150), tok(' depois', 1500, 320), tok(' agora', 3300, 400)])] }
    const r = parseWhisperJson(j, speech)
    expect(r.words.map((w) => [w.text, w.startUs])).toEqual([['antes', 200_000], ['depois', 3_000_000], ['agora', 3_200_000]])
    expect(r.words[0].endUs).toBe(3_000_000)
  })

  it('sem fala detectada (voz baixa): mantém as palavras não anotação, sem filtro nem ajuste, e marca unfiltered', () => {
    const j: WhisperJson = {
      transcription: [
        seg(0, 1000, ' [Música]', [tok(' [', 0, 10), tok('Música', 100, 50), tok(']', 200, 90)]),
        seg(4000, 7000, ' voz baixa', [tok(' voz', 4000, 500), tok(' baixa', 5000, 600)])
      ]
    }
    const r = parseWhisperJson(j, [])
    expect(r.words.map((w) => [w.text, w.startUs])).toEqual([['voz', 4_000_000], ['baixa', 5_000_000]])
    expect(r.dropped).toBe(1)
    expect(r.unfiltered).toBe(true)
    // só anotação e nada mais: sem palavras e sem a marca (nada a avisar)
    expect(parseWhisperJson({ transcription: [j.transcription[0]] }, []).unfiltered).toBe(false)
  })

  it('fim da palavra = início da próxima do segmento ou o fim do segmento; nunca antes do início', () => {
    const j: WhisperJson = { transcription: [seg(0, 500, ' a b', [tok(' a', 100, 70), tok(' b', 700, 90)])] }
    const r = parseWhisperJson(j, ALL)
    expect(r.words).toEqual([
      { text: 'a', startUs: 100_000, endUs: 700_000, prob: 0.9 },
      { text: 'b', startUs: 700_000, endUs: 700_000, prob: 0.9 }
    ])
  })
})
