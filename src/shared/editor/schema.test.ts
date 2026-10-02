import { describe, expect, it } from 'vitest'
import { parseProject, toDiskProject, validateProject } from './schema'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import type { Asset, MediaItem, PresetAnim, Project, TextItem } from './project'
import { resolveFrame } from './resolve'
import { planAudio } from './audioPlan'
import fixture from './__fixtures__/v13-project.json'
import golden from './__fixtures__/v13-golden.json'

const asset: Asset = { id: 'a1', name: 'a', kind: 'video', source: { type: 'file', path: 'x', size: 1, mtimeMs: 1 }, durationUs: 2_000_000, status: 'ready' }
const withItems = (items: ReturnType<typeof createMediaItem>[]): Project => {
  const p = createEmptyProject('x')
  p.assets = [asset]
  p.tracks[0].items = items
  return p
}
describe('schema', () => {
  it('round-trip', () => { const p = createEmptyProject('x'); expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p) })
  it('round-trip com item', () => { const p = withItems([createMediaItem(asset, 0, 'video')]); expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p) })
  it('round-trip com filmstrip/peaks e filmstripInfo', () => {
    const p = createEmptyProject('x')
    p.assets = [{ ...asset, filmstrip: 'cache/a1.strip.jpg', filmstripInfo: { frames: 6, everyUs: 1_000_000, tileW: 114, tileH: 64 }, peaks: 'cache/a1.peaks.bin', speech: 'cache/a1.speech.json', loudness: { integrated: -23.1, truePeak: -1.2, lra: 4.5 } }]
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })
  it('audioTrackIndex: round-trip; negativo ou fracionário lança', () => {
    const p = createEmptyProject('x')
    p.assets = [{ ...asset, audioTrackIndex: 1 }]
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    p.assets = [{ ...asset, audioTrackIndex: -1 }]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow(/audioTrackIndex/)
    p.assets = [{ ...asset, audioTrackIndex: 0.5 }]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow(/audioTrackIndex/)
  })
  it('videoTrackIndex: round-trip; negativo ou fracionário lança', () => {
    const p = createEmptyProject('x')
    p.assets = [{ ...asset, videoTrackIndex: 1 }]
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    p.assets = [{ ...asset, videoTrackIndex: -1 }]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow(/videoTrackIndex/)
    p.assets = [{ ...asset, videoTrackIndex: 1.5 }]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow(/videoTrackIndex/)
  })
  it('filmstripInfo inválido lança', () => {
    const p = createEmptyProject('x')
    p.assets = [{ ...asset, filmstripInfo: { frames: 6, everyUs: 1.5, tileW: 114, tileH: 64 } }]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow(/filmstripInfo/)
  })
  it('anotações: autoFadeMs opcional (número ≥ 0 ou null), round-trip', () => {
    const p = createEmptyProject('x')
    const ann = (autoFadeMs?: number | null): Project['tracks'][number]['items'][number] => ({ id: 'an', type: 'annotations', sessionId: 's', inUs: 0, startUs: 0, durationUs: 1_000_000, ...(autoFadeMs !== undefined ? { autoFadeMs } : {}) })
    for (const v of [undefined, null, 3000]) {
      p.tracks[0].items = [ann(v)]
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    }
    p.tracks[0].items = [ann(-1)]
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow()
  })
  it('versão futura lança', () => expect(() => parseProject({ ...createEmptyProject('x'), version: 2 })).toThrow())
  it('detecta sobreposição', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), id: 'i1', durationUs: 1_000_000 }
    const b = { ...createMediaItem(asset, 500_000, 'video'), id: 'i2', durationUs: 1_000_000 }
    expect(validateProject(withItems([a, b])).some((m) => m.includes('sobrepõe'))).toBe(true)
  })
  it('detecta sobreposição não adjacente (fim máximo acumulado)', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), id: 'i1', durationUs: 2_000_000 }
    const b = { ...createMediaItem(asset, 2_000_000, 'video'), id: 'i2', durationUs: 100_000 }
    const c = { ...createMediaItem(asset, 1_500_000, 'video'), id: 'i3', durationUs: 100_000, inUs: 0 }
    const d = { ...createMediaItem(asset, 1_000_000, 'video'), id: 'i0', durationUs: 100_000 }
    // ordenado: i1 [0,2s), i0 [1s,1.1s), i3 [1.5s,1.6s), i2 [2s,2.1s) → i0 e i3 sobrepõem i1
    const msgs = validateProject(withItems([a, b, c, d])).filter((m) => m.includes('sobrepõe'))
    expect(msgs.some((m) => m.includes('i3') && m.includes('i1'))).toBe(true)
  })
  it('detecta keyframes com tempo repetido', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), durationUs: 1_000_000 }
    a.audio = { ...a.audio, volume: { value: 1, keys: [{ tUs: 100, value: 0, ease: 'linear' }, { tUs: 100, value: 1, ease: 'linear' }] } }
    expect(validateProject(withItems([a])).some((m) => m.includes('keyframes de volume'))).toBe(true)
  })
  it('detecta excesso de fonte', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), durationUs: 1_000_000, inUs: 1_500_000 }
    expect(validateProject(withItems([a])).some((m) => m.includes('excede'))).toBe(true)
  })
  it('projeto válido sem mensagens', () => {
    const a = { ...createMediaItem(asset, 0, 'video'), durationUs: 1_000_000 }
    expect(validateProject(withItems([a]))).toEqual([])
  })
  it('enabled é opcional: ausente não aparece; false faz round-trip', () => {
    const fx = createEffectItem('blur', 0, 1_000_000)
    expect(JSON.stringify(fx)).not.toContain('enabled')
    const p = createEmptyProject('x')
    p.tracks[0].items = [{ ...fx, enabled: false }]
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })
  it.each(['blur', 'pixelate', 'solid', 'blurFace', 'blurText', 'blurAllExcept'] as const)('fábrica %s valida no schema', (preset) => {
    const p = createEmptyProject('x')
    p.tracks[0].items = [createEffectItem(preset, 0, 1_000_000)]
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(validateProject(p)).toEqual([])
  })
  it('valores dos presets', () => {
    const f = (id: Parameters<typeof createEffectItem>[0]) => createEffectItem(id, 0, 1_000_000)
    expect(f('blur')).toMatchObject({ effect: 'blur', strength: { value: 60 }, feather: 0.15, invert: false, region: { shape: 'rect' } })
    expect(f('pixelate')).toMatchObject({ effect: 'pixelate', strength: { value: 50 } })
    expect(f('solid')).toMatchObject({ effect: 'solid', color: '#000000', feather: 0, strength: { value: 100 } })
    expect(f('blurFace')).toMatchObject({ strength: { value: 80 }, feather: 0.3, region: { shape: 'ellipse', x: { value: 0.5 }, y: { value: 0.5 }, w: { value: 0.18 }, h: { value: 0.32 } } })
    expect(f('blurText')).toMatchObject({ strength: { value: 80 }, region: { shape: 'rect', w: { value: 0.4 }, h: { value: 0.08 } } })
    expect(f('blurAllExcept')).toMatchObject({ invert: true, strength: { value: 80 }, feather: 0.2, region: { w: { value: 0.5 }, h: { value: 0.5 } } })
    expect(createEffectItem('blur', 0, 1, { x: 0.2, shape: 'ellipse' }).region).toMatchObject({ shape: 'ellipse', x: { value: 0.2 }, y: { value: 0.5 } })
  })
})

describe('schema F4: propriedades que viraram animáveis (compatível com v1.1–v1.3)', () => {
  // projeto no formato da v1.3 (corte/ajuste/raio/tamanho do texto numéricos) e o que a v1.3 resolvia/mixava
  // (golden gerado com o código da v1.3 antes da mudança; ShapeLayer.item reduzido ao id)
  const old = fixture as unknown
  const shrink = (layers: ReturnType<typeof resolveFrame>) => layers.map((l) => (l.kind === 'shape' ? { ...l, item: l.item.id } : l))
  it('número vira { value } no parse, sem mudar version', () => {
    const p = parseProject(old)
    expect(p.version).toBe(1)
    const v = (p.tracks[0].items[0] as MediaItem).visual!
    expect(v.crop).toEqual({ l: { value: 0.1 }, t: { value: 0 }, r: { value: 0.05 }, b: { value: 0.02 } })
    expect(v.adjust).toEqual({ brightness: { value: 0.1 }, contrast: { value: 0.2 }, saturation: { value: -0.3 } })
    expect(v.radius).toEqual({ value: 12 })
    expect((p.tracks[2].items[0] as TextItem).style.size).toEqual({ value: 48 })
    // salvar e abrir de novo (formato novo) é estável
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(validateProject(p)).toEqual([])
  })
  it('projeto v1.3: resolveFrame e planAudio idênticos aos da v1.3 (golden)', () => {
    const p = parseProject(old)
    for (const { t, layers } of golden.frames) expect(JSON.parse(JSON.stringify(shrink(resolveFrame(p, t))))).toEqual(layers)
    expect(JSON.parse(JSON.stringify(planAudio(p)))).toEqual(golden.audio)
    expect(golden.frames.length).toBeGreaterThan(150)
  })
  it('as novas propriedades aceitam keyframes; ordem dos keys é validada', () => {
    const p = parseProject(old)
    const m = p.tracks[0].items[0] as MediaItem
    m.visual!.crop.l = { value: 0, keys: [{ tUs: 200, value: 0.1, ease: 'in' }, { tUs: 100, value: 0.2, ease: 'linear' }] }
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(validateProject(p).some((s) => s.includes('crop.l'))).toBe(true)
  })
  it('bezier: x1/x2 fora de [0,1] é recusado; y livre (overshoot)', () => {
    const p = parseProject(old)
    const m = p.tracks[0].items[0] as MediaItem
    m.visual!.transform.y = { value: 0, keys: [{ tUs: 0, value: 0, ease: { bezier: [0.3, -0.5, 0.7, 1.8] } }] }
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    m.visual!.transform.y = { value: 0, keys: [{ tUs: 0, value: 0, ease: { bezier: [1.2, 0, 0.7, 1] } }] }
    expect(() => parseProject(JSON.parse(JSON.stringify(p)))).toThrow(/Projeto inválido/)
  })
})

describe('toDiskProject: a v1.3 instalada continua lendo o que o build novo grava', () => {
  it('sem keys nas propriedades novas: compacta para número, v1.3 lê, e o parse novo volta ao mesmo projeto', () => {
    const p = parseProject(fixture)
    const disk = JSON.parse(JSON.stringify(toDiskProject(p)))
    const v13 = parseProjectV13(disk)
    expect(v13.success).toBe(true)
    expect(disk.tracks[0].items[0].visual.crop).toEqual({ l: 0.1, t: 0, r: 0.05, b: 0.02 })
    expect(disk.tracks[0].items[0].visual.adjust).toEqual({ brightness: 0.1, contrast: 0.2, saturation: -0.3 })
    expect(disk.tracks[0].items[0].visual.radius).toBe(12)
    expect(disk.tracks[2].items[0].style.size).toBe(48)
    // o arquivo da v1.3 é igual ao que ela mesma gravaria (o fixture)
    expect(disk).toEqual(fixture)
    expect(parseProject(disk)).toEqual(p)
    // não muda o objeto recebido
    expect((p.tracks[0].items[0] as MediaItem).visual!.crop.l).toEqual({ value: 0.1 })
  })
  it('projeto novo da fábrica também é legível pela v1.3', () => {
    const p = withItems([createMediaItem(asset, 0, 'video')])
    expect(parseProjectV13(JSON.parse(JSON.stringify(toDiskProject(p)))).success).toBe(true)
  })
  it('com keys nas propriedades novas fica Anim (a v1.3 não lê — recurso da v1.4)', () => {
    const p = parseProject(fixture)
    ;(p.tracks[0].items[0] as MediaItem).visual!.crop.l = { value: 0, keys: [{ tUs: 0, value: 0, ease: 'linear' }, { tUs: 1000, value: 0.2, ease: 'in' }] }
    const disk = JSON.parse(JSON.stringify(toDiskProject(p)))
    expect(disk.tracks[0].items[0].visual.crop.l.keys).toHaveLength(2)
    expect(disk.tracks[0].items[0].visual.crop.t).toBe(0)
    expect(parseProjectV13(disk).success).toBe(false)
    expect(parseProject(disk)).toEqual(p)
  })
})


describe('animações de entrada/saída (F4): presets novos e curva', () => {
  const withAnims = (animIn: unknown, animOut?: unknown): unknown => {
    const p = withItems([createMediaItem(asset, 0, 'video')])
    const json = JSON.parse(JSON.stringify(toDiskProject(p)))
    json.tracks[0].items[0].visual.animIn = animIn
    if (animOut) json.tracks[0].items[0].visual.animOut = animOut
    return json
  }
  it('girar, quicar e desfoque com curva: round-trip; preset desconhecido lança', () => {
    for (const preset of ['zoom', 'pop', 'rotate', 'bounce', 'blur']) {
      const json = withAnims({ preset, durationUs: 500_000, ease: { bezier: [0.34, 1.56, 0.64, 1] } }, { preset, durationUs: 300_000, ease: 'inOut' })
      const p = parseProject(json)
      expect((p.tracks[0].items[0] as MediaItem).visual!.animIn).toEqual({ preset, durationUs: 500_000, ease: { bezier: [0.34, 1.56, 0.64, 1] } })
      expect(parseProject(JSON.parse(JSON.stringify(toDiskProject(p))))).toEqual(p)
    }
    expect(() => parseProject(withAnims({ preset: 'spin', durationUs: 1 }))).toThrow()
    expect(() => parseProject(withAnims({ preset: 'zoom', durationUs: 1, ease: { bezier: [2, 0, 0.5, 1] } }))).toThrow()
  })
  it('segurar não vale como curva de animação', () => {
    expect(() => parseProject(withAnims({ preset: 'zoom', durationUs: 1, ease: 'hold' }))).toThrow(/animIn/)
  })
  /** Projeto com o vídeo animado (entrada e saída), em memória. */
  const animated = (animIn: PresetAnim, animOut?: PresetAnim): Project => {
    const m = createMediaItem(asset, 0, 'video') as MediaItem
    m.visual = { ...m.visual!, animIn, ...(animOut ? { animOut } : {}) }
    return withItems([m])
  }
  const diskOf = (p: Project) => JSON.parse(JSON.stringify(toDiskProject(p)))
  it.each([['rotate', 'fade'], ['blur', 'fade'], ['bounce', 'slideD']] as const)('%s no disco: a v1.3 lê %s (presetV14 guarda o real); o parse novo volta ao mesmo projeto', (preset, v13) => {
    const p = animated({ preset, durationUs: 400_000, ease: 'inOut' }, { preset, durationUs: 300_000 })
    const disk = diskOf(p)
    expect(disk.tracks[0].items[0].visual.animIn).toEqual({ preset: v13, presetV14: preset, durationUs: 400_000, ease: 'inOut' })
    expect(disk.tracks[0].items[0].visual.animOut).toEqual({ preset: v13, presetV14: preset, durationUs: 300_000 })
    expect(parseProject(disk)).toEqual(p)
    // a v1.3 abre e, regravando (o zod dela descarta presetV14 e a curva), o projeto fica com o equivalente dela
    const v = parseProjectV13(disk)
    expect(v.success).toBe(true)
    const back = parseProject(JSON.parse(JSON.stringify(v.data)))
    expect((back.tracks[0].items[0] as MediaItem).visual!.animIn).toEqual({ preset: v13, durationUs: 400_000 })
    expect((back.tracks[0].items[0] as MediaItem).visual!.animOut).toEqual({ preset: v13, durationUs: 300_000 })
  })
  it('presets que a v1.3 conhece vão como estão (sem presetV14); texto e forma também mapeiam', () => {
    const p = animated({ preset: 'pop', durationUs: 1, ease: 'linear' }, { preset: 'slideL', durationUs: 1 })
    const disk = diskOf(p)
    expect(disk.tracks[0].items[0].visual.animIn).toEqual({ preset: 'pop', durationUs: 1, ease: 'linear' })
    expect(parseProjectV13(disk).success).toBe(true)
    expect(parseProject(disk)).toEqual(p)
    const t = parseProject(fixture)
    const text = t.tracks[2].items[0] as TextItem
    text.visual = { ...text.visual, animIn: { preset: 'bounce', durationUs: 500_000 } }
    const td = diskOf(t)
    expect(td.tracks[2].items[0].visual.animIn).toEqual({ preset: 'slideD', presetV14: 'bounce', durationUs: 500_000 })
    expect(parseProjectV13(td).success).toBe(true)
    expect(parseProject(td)).toEqual(t)
  })
})
