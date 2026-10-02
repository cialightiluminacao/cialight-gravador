import { describe, expect, it } from 'vitest'
import { decodeSrtBytes, encodeSrtFile, srtBesidePath } from './srtFiles'

const TEXT = '1\r\n00:00:01,000 --> 00:00:02,000\r\nAção — coração “ok”\r\n'

describe('decodeSrtBytes', () => {
  it('BOM UTF-8', () => {
    expect(decodeSrtBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(TEXT, 'utf8')]))).toBe(TEXT)
  })
  it('BOM UTF-16 LE e BE', () => {
    const le = Buffer.from(TEXT, 'utf16le')
    expect(decodeSrtBytes(new Uint8Array([0xff, 0xfe, ...le]))).toBe(TEXT)
    const be = Buffer.from(le)
    be.swap16()
    expect(decodeSrtBytes(new Uint8Array([0xfe, 0xff, ...be]))).toBe(TEXT)
  })
  it('sem BOM: UTF-8 válido', () => {
    expect(decodeSrtBytes(new Uint8Array(Buffer.from(TEXT, 'utf8')))).toBe(TEXT)
  })
  it('sem BOM e UTF-8 inválido: Windows-1252 (acentos e aspas curvas)', () => {
    // "Ação “ok”" em cp1252: A=41 ç=E7 ã=E3 o=6F espaço “=93 o k ”=94
    const bytes = new Uint8Array([0x41, 0xe7, 0xe3, 0x6f, 0x20, 0x93, 0x6f, 0x6b, 0x94])
    expect(decodeSrtBytes(bytes)).toBe('Ação “ok”')
  })
})

describe('encodeSrtFile', () => {
  it('UTF-8 com BOM', () => {
    const b = encodeSrtFile(TEXT)
    expect([...b.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(decodeSrtBytes(new Uint8Array(b))).toBe(TEXT)
    expect(b.subarray(3).toString('utf8')).toBe(TEXT)
  })
})

describe('srtBesidePath', () => {
  it('troca a extensão do vídeo por .srt (nome numerado incluso)', () => {
    expect(srtBesidePath('C:\\Vídeos\\Aula (2).mp4')).toBe('C:\\Vídeos\\Aula (2).srt')
    expect(srtBesidePath('C:/x/a.b.MP4')).toBe('C:/x/a.b.srt')
    expect(srtBesidePath('C:/x/sem-extensao')).toBe('C:/x/sem-extensao.srt')
  })
})
