import { describe, expect, it } from 'vitest'
import type { Marker } from './project'
import { baseName, chaptersFromMarkers, formatChapterTime, joinDefaultPath, MIN_CHAPTER_GAP_US } from './chapters'

const S = 1_000_000
const mk = (tSec: number, label = 'x'): Marker => ({ id: `m${tSec}`, tUs: Math.round(tSec * S), label, color: '#f59e0b' })
const R = { fromUs: 0, toUs: 600 * S }

describe('formatChapterTime', () => {
  it('formata MM:SS truncando os segundos', () => {
    expect(formatChapterTime(0, false)).toBe('00:00')
    expect(formatChapterTime(725 * S, false)).toBe('12:05')
    expect(formatChapterTime(59_999_999, false)).toBe('00:59')
  })
  it('formata H:MM:SS', () => {
    expect(formatChapterTime(3723 * S, true)).toBe('1:02:03')
    expect(formatChapterTime(5 * S, true)).toBe('0:00:05')
    expect(formatChapterTime(3_599_999_000, true)).toBe('0:59:59')
  })
})

describe('chaptersFromMarkers', () => {
  it('lista normal com marcador em 0', () => {
    const r = chaptersFromMarkers([mk(0, 'Início'), mk(65, 'Meio'), mk(130, 'Fim')], R)
    expect(r.text).toBe('00:00 Início\n01:05 Meio\n02:10 Fim')
    expect(r.warnings).toEqual([])
  })
  it('insere Introdução quando não há marcador em 0', () => {
    const r = chaptersFromMarkers([mk(30, 'A'), mk(90, 'B')], R)
    expect(r.chapters.map((c) => c.label)).toEqual(['Introdução', 'A', 'B'])
    expect(r.chapters[0].tUs).toBe(0)
  })
  it('marcador em [0, 1 s) vira 00:00 (sem Introdução); em 1 s exato não', () => {
    const a = chaptersFromMarkers([mk(0.9, 'A'), mk(30, 'B'), mk(60, 'C')], R)
    expect(a.text).toBe('00:00 A\n00:30 B\n01:00 C')
    const b = chaptersFromMarkers([mk(1, 'A'), mk(30, 'B'), mk(60, 'C')], R)
    expect(b.chapters[0].label).toBe('Introdução')
  })
  it('descarta marcadores fora do intervalo e usa tempo relativo (I–O)', () => {
    const r = chaptersFromMarkers([mk(5, 'fora'), mk(100, 'A'), mk(140, 'B'), mk(200, 'fim')], { fromUs: 100 * S, toUs: 200 * S })
    expect(r.text).toBe('00:00 A\n00:40 B')
  })
  it('ordena e rotula vazios como Capítulo N (posição final), tira espaços e quebras', () => {
    const r = chaptersFromMarkers([mk(60, '  '), mk(20, ' a\nb \r\n c '), mk(0, '')], R)
    expect(r.chapters.map((c) => c.label)).toEqual(['Capítulo 1', 'a b c', 'Capítulo 3'])
  })
  it('mesmo segundo: mantém o primeiro e avisa', () => {
    const r = chaptersFromMarkers([mk(20.2, 'A'), mk(20.8, 'B'), mk(40, 'C')], R)
    expect(r.chapters.map((c) => c.label)).toEqual(['Introdução', 'A', 'C'])
    expect(r.warnings).toEqual(['Marcadores no mesmo segundo: só o primeiro foi mantido; descartado: 00:20 "B"'])
  })
  it('sem marcadores no intervalo', () => {
    const r = chaptersFromMarkers([mk(700)], R)
    expect(r).toEqual({ chapters: [], text: '', warnings: ['Nenhum marcador no intervalo'] })
    expect(chaptersFromMarkers([], R).chapters).toEqual([])
  })
  it('avisa com menos de 3 capítulos sem alterar a lista', () => {
    const r = chaptersFromMarkers([mk(0, 'A'), mk(100, 'B')], R)
    expect(r.chapters).toHaveLength(2)
    expect(r.warnings).toContain('O YouTube exige pelo menos 3 capítulos')
  })
  it('intervalo de exatamente 10 s é aceito; 9,999 s avisa', () => {
    expect(MIN_CHAPTER_GAP_US).toBe(10 * S)
    const ok = chaptersFromMarkers([mk(0, 'A'), mk(10, 'B'), mk(20, 'C')], { fromUs: 0, toUs: 30 * S })
    expect(ok.warnings).toEqual([])
    const bad = chaptersFromMarkers([mk(0, 'A'), mk(10, 'B'), mk(20, 'C')], { fromUs: 0, toUs: 29_999_000 })
    expect(bad.warnings).toEqual(['Capítulos com menos de 10 s: 00:20'])
    const mid = chaptersFromMarkers([mk(0, 'A'), mk(9.999, 'B'), mk(40, 'C')], R)
    expect(mid.warnings).toEqual(['Capítulos com menos de 10 s: 00:00'])
  })
  it('horas: 59:59.999 usa MM:SS, 1:00:00 usa H:MM:SS em todas as linhas', () => {
    const ms = [mk(0, 'A'), mk(100, 'B'), mk(200, 'C')]
    expect(chaptersFromMarkers(ms, { fromUs: 0, toUs: 3_599_999_000 }).text).toBe('00:00 A\n01:40 B\n03:20 C')
    expect(chaptersFromMarkers(ms, { fromUs: 0, toUs: 3_600 * S }).text).toBe('0:00:00 A\n0:01:40 B\n0:03:20 C')
  })
  it('1000 marcadores: rápido e ordenado', () => {
    const ms = Array.from({ length: 1000 }, (_, i) => mk((999 - i) * 11, `c${i}`))
    const t0 = performance.now()
    const r = chaptersFromMarkers(ms, { fromUs: 0, toUs: 11_100 * S })
    expect(performance.now() - t0).toBeLessThan(200)
    expect(r.chapters).toHaveLength(1000)
    expect(r.chapters.every((c, i) => i === 0 || c.tUs > r.chapters[i - 1].tUs)).toBe(true)
  })
})

describe('caminhos do .txt', () => {
  const n = 'Visão geral - capítulos.txt'
  it('junta pasta e nome com o separador certo', () => {
    expect(joinDefaultPath('C:\\a\\b\\', n)).toBe('C:\\a\\b\\' + n)
    expect(joinDefaultPath('C:\\a\\b', n)).toBe('C:\\a\\b\\' + n)
    expect(joinDefaultPath('C:/a/b', n)).toBe('C:/a/b/' + n)
    expect(joinDefaultPath('C:/a/b//', n)).toBe('C:/a/b/' + n)
    expect(joinDefaultPath(null, n)).toBe(n)
    expect(joinDefaultPath('', n)).toBe(n)
  })
  it('baseName com barra invertida e normal', () => {
    expect(baseName('C:\\a\\b\\x.txt')).toBe('x.txt')
    expect(baseName('C:/a/b/x.txt')).toBe('x.txt')
    expect(baseName('x.txt')).toBe('x.txt')
  })
})
