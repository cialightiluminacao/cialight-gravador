import { describe, expect, it } from 'vitest'
import { cuesForRange, formatCueTime, parseCueTime, parseSrt, serializeSrt, type Cue } from './srt'

const ms = (h: number, m: number, s: number, x: number): number => (((h * 60 + m) * 60 + s) * 1000 + x) * 1000

describe('parseSrt', () => {
  it('lê um SRT simples (índices, \\n, vírgula)', () => {
    const r = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nOlá\n\n2\n00:00:03,000 --> 00:00:04,000\nMundo\n')
    expect(r.warnings).toEqual([])
    expect(r.cues).toEqual([
      { startUs: 1_000_000, endUs: 2_500_000, text: 'Olá' },
      { startUs: 3_000_000, endUs: 4_000_000, text: 'Mundo' }
    ])
  })

  it('remove o BOM UTF-8 e aceita \\r\\n e \\r', () => {
    const crlf = parseSrt('﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n')
    const cr = parseSrt('1\r00:00:01,000 --> 00:00:02,000\rA\r\r2\r00:00:03,000 --> 00:00:04,000\rB\r')
    for (const r of [crlf, cr]) {
      expect(r.warnings).toEqual([])
      expect(r.cues.map((c) => c.text)).toEqual(['A', 'B'])
      expect(r.cues[1].startUs).toBe(3_000_000)
    }
  })

  it('tolera linhas em branco extras e espaços', () => {
    const r = parseSrt('\n\n  1  \n  00:00:01,000   -->   00:00:02,000  \n  Olá mundo  \n\n\n\n 2\n00:00:03,000 --> 00:00:04,000\nB\n\n\n')
    expect(r.warnings).toEqual([])
    expect(r.cues).toEqual([
      { startUs: 1_000_000, endUs: 2_000_000, text: 'Olá mundo' },
      { startUs: 3_000_000, endUs: 4_000_000, text: 'B' }
    ])
  })

  it('índice ausente, repetido ou fora de ordem é ignorado; ordena pelo início', () => {
    const r = parseSrt('00:00:05,000 --> 00:00:06,000\nC\n\n7\n00:00:01,000 --> 00:00:02,000\nA\n\n7\n00:00:03,000 --> 00:00:04,000\nB\n')
    expect(r.warnings).toEqual([])
    expect(r.cues.map((c) => c.text)).toEqual(['A', 'B', 'C'])
  })

  it('aceita ponto nos milissegundos e horas com 1 a 3 dígitos', () => {
    const r = parseSrt('1\n0:00:01.250 --> 0:00:02.5\nA\n\n2\n100:00:00,000 --> 100:00:01,000\nB\n')
    expect(r.warnings).toEqual([])
    expect(r.cues[0]).toEqual({ startUs: 1_250_000, endUs: 2_500_000, text: 'A' })
    expect(r.cues[1].startUs).toBe(ms(100, 0, 0, 0))
  })

  it('remove <i>, <b>, <u>, <font …> e {\\an8}, mantendo as quebras de linha', () => {
    const r = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Itálico</i> e <b>negrito</b>\n<font color="#ff0000">vermelho</font> <u>sublinhado</u>\n')
    expect(r.cues[0].text).toBe('Itálico e negrito\nvermelho sublinhado')
  })

  it('descarta cue com fim ≤ início, com aviso com o número do bloco', () => {
    const r = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:05,000 --> 00:00:04,000\nB\n\n3\n00:00:06,000 --> 00:00:06,000\nC\n')
    expect(r.cues.map((c) => c.text)).toEqual(['A'])
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toMatch(/^Bloco 2: /)
    expect(r.warnings[0]).toMatch(/fim/)
    expect(r.warnings[1]).toMatch(/^Bloco 3: /)
  })

  it('cues sobrepostas: o fim da anterior é cortado no início da seguinte (aviso)', () => {
    const r = parseSrt('1\n00:00:01,000 --> 00:00:04,000\nA\n\n2\n00:00:03,000 --> 00:00:05,000\nB\n')
    expect(r.cues).toEqual([
      { startUs: 1_000_000, endUs: 3_000_000, text: 'A' },
      { startUs: 3_000_000, endUs: 5_000_000, text: 'B' }
    ])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/^Bloco 1: .*bloco 2/)
  })

  it('bloco ilegível → aviso e continua', () => {
    const r = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nA\n\nlixo sem tempo\noutra linha\n\n3\n00:00:03,000 --> 00:00:04,000\nB\n\n4\n00:00:xx,000 --> 00:00:05,000\nC\n')
    expect(r.cues.map((c) => c.text)).toEqual(['A', 'B'])
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toMatch(/^Bloco 2: /)
    expect(r.warnings[1]).toMatch(/^Bloco 4: /)
  })

  it('blocos sem linha em branco entre si (índice colado no texto anterior)', () => {
    const r = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n')
    expect(r.warnings).toEqual([])
    expect(r.cues.map((c) => c.text)).toEqual(['A', 'B'])
  })

  it('texto solto antes da linha de tempo: descartado com aviso (o índice sozinho não avisa)', () => {
    const r = parseSrt('lixo\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n')
    expect(r.cues.map((c) => c.text)).toEqual(['A', 'B'])
    expect(r.warnings).toEqual(['Bloco 1: texto antes do tempo ignorado (“lixo”)'])
  })

  it('cue sem texto é descartada com aviso', () => {
    const r = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n')
    expect(r.cues.map((c) => c.text)).toEqual(['B'])
    expect(r.warnings[0]).toMatch(/^Bloco 1: /)
  })

  it('arquivo vazio: nada, sem avisos', () => {
    expect(parseSrt('')).toEqual({ cues: [], warnings: [] })
    expect(parseSrt('﻿\r\n\r\n')).toEqual({ cues: [], warnings: [] })
  })

  it('arquivo real com acentos', () => {
    const real = [
      '﻿1',
      '00:00:00,500 --> 00:00:02,840',
      'Olá! Bem-vindo à apresentação',
      'da Cia Light.',
      '',
      '2',
      '00:00:02,840 --> 00:00:05,120',
      'Hoje vamos ver as luminárias de',
      '<i>emergência</i> e a instalação elétrica.',
      '',
      '3',
      '00:00:05,500 --> 00:00:08,000',
      'Atenção: ação, coração, pão, maçã — “aspas” e ç.',
      ''
    ].join('\r\n')
    const r = parseSrt(real)
    expect(r.warnings).toEqual([])
    expect(r.cues).toEqual([
      { startUs: 500_000, endUs: 2_840_000, text: 'Olá! Bem-vindo à apresentação\nda Cia Light.' },
      { startUs: 2_840_000, endUs: 5_120_000, text: 'Hoje vamos ver as luminárias de\nemergência e a instalação elétrica.' },
      { startUs: 5_500_000, endUs: 8_000_000, text: 'Atenção: ação, coração, pão, maçã — “aspas” e ç.' }
    ])
  })
})

describe('serializeSrt', () => {
  it('índices 1..n, HH:MM:SS,mmm, \\r\\n e linha em branco entre blocos', () => {
    const s = serializeSrt([
      { startUs: 1_000_000, endUs: 2_500_000, text: 'Olá' },
      { startUs: ms(1, 2, 3, 4), endUs: ms(1, 2, 5, 0), text: 'Linha 1\nLinha 2' }
    ])
    expect(s).toBe('1\r\n00:00:01,000 --> 00:00:02,500\r\nOlá\r\n\r\n2\r\n01:02:03,004 --> 01:02:05,000\r\nLinha 1\r\nLinha 2\r\n')
  })

  it('arredonda ao milissegundo (Math.round)', () => {
    const s = serializeSrt([{ startUs: 1_000_499, endUs: 1_999_500, text: 'x' }])
    expect(s).toContain('00:00:01,000 --> 00:00:02,000')
  })

  it('lista vazia → texto vazio', () => {
    expect(serializeSrt([])).toBe('')
  })

  it('ida e volta: parseSrt(serializeSrt(c)) = c (em ms)', () => {
    const cues: Cue[] = [
      { startUs: 0, endUs: 1_234_000, text: 'Começo' },
      { startUs: 1_234_000, endUs: 3_000_000, text: 'Duas\nlinhas' },
      { startUs: ms(0, 59, 59, 999), endUs: ms(1, 0, 1, 1), text: 'Virada da hora — ç ã é' },
      { startUs: ms(12, 0, 0, 0), endUs: ms(12, 0, 0, 1), text: '1 ms' }
    ]
    const r = parseSrt(serializeSrt(cues))
    expect(r.warnings).toEqual([])
    expect(r.cues).toEqual(cues)
  })
})

describe('tempo da lista de legendas (mm:ss,mmm)', () => {
  it('formata', () => {
    expect(formatCueTime(0)).toBe('00:00,000')
    expect(formatCueTime(61_234_000)).toBe('01:01,234')
    expect(formatCueTime(1_000_600)).toBe('00:01,001')
    expect(formatCueTime(ms(1, 2, 3, 4))).toBe('1:02:03,004')
  })
  it('lê mm:ss,mmm, ss,mmm, h:mm:ss.mmm; inválido → null', () => {
    expect(parseCueTime('01:01,234')).toBe(61_234_000)
    expect(parseCueTime(' 1:01.5 ')).toBe(61_500_000)
    expect(parseCueTime('5,25')).toBe(5_250_000)
    expect(parseCueTime('12')).toBe(12_000_000)
    expect(parseCueTime('1:02:03,004')).toBe(ms(1, 2, 3, 4))
    expect(parseCueTime('abc')).toBeNull()
    expect(parseCueTime('00:61,000')).toBeNull()
    expect(parseCueTime('')).toBeNull()
  })
})

describe('cuesForRange (exportação de um trecho)', () => {
  it('corta nas bordas, desloca para 0 = início do trecho e tira as de fora', () => {
    const cues: Cue[] = [
      { startUs: 0, endUs: 1_000_000, text: 'antes' },
      { startUs: 1_500_000, endUs: 2_500_000, text: 'borda' },
      { startUs: 3_000_000, endUs: 4_000_000, text: 'dentro' },
      { startUs: 4_500_000, endUs: 6_000_000, text: 'fim' },
      { startUs: 6_000_000, endUs: 7_000_000, text: 'depois' }
    ]
    expect(cuesForRange(cues, 2_000_000, 5_000_000)).toEqual([
      { startUs: 0, endUs: 500_000, text: 'borda' },
      { startUs: 1_000_000, endUs: 2_000_000, text: 'dentro' },
      { startUs: 2_500_000, endUs: 3_000_000, text: 'fim' }
    ])
    expect(cuesForRange(cues, 0, 10_000_000)).toEqual(cues)
  })
})
