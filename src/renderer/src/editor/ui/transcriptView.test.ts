import { describe, expect, it } from 'vitest'
import { buildTranscript, findMatches, foldForSearch, formatClock, seekUsForOffset, tokenizeCue, transcriptText, type TranscriptCue } from './transcriptView'

const S = 1_000_000
const cue = (id: string, s: number, e: number, text: string): TranscriptCue => ({ id, startUs: Math.round(s * S), durationUs: Math.round((e - s) * S), text })

describe('foldForSearch', () => {
  it('minúsculas, sem acentos, quebras de linha viram espaço; mapa para o índice original', () => {
    const r = foldForSearch('Ação\nÉ')
    expect(r.folded).toBe('acao e')
    expect(r.map).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
  it('caractere que vira dois (İ → i̇ minúsculo) mantém o mapa para o original', () => {
    const r = foldForSearch('İa')
    // NFD tira o ponto combinante; sobra "i" + "a"
    expect(r.folded).toBe('ia')
    expect(r.map[r.folded.length]).toBe(2)
  })
})

describe('findMatches', () => {
  it('sem diferenciar maiúsculas/acentos; intervalos no texto original', () => {
    expect(findMatches('Coração e CORACAO', 'coracao')).toEqual([[0, 7], [10, 17]])
    expect(findMatches('São Paulo', 'sao')).toEqual([[0, 3]])
  })
  it('consulta vazia/só espaços → nada; espaços repetidos na consulta contam como um; atravessa a quebra de linha', () => {
    expect(findMatches('abc', '')).toEqual([])
    expect(findMatches('abc', '   ')).toEqual([])
    expect(findMatches('bom\ndia', 'bom   dia')).toEqual([[0, 7]])
  })
  it('ocorrências não se sobrepõem', () => {
    expect(findMatches('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
  })
})

describe('tokenizeCue', () => {
  it('palavras com o deslocamento; espaços à parte; trechos destacados dentro da palavra', () => {
    const t = tokenizeCue('Olá mundo', [[5, 7]])
    expect(t).toEqual([
      { offset: 0, word: true, pieces: [{ text: 'Olá', hl: false }] },
      { offset: 3, word: false, pieces: [{ text: ' ', hl: false }] },
      { offset: 4, word: true, pieces: [{ text: 'm', hl: false }, { text: 'un', hl: true }, { text: 'do', hl: false }] }
    ])
  })
  it('destaque que atravessa o espaço marca as duas palavras e o espaço', () => {
    const t = tokenizeCue('ab cd', [[1, 4]])
    expect(t.map((x) => x.pieces)).toEqual([[{ text: 'a', hl: false }, { text: 'b', hl: true }], [{ text: ' ', hl: true }], [{ text: 'c', hl: true }, { text: 'd', hl: false }]])
  })
})

describe('seekUsForOffset', () => {
  it('início + round(duração · deslocamento / tamanho do texto)', () => {
    const c = cue('a', 1, 3, 'abcd efgh')
    expect(seekUsForOffset(c, 0)).toBe(S)
    expect(seekUsForOffset(c, 5)).toBe(S + Math.round((2 * S * 5) / 9))
    expect(Number.isInteger(seekUsForOffset({ startUs: 1, durationUs: 1_000_001, text: 'abc' }, 1))).toBe(true)
  })
  it('texto vazio → início', () => {
    expect(seekUsForOffset(cue('a', 2, 3, ''), 0)).toBe(2 * S)
  })
})

describe('formatClock / transcriptText', () => {
  it('mm:ss (minutos passam de 59)', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(65.9 * S)).toBe('01:05')
    expect(formatClock(3723 * S)).toBe('62:03')
  })
  it('uma linha por legenda "mm:ss texto", quebras viram espaço, em ordem de início', () => {
    expect(transcriptText([cue('b', 70, 72, 'segunda\nlinha'), cue('a', 1, 2, 'primeira')])).toBe('00:01 primeira\n01:10 segunda linha')
  })
})

describe('buildTranscript', () => {
  it('linhas em ordem, com o horário e o total de ocorrências', () => {
    const r = buildTranscript([cue('b', 5, 6, 'Bom dia, São Paulo'), cue('a', 1, 2, 'são joão')], 'SAO')
    expect(r.rows.map((x) => [x.cue.id, x.time, x.matchCount])).toEqual([['a', '00:01', 1], ['b', '00:05', 1]])
    expect(r.matches).toBe(2)
  })

  // retry: medida de tempo sob a suíte inteira em paralelo oscila; regressão real falha nas 3
  it('1 000 legendas: busca + tokens < 50 ms (e sem busca idem)', { retry: 2 }, () => {
    const words = ['ação', 'iluminação', 'reunião', 'equipe', 'clientes', 'São', 'Paulo', 'orçamento', 'manutenção', 'semana']
    const cues: TranscriptCue[] = []
    for (let i = 0; i < 1000; i++) {
      const text = Array.from({ length: 9 }, (_, k) => words[(i + k * 3) % words.length]).join(' ')
      cues.push(cue(`c${i}`, i * 3, i * 3 + 2.5, text.slice(0, 40) + '\n' + text.slice(40)))
    }
    // aquece o JIT
    buildTranscript(cues, 'manut')
    let best = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now()
      const r = buildTranscript(cues, 'manutencao')
      const r2 = buildTranscript(cues, '')
      best = Math.min(best, performance.now() - t0)
      expect(r.rows).toHaveLength(1000)
      expect(r.matches).toBeGreaterThan(100)
      expect(r2.matches).toBe(0)
    }
    expect(best).toBeLessThan(50)
  })
})
