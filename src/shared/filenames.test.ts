import { describe, expect, it } from 'vitest'
import { defaultOutputName, numberedName, sanitizeFileName, sessionIdFor, uniqueName } from './filenames'

describe('sessionIdFor', () => {
  it('formata com zero à esquerda', () => {
    expect(sessionIdFor(new Date(2026, 7, 18, 14, 32, 5))).toBe('2026-08-18T14-32-05')
    expect(sessionIdFor(new Date(2026, 0, 3, 9, 4, 0))).toBe('2026-01-03T09-04-00')
  })
})

describe('defaultOutputName', () => {
  it('gera "Gravação AAAA-MM-DD HH-MM.mp4"', () => {
    expect(defaultOutputName(new Date(2026, 7, 18, 14, 32, 5))).toBe('Gravação 2026-08-18 14-32.mp4')
  })
  it('aceita outra extensão (com ou sem ponto)', () => {
    const d = new Date(2026, 7, 18, 14, 32, 5)
    expect(defaultOutputName(d, 'mkv')).toBe('Gravação 2026-08-18 14-32.mkv')
    expect(defaultOutputName(d, '.mkv')).toBe('Gravação 2026-08-18 14-32.mkv')
  })
})

describe('sanitizeFileName', () => {
  it('remove caracteres proibidos no Windows', () => {
    expect(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j')).toBe('abcdefghij')
  })
  it('remove caracteres de controle', () => {
    expect(sanitizeFileName('abc' + String.fromCharCode(0, 1, 31) + 'def' + String.fromCharCode(127))).toBe('abcdef')
  })
  it('colapsa espaços e faz trim', () => {
    expect(sanitizeFileName('  meu   vídeo   final  ')).toBe('meu vídeo final')
    expect(sanitizeFileName('a\t\tb\n c')).toBe('a b c')
  })
  it('remove pontos/espaços finais (inválidos no Windows)', () => {
    expect(sanitizeFileName('nome. ')).toBe('nome')
    expect(sanitizeFileName('nome...')).toBe('nome')
  })
  it('limita a 120 caracteres', () => {
    const longo = 'x'.repeat(200)
    expect(sanitizeFileName(longo)).toHaveLength(120)
    expect(sanitizeFileName(longo + '.mp4')).toHaveLength(120)
  })
  it('mantém a extensão ao truncar', () => {
    const r = sanitizeFileName('y'.repeat(200) + '.mp4')
    expect(r.endsWith('.mp4')).toBe(true)
    expect(r).toHaveLength(120)
  })
  it('string vazia ou só inválidos → string vazia', () => {
    expect(sanitizeFileName('')).toBe('')
    expect(sanitizeFileName('***')).toBe('')
    expect(sanitizeFileName('   ')).toBe('')
  })
})

describe('uniqueName', () => {
  it('sem conflito devolve o próprio nome', () => {
    expect(uniqueName(new Set(), 'x.mp4')).toBe('x.mp4')
    expect(uniqueName(new Set(['y.mp4']), 'x.mp4')).toBe('x.mp4')
  })
  it('gera -2, -3, … até achar livre', () => {
    expect(uniqueName(new Set(['x.mp4']), 'x.mp4')).toBe('x-2.mp4')
    expect(uniqueName(new Set(['x.mp4', 'x-2.mp4']), 'x.mp4')).toBe('x-3.mp4')
    expect(uniqueName(new Set(['x.mp4', 'x-2.mp4', 'x-3.mp4']), 'x.mp4')).toBe('x-4.mp4')
  })
  it('funciona sem extensão', () => {
    expect(uniqueName(new Set(['pasta']), 'pasta')).toBe('pasta-2')
  })
  it('só considera a última extensão', () => {
    expect(uniqueName(new Set(['a.b.mp4']), 'a.b.mp4')).toBe('a.b-2.mp4')
  })
  it('compara sem diferenciar maiúsculas (Windows)', () => {
    expect(uniqueName(new Set(['X.MP4']), 'x.mp4')).toBe('x-2.mp4')
  })
})

describe('numberedName', () => {
  it('nome livre fica igual; ocupado ganha " (2)", " (3)"…', () => {
    expect(numberedName('Vídeo.mp4', () => false)).toBe('Vídeo.mp4')
    const taken = new Set(['vídeo.mp4', 'vídeo (2).mp4'])
    expect(numberedName('Vídeo.mp4', (n) => taken.has(n.toLowerCase()))).toBe('Vídeo (3).mp4')
  })
  it('sem extensão', () => {
    expect(numberedName('x', (n) => n === 'x')).toBe('x (2)')
  })
})
