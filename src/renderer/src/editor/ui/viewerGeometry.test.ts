import { describe, expect, it } from 'vitest'
import { createEmptyProject, createMediaItem } from '@shared/editor/factory'
import { attachEffects } from '@shared/editor/followTransform'
import { EditError, addAsset, addEffect, addMediaFromAsset, addShape, addText, addTransition, insertItems, setAnimValue, setItemEnabled, toggleKeyframe, updateItem, updateTrack } from '@shared/editor/ops'
import type { Asset, EffectItem, MediaItem, Project } from '@shared/editor/project'
import { cornerScale, dragToRegion, effectBoxes, hitTest, hitTestRegions, itemBoxes, keyframeAt, regionBoxOf, regionHit, resizeRegion, rotateAngle, snapCenter, snapRegion, snapResize, writeRegion, writeRegionValues, type RegionBox } from './viewerGeometry'

const asset = (id: string, w: number, h: number): Asset => ({ id, name: id, kind: 'video', source: { type: 'generated', file: `${id}.mp4` }, durationUs: 5_000_000, status: 'ready', video: { width: w, height: h, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: 1_000_000 } })

function project(): Project {
  let p = createEmptyProject('t') // 1920×1080, faixas: vídeo 1, áudio 1
  p = addAsset(addAsset(p, asset('full', 1920, 1080)), asset('pip', 640, 640))
  p = insertItems(p, p.tracks[0].id, [createMediaItem(p.assets[0], 0, 'video')], 'overwrite')
  const pip = createMediaItem(p.assets[1], 0, 'video')
  const v = pip.visual!
  const top = { id: 't_top', kind: 'video' as const, name: 'Vídeo 2', muted: false, hidden: false, locked: false, volume: 1, items: [] }
  p = { ...p, tracks: [...p.tracks, top] }
  return insertItems(p, 't_top', [{ ...pip, id: 'i_pip', visual: { ...v, transform: { ...v.transform, x: { value: 0.8 }, y: { value: 0.75 }, scale: { value: 0.25 } } } }], 'overwrite')
}

describe('viewerGeometry', () => {
  it('caixas das camadas de mídia em pixels do canvas (fundo → topo)', () => {
    const boxes = itemBoxes(project(), 1_000_000)
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toMatchObject({ cx: 960, cy: 540, w: 1920, h: 1080, rotation: 0 })
    // 640² contido em 1080 de altura → 1080², ×0,25 = 270
    expect(boxes[1]).toMatchObject({ itemId: 'i_pip', cx: 1536, cy: 810, rotation: 0 })
    expect(boxes[1].w).toBeCloseTo(270)
    expect(boxes[1].h).toBeCloseTo(270)
  })

  it('hitTest devolve o item mais ao topo sob o ponto, considerando rotação', () => {
    const boxes = itemBoxes(project(), 1_000_000)
    expect(hitTest(boxes, 1536, 810)).toBe('i_pip')
    expect(hitTest(boxes, 100, 100)).toBe(boxes[0].itemId)
    expect(hitTest(boxes, -10, 100)).toBeNull()
    const rotated = [{ ...boxes[1], rotation: 45 }]
    // canto do quadrado sem rotação (fora do losango girado)
    expect(hitTest(rotated, 1536 + 130, 810 + 130)).toBeNull()
    expect(hitTest(rotated, 1536 + 180, 810)).toBe('i_pip')
  })

  it('snapCenter gruda no centro a ±1 %', () => {
    expect(snapCenter(0.505)).toEqual({ value: 0.5, snapped: true })
    expect(snapCenter(0.489)).toEqual({ value: 0.489, snapped: false })
  })

  it('cornerScale: Shift mantém o centro; sem Shift o canto oposto fica parado', () => {
    const box = { itemId: 'x', cx: 100, cy: 100, w: 100, h: 50, rotation: 0 }
    // canto inferior direito (150,125) → (200,150): diagonal a partir do canto oposto (50,75) ×1,5
    const keep = cornerScale(box, 'br', { x: 200, y: 150 }, false)
    expect(keep.factor).toBeCloseTo(1.5)
    expect(keep.cx).toBeCloseTo(125) // canto oposto fixo → centro no meio da nova diagonal
    expect(keep.cy).toBeCloseTo(112.5)
    // a partir do centro (100,100): (50,25) → (100,50) = ×2
    const center = cornerScale(box, 'br', { x: 200, y: 150 }, true)
    expect(center.factor).toBeCloseTo(2)
    expect(center.cx).toBe(100)
    expect(center.cy).toBe(100)
  })

  it('rotateAngle: ângulo desde o início do arrasto, Shift em passos de 15°', () => {
    const c = { x: 0, y: 0 }
    expect(rotateAngle(c, { x: 0, y: -10 }, { x: 10, y: 0 }, 10, false)).toBeCloseTo(100)
    expect(rotateAngle(c, { x: 0, y: -10 }, { x: 10, y: 1 }, 0, true)).toBe(90)
  })
})

describe('viewerGeometry — regiões de efeito', () => {
  const W = 1920
  const H = 1080
  const box = (o: Partial<RegionBox> = {}): RegionBox => ({ itemId: 'fx', cx: 960, cy: 540, w: 400, h: 200, rotation: 0, shape: 'rect', ...o })

  it('effectBoxes: efeitos ativos no instante, interpolados, de baixo para cima; desativados ficam de fora', () => {
    let p = project()
    const a = addEffect(p, 'blur', 0, { durationUs: 4_000_000, region: { x: 0.25, y: 0.5, w: 0.2, h: 0.1 } })
    p = toggleKeyframe(a.project, a.itemId, 'region.x', 0)
    p = setAnimValue(toggleKeyframe(p, a.itemId, 'region.x', 2_000_000), a.itemId, 'region.x', 2_000_000, 0.75)
    const b = addEffect(p, 'solid', 0, { durationUs: 4_000_000, region: { shape: 'ellipse', rotation: 30 } })
    p = b.project
    const at1 = effectBoxes(p, 1_000_000)
    expect(at1.map((x) => x.itemId)).toEqual([a.itemId, b.itemId])
    expect(at1[0]).toMatchObject({ cy: 540, shape: 'rect', rotation: 0 })
    expect(at1[0].cx).toBeCloseTo(0.5 * W) // 0,25 → 0,75 linear: meio do caminho em 1 s
    expect(at1[0].w).toBeCloseTo(0.2 * W)
    expect(at1[0].h).toBeCloseTo(0.1 * H)
    expect(at1[1]).toMatchObject({ shape: 'ellipse', rotation: 30 })
    expect(effectBoxes(p, 5_000_000)).toEqual([])
    expect(effectBoxes(setItemEnabled(p, [b.itemId], false), 1_000_000).map((x) => x.itemId)).toEqual([a.itemId])
    const fxTrack = p.tracks.find((t) => t.items.some((i) => i.id === b.itemId))!
    expect(effectBoxes(updateTrack(p, fxTrack.id, { locked: true }), 1_000_000)[1]).toMatchObject({ itemId: b.itemId, locked: true })
  })

  it('regionHit: retângulo e elipse rotacionados', () => {
    const r = box({ rotation: 90 }) // 400×200 girado 90° → 200 de largura e 400 de altura na tela
    expect(regionHit(r, 960, 540 + 190)).toBe(true)
    expect(regionHit(r, 960 + 190, 540)).toBe(false)
    const e = box({ shape: 'ellipse' })
    expect(regionHit(e, 960 + 190, 540)).toBe(true)
    expect(regionHit(e, 960 + 190, 540 + 90)).toBe(false) // canto do retângulo, fora da elipse
    expect(regionHit(box({ shape: 'ellipse', rotation: 45 }), 960, 540)).toBe(true)
    // folga em px (alças na borda)
    expect(regionHit(box(), 960 + 205, 540)).toBe(false)
    expect(regionHit(box(), 960 + 205, 540, 6)).toBe(true)
    expect(hitTestRegions([box({ itemId: 'a' }), box({ itemId: 'b', cx: 1000 })], 1000, 540)).toBe('b')
    expect(hitTestRegions([box()], 10, 10)).toBeNull()
    // faixa bloqueada: não é selecionável; a de baixo (desbloqueada) é
    expect(hitTestRegions([box({ itemId: 'a' }), box({ itemId: 'b', locked: true })], 960, 540)).toBe('a')
  })

  it('dragToRegion: canto a canto, Alt a partir do centro, Shift = elipse, mínimo de 1 % do quadro', () => {
    const plain = { alt: false, shift: false, shape: 'rect' as const }
    expect(dragToRegion({ x: 192, y: 108 }, { x: 576, y: 324 }, W, H, plain)).toEqual({ x: 0.2, y: 0.2, w: 0.2, h: 0.2, shape: 'rect' })
    // arrastar para cima/esquerda dá o mesmo retângulo
    expect(dragToRegion({ x: 576, y: 324 }, { x: 192, y: 108 }, W, H, plain)).toEqual({ x: 0.2, y: 0.2, w: 0.2, h: 0.2, shape: 'rect' })
    expect(dragToRegion({ x: 960, y: 540 }, { x: 1152, y: 648 }, W, H, { alt: true, shift: true, shape: 'rect' })).toEqual({ x: 0.5, y: 0.5, w: 0.2, h: 0.2, shape: 'ellipse' })
    const tiny = dragToRegion({ x: 100, y: 100 }, { x: 102, y: 100 }, W, H, { alt: false, shift: false, shape: 'ellipse' })
    expect(tiny).toMatchObject({ w: 0.01, h: 0.01, shape: 'ellipse' })
  })

  it('resizeRegion: borda, canto, Shift mantém proporção, Alt a partir do centro, mínimo de 1 %', () => {
    const b = box() // x 760…1160, y 440…640
    const opts = { keepAspect: false, fromCenter: false, minW: 19.2, minH: 10.8 }
    // borda direita até 1260: largura 500, borda esquerda parada
    expect(resizeRegion(b, 'e', { x: 1260, y: 999 }, opts)).toMatchObject({ cx: 1010, cy: 540, w: 500, h: 200 })
    expect(resizeRegion(b, 'se', { x: 1260, y: 740 }, opts)).toMatchObject({ cx: 1010, cy: 590, w: 500, h: 300 })
    // Alt: a partir do centro (os dois lados andam)
    expect(resizeRegion(b, 'e', { x: 1260, y: 540 }, { ...opts, fromCenter: true })).toMatchObject({ cx: 960, w: 600, h: 200 })
    // Shift: canto mantém a proporção 2:1 (projeção na diagonal), canto oposto parado
    const k = resizeRegion(b, 'se', { x: 1360, y: 640 }, { ...opts, keepAspect: true })
    expect(k.w / k.h).toBeCloseTo(2)
    expect(k.w).toBeCloseTo(560)
    expect(k.cx - k.w / 2).toBeCloseTo(760)
    expect(k.cy - k.h / 2).toBeCloseTo(440)
    // Shift numa borda: o outro lado acompanha, centrado
    expect(resizeRegion(b, 'e', { x: 1360, y: 540 }, { ...opts, keepAspect: true })).toMatchObject({ w: 600, h: 300, cy: 540 })
    // passando do lado oposto: prende no mínimo
    const min = resizeRegion(b, 'e', { x: 0, y: 540 }, opts)
    expect(min.w).toBe(19.2)
    expect(min.cx).toBeCloseTo(760 + 9.6)
    // girada 90°: a borda "e" local aponta para baixo na tela
    const r = resizeRegion(box({ rotation: 90 }), 'e', { x: 960, y: 540 + 300 }, opts)
    expect(r.w).toBeCloseTo(500)
    expect(r.cx).toBeCloseTo(960)
    expect(r.cy).toBeCloseTo(540 + 50)
  })

  it('snapRegion: centro e bordas do quadro a ±1 %; bordas só sem rotação', () => {
    expect(snapRegion({ x: 0.505, y: 0.3, w: 0.2, h: 0.2, rotation: 0 })).toEqual({ x: 0.5, y: 0.3, guides: { v: [0.5], h: [] } })
    const edge = snapRegion({ x: 0.108, y: 0.3, w: 0.2, h: 0.2, rotation: 0 }) // borda esquerda em 0,008 → 0
    expect(edge.x).toBeCloseTo(0.1)
    expect(edge.guides).toEqual({ v: [0], h: [] })
    const bottom = snapRegion({ x: 0.3, y: 0.893, w: 0.2, h: 0.2, rotation: 0 }) // borda de baixo em 0,993 → 1
    expect(bottom.y).toBeCloseTo(0.9)
    expect(bottom.guides.h).toEqual([1])
    const rotated = snapRegion({ x: 0.108, y: 0.505, w: 0.2, h: 0.2, rotation: 30 })
    expect(rotated).toEqual({ x: 0.108, y: 0.5, guides: { v: [], h: [0.5] } })
  })

  it('snapResize: a borda arrastada gruda nas guias (sem rotação)', () => {
    const none = snapResize({ itemId: 'x', cx: 960, cy: 540, w: 400, h: 200, rotation: 0 }, 'e', false, W, H)
    expect(none.box).toMatchObject({ cx: 960, w: 400 })
    expect(none.guides).toEqual({ v: [], h: [] })
    const s = snapResize({ itemId: 'x', cx: 1000, cy: 540, w: 1820, h: 200, rotation: 0 }, 'e', false, W, H) // direita em 1910
    expect(s.box.cx + s.box.w / 2).toBeCloseTo(1920)
    expect(s.box.cx - s.box.w / 2).toBeCloseTo(90) // esquerda parada
    expect(s.guides).toEqual({ v: [1], h: [] })
    const c = snapResize({ itemId: 'x', cx: 960, cy: 540, w: 1900, h: 200, rotation: 0 }, 'w', true, W, H) // Alt: espelha
    expect(c.box).toMatchObject({ cx: 960, w: 1920 })
    // borda arrastada até perto do centro (0,5) com a outra também lá: prende no mínimo de 1 % do quadro
    const tiny = snapResize({ itemId: 'x', cx: 955, cy: 540, w: 10, h: 200, rotation: 0 }, 'e', false, W, H) // direita em 960 → 960, esquerda em 950
    expect(tiny.box.w).toBeCloseTo(19.2)
    expect(tiny.box.cx - tiny.box.w / 2).toBeCloseTo(950)
    const tinyAlt = snapResize({ itemId: 'x', cx: 958, cy: 540, w: 8, h: 200, rotation: 0 }, 'e', true, W, H) // Alt: 2·|960−958| = 4 → 19,2
    expect(tinyAlt.box.w).toBeCloseTo(19.2)
    const rot = snapResize({ itemId: 'x', cx: 1000, cy: 540, w: 1820, h: 200, rotation: 10 }, 'e', false, W, H)
    expect(rot.box.w).toBe(1820)
  })

  it('writeRegion: estático muda o valor fixo; animado cria/atualiza key no playhead; só o que mudou', () => {
    const a = addEffect(project(), 'blur', 1_000_000, { durationUs: 4_000_000 })
    const fx = (q: Project): EffectItem => q.tracks.flatMap((t) => t.items).find((i) => i.id === a.itemId) as EffectItem
    const from = { x: 0.5, y: 0.5, w: 0.4, h: 0.3, rotation: 0 }
    const s = writeRegion(a.project, a.itemId, 2_000_000, from, { x: 0.6, y: 0.5 })
    expect(fx(s).region.x).toEqual({ value: 0.6 })
    expect(fx(s).region.y).toEqual({ value: 0.5 })
    // x animado (key em 1 s local): mover em 3 s (2 s local) cria key só em x; y continua fixo
    const k = toggleKeyframe(a.project, a.itemId, 'region.x', 2_000_000)
    const m = writeRegion(k, a.itemId, 3_000_000, from, { x: 0.7, y: 0.4 })
    expect(fx(m).region.x.keys).toEqual([{ tUs: 1_000_000, value: 0.5, ease: 'linear' }, { tUs: 2_000_000, value: 0.7, ease: 'linear' }])
    expect(fx(m).region.y).toEqual({ value: 0.4 })
    // mesmo instante de novo: atualiza o key existente
    expect(fx(writeRegion(m, a.itemId, 3_000_000, { ...from, x: 0.7 }, { x: 0.8 })).region.x.keys!.map((x) => x.value)).toEqual([0.5, 0.8])
    expect(writeRegion(a.project, a.itemId, 2_000_000, from, { ...from })).toBe(a.project)
  })

  it('efeito ancorado: a caixa é a da tela (zoom 2× do clipe) e arrastar grava relativo ao conteúdo, sem acumular a folga', () => {
    const p0 = project()
    const full = p0.tracks[0].items[0].id
    const a = addEffect(p0, 'blur', 0, { durationUs: 4_000_000, region: { x: 0.3, y: 0.5, w: 0.2, h: 0.2 } })
    let p = attachEffects(a.project, full, [a.itemId])
    p = updateItem<MediaItem>(p, full, (d) => { d.visual!.transform.scale = { value: 2 } })
    const fx = (q: Project): EffectItem => q.tracks.flatMap((t) => t.items).find((i) => i.id === a.itemId) as EffectItem
    // conteúdo 0,3 → tela ½ + 2·(0,3 − ½) = 0,1; largura 0,4 (+ 1 px de cada lado)
    const box = regionBoxOf(p, fx(p), 1_000_000)
    expect(box.cx / 1920).toBeCloseTo(0.1, 9)
    expect(box.w).toBeCloseTo(0.4 * 1920 + 2, 6)
    expect(effectBoxes(p, 1_000_000).find((b) => b.itemId === a.itemId)).toMatchObject({ cx: box.cx, w: box.w })
    // arrastar +0,1 do quadro = +0,05 no conteúdo (escala 2); a largura guardada não muda
    const from = { x: box.cx / 1920, y: box.cy / 1080, w: box.w / 1920, h: box.h / 1080, rotation: box.rotation }
    const q = writeRegion(p, a.itemId, 1_000_000, from, { x: from.x + 0.1 })
    expect(fx(q).region.x.value).toBeCloseTo(0.35, 9)
    expect(fx(q).region.w.value).toBeCloseTo(0.2, 9)
    // âncora perdida (clipe desativado): EditError (vira toast no editor), nunca um "não fez nada" silencioso
    const lost = setItemEnabled(p, [full], false)
    expect(() => writeRegion(lost, a.itemId, 1_000_000, from, { x: 0.9 })).toThrow(/Clipe da âncora indisponível/)
    expect(() => writeRegionValues(lost, a.itemId, 1_000_000, { x: 0.5 })).toThrow(EditError)
    // "Ajustar ao quadro inteiro" ancorado: a imagem inteira da fonte (no espaço do conteúdo); com o zoom 2× a região na
    // tela passa a cobrir a camada inteira (2× o quadro, + a folga)
    const whole = writeRegionValues(p, a.itemId, 1_000_000, { x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0 })
    expect(fx(whole).region).toMatchObject({ x: { value: 0.5 }, y: { value: 0.5 }, w: { value: 1 }, h: { value: 1 } })
    const b = regionBoxOf(whole, fx(whole), 1_000_000)
    expect(b).toMatchObject({ cx: 960, cy: 540 })
    expect(b.w).toBeCloseTo(2 * 1920 + 2, 6)
  })

  it('keyframeAt: losango só com key de região a ±meio quadro', () => {
    let p = project()
    const a = addEffect(p, 'blur', 1_000_000, { durationUs: 4_000_000 })
    p = toggleKeyframe(a.project, a.itemId, 'region.y', 2_000_000)
    const fx = (): EffectItem => p.tracks.flatMap((t) => t.items).find((i) => i.id === a.itemId) as EffectItem
    expect(keyframeAt(fx(), 1_000_000, 16_666)).toBe(true)
    expect(keyframeAt(fx(), 1_010_000, 16_666)).toBe(true)
    expect(keyframeAt(fx(), 1_050_000, 16_666)).toBe(false)
    p = toggleKeyframe(p, a.itemId, 'strength', 3_000_000)
    expect(keyframeAt(fx(), 2_000_000, 16_666)).toBe(false)
  })
})

describe('viewerGeometry — texto, forma e transição (F5)', () => {
  // medidor sem Canvas: caixa 400×100 px no centro do transform (a do compositor é testada em textRaster)
  const measure = (l: { rect: { cx: number; cy: number; scale: number; rotation: number } }, f: { W: number; H: number }) => ({ cx: l.rect.cx * f.W, cy: l.rect.cy * f.H, w: 400 * l.rect.scale, h: 100 * l.rect.scale, rotation: l.rect.rotation })

  it('texto e forma têm caixa (a forma = box × quadro × escala) e entram no hit-test', () => {
    let p = project()
    const t = addText(p, 'title', 0)
    p = addShape(t.project, 'rect', 0).project
    const shapeId = p.tracks.flatMap((x) => x.items).find((i) => i.type === 'shape')!.id
    p = updateItem(p, t.itemId, (d) => { if (d.type === 'text') d.visual.transform.scale = { value: 2 } })
    const boxes = itemBoxes(p, 1_000_000, measure)
    const tb = boxes.find((b) => b.itemId === t.itemId)!
    expect(tb).toMatchObject({ cx: 960, cy: 540, w: 800, h: 200, rotation: 0 })
    const sb = boxes.find((b) => b.itemId === shapeId)!
    expect(sb).toMatchObject({ cx: 960, cy: 540 })
    expect(sb.w).toBeCloseTo(0.3 * 1920)
    expect(sb.h).toBeCloseTo(0.2 * 1080)
    expect(hitTest(boxes, 960 + 390, 540)).toBe(t.itemId) // texto (maior) por cima? a forma entra depois (mais ao topo)
  })

  it('texto vazio não tem caixa; fora do intervalo do item também não', () => {
    const t = addText(project(), 'title', 0, { text: '' })
    expect(itemBoxes(t.project, 1_000_000, measure).some((b) => b.itemId === t.itemId)).toBe(false)
    const u = addText(project(), 'title', 0)
    expect(itemBoxes(u.project, 4_000_000, measure).some((b) => b.itemId === u.itemId)).toBe(false) // título dura 3 s
  })

  it('durante a transição, A e B são selecionáveis; a caixa à frente é A na 1ª metade e B na 2ª', () => {
    let p = addAsset(createEmptyProject('t'), asset('v', 1920, 1080))
    const a = addMediaFromAsset(p, 'v', 0)
    const b = addMediaFromAsset(a.project, 'v', 5_000_000)
    const idA = a.itemIds[0], idB = b.itemIds[0]
    p = addTransition(b.project, idB, 'crossfade', 1_000_000) // janela 4,5 s – 5,5 s
    const early = itemBoxes(p, 4_800_000, measure).map((x) => x.itemId)
    expect(early).toEqual(expect.arrayContaining([idA, idB]))
    expect(early.lastIndexOf(idA)).toBeGreaterThan(early.lastIndexOf(idB)) // A na frente
    const late = itemBoxes(p, 5_200_000, measure).map((x) => x.itemId)
    expect(late).toEqual(expect.arrayContaining([idA, idB]))
    expect(late.lastIndexOf(idB)).toBeGreaterThan(late.lastIndexOf(idA)) // B na frente
    const outside = itemBoxes(p, 3_000_000, measure).map((x) => x.itemId)
    expect(outside).toEqual([idA])
    const boxes = itemBoxes(p, 4_800_000, measure)
    expect(hitTest(boxes, 960, 540)).toBe(idA)
  })

  it('texto dentro da transição (texto → mídia) também tem caixa', () => {
    let p = addAsset(createEmptyProject('t'), asset('v', 1920, 1080))
    const m = addMediaFromAsset(p, 'v', 3_000_000)
    p = m.project
    const t = addText(p, 'title', 0, { trackId: p.tracks[0].id })
    const q = addTransition(t.project, m.itemIds[0], 'crossfade', 1_000_000)
    const ids = itemBoxes(q, 3_100_000, measure).map((x) => x.itemId)
    expect(ids).toEqual(expect.arrayContaining([t.itemId, m.itemIds[0]]))
  })
})
