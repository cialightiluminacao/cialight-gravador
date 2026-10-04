import { describe, expect, it } from 'vitest'
import { CAPTION_SEGMENT_DEFAULTS as D, segmentCaptions } from './captionSegment'

const S = 1_000_000
const w = (text: string, startS: number, endS: number): { text: string; startUs: number; endUs: number } => ({ text, startUs: Math.round(startS * S), endUs: Math.round(endS * S) })
/** n palavras "pN" de 0,3 s, uma a cada `stepS`, a partir de t0. */
const run = (n: number, t0 = 0, stepS = 0.3, text = (i: number): string => `p${i}`): ReturnType<typeof w>[] => Array.from({ length: n }, (_, i) => w(text(i), t0 + i * stepS, t0 + i * stepS + 0.28))
const flat = (cues: { text: string }[]): string[] => cues.flatMap((c) => c.text.split(/\s+/))

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('segmentCaptions', () => {
  it('vazio e palavras em branco → []; trim e espaços internos colapsados', () => {
    expect(segmentCaptions([])).toEqual([])
    expect(segmentCaptions([w('  ', 0, 1), w('', 1, 2)])).toEqual([])
    const c = segmentCaptions([w(' olá,', 0, 0.4), w('  mundo.', 0.4, 1.2), w('a\n b', 1.2, 1.5)])
    expect(c.map((x) => x.text)).toEqual(['olá, mundo.', 'a b'])
  })

  it('pausa: silêncio de 0,6 s quebra, 0,59 s não', () => {
    const split = segmentCaptions([w('um', 0, 0.5), w('dois', 1.1, 1.6), w('três', 1.7, 2.6)])
    expect(split.map((c) => c.text)).toEqual(['um', 'dois três'])
    const joined = segmentCaptions([w('um', 0, 0.5), w('dois', 1.09, 1.6), w('três', 1.7, 2.6)])
    expect(joined.map((c) => c.text)).toEqual(['um dois três'])
  })

  it('pontuação final quebra quando a cue já dura ≥ 1 s; antes disso não', () => {
    const long = segmentCaptions([w('Eu', 0, 0.5), w('vou.', 0.5, 1.2), w('Agora', 1.2, 1.7), w('não.', 1.7, 2.4)])
    expect(long.map((c) => c.text)).toEqual(['Eu vou.', 'Agora não.'])
    const short = segmentCaptions([w('Sim.', 0, 0.4), w('Claro', 0.4, 0.9), w('que', 0.9, 1.2), w('sim.', 1.2, 1.8)])
    expect(short.map((c) => c.text)).toEqual(['Sim. Claro que sim.'])
  })

  it('vírgula: quebra só com o texto a ≥ 60 % da capacidade (84 caracteres)', () => {
    const base = Array.from({ length: 12 }, (_, i) => w(`palavra${i % 10}`, i * 0.4, i * 0.4 + 0.35)) // 12 × 8 + 11 = 107 > 84 -> usa 8
    // 7 palavras de 8 chars = 62 chars (≥ 50,4): vírgula na 7ª quebra; na 3ª (26 chars) não
    const text = base.map((x, i) => (i === 2 || i === 6 ? { ...x, text: x.text + ',' } : x))
    const c = segmentCaptions(text)
    expect(c[0].text.replace('\n', ' ').split(' ')).toHaveLength(7)
    expect(c[0].text).toContain('palavra2,')
    expect(c[1].text.split(/\s+/)).toHaveLength(5)
  })

  it('fala contínua longa: quebra por caracteres (≤ 2 × 42) e por tempo (≤ 6 s)', () => {
    const words = run(400, 0, 0.3, (i) => `palavra${i % 100}`)
    const cues = segmentCaptions(words)
    expect(cues.length).toBeGreaterThan(20)
    for (const c of cues) {
      const lines = c.text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(2)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42)
      expect(c.endUs - c.startUs).toBeLessThanOrEqual(D.maxCueUs)
    }
    expect(flat(cues)).toEqual(words.map((x) => x.text))
    // palavras curtas e rápidas: o limite de tempo aparece
    const fast = segmentCaptions(run(200, 0, 0.1, () => 'a'))
    for (const c of fast) expect(c.endUs - c.startUs).toBeLessThanOrEqual(D.maxCueUs)
    expect(fast.length).toBeGreaterThanOrEqual(3)
  })

  it('duas linhas equilibradas (a maior mínima), cada uma ≤ 42', () => {
    const words = ['uma', 'frase', 'comprida', 'para', 'testar', 'a', 'quebra', 'balanceada', 'direito'].map((t, i) => w(t, i * 0.3, i * 0.3 + 0.28))
    const [c] = segmentCaptions(words)
    const total = words.map((x) => x.text).join(' ')
    expect(total.length).toBe(58)
    expect(c.text.split('\n')).toEqual(['uma frase comprida para testar', 'a quebra balanceada direito'])
  })

  it('palavra de 50 caracteres fica sozinha na linha (único estouro)', () => {
    const big = 'x'.repeat(50)
    const [c] = segmentCaptions([w('de', 0, 0.3), w(big, 0.3, 1.0)])
    expect(c.text).toBe(`de\n${big}`)
    expect(segmentCaptions([w(big, 0, 1)])[0].text).toBe(big)
    // não cabe nada junto com ela na 2ª linha: quebra de cue
    const cs = segmentCaptions([w('a', 0, 0.3), w(big, 0.3, 1.0), w('b', 1.0, 1.3), w('c', 1.3, 2.4)])
    for (const c2 of cs) expect(c2.text.split('\n').filter((l) => l.length > 42)).toEqual([big].slice(0, c2.text.includes(big) ? 1 : 0))
  })

  it('"Sim." isolado de 0,2 s com a próxima fala 3 s depois: ≥ 1 s e termina antes da fala', () => {
    const c = segmentCaptions([w('Sim.', 5, 5.2), w('Então', 8.2, 8.7), w('vamos', 8.7, 9.2)])
    expect(c[0].text).toBe('Sim.')
    expect(c[0].startUs).toBe(5 * S)
    expect(c[0].endUs - c[0].startUs).toBeGreaterThanOrEqual(S)
    expect(c[0].endUs).toBeLessThanOrEqual(8.2 * S)
  })

  it('palavra mínima com a próxima fala 0,65 s depois: ≥ 0,7 s, sem passar do início da fala', () => {
    const c = segmentCaptions([w('Ah', 0, 0.1), w('bom', 0.75, 1.4)])
    expect(c).toHaveLength(2)
    expect(c[0].endUs - c[0].startUs).toBeGreaterThanOrEqual(D.minCueUs)
    expect(c[0].endUs).toBeLessThanOrEqual(0.75 * S)
    // sem espaço no vão (0,3 s < pausa): funde com a seguinte
    const m = segmentCaptions([w('Ah', 0, 0.1), w('bom', 0.4, 0.5)])
    expect(m.map((x) => x.text)).toEqual(['Ah bom'])
  })

  it('cue curta presa entre vizinhas: puxa o início para trás no silêncio, sem tocar a anterior', () => {
    // anterior [0, 1,5]; curta 0,1 s em [2,2; 2,3]; seguinte começa em 2,4 s (vão ≥ pausa antes dela, 0,1 depois)
    const c = segmentCaptions([w('aaa.', 0, 1.5), w('x', 2.2, 2.3), w('bbb', 2.4, 3.6)])
    // x funde com a seguinte (vão 0,1 < pausa)
    expect(c.map((x) => x.text)).toEqual(['aaa.', 'x bbb'])
    for (const q of c) expect(q.endUs - q.startUs).toBeGreaterThanOrEqual(D.minCueUs)
  })

  it('entrada fora de ordem é ordenada; e estende ao alvo de 1 s sem próxima fala', () => {
    const c = segmentCaptions([w('mundo', 0.3, 0.5), w('olá', 0, 0.3)])
    expect(c).toEqual([{ startUs: 0, endUs: S, text: 'olá mundo' }])
  })

  it('opções parciais', () => {
    const c = segmentCaptions(run(10), { maxLineChars: 10, maxLines: 1 })
    for (const q of c) expect(q.text.includes('\n')).toBe(false)
    expect(c.length).toBeGreaterThan(1)
  })

  it('propriedade (600 fluxos aleatórios): todos os invariantes', () => {
    const rnd = mulberry32(20261003)
    for (let seed = 0; seed < 600; seed++) {
      const n = 1 + Math.floor(rnd() * 120)
      let t = rnd() * 3
      const words: { text: string; startUs: number; endUs: number }[] = []
      const puncts = ['', '', '', '', ',', '.', '?', '!', ';', '…']
      for (let k = 0; k < n; k++) {
        const dur = 0.1 + rnd() * 0.7
        const len = 1 + Math.floor(rnd() * 15)
        const gap = rnd() < 0.3 ? rnd() * 2 : rnd() * 0.3
        const text = 'abcdefghijklmno'.slice(0, len) + puncts[Math.floor(rnd() * puncts.length)]
        const startUs = Math.round(t * S)
        const endUs = Math.round((t + dur) * S)
        words.push({ text: ` ${text}`, startUs, endUs })
        t += dur + gap
      }
      const cues = segmentCaptions(words)
      const ctx = `seed ${seed}`
      const spanUs = words[words.length - 1].endUs - words[0].startUs
      expect(cues.length, ctx).toBeGreaterThan(0)
      let wi = 0
      for (let k = 0; k < cues.length; k++) {
        const c = cues[k]
        expect(Number.isInteger(c.startUs) && Number.isInteger(c.endUs), ctx).toBe(true)
        expect(c.startUs, ctx).toBeGreaterThanOrEqual(0)
        if (k > 0) expect(c.startUs, ctx).toBeGreaterThanOrEqual(cues[k - 1].endUs)
        const dur = c.endUs - c.startUs
        expect(dur, `${ctx} cue ${k}`).toBeLessThanOrEqual(D.maxCueUs)
        if (spanUs >= D.minCueUs) expect(dur, `${ctx} cue ${k} ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(D.minCueUs)
        const lines = c.text.split('\n')
        expect(lines.length, ctx).toBeLessThanOrEqual(D.maxLines)
        for (const l of lines) expect(l.length, ctx).toBeLessThanOrEqual(D.maxLineChars)
        // palavras desta cue, na ordem, cada uma exatamente uma vez
        const toks = c.text.split(/\s+/)
        const mine = words.slice(wi, wi + toks.length)
        expect(toks, ctx).toEqual(mine.map((x) => x.text.trim()))
        // início/fim cobrem as palavras; nenhum vão interno ≥ pausa
        expect(c.startUs, ctx).toBeLessThanOrEqual(mine[0].startUs)
        for (let q = 1; q < mine.length; q++) expect(mine[q].startUs - mine[q - 1].endUs, ctx).toBeLessThan(D.pauseBreakUs)
        // o fim nunca passa do início da próxima palavra
        const nextWord = words[wi + toks.length]
        if (nextWord) expect(c.endUs, ctx).toBeLessThanOrEqual(nextWord.startUs)
        wi += toks.length
      }
      expect(wi, ctx).toBe(words.length)
    }
  })

  it('desempenho: 20 000 palavras < 50 ms (melhor de 3)', { timeout: 30_000, retry: 2 }, () => {
    const rnd = mulberry32(7)
    let t = 0
    const words = Array.from({ length: 20_000 }, (_, i) => {
      const dur = 0.15 + rnd() * 0.4
      const x = { text: `palavra${i % 30}${i % 7 === 0 ? ',' : i % 11 === 0 ? '.' : ''}`, startUs: Math.round(t * S), endUs: Math.round((t + dur) * S) }
      t += dur + (rnd() < 0.1 ? 0.8 : 0.05)
      return x
    })
    let best = Infinity
    let n = 0
    for (let i = 0; i < 3 && best >= 50; i++) {
      const t0 = performance.now()
      n = segmentCaptions(words).length
      best = Math.min(best, performance.now() - t0)
    }
    console.log(`[perf] segmentCaptions 20000 palavras: ${best.toFixed(1)} ms (${n} cues)`)
    expect(best).toBeLessThan(50)
  })
})
