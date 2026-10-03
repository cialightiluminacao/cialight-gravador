import { describe, expect, it } from 'vitest'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { applyTemplate, BRAND_MAX_ASSET_BYTES, BrandFileSchema, BrandTemplateSchema, templateFromSelection, type BrandTemplate } from './brand'
import { createEmptyProject, defaultVisual } from './factory'
import { attachEffects } from './followTransform'
import * as ops from './ops'
import type { Asset, EffectItem, Item, MediaItem, Project, TextItem, Track, Us } from './project'
import { resolveFrame, type Layer } from './resolve'
import { parseProject, toDiskProject, validateProject } from './schema'
import { itemEndUs } from './time'

// Modelos de marca (F5 Task 7): salvar a seleção como modelo e aplicar no playhead / abertura / encerramento / marca
// d'água. A abertura desloca o projeto inteiro: oráculo denso de cobertura dos efeitos de privacidade.

const S = 1_000_000
const file = (id: string, kind: Asset['kind'], dur: Us | null, extra: Partial<Asset> = {}): Asset => ({
  id, name: `${id}.${kind === 'image' ? 'png' : kind === 'audio' ? 'm4a' : 'mp4'}`, kind, source: { type: 'file', path: `C:/m/${id}`, size: 1000, mtimeMs: 1 }, durationUs: dur,
  ...(kind === 'video' ? { video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0 as const, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' } } : {}),
  ...(kind === 'audio' ? { audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' } } : {}),
  status: 'ready', ...extra
})
const session: Asset = { id: 'rec', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const items = (p: Project): Item[] => p.tracks.flatMap((t) => t.items)
const find = (p: Project, id: string): Item => ops.findItem(p, id)!.item
const trackOf = (p: Project, id: string): Track => ops.findItem(p, id)!.track
const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return `${(e as ops.EditError).code}: ${(e as Error).message}` }
  return 'ok'
}
/** v1.3 abre e o build novo relê igual. */
function v13RoundTrip(p: Project): void {
  const disk = JSON.parse(JSON.stringify(toDiskProject(p)))
  expect(parseProjectV13(disk).success).toBe(true)
  expect(parseProject(disk)).toEqual(p)
  expect(validateProject(p)).toEqual([])
}

/**
 * Projeto de origem: vídeo de arquivo (com áudio vinculado) em 1–6 s, logo (imagem) em PiP 1–4 s, título 1,5–4,5 s,
 * blur vinculado ao vídeo, forma 2–3 s, gravação da tela (session) em 8–12 s.
 */
function source(): { p: Project; video: string; audio: string; logo: string; title: string; fx: string; shape: string; rec: string } {
  let p = createEmptyProject('origem')
  for (const a of [file('v', 'video', 10 * S), file('logo', 'image', null), session]) p = ops.addAsset(p, a)
  const v = ops.addMediaFromAsset(p, 'v', 1 * S)
  p = ops.updateItem<MediaItem>(v.project, v.itemIds[0], (d) => { d.durationUs = 5 * S })
  p = ops.updateItem<MediaItem>(p, v.itemIds[1], (d) => { d.durationUs = 5 * S })
  const logo = ops.addMediaFromAsset(p, 'logo', 1 * S)
  p = ops.updateItem<MediaItem>(logo.project, logo.itemIds[0], (d) => { d.durationUs = 3 * S; d.visual!.transform.scale = { value: 0.2 } })
  const t = ops.addText(p, 'title', 1.5 * S)
  const fx = ops.addEffect(t.project, 'blur', 2 * S, { durationUs: 2 * S })
  const sh = ops.addShape(fx.project, 'rect', 2 * S, { durationUs: S })
  const rec = ops.addMediaFromAsset(sh.project, 'rec', 8 * S)
  return { p: rec.project, video: v.itemIds[0], audio: v.itemIds[1], logo: logo.itemIds[0], title: t.itemId, fx: fx.itemId, shape: sh.itemId, rec: rec.itemIds[0] }
}

/** Asset do projeto (copiado do modelo) para cada asset do modelo. */
const materialized = (t: BrandTemplate): Record<string, Asset> =>
  Object.fromEntries(t.assets.map((a) => [a.id, { ...file(`gen-${a.id}`, a.kind, a.kind === 'image' ? null : 10 * S), name: a.name, source: { type: 'generated' as const, file: `generated/brand-${t.id}-${a.file}` } }]))

describe('templateFromSelection', () => {
  it('tempos relativos ao menor início, faixas na ordem de pilha, vínculos internos ficam, arquivos a copiar', () => {
    const s = source()
    const r = templateFromSelection(s.p, [s.title, s.logo, s.video, s.audio, s.shape], 'Vinheta', 'intro', new Date('2026-10-02T12:00:00Z'))
    const t = r.template
    expect(t.name).toBe('Vinheta')
    expect(t.kind).toBe('intro')
    expect(t.createdAt).toBe('2026-10-02T12:00:00.000Z')
    expect(t.durationUs).toBe(5 * S) // 1 s → 6 s
    const all = t.tracks.flatMap((x) => x.items)
    expect(Math.min(...all.map((i) => i.startUs))).toBe(0)
    const byType = (ty: string): Item[] => all.filter((i) => i.type === ty)
    expect(byType('text')[0].startUs).toBe(0.5 * S)
    expect(byType('shape')[0].startUs).toBe(1 * S)
    // pilha: vídeo, logo, texto/forma (de baixo para cima); áudio no fim (faixas de áudio vêm depois)
    const order = s.p.tracks.filter((x) => x.items.some((i) => [s.title, s.logo, s.video, s.audio, s.shape].includes(i.id))).map((x) => x.id)
    expect(t.tracks.map((x) => x.items[0].id)).toEqual(order.map((id) => s.p.tracks.find((x) => x.id === id)!.items.find((i) => [s.title, s.logo, s.video, s.audio, s.shape].includes(i.id))!.id))
    // vídeo e áudio vinculados entre si (o blur, vinculado também, ficou de fora)
    const vid = all.find((i) => i.id === s.video)!, aud = all.find((i) => i.id === s.audio)!
    expect(vid.linkId).toBeDefined()
    expect(vid.linkId).toBe(aud.linkId)
    expect(t.assets.map((a) => [a.id, a.kind, a.file])).toEqual([['v', 'video', '1-v.mp4'], ['logo', 'image', '2-logo.png']])
    expect(r.assetsToCopy).toEqual([{ assetId: 'v', sourcePath: 'C:/m/v' }, { assetId: 'logo', sourcePath: 'C:/m/logo' }])
    expect(r.warnings).toEqual([])
    expect(BrandTemplateSchema.safeParse(JSON.parse(JSON.stringify(t))).success).toBe(true)
  })

  it('vínculo para fora da seleção sai; efeitos ficam de fora com aviso', () => {
    const s = source()
    const r = templateFromSelection(s.p, [s.video, s.fx, s.title], 'X', 'overlay')
    const all = r.template.tracks.flatMap((x) => x.items)
    expect(all.map((i) => i.type).sort()).toEqual(['media', 'text'])
    expect(all.find((i) => i.type === 'media')!.linkId).toBeUndefined() // o áudio vinculado não foi selecionado
    expect(r.warnings).toEqual(['1 efeito de privacidade ficou de fora: eles dependem do conteúdo do projeto.'])
  })

  it('gravação (session) ou anotações → recusa; só efeitos → nada para salvar; nome vazio → recusa', () => {
    const s = source()
    expect(code(() => templateFromSelection(s.p, [s.title, s.rec], 'X', 'overlay'))).toMatch(/^invalid: 1 item selecionado vem de uma gravação/)
    const ann: Project = { ...s.p, tracks: [...s.p.tracks, { id: 'ta', kind: 'video', name: 'Anotações', muted: false, hidden: false, locked: false, volume: 1, items: [{ id: 'an', type: 'annotations', startUs: 0, durationUs: S, sessionId: 's1', inUs: 0 }] }] }
    expect(code(() => templateFromSelection(ann, ['an'], 'X', 'overlay'))).toMatch(/^invalid: .*gravação/)
    expect(code(() => templateFromSelection(s.p, [s.fx], 'X', 'overlay'))).toMatch(/^invalid: Nada para salvar/)
    expect(code(() => templateFromSelection(s.p, [s.title], '   ', 'overlay'))).toBe('invalid: Dê um nome ao modelo')
    expect(code(() => templateFromSelection(s.p, [], 'X', 'overlay'))).toMatch(/^notFound/)
  })

  it('arquivos acima de 500 MB → recusa', () => {
    const s = source()
    const big = ops.updateAsset(s.p, 'v', { source: { type: 'file', path: 'C:/m/v', size: BRAND_MAX_ASSET_BYTES + 1, mtimeMs: 1 } })
    expect(code(() => templateFromSelection(big, [s.video], 'X', 'intro'))).toMatch(/^invalid: Os arquivos do modelo somam 500 MB; o limite é 500 MB/)
  })

  it('transição de entrada só fica com o item anterior encostado também no modelo; legendas mantêm o papel', () => {
    let p = ops.addCaption(createEmptyProject('c'), 0, 'Oi').project
    const t1 = ops.addText(p, 'title', 0, { durationUs: 2 * S })
    const t2 = ops.addText(t1.project, 'title', 2 * S, { durationUs: 2 * S, trackId: ops.findItem(t1.project, t1.itemId)!.track.id })
    p = ops.addTransition(t2.project, t2.itemId, 'crossfade', 500_000)
    expect((find(p, t2.itemId) as TextItem).transitionIn).toBeDefined()
    const cap = items(p).find((i) => ops.isCaptionsTrack(trackOf(p, i.id)))!
    const both = templateFromSelection(p, [t1.itemId, t2.itemId, cap.id], 'X', 'overlay').template
    expect(both.tracks.flatMap((x) => x.items).filter((i) => i.type === 'text' && i.transitionIn)).toHaveLength(1)
    expect(both.tracks.map((x) => x.role)).toEqual([undefined, 'captions'])
    const only = templateFromSelection(p, [t2.itemId], 'X', 'overlay').template
    expect((only.tracks[0].items[0] as TextItem).transitionIn).toBeUndefined()
  })
})

describe('BrandTemplateSchema', () => {
  const s = source()
  const t = templateFromSelection(s.p, [s.logo, s.title], 'Logo', 'watermark').template
  it('aceita o modelo e recusa id/arquivo inseguros, mídia sem arquivo e efeitos', () => {
    expect(BrandFileSchema.safeParse({ version: 1, templates: [t] }).success).toBe(true)
    expect(BrandTemplateSchema.safeParse({ ...t, id: '../x' }).success).toBe(false)
    expect(BrandTemplateSchema.safeParse({ ...t, assets: [{ ...t.assets[0], file: '..\\evil.png' }] }).success).toBe(false)
    expect(BrandTemplateSchema.safeParse({ ...t, assets: [] }).success).toBe(false)
    const fx = items(s.p).find((i) => i.type === 'effect')
    expect(BrandTemplateSchema.safeParse({ ...t, tracks: [{ items: [fx] }] }).success).toBe(false)
    expect(BrandFileSchema.safeParse({ version: 2, templates: [] }).success).toBe(false)
  })
})

/** Destino: vídeo 0–10 s (áudio vinculado), blur vinculado 2–6 s numa faixa de efeitos, marcador em 3 s. */
function target(): { p: Project; clip: string; fx: string } {
  let p = ops.addAsset(createEmptyProject('destino'), file('w', 'video', 20 * S))
  const m = ops.addMediaFromAsset(p, 'w', 0)
  p = ops.updateItem<MediaItem>(m.project, m.itemIds[0], (d) => { d.durationUs = 10 * S })
  p = ops.updateItem<MediaItem>(p, m.itemIds[1], (d) => { d.durationUs = 10 * S })
  const fx = ops.addEffect(p, 'blur', 2 * S, { durationUs: 4 * S })
  p = ops.addMarker(fx.project, 3 * S, 'M')
  return { p, clip: m.itemIds[0], fx: fx.itemId }
}
function brandOf(kind: BrandTemplate['kind'] = 'intro'): BrandTemplate {
  const s = source()
  return templateFromSelection(s.p, [s.title, s.logo, s.video, s.audio, s.shape], 'Vinheta', kind).template
}

describe('applyTemplate', () => {
  it('playhead: sem ripple, ids novos, mídia abaixo dos efeitos, texto numa sobreposição no topo, vínculo refeito, assets entram', () => {
    const { p } = target()
    const t = brandOf()
    const map = materialized(t)
    const r = applyTemplate(p, t, map, 'playhead', 12 * S)
    const q = r.project
    expect(r.itemIds).toHaveLength(5)
    expect(r.itemIds.every((id) => !t.tracks.some((x) => x.items.some((i) => i.id === id)))).toBe(true)
    // nada existente mudou de lugar
    for (const it of items(p)) expect(find(q, it.id)).toEqual(it)
    expect(q.markers).toEqual(p.markers)
    const added = r.itemIds.map((id) => find(q, id))
    expect(Math.min(...added.map((i) => i.startUs))).toBe(12 * S)
    // mídia (vídeo e logo) nunca acima da faixa de efeitos; texto/forma acima dela
    const fxIndex = q.tracks.findIndex(ops.isFxTrack)
    for (const it of added) {
      const ti = q.tracks.findIndex((x) => x.items.some((i) => i.id === it.id))
      if (it.type === 'media' && (it as MediaItem).visual) expect(ti).toBeLessThan(fxIndex)
      if (it.type === 'text' || it.type === 'shape') expect(ti).toBeGreaterThan(fxIndex)
    }
    const vid = added.find((i) => i.type === 'media' && (i as MediaItem).visual && (i as MediaItem).assetId === map.v.id) as MediaItem
    const aud = added.find((i) => i.type === 'media' && !(i as MediaItem).visual) as MediaItem
    expect(vid.linkId).toBeDefined()
    expect(aud.linkId).toBe(vid.linkId)
    expect(q.assets.map((a) => a.id)).toEqual([...p.assets.map((a) => a.id), map.v.id, map.logo.id])
    // a pilha do modelo continua: logo acima do vídeo
    const logo = added.find((i) => i.type === 'media' && (i as MediaItem).assetId === map.logo.id)!
    expect(q.tracks.findIndex((x) => x.items.includes(logo))).toBeGreaterThan(q.tracks.findIndex((x) => x.items.includes(vid)))
    v13RoundTrip(q)
  })

  it('playhead sobre conteúdo: não recorta nada, usa outras faixas', () => {
    const { p, clip } = target()
    const t = brandOf()
    const q = applyTemplate(p, t, materialized(t), 'playhead', 1 * S).project
    expect(find(q, clip)).toEqual(find(p, clip))
    expect(items(q)).toHaveLength(items(p).length + 5)
    v13RoundTrip(q)
  })

  it('intro: desloca tudo (itens, efeitos, legendas, marcadores) pela duração e põe o modelo em 0', () => {
    const tp = target()
    const p = ops.addCaption(tp.p, 1 * S, 'Legenda').project
    const t = brandOf()
    const q = applyTemplate(p, t, materialized(t), 'intro', 99 * S).project
    for (const it of items(p)) expect(find(q, it.id).startUs).toBe(it.startUs + t.durationUs)
    expect(q.markers.map((m) => m.tUs)).toEqual(p.markers.map((m) => m.tUs + t.durationUs))
    const added = items(q).filter((i) => !items(p).some((x) => x.id === i.id))
    expect(Math.min(...added.map((i) => i.startUs))).toBe(0)
    expect(Math.max(...added.map(itemEndUs))).toBe(t.durationUs)
    v13RoundTrip(q)
  })

  it('intro com faixa bloqueada → EditError (sem deslocar nada)', () => {
    const { p } = target()
    const locked = ops.updateTrack(p, p.tracks.find(ops.isFxTrack)!.id, { locked: true })
    const t = brandOf()
    expect(code(() => applyTemplate(locked, t, materialized(t), 'intro', 0))).toMatch(/^locked: Faixa bloqueada: "Efeitos"/)
  })

  it('outro: no fim do conteúdo (efeitos não contam), sem ripple', () => {
    const { p } = target()
    const t = brandOf('outro')
    const r = applyTemplate(p, t, materialized(t), 'outro', 0)
    expect(Math.min(...r.itemIds.map((id) => find(r.project, id).startUs))).toBe(ops.contentEndUs(p))
    for (const it of items(p)) expect(find(r.project, it.id)).toEqual(it)
    v13RoundTrip(r.project)
  })

  it('legendas do modelo: na faixa de legendas; ocupada no trecho → EditError', () => {
    let src = ops.addCaption(createEmptyProject('c'), 0, 'Assinatura').project
    const cap = items(src)[0]
    const t = templateFromSelection(src, [cap.id], 'Leg', 'overlay').template
    const { p } = target()
    const q = applyTemplate(p, t, {}, 'playhead', 4 * S).project
    const added = items(q).find((i) => i.type === 'text')!
    expect(ops.isCaptionsTrack(trackOf(q, added.id))).toBe(true)
    expect(code(() => applyTemplate(q, t, {}, 'playhead', 4 * S))).toMatch(/^overlap: Já há legendas/)
    v13RoundTrip(q)
    src = q
  })

  it('arquivo do modelo sem asset no mapa → EditError', () => {
    const { p } = target()
    const t = brandOf()
    expect(code(() => applyTemplate(p, t, {}, 'playhead', 0))).toMatch(/^notFound: O arquivo “v.mp4” do modelo/)
  })

  it("marca d'água: imagem esticada de 0 ao fim do conteúdo numa faixa nova no topo (abaixo das legendas)", () => {
    const tp = target()
    const p = ops.addCaption(tp.p, 0, 'Oi').project
    const s = source()
    const t = templateFromSelection(s.p, [s.logo], 'Logo', 'watermark').template
    const r = applyTemplate(p, t, materialized(t), 'watermark', 5 * S)
    const q = r.project
    expect(r.itemIds).toHaveLength(1)
    const wm = find(q, r.itemIds[0]) as MediaItem
    expect([wm.startUs, wm.durationUs]).toEqual([0, ops.contentEndUs(p)])
    const ti = q.tracks.findIndex((x) => x.items.includes(wm))
    expect(q.tracks[ti].name).toBe("Marca d'água")
    expect(ops.isCaptionsTrack(q.tracks[ti + 1])).toBe(true)
    expect(ti).toBeGreaterThan(q.tracks.findIndex(ops.isFxTrack))
    expect(r.warnings).toEqual([])
    v13RoundTrip(q)
  })

  it("marca d'água: texto + vídeo se repetem com o período do modelo (último pedaço cortado); áudio fica de fora com aviso", () => {
    const { p } = target() // conteúdo até 10 s
    const s = source()
    const t = templateFromSelection(s.p, [s.video, s.audio, s.title], 'Selo', 'watermark').template // 5 s; texto 0,5–3,5
    const r = applyTemplate(p, t, materialized(t), 'watermark', 0)
    expect(r.warnings).toEqual(["O áudio do modelo não entra na marca d'água."])
    const added = r.itemIds.map((id) => find(r.project, id))
    const vids = added.filter((i) => i.type === 'media').map((i) => [i.startUs, i.durationUs])
    expect(vids).toEqual([[0, 5 * S], [5 * S, 5 * S]])
    // o texto (um item só, parado) é esticado de 0 ao fim
    expect(added.filter((i) => i.type === 'text').map((i) => [i.startUs, i.durationUs])).toEqual([[0, 10 * S]])
    expect(added.every((i) => !i.linkId)).toBe(true)
    v13RoundTrip(r.project)
  })

  it("marca d'água: vídeo de 4 s num conteúdo de 10 s → 4 + 4 + 2", () => {
    const { p } = target()
    const s = source()
    const short = ops.updateItem<MediaItem>(s.p, s.video, (d) => { d.durationUs = 4 * S })
    const t = templateFromSelection(short, [s.video], 'V', 'watermark').template
    const r = applyTemplate(p, t, materialized(t), 'watermark', 0)
    expect(r.itemIds.map((id) => [find(r.project, id).startUs, find(r.project, id).durationUs])).toEqual([[0, 4 * S], [4 * S, 4 * S], [8 * S, 2 * S]])
  })

  it("marca d'água num projeto vazio → EditError", () => {
    const s = source()
    const t = templateFromSelection(s.p, [s.logo], 'Logo', 'watermark').template
    expect(code(() => applyTemplate(createEmptyProject('v'), t, materialized(t), 'watermark', 0))).toMatch(/^invalid: O projeto ainda não tem conteúdo/)
  })
})

// ---------------------------------------------------------------- privacidade (invariante 2): abertura

/** Id da camada (transição: o item B). */
const layerKey = (l: Layer): string => ('itemId' in l ? l.itemId : '?')

/**
 * Projeto denso de privacidade: dois clipes com dissolver entre eles, áudio vinculado, efeito vinculado (seguidor),
 * ancorado (attach) com região animada, invertido, `scope:'track'` com alvo explícito, tarja solta, legendas e
 * marcadores; uma faixa de vídeo oculta e um item desativado.
 */
function privacyScene(): Project {
  let p = ops.addAsset(ops.addAsset(createEmptyProject('priv'), file('a', 'video', 20 * S)), file('b', 'video', 20 * S))
  const a = ops.addMediaFromAsset(p, 'a', 0)
  p = ops.updateItem<MediaItem>(a.project, a.itemIds[0], (d) => { d.durationUs = 5 * S; d.visual!.transform.scale = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'inOut' }, { tUs: 4 * S, value: 1.6, ease: 'linear' }] } })
  p = ops.updateItem<MediaItem>(p, a.itemIds[1], (d) => { d.durationUs = 5 * S })
  const b = ops.addMediaFromAsset(p, 'b', 5 * S, { videoTrackId: ops.findItem(p, a.itemIds[0])!.track.id })
  p = ops.addTransition(b.project, b.itemIds[0], 'crossfade', 800_000)
  // PiP numa segunda faixa de vídeo (alvo do escopo track)
  const pt = ops.addTrack(p, 'video')
  const pip = ops.addMediaFromAsset(pt.project, 'b', 1 * S, { videoTrackId: pt.trackId })
  p = pip.project
  const pipTrack = ops.findItem(p, pip.itemIds[0])
  p = ops.updateItem<MediaItem>(p, pip.itemIds[0], (d) => { d.durationUs = 6 * S; d.visual!.transform.scale = { value: 0.3 }; d.visual!.transform.x = { value: 0.8 } })
  // seguidor vinculado ao clipe A
  const f1 = ops.addEffect(p, 'blur', 0.5 * S, { durationUs: 3 * S, region: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 } })
  p = f1.project
  // ancorado ao clipe A com região animada
  const f2 = ops.addEffect(p, 'pixelate', 1 * S, { durationUs: 3 * S, region: { x: 0.6, y: 0.4, w: 0.15, h: 0.1 } })
  p = ops.updateItem<EffectItem>(f2.project, f2.itemId, (d) => { d.region.x = { value: 0.6, keys: [{ tUs: 0, value: 0.6, ease: 'linear' }, { tUs: 2 * S, value: 0.4, ease: 'linear' }] } })
  p = attachEffects(p, a.itemIds[0], [f2.itemId])
  // invertido sobre B
  const f3 = ops.addEffect(p, 'blurAllExcept', 6 * S, { durationUs: 3 * S })
  p = f3.project
  // escopo 'track' com alvo explícito (o PiP)
  const f4 = ops.addEffect(p, 'blur', 2 * S, { durationUs: 3 * S, region: { x: 0.8, y: 0.5, w: 0.2, h: 0.3 } })
  p = ops.setEffectScope(f4.project, f4.itemId, 'track')
  p = ops.updateItem<EffectItem>(p, f4.itemId, (d) => { d.targetTrackId = pipTrack!.track.id })
  // tarja solta (sem vínculo), desativada em parte do tempo? — um item desativado separado
  const f5 = ops.addEffect(p, 'solid', 7 * S, { durationUs: 2 * S })
  p = ops.setItemEnabled(f5.project, [f5.itemId], false)
  const f6 = ops.addEffect(p, 'solid', 8.5 * S, { durationUs: 1 * S })
  p = ops.updateItem<EffectItem>(f6.project, f6.itemId, (d) => { delete d.linkId })
  p = ops.addCaption(p, 0.2 * S, 'Primeira').project
  p = ops.addCaption(p, 4 * S, 'Segunda').project
  p = ops.addMarker(ops.addMarker(p, 2 * S, 'a'), 9 * S, 'b')
  // faixa de vídeo oculta com conteúdo
  const hid = ops.addTrack(p, 'video')
  p = ops.insertItems(hid.project, hid.trackId, [{ ...(find(p, a.itemIds[0]) as MediaItem), id: 'hidden-clip', linkId: undefined, startUs: 3 * S, durationUs: 2 * S, visual: defaultVisual() }], 'overwrite')
  p = ops.updateTrack(p, hid.trackId, { hidden: true })
  return p
}

describe('privacidade: abertura (intro) não muda a cobertura de nenhum efeito', () => {
  it('cena tem os casos: vinculado, ancorado, invertido, escopo track, transição, legendas', () => {
    const p = privacyScene()
    const fx = items(p).filter((i): i is EffectItem => i.type === 'effect')
    expect(fx.some((f) => f.linkId && !f.attach)).toBe(true)
    expect(fx.some((f) => f.attach)).toBe(true)
    expect(fx.some((f) => f.invert)).toBe(true)
    expect(fx.some((f) => f.scope === 'track' && f.targetTrackId)).toBe(true)
    expect(items(p).some((i) => i.type === 'media' && i.transitionIn)).toBe(true)
    expect(p.tracks.some(ops.isCaptionsTrack)).toBe(true)
  })

  it.each([
    ['modelo com texto, forma, logo e vídeo', () => brandOf()],
    ['modelo só com texto', () => { const s = source(); return templateFromSelection(s.p, [s.title], 'T', 'intro').template }]
  ])('denso (1/240 s): resolve(original, t) = resolve(novo, t + duração) nas camadas originais — %s', (_n, make) => {
    const p = privacyScene()
    const t = make()
    const q = applyTemplate(p, t, materialized(t), 'intro', 0).project
    const D = t.durationUs
    const orig = new Set(items(p).map((i) => i.id))
    const end = ops.projectDurationUs(p)
    const step = Math.round(S / 240)
    let n = 0
    for (let at = 0; at < end; at += step) {
      const a = JSON.stringify(resolveFrame(p, at))
      const b = JSON.stringify(resolveFrame(q, at + D).filter((l) => orig.has(layerKey(l))))
      if (a !== b) throw new Error(`cobertura diferente em t=${at} µs:\n${a}\n${b}`)
      // nada do modelo aparece depois da abertura
      expect(resolveFrame(q, at + D).every((l) => orig.has(layerKey(l)))).toBe(true)
      n++
    }
    expect(n).toBeGreaterThan(2000)
    v13RoundTrip(q)
  })
})
