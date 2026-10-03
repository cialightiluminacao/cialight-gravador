import { describe, expect, it } from 'vitest'
import { parseProject, toDiskProject, validateProject } from './schema'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { createEffectItem, createEmptyProject, createMediaItem, patchTextStyle, SHAPE_PRESETS, TEXT_PRESETS, type ShapePresetId, type TextPresetId } from './factory'
import { DEFAULT_CURSOR_FX } from './project'
import type { Asset, CursorFx, EffectItem, Item, MediaItem, PresetAnim, Project, ShapeItem, TextItem, Track } from './project'
import * as ops from './ops'
import { applyTemplate, templateFromSelection, type BrandTemplate } from './brand'
import { transitionWindows } from './transitions'
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
  // (golden gerado com o código da v1.3 antes da mudança; ShapeLayer.item reduzido ao id). F5: TextLayer/ShapeLayer
  // ganharam `trackId` (escopo `track` com alvo em texto/forma) — campo novo, não um valor diferente: a comparação o
  // ignora em vez de regenerar o golden (o resto da camada continua idêntico ao da v1.3).
  // F5 (correção de privacidade): UMA entrada do golden mudou — frames[206] (t = 8 999 999, último µs do clipe
  // reverso i_v2, inUs 2 000 000, 2×): srcUs 1 966 669 → 2 000 000. A v1.3 lia ali um quadro ANTES de inUs (trecho
  // cortado, que pode ser sigiloso); sourceTimeUs agora prende srcUs ao trecho aparado. Nenhuma outra entrada mudou
  // (planAudio idêntico).
  const old = fixture as unknown
  const shrink = (layers: ReturnType<typeof resolveFrame>) =>
    layers.map((l) => {
      if (l.kind !== 'text' && l.kind !== 'shape') return l
      const { trackId: _trackId, ...rest } = l
      return rest.kind === 'shape' ? { ...rest, item: rest.item.id } : rest
    })
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

describe('cursorFx e asset.cursor (F6)', () => {
  const screen: Asset = { ...asset, id: 'scr', source: { type: 'session', sessionId: 's1', stream: 'screen' }, cursor: 'cursor.json' }
  const withFx = (fx: CursorFx = DEFAULT_CURSOR_FX): Project => {
    const p = createEmptyProject('x')
    p.assets = [screen]
    p.tracks[0].items = [{ ...createMediaItem(screen, 0, 'video'), durationUs: 1_000_000, cursorFx: fx }]
    return p
  }
  const diskOf = (p: Project) => JSON.parse(JSON.stringify(toDiskProject(p)))
  /** O mesmo projeto com outro cursorFx no clipe da tela. */
  const swapFx = (p: Project, fx: CursorFx): Project => ({ ...p, tracks: [{ ...p.tracks[0], items: [{ ...(p.tracks[0].items[0] as MediaItem), cursorFx: fx }] }, ...p.tracks.slice(1)] })
  const fxWith = (h: Partial<CursorFx['highlight']>, c: Partial<CursorFx['cursor']> = {}): CursorFx => ({
    highlight: { ...DEFAULT_CURSOR_FX.highlight, ...h }, cursor: { ...DEFAULT_CURSOR_FX.cursor, ...c }
  })

  it('padrões: tudo desligado (opt-in) e nos valores da especificação', () => {
    expect(DEFAULT_CURSOR_FX).toEqual({ highlight: { enabled: false, color: '#ffd400', sizePx: 28, durationMs: 450 }, cursor: { enabled: false, scale: 1.8, smoothing: 0.5 } })
  })
  it('a v1.3 lê o disco (descarta os campos novos) e o parse novo volta ao mesmo projeto', () => {
    const p = withFx(fxWith({ enabled: true, color: '#00aaff', sizePx: 120, durationMs: 150 }, { enabled: true, scale: 4, smoothing: 0 }))
    const disk = diskOf(p)
    expect(disk.tracks[0].items[0].cursorFx).toEqual(p.tracks[0].items[0].type === 'media' && p.tracks[0].items[0].cursorFx)
    expect(disk.assets[0].cursor).toBe('cursor.json')
    const v = parseProjectV13(disk)
    expect(v.success).toBe(true)
    expect(parseProject(disk)).toEqual(p)
    expect(validateProject(p)).toEqual([])
  })
  // ruling R14: ler do disco nunca recusa o projeto por causa do cursorFx (load cairia numa versão antiga e perderia
  // trabalho); o parse prende ou volta ao padrão campo a campo e só descarta o cursorFx de estrutura quebrada.
  // validateProject continua estrito (ops/inspetor recusam).
  it.each([
    ['cor sem #rrggbb', fxWith({ color: 'red' }), fxWith({ color: DEFAULT_CURSOR_FX.highlight.color })],
    ['tamanho < 8', fxWith({ sizePx: 7 }), fxWith({ sizePx: 8 })],
    ['tamanho > 120', fxWith({ sizePx: 121 }), fxWith({ sizePx: 120 })],
    ['duração < 150', fxWith({ durationMs: 149 }), fxWith({ durationMs: 150 })],
    ['duração > 1500', fxWith({ durationMs: 1501 }), fxWith({ durationMs: 1500 })],
    ['escala < 1', fxWith({}, { scale: 0.9 }), fxWith({}, { scale: 1 })],
    ['escala > 4 (ex.: versão futura com faixa maior)', fxWith({}, { scale: 6 }), fxWith({}, { scale: 4 })],
    ['suavização < 0', fxWith({}, { smoothing: -0.1 }), fxWith({}, { smoothing: 0 })],
    ['suavização > 1', fxWith({}, { smoothing: 1.1 }), fxWith({}, { smoothing: 1 })]
  ])('valor fora da faixa no disco: %s → preso/padrão no parse; validateProject avisa', (_label, fx, fixed) => {
    const p = withFx(fx)
    expect(validateProject(p).some((m) => m.includes('cursor'))).toBe(true)
    const back = parseProject(diskOf(p))
    expect(back).toEqual(swapFx(p, fixed))
    expect(validateProject(back)).toEqual([])
  })
  it('folha com tipo errado volta ao padrão dela; o resto do cursorFx fica', () => {
    const p = withFx(fxWith({ enabled: true, sizePx: 50 }, { scale: 3 }))
    const disk = diskOf(p)
    Object.assign(disk.tracks[0].items[0].cursorFx.highlight, { color: 42, durationMs: 'x' })
    disk.tracks[0].items[0].cursorFx.cursor.enabled = 'sim'
    expect(parseProject(disk)).toEqual(swapFx(p, fxWith({ enabled: true, sizePx: 50 }, { scale: 3, enabled: false })))
  })
  it.each([
    ['sem `cursor`', (fx: Record<string, unknown>): void => void delete fx.cursor],
    ['`highlight` não é objeto', (fx: Record<string, unknown>): void => void (fx.highlight = 'x')],
    ['cursorFx é número', null]
  ] as [string, ((fx: Record<string, unknown>) => void) | null][])('estrutura quebrada (%s): o cursorFx sai e o resto do projeto carrega igual', (_l, mutate) => {
    const p = withFx()
    const disk = diskOf(p)
    if (mutate) mutate(disk.tracks[0].items[0].cursorFx)
    else disk.tracks[0].items[0].cursorFx = 7
    const back = parseProject(disk)
    const { cursorFx: _drop, ...rest } = p.tracks[0].items[0] as MediaItem
    expect('cursorFx' in back.tracks[0].items[0]).toBe(false)
    expect(back).toEqual({ ...p, tracks: [{ ...p.tracks[0], items: [rest] }, ...p.tracks.slice(1)] })
    expect(parseProjectV13(diskOf(back)).success).toBe(true)
  })
})

describe('v1.3 lê um projeto com TODAS as funções da F5 ao mesmo tempo (invariante 1)', () => {
  const S = 1_000_000
  const vid = (id: string): Asset => ({ id, name: `${id}.mp4`, kind: 'video', source: { type: 'file', path: `C:/m/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: 30 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
  const png = (id: string): Asset => ({ id, name: `${id}.png`, kind: 'image', source: { type: 'file', path: `C:/m/${id}.png`, size: 1, mtimeMs: 1 }, durationUs: null, video: { width: 200, height: 100, fps: 0, codec: 'png', rotation: 0, decodable: true, gopUs: 0 }, status: 'ready' })
  const all = (p: Project): Item[] => p.tracks.flatMap((t) => t.items)
  const trackOf = (p: Project, id: string): Track => ops.findItem(p, id)!.track
  /** Assets do projeto copiados do modelo (como o brandActions faz depois de copiar os arquivos). */
  const materialized = (t: BrandTemplate): Record<string, Asset> =>
    Object.fromEntries(t.assets.map((a) => [a.id, { ...(a.kind === 'image' ? png(`gen-${a.id}`) : vid(`gen-${a.id}`)), name: a.name, source: { type: 'generated' as const, file: `generated/brand-${t.id}-${a.file}` } }]))
  /** Efeito como gravado até a v1.4: escopo track sem alvo gravado (alvo pela posição). */
  const asLegacy = (p: Project, fxId: string): Project => ({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      items: t.items.map((i) => {
        if (i.id !== fxId || i.type !== 'effect') return i
        const { targetTrackId: _t, linkId: _l, ...rest } = i
        return { ...rest, scope: 'track' as const }
      })
    }))
  })

  function kitchenSink(): Project {
    let p = createEmptyProject('tudo')
    for (const a of [vid('a'), vid('b'), png('logo')]) p = ops.addAsset(p, a)
    // V1: A 0–10 s e B 10–20 s encostados, Dissolver na entrada de B (transição em mídia)
    const a = ops.addMediaFromAsset(p, 'a', 0)
    p = ops.updateItem<MediaItem>(a.project, a.itemIds[0], (d) => { d.durationUs = 10 * S })
    p = ops.updateItem<MediaItem>(p, a.itemIds[1], (d) => { d.durationUs = 10 * S })
    const b = ops.addMediaFromAsset(p, 'b', 10 * S)
    p = ops.updateItem<MediaItem>(b.project, b.itemIds[0], (d) => { d.durationUs = 10 * S })
    p = ops.updateItem<MediaItem>(p, b.itemIds[1], (d) => { d.durationUs = 10 * S })
    p = ops.addTransition(p, b.itemIds[0], 'crossfade', S)
    const v1 = trackOf(p, a.itemIds[0]).id
    // texto NA faixa V1 (depois de B) + efeito antigo de escopo track sem alvo → a próxima edição grava o alvo com
    // targetMediaOnly (regra do alvo antigo)
    const legacyText = ops.addText(p, 'title', 22 * S, { trackId: v1 })
    const lfx = ops.addEffect(legacyText.project, 'blur', 1 * S, { durationUs: 6 * S })
    p = ops.addMarker(asLegacy(lfx.project, lfx.itemId), 0)
    // todos os modelos de texto numa faixa de texto, encostados (texto→texto com transição), sombra configurada
    const first = ops.addText(p, 'title', 0, { durationUs: 2 * S })
    p = first.project
    const textTrack = trackOf(p, first.itemId).id
    let t = 2 * S
    const textIds: string[] = [first.itemId]
    for (const id of (Object.keys(TEXT_PRESETS) as TextPresetId[]).filter((x) => x !== 'caption')) {
      const r = ops.addText(p, id, t, { durationUs: 2 * S, trackId: textTrack })
      p = r.project
      textIds.push(r.itemId)
      t += 2 * S
    }
    p = ops.addTransition(p, textIds[1], 'slideL', 0.5 * S)
    p = ops.updateItem<TextItem>(p, textIds[2], (it) => { it.style = patchTextStyle(it.style, { shadowStyle: { color: '#ff000080', blur: 0.2, dx: -0.05, dy: 0.1 }, background: '#11223344', backgroundRadius: 0.3, padding: 0.4 }) })
    // todas as formas (inclui destaque e holofote)
    t = 0
    for (const id of Object.keys(SHAPE_PRESETS) as ShapePresetId[]) {
      p = ops.addShape(p, id, t, { durationUs: 2 * S }).project
      t += 3 * S
    }
    const spot = all(p).find((i): i is ShapeItem => i.type === 'shape' && !!i.spotlight)!
    p = ops.updateItem<ShapeItem>(p, spot.id, (it) => { it.spotlight = { dim: 0.35 }; it.cornerRadius = 0.2 })
    // efeito novo de escopo track ligado à faixa de TEXTO
    const tfx = ops.addEffect(p, 'pixelate', 3 * S, { durationUs: 4 * S })
    p = ops.updateItem<EffectItem>(tfx.project, tfx.itemId, (it) => { it.scope = 'track'; it.targetTrackId = textTrack; delete it.linkId })
    // faixa de legendas (modelo "Legenda") com cues encostadas e estilo próprio
    p = ops.importCaptions(p, [{ startUs: 1 * S, endUs: 3 * S, text: 'Olá' }, { startUs: 3 * S, endUs: 5 * S, text: 'Ação' }], { mode: 'replace' }).project
    p = ops.setCaptionStyle(p, { shadow: true, maxWidth: 0.6 })
    // marca: abertura (desloca tudo) e marca d'água, de modelos salvos de um projeto de origem
    let src = ops.addAsset(createEmptyProject('origem'), png('logo'))
    const logo = ops.addMediaFromAsset(src, 'logo', 0)
    src = ops.updateItem<MediaItem>(logo.project, logo.itemIds[0], (d) => { d.durationUs = 2 * S; d.visual!.transform.scale = { value: 0.2 } })
    const introTitle = ops.addText(src, 'title', 0, { durationUs: 2 * S })
    const intro = templateFromSelection(introTitle.project, [logo.itemIds[0], introTitle.itemId], 'Vinheta', 'intro').template
    const mark = templateFromSelection(introTitle.project, [logo.itemIds[0]], 'Logo', 'watermark').template
    p = applyTemplate(p, intro, materialized(intro), 'intro', 0).project
    p = applyTemplate(p, mark, materialized(mark), 'watermark', 0).project
    return p
  }

  it('toDiskProject → v1.3 aceita, o parse novo devolve o mesmo projeto e a regravação da v1.3 continua legível', () => {
    const p = kitchenSink()
    // o projeto tem de fato tudo (o teste não pode passar vazio)
    const items = all(p)
    const texts = items.filter((i): i is TextItem => i.type === 'text')
    const fx = items.filter((i): i is EffectItem => i.type === 'effect')
    expect(texts.length).toBeGreaterThanOrEqual(Object.keys(TEXT_PRESETS).length + 3)
    expect(texts.some((x) => x.counter)).toBe(true)
    expect(texts.some((x) => x.style.shadowStyle)).toBe(true)
    expect(items.some((i) => i.type === 'shape' && i.spotlight)).toBe(true)
    expect(items.filter((i) => i.type === 'shape').length).toBeGreaterThanOrEqual(Object.keys(SHAPE_PRESETS).length)
    const kinds = transitionWindows(p).map((w) => `${ops.findItem(p, w.fromId)!.item.type}→${ops.findItem(p, w.toId)!.item.type}`)
    expect(kinds.sort()).toEqual(['media→media', 'text→text'])
    expect(p.tracks.some(ops.isCaptionsTrack)).toBe(true)
    expect(fx.some((e) => e.targetMediaOnly === true)).toBe(true)
    const textTrackFx = fx.find((e) => e.scope === 'track' && !e.targetMediaOnly)!
    expect(p.tracks.find((tr) => tr.id === textTrackFx.targetTrackId)!.items.every((i) => i.type === 'text')).toBe(true)
    const gen = new Set(p.assets.filter((x) => x.source.type === 'generated').map((x) => x.id))
    expect(items.filter((i) => i.type === 'media' && gen.has(i.assetId)).length).toBeGreaterThanOrEqual(2) // abertura + marca d'água
    expect(items.some((i) => i.type === 'media' && i.startUs === 0 && p.assets.find((x) => x.id === i.assetId)?.source.type === 'generated')).toBe(true)
    expect(validateProject(p)).toEqual([])

    const disk = JSON.parse(JSON.stringify(toDiskProject(p)))
    const v13 = parseProjectV13(disk)
    expect(v13.success).toBe(true)
    expect(parseProject(disk)).toEqual(p)
    // a v1.3 regrava (perde só o que é da v1.5): o arquivo continua legível pelo build novo e pela própria v1.3
    const back = parseProject(JSON.parse(JSON.stringify(v13.data)))
    expect(validateProject(back)).toEqual([])
    expect(parseProjectV13(JSON.parse(JSON.stringify(toDiskProject(back)))).success).toBe(true)
  })
})
