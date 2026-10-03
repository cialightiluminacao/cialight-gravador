import { describe, expect, it } from 'vitest'
import { evalAnim } from './anim'
import { createEmptyProject, defaultVisual } from './factory'
import type { Anim, Asset, Ease, Item, MediaItem, Project, TextItem } from './project'
import * as ops from './ops'
import { resolveFrame, type MediaLayer, type TextLayer } from './resolve'

// F4: todas as propriedades numéricas animáveis passam pelas mesmas operações que transform/volume.
const S = 1_000_000
const vid = (): Asset => ({ id: 'a1', name: 'a1', kind: 'video', source: { type: 'file', path: 'C:/a.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
const curve = (a: number, b: number, ease: Ease = 'in', t0 = 0, t1 = 10 * S): Anim<number> => ({ value: a, keys: [{ tUs: t0, value: a, ease }, { tUs: t1, value: b, ease: 'linear' }] })

/** Clipe de vídeo [0,10) com corte, ajuste e raio animados (curvas não lineares) + texto [0,10) com tamanho animado. */
function base(): { p: Project; v: string; txt: string } {
  const r = ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid()), 'a1', 0)
  const v = r.itemIds[0]
  let p = ops.trimItem(r.project, v, 'end', 10 * S, { includeLinked: true })
  p = ops.updateItem<MediaItem>(p, v, (d) => {
    d.visual!.crop.l = curve(0, 0.4, 'in')
    d.visual!.adjust = { brightness: curve(0, 0.5, 'out'), contrast: { value: 0.1 }, saturation: { value: 0 } }
    d.visual!.radius = curve(0, 40, { bezier: [0.3, 0, 0.2, 1] })
    d.visual!.shape = 'rounded'
  })
  const txt: TextItem = {
    id: 'txt', type: 'text', startUs: 0, durationUs: 10 * S, text: 'Oi',
    style: { font: 'Inter', size: curve(20, 80, 'inOut'), weight: 400, color: '#fff', align: 'center', lineHeight: 1.2 },
    visual: defaultVisual()
  }
  p = ops.addTrack(p, 'video').project
  const tid = p.tracks.find((t) => t.kind === 'video' && t.items.length === 0)!.id
  p = ops.insertItems(p, tid, [txt], 'overwrite')
  return { p, v, txt: 'txt' }
}
const all = (p: Project): Item[] => p.tracks.flatMap((t) => t.items)
const byId = <T extends Item>(p: Project, id: string): T => all(p).find((i) => i.id === id) as T
/** Valores resolvidos no instante (absoluto) das propriedades novas do clipe de vídeo e do texto. */
function sample(p: Project, t: number): number[] {
  const ls = resolveFrame(p, t)
  const m = ls.find((l): l is MediaLayer => l.kind === 'media')!
  const x = ls.find((l): l is TextLayer => l.kind === 'text')!
  return [m.crop.l, m.adjust!.brightness, m.radius, x.style.size]
}

describe('getAnim / AnimPath ampliado', () => {
  it('lê os caminhos novos; opcionais ausentes valem o neutro; tipo errado → null', () => {
    const { p, v, txt } = base()
    const m = byId<MediaItem>(p, v)
    expect(evalAnim(ops.getAnim(m, 'crop.l')!, 5 * S)).toBeCloseTo(0.05)
    expect(ops.getAnim(m, 'adjust.contrast')).toEqual({ value: 0.1 })
    expect(ops.getAnim(byId(p, txt), 'adjust.saturation')).toEqual({ value: 0 })
    expect(ops.getAnim(byId(p, txt), 'visual.radius')).toEqual({ value: 0 })
    expect(ops.getAnim(byId(p, txt), 'text.size')!.keys).toHaveLength(2)
    expect(ops.getAnim(m, 'text.size')).toBeNull()
    expect(ops.getAnim(p.tracks.find((t) => t.kind === 'audio')!.items[0], 'crop.l')).toBeNull() // áudio sem visual
  })
  it('setAnimValue/toggleKeyframe nos caminhos novos (adjust ausente é criado neutro)', () => {
    const { p, txt } = base()
    let q = ops.toggleKeyframe(p, txt, 'adjust.saturation', 2 * S)
    q = ops.setAnimValue(q, txt, 'adjust.saturation', 2 * S, -0.5)
    const v = byId<TextItem>(q, txt).visual
    expect(v.adjust).toEqual({ brightness: { value: 0 }, contrast: { value: 0 }, saturation: { value: 0, keys: [{ tUs: 2 * S, value: -0.5, ease: 'linear' }] } })
    q = ops.setAnimValue(q, txt, 'text.size', 0, 30)
    expect(byId<TextItem>(q, txt).style.size.keys![0]).toMatchObject({ tUs: 0, value: 30 })
    expect(ops.keyframeTimesUs(byId(q, txt))).toEqual([0, 2 * S, 10 * S])
    expect(ops.nextKeyframeUs(q, txt, 'any', 0, 1)).toBe(2 * S)
  })
})

describe('operações percorrem as propriedades novas', () => {
  it('splitAt: os dois pedaços reproduzem as curvas (corte, ajuste, raio, tamanho do texto)', () => {
    const { p } = base()
    const q = ops.splitAt(p, 'all', 3.3 * S)
    for (let t = 0; t < 10 * S; t += S / 3) {
      const a = sample(p, t), b = sample(q, t)
      for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 4)
    }
  })
  it('deleteRanges: o que sobra mantém as curvas (com o trecho removido)', () => {
    const { p } = base()
    const q = ops.deleteRanges(p, [{ fromUs: 2 * S, toUs: 4 * S }])
    for (let t = 0; t < 8 * S; t += S / 3) {
      const a = sample(p, t < 2 * S ? t : t + 2 * S), b = sample(q, t)
      for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 4)
    }
  })
  it('setSpeed 2×: keys do corte/ajuste/raio na metade do tempo', () => {
    const { p, v } = base()
    const q = ops.setSpeed(p, v, 2)
    const m = byId<MediaItem>(q, v).visual!
    expect(m.crop.l.keys!.map((k) => k.tUs)).toEqual([0, 5 * S])
    expect(m.adjust!.brightness.keys!.map((k) => k.tUs)).toEqual([0, 5 * S])
    expect(m.radius!.keys!.map((k) => k.tUs)).toEqual([0, 5 * S])
  })
  it('setReverse: as curvas novas são espelhadas no tempo', () => {
    const { p, v } = base()
    const q = ops.setReverse(p, [v], true)
    const a = byId<MediaItem>(p, v).visual!, b = byId<MediaItem>(q, v).visual!
    for (let t = 0; t <= 10 * S; t += S / 2) {
      expect(evalAnim(b.crop.l, t)).toBeCloseTo(evalAnim(a.crop.l, 10 * S - t), 6)
      expect(evalAnim(b.adjust!.brightness, t)).toBeCloseTo(evalAnim(a.adjust!.brightness, 10 * S - t), 6)
      expect(evalAnim(b.radius!, t)).toBeCloseTo(evalAnim(a.radius!, 10 * S - t), 6)
    }
  })
  it('freezeFrameAt: o quadro parado fica com os valores do instante; o texto por cima segura o tamanho', () => {
    const { p, v, txt } = base()
    const q = ops.freezeFrameAt(p, v, 4 * S, 2 * S)
    const before = sample(p, 4 * S)
    for (const t of [4 * S, 5 * S, 6 * S - 1]) expect(sample(q, t)).toEqual(before.map((x) => expect.closeTo(x, 6)))
    const piece = all(q).find((i): i is MediaItem => i.type === 'media' && !!i.freeze)!
    expect(piece.visual!.crop.l.keys).toBeUndefined()
    // depois do parado, tudo continua de onde estava (texto: mesmo pedaço da curva inOut)
    for (const t of [6 * S, 8 * S, 11 * S]) {
      expect(sample(q, t)[3]).toBeCloseTo(sample(p, t - 2 * S)[3], 6)
      expect(sample(q, t)[0]).toBeCloseTo(sample(p, t - 2 * S)[0], 6)
    }
    expect(byId<TextItem>(q, txt).durationUs).toBe(12 * S)
  })
})

describe('setKeyEase / copiar e colar keyframes', () => {
  it('setKeyEase troca a curva do key mais próximo (±meio quadro) e afeta a interpolação', () => {
    const { p, v } = base()
    const q = ops.setKeyEase(p, v, 'crop.l', 10_000, 'linear') // key em 0, dentro de meio quadro
    expect(byId<MediaItem>(q, v).visual!.crop.l.keys![0].ease).toBe('linear')
    expect(sample(q, 5 * S)[0]).toBeCloseTo(0.2)
    expect(ops.setKeyEase(p, v, 'crop.l', 5 * S, 'out')).toEqual(p) // sem key ali
    expect(() => ops.setKeyEase(p, v, 'crop.l', 0, { bezier: [1.5, 0, 0.5, 1] })).toThrow(/x1 e x2/)
    expect(() => ops.setKeyEase(p, v, 'text.size', 0, 'in')).toThrow(/não tem a propriedade/)
  })
  it('copyKeyframes: tempos relativos ao 1º key copiado, por propriedade; intervalo opcional', () => {
    const { p, v } = base()
    const c = ops.copyKeyframes(p, v)!
    expect(Object.keys(c.keys).sort()).toEqual(['adjust.brightness', 'crop.l', 'visual.radius'])
    expect(c.keys['crop.l']!.map((k) => k.tUs)).toEqual([0, 10 * S])
    const part = ops.copyKeyframes(p, v, { paths: ['crop.l'], fromUs: 5 * S, toUs: 10 * S })!
    expect(part.keys).toEqual({ 'crop.l': [{ tUs: 0, value: 0.4, ease: 'linear' }] })
    expect(ops.copyKeyframes(p, v, { paths: ['transform.x'] })).toBeNull()
  })
  it('pasteKeyframes num item mais curto: tempos preservados e presos à duração, sem salto', () => {
    const { p, v } = base()
    const c = ops.copyKeyframes(p, v, { paths: ['crop.l', 'adjust.brightness'] })!
    // destino: item de 4 s (clipe dividido); cola em 1 s → keys em 1 s e corte exato em 4 s
    const q0 = ops.splitAt(p, 'all', 6 * S)
    const right = all(q0).find((i): i is MediaItem => i.type === 'media' && i.startUs === 6 * S && !!i.visual)!
    const q = ops.pasteKeyframes(q0, right.id, c, 7 * S)
    const r = byId<MediaItem>(q, right.id).visual!
    // o key que o pedaço já tinha em 0 (fora do trecho colado) fica
    expect(r.crop.l.keys!.map((k) => k.tUs)).toEqual([0, S, 4 * S])
    // a curva colada é a original deslocada 1 s (até a borda)
    for (let t = S; t <= 4 * S; t += S / 4) expect(evalAnim(r.crop.l, t)).toBeCloseTo(evalAnim(byId<MediaItem>(p, v).visual!.crop.l, t - S), 6)
    expect(r.adjust!.brightness.keys!.map((k) => k.tUs)).toEqual([0, S, 4 * S])
    // tamanho do texto não existe no vídeo: ignorado (nada aplicável → o mesmo projeto)
    const t = ops.copyKeyframes(p, 'txt', { paths: ['text.size'] })!
    expect(ops.pasteKeyframes(p, v, t, 0)).toBe(p)
    expect(() => ops.pasteKeyframes(p, v, c, 11 * S)).toThrow(/fora do item/)
  })
})

describe('pasteKeyframes em efeitos', () => {
  it('Tarja (solid) não recebe keys de intensidade; a região sim', () => {
    let p = createEmptyProject('t')
    const a = ops.addEffect(p, 'blur', 0, { durationUs: 4 * S })
    p = ops.toggleKeyframe(a.project, a.itemId, 'strength', 0)
    p = ops.toggleKeyframe(p, a.itemId, 'region.x', 0)
    const clip = ops.copyKeyframes(p, a.itemId)!
    expect(Object.keys(clip.keys).sort()).toEqual(['region.x', 'strength'])
    const b = ops.addEffect(p, 'solid', 5 * S, { durationUs: 2 * S })
    const q = ops.pasteKeyframes(b.project, b.itemId, clip, 5 * S)
    const fx = byId<import('./project').EffectItem>(q, b.itemId)
    expect(fx.strength.keys).toBeUndefined()
    expect(fx.region.x.keys).toHaveLength(1)
    expect(ops.pasteKeyframes(b.project, b.itemId, { keys: { strength: clip.keys.strength } }, 5 * S)).toBe(b.project)
  })
})


describe('keys por propriedade (linhas de keyframes na timeline)', () => {
  const times = (a: Anim<number> | undefined): number[] => (a?.keys ?? []).map((k) => k.tUs)
  it('moveKeys move só os keys pedidos, na mesma distância, com a curva junto', () => {
    const { p, v } = base()
    const q = ops.moveKeys(p, v, [{ path: 'crop.l', tUs: 0 }], 2 * S)
    const m = byId<MediaItem>(q, v).visual!
    expect(times(m.crop.l)).toEqual([2 * S, 10 * S])
    expect(m.crop.l.keys![0].ease).toBe('in')
    expect(times(m.adjust!.brightness)).toEqual([0, 10 * S]) // outra propriedade no mesmo instante fica
    const g = byId<MediaItem>(ops.moveKeys(p, v, [{ path: 'crop.l', tUs: 10 * S }, { path: 'visual.radius', tUs: 10 * S }], -3 * S), v).visual!
    expect(times(g.crop.l)).toEqual([0, 7 * S])
    expect(times(g.radius)).toEqual([0, 7 * S])
  })
  it('moveKeys: o grupo fica preso ao item (distâncias mantidas) e substitui o key onde cai', () => {
    const { p, v } = base()
    // grupo [0, 10 s] não tem folga: nada muda
    expect(ops.moveKeys(p, v, [{ path: 'crop.l', tUs: 0 }, { path: 'visual.radius', tUs: 10 * S }], S)).toBe(p)
    const q = ops.moveKeys(p, v, [{ path: 'crop.l', tUs: 10 * S }], -20 * S)
    const c = byId<MediaItem>(q, v).visual!.crop.l
    expect(c.keys).toEqual([{ tUs: 0, value: 0.4, ease: 'linear' }])
    expect(ops.moveKeys(p, v, [], S)).toBe(p)
  })
  it('moveKeys/removeKeys recusam faixa bloqueada', () => {
    const { p, v } = base()
    const tid = p.tracks.find((t) => t.items.some((i) => i.id === v))!.id
    const locked = ops.updateTrack(p, tid, { locked: true })
    expect(() => ops.moveKeys(locked, v, [{ path: 'crop.l', tUs: 0 }], S)).toThrow()
    expect(() => ops.removeKeys(locked, v, [{ path: 'crop.l', tUs: 0 }])).toThrow()
  })
  it('removeKeys tira só os keys pedidos', () => {
    const { p, v } = base()
    const m = byId<MediaItem>(ops.removeKeys(p, v, [{ path: 'crop.l', tUs: 0 }, { path: 'visual.radius', tUs: 10 * S }]), v).visual!
    expect(times(m.crop.l)).toEqual([10 * S])
    expect(times(m.radius)).toEqual([0])
    expect(times(m.adjust!.brightness)).toEqual([0, 10 * S])
    expect(ops.removeKeys(p, v, [{ path: 'crop.l', tUs: 5 * S }])).toBe(p)
  })
  it('copyKeyframes com keys: copia exatamente os escolhidos, relativos ao primeiro', () => {
    const { p, v } = base()
    const c = ops.copyKeyframes(p, v, { keys: [{ path: 'crop.l', tUs: 10 * S }, { path: 'adjust.brightness', tUs: 0 }] })!
    expect(Object.keys(c.keys).sort()).toEqual(['adjust.brightness', 'crop.l'])
    expect(c.keys['crop.l']!.map((k) => k.tUs)).toEqual([10 * S])
    expect(c.keys['adjust.brightness']!.map((k) => k.tUs)).toEqual([0])
    const d = ops.copyKeyframes(p, v, { keys: [{ path: 'crop.l', tUs: 10 * S }] })!
    expect(d.keys['crop.l']).toEqual([{ tUs: 0, value: 0.4, ease: 'linear' }])
    expect(ops.copyKeyframes(p, v, { keys: [{ path: 'crop.l', tUs: 3 * S }] })).toBeNull()
  })
})

describe('pastablePaths', () => {
  it('propriedades do clipboard que o item tem (Tarja sem intensidade)', () => {
    const { p, v, txt } = base()
    const clip = ops.copyKeyframes(p, txt)!
    expect(Object.keys(clip.keys).sort()).toEqual(['text.size'])
    expect(ops.pastablePaths(byId(p, v), clip)).toEqual([])
    expect(ops.pastablePaths(byId(p, txt), clip)).toEqual(['text.size'])
    const solid = ops.addEffect(p, 'solid', 12 * S, { durationUs: S })
    const fxClip = { keys: { strength: [{ tUs: 0, value: 1, ease: 'linear' as const }], 'region.x': [{ tUs: 0, value: 0.5, ease: 'linear' as const }] } }
    expect(ops.pastablePaths(byId(solid.project, solid.itemId), fxClip)).toEqual(['region.x'])
  })
})

describe('keyframeTimesUs com curvas densas (invariante 6)', () => {
  it('1 h com um key por quadro em x/y/w/h (efeito rastreado): fusão ordenada sem repetidos (±1 µs) em poucos ms', () => {
    const H = 108_000
    const mk = (off: number): Anim<number> => ({ value: 0, keys: Array.from({ length: H }, (_, i) => ({ tUs: Math.round((i * S) / 30) + off, value: i, ease: 'linear' as const })) })
    const fx = { id: 'fx', type: 'effect', effect: 'blur', startUs: 0, durationUs: 3600 * S, strength: { value: 80, keys: [{ tUs: 5, value: 1, ease: 'linear' as const }] }, feather: 0, color: '#000', invert: false, scope: 'below', region: { shape: 'rect', x: mk(0), y: mk(0), w: mk(1), h: mk(0), rotation: { value: 0 } } } as unknown as Item
    let best = Infinity
    let out: number[] = []
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now()
      out = ops.keyframeTimesUs(fx)
      best = Math.min(best, performance.now() - t0)
    }
    // w a +1 µs conta como o mesmo instante; o key de intensidade em 5 µs entra entre os dois primeiros
    expect(out.slice(0, 3)).toEqual([0, 5, 33_333])
    expect(out).toHaveLength(H + 1)
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1])
    expect(best).toBeLessThan(80)
  })
})

describe('keyframeTimesUs: ±1 µs contra o key ANTERIOR (semântica de antes da fusão)', () => {
  it('cadeia t, t+1, t+2 vira um instante só (t); t, t+2 são dois', () => {
    const at = (ts: number[]): Anim<number> => ({ value: 0, keys: ts.map((tUs) => ({ tUs, value: 0, ease: 'linear' as const })) })
    const fx = (x: number[], w: number[]): Item => ({ id: 'fx', type: 'effect', effect: 'blur', startUs: 0, durationUs: 10 * S, strength: { value: 80 }, feather: 0, color: '#000', invert: false, scope: 'below', region: { shape: 'rect', x: at(x), y: { value: 0 }, w: at(w), h: { value: 0 }, rotation: { value: 0 } } }) as unknown as Item
    expect(ops.keyframeTimesUs(fx([100, 102], [101]))).toEqual([100])
    expect(ops.keyframeTimesUs(fx([100, 102], []))).toEqual([100, 102])
    expect(ops.keyframeTimesUs(fx([100, 101, 102, 500], [499]))).toEqual([100, 499])
  })
})
