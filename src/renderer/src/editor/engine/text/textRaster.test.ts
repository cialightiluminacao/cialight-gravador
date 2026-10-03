import { describe, expect, it } from 'vitest'
import type { ResolvedTextStyle } from '@shared/editor/resolve'
import { RasterCache } from './rasterCache'
import { cssFont, fontPx, layoutText, lineX, textBoxPx, textCacheKey, type MeasureCtx } from './textRaster'

// Medidor falso (sem canvas no vitest/node): cada caractere mede meia "em" do tamanho em px de ctx.font.
function fakeCtx(): MeasureCtx {
  return {
    font: '',
    measureText(s: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 0)
      return { width: s.length * px * 0.5 }
    }
  }
}

const style = (over: Partial<ResolvedTextStyle> = {}): ResolvedTextStyle => ({ font: 'Manrope Variable', size: 100, weight: 700, color: '#ffffff', align: 'center', lineHeight: 1.2, ...over })
const F1080 = { W: 1920, H: 1080 }
const F720 = { W: 1280, H: 720 }

describe('textRaster: unidades e fonte', () => {
  it('tamanho em px = size · lado menor / 1080', () => {
    expect(fontPx(100, F1080)).toBe(100)
    expect(fontPx(100, F720)).toBeCloseTo(66.6667, 3)
    expect(fontPx(100, { W: 1080, H: 1920 })).toBe(100) // vertical: lado menor = largura
  })
  it('fonte CSS: itálico, peso, família entre aspas e sempre com sans-serif', () => {
    expect(cssFont(style(), 50)).toBe('normal 700 50px "Manrope Variable", sans-serif')
    expect(cssFont(style({ italic: true, weight: 400, font: 'Arial' }), 12.5)).toBe('italic 400 12.5px "Arial", sans-serif')
    expect(cssFont(style({ font: '"Segoe UI"' }), 10)).toBe('normal 700 10px "Segoe UI", sans-serif')
  })
})

describe('layoutText', () => {
  it('\\n explícito: uma linha por parágrafo (linha vazia conta)', () => {
    const l = layoutText('AB\n\nABCD', style(), F1080, fakeCtx())
    expect(l.lines).toEqual(['AB', '', 'ABCD'])
    expect(l.widths).toEqual([100, 0, 200])
    expect(l.textW).toBe(200)
    expect(l.textH).toBeCloseTo(3 * 100 * 1.2)
  })
  it('sem maxWidth: nunca quebra sozinho', () => {
    const t = 'palavra '.repeat(40).trim()
    expect(layoutText(t, style(), F1080, fakeCtx()).lines).toEqual([t])
  })
  it('quebra por palavra com maxWidth (fração de W)', () => {
    // 0,3 × 1920 = 576 px = 11 caracteres de 50 px
    const l = layoutText('aaaa bbbb cccc dddd', style({ maxWidth: 0.3 }), F1080, fakeCtx())
    expect(l.lines).toEqual(['aaaa bbbb', 'cccc dddd'])
    expect(Math.max(...l.widths)).toBeLessThanOrEqual(576)
  })
  it('palavra maior que a largura é quebrada por caractere', () => {
    const l = layoutText('ab ' + 'x'.repeat(25) + ' cd', style({ maxWidth: 0.3 }), F1080, fakeCtx())
    expect(l.lines).toEqual(['ab', 'x'.repeat(11), 'x'.repeat(11), 'xxx cd'])
    for (const w of l.widths) expect(w).toBeLessThanOrEqual(576)
  })
  it('caixa: padding 0,3 em com fundo, 0 sem; padding explícito', () => {
    const plain = layoutText('ABCD', style(), F1080, fakeCtx())
    expect([plain.pad, plain.boxW, plain.boxH]).toEqual([0, 200, 120])
    const bg = layoutText('ABCD', style({ background: '#2050ff' }), F1080, fakeCtx())
    expect(bg.pad).toBeCloseTo(30)
    expect(bg.boxW).toBeCloseTo(260)
    expect(bg.boxH).toBeCloseTo(180)
    expect(layoutText('ABCD', style({ background: '#000', padding: 0.5 }), F1080, fakeCtx()).pad).toBeCloseTo(50)
  })
  it('720p é a mesma caixa proporcional da de 1080p (× 2/3)', () => {
    const s = style({ background: '#000', maxWidth: 0.3 })
    const a = layoutText('aaaa bbbb cccc dddd', s, F1080, fakeCtx())
    const b = layoutText('aaaa bbbb cccc dddd', s, F720, fakeCtx())
    expect(b.lines).toEqual(a.lines)
    expect(b.boxW).toBeCloseTo((a.boxW * 2) / 3, 1) // px da fonte arredondado a 0,001 na string CSS
    expect(b.boxH).toBeCloseTo((a.boxH * 2) / 3, 6)
  })
  it('alinhamento dentro da caixa (x da âncora do fillText de cada linha)', () => {
    const l = layoutText('AB\nABCD', style({ background: '#000' }), F1080, fakeCtx())
    expect(lineX(l, 'left')).toBeCloseTo(30)
    expect(lineX(l, 'center')).toBeCloseTo(l.boxW / 2)
    expect(lineX(l, 'right')).toBeCloseTo(l.boxW - 30)
  })
  it('textBoxPx: caixa do desenho × escala do transform', () => {
    const l = layoutText('ABCD', style({ background: '#000' }), F1080, fakeCtx())
    expect(textBoxPx(l, 2)).toEqual({ w: l.boxW * 2, h: l.boxH * 2 })
  })
})

describe('chave do cache', () => {
  it('muda com texto, estilo resolvido e tamanho do quadro; não com o transform', () => {
    const base = { text: 'Olá', style: style() }
    const k = textCacheKey(base, F1080)
    expect(textCacheKey({ ...base }, F1080)).toBe(k)
    expect(textCacheKey({ ...base, text: 'Olá!' }, F1080)).not.toBe(k)
    expect(textCacheKey({ ...base, style: style({ size: 101 }) }, F1080)).not.toBe(k)
    expect(textCacheKey({ ...base, style: style({ color: '#000000' }) }, F1080)).not.toBe(k)
    expect(textCacheKey(base, F720)).not.toBe(k)
  })
})

describe('RasterCache (LRU)', () => {
  it('expulsa a menos recente ao passar de N entradas e libera (onEvict)', () => {
    const freed: string[] = []
    const c = new RasterCache<string>({ maxEntries: 3, maxBytes: 1e9, onEvict: (v) => freed.push(v) })
    c.set('a', 'A', 1)
    c.set('b', 'B', 1)
    c.set('c', 'C', 1)
    expect(c.get('a')).toBe('A') // a vira a mais recente
    c.set('d', 'D', 1)
    expect(freed).toEqual(['B'])
    expect(c.get('b')).toBeUndefined()
    expect(c.size).toBe(3)
  })
  it('limite de bytes; entrada sozinha maior que o limite fica', () => {
    const freed: string[] = []
    const c = new RasterCache<string>({ maxEntries: 100, maxBytes: 10, onEvict: (v) => freed.push(v) })
    c.set('a', 'A', 4)
    c.set('b', 'B', 4)
    c.set('c', 'C', 4)
    expect(freed).toEqual(['A'])
    expect(c.bytes).toBe(8)
    c.set('big', 'BIG', 50)
    expect(freed).toEqual(['A', 'B', 'C'])
    expect(c.get('big')).toBe('BIG')
    expect(c.bytes).toBe(50)
  })
  it('substituir a mesma chave libera a antiga; clear libera tudo', () => {
    const freed: string[] = []
    const c = new RasterCache<string>({ onEvict: (v) => freed.push(v) })
    c.set('a', 'A1', 1)
    c.set('a', 'A2', 1)
    expect(freed).toEqual(['A1'])
    c.set('b', 'B', 1)
    c.clear()
    expect(freed).toEqual(['A1', 'A2', 'B'])
    expect([c.size, c.bytes]).toEqual([0, 0])
  })
  it('padrão: 64 entradas', () => {
    const c = new RasterCache<number>()
    for (let i = 0; i < 70; i++) c.set(String(i), i, 1)
    expect(c.size).toBe(64)
    expect(c.get('5')).toBeUndefined()
    expect(c.get('6')).toBe(6)
  })
})
