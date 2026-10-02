import { describe, expect, it } from 'vitest'
import { evalAnim } from './anim'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { layerBase } from './layerGeometry'
import { findItem } from './ops'
import type { Asset, MediaItem, Project } from './project'
import { privacyWarnings } from './privacy'
import { applyKenBurns, applyZoom, aspectRect, KEN_BURNS_SCALE, kenBurnsRect, linkedRegionEffects, zoomKeys, zoomPose, type ZoomRect } from './zoom'

const S = 1_000_000
const HD = { w: 1920, h: 1080 }
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const SRC = { w: 1920, h: 1080, rotation: 0 as const }

function media(edit?: (m: MediaItem) => void): MediaItem {
  const m = { ...createMediaItem(vid, 0, 'video'), id: 'm' }
  edit?.(m)
  return m
}

/** Ponto do conteúdo (quad local a ∈ [0,1]²) → px do quadro, a mesma conta do compositor (matrix.layerMatrix). */
function contentToFrame(m: MediaItem, local: number, a: [number, number], canvas = HD, src: { w: number; h: number; rotation: 0 | 90 | 180 | 270 } = SRC): [number, number] {
  const v = m.visual!
  const g = layerBase({ l: evalAnim(v.crop.l, local), t: evalAnim(v.crop.t, local), r: evalAnim(v.crop.r, local), b: evalAnim(v.crop.b, local) }, v.fit, src, canvas)
  const s = evalAnim(v.transform.scale, local)
  const th = (evalAnim(v.transform.rotation, local) * Math.PI) / 180
  const lx = (a[0] - 0.5) * g.bw * s, ly = (a[1] - 0.5) * g.bh * s
  return [evalAnim(v.transform.x, local) * canvas.w + lx * Math.cos(th) - ly * Math.sin(th), evalAnim(v.transform.y, local) * canvas.h + lx * Math.sin(th) + ly * Math.cos(th)]
}

/** Ponto do quadro (px) → quad local do conteúdo (inverso de contentToFrame). */
function frameToContent(m: MediaItem, local: number, px: [number, number], canvas = HD, src: { w: number; h: number; rotation: 0 | 90 | 180 | 270 } = SRC): [number, number] {
  const v = m.visual!
  const g = layerBase({ l: evalAnim(v.crop.l, local), t: evalAnim(v.crop.t, local), r: evalAnim(v.crop.r, local), b: evalAnim(v.crop.b, local) }, v.fit, src, canvas)
  const s = evalAnim(v.transform.scale, local)
  const th = (evalAnim(v.transform.rotation, local) * Math.PI) / 180
  const dx = px[0] - evalAnim(v.transform.x, local) * canvas.w, dy = px[1] - evalAnim(v.transform.y, local) * canvas.h
  return [(Math.cos(th) * dx + Math.sin(th) * dy) / (g.bw * s) + 0.5, (-Math.sin(th) * dx + Math.cos(th) * dy) / (g.bh * s) + 0.5]
}

const withKeys = (m: MediaItem, k: ReturnType<typeof zoomKeys>): MediaItem => ({ ...m, visual: { ...m.visual!, transform: { ...m.visual!.transform, x: k.x, y: k.y, scale: k.scale } } })

describe('zoomPose: retângulo-alvo → transformação', () => {
  it('2× num retângulo da proporção do quadro: o centro do retângulo vai para o centro do quadro', () => {
    const r: ZoomRect = { x: 0.7, y: 0.3, w: 0.5, h: 0.5 }
    const p = zoomPose({ x: 0.5, y: 0.5, scale: 1 }, r, HD)
    expect(p.scale).toBeCloseTo(2, 9)
    expect(p.x).toBeCloseTo(0.5 + 2 * (0.5 - 0.7), 9)
    expect(p.y).toBeCloseTo(0.5 + 2 * (0.5 - 0.3), 9)
  })
  it('retângulo fora da proporção: cabe inteiro (o lado que manda é o maior em relação ao quadro)', () => {
    const p = zoomPose({ x: 0.5, y: 0.5, scale: 1 }, { x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, HD)
    expect(p.scale).toBeCloseTo(2, 9)
  })
  it('parte de qualquer pose: escala relativa e centro levado pela mesma semelhança', () => {
    const p = zoomPose({ x: 0.3, y: 0.6, scale: 0.5 }, { x: 0.4, y: 0.5, w: 0.25, h: 0.25 }, HD)
    expect(p.scale).toBeCloseTo(2, 9)
    expect(p.x).toBeCloseTo(0.5 + 4 * (0.3 - 0.4), 9)
    expect(p.y).toBeCloseTo(0.5 + 4 * (0.6 - 0.5), 9)
  })
  it('ida e volta: o retângulo inverso (o quadro antigo visto no novo) devolve a pose original', () => {
    const cur = { x: 0.45, y: 0.55, scale: 1.2 }
    const r: ZoomRect = { x: 0.62, y: 0.38, w: 0.4, h: 0.4 }
    const z = zoomPose(cur, r, HD)
    const k = 1 / 0.4
    const back = zoomPose(z, { x: 0.5 + k * (0.5 - r.x), y: 0.5 + k * (0.5 - r.y), w: k, h: k }, HD)
    expect(back.x).toBeCloseTo(cur.x, 9)
    expect(back.y).toBeCloseTo(cur.y, 9)
    expect(back.scale).toBeCloseTo(cur.scale, 9)
  })
  it('clamp de bordas: retângulo no canto não deixa o conteúdo descobrir o fundo', () => {
    const r: ZoomRect = { x: 0.1, y: 0.9, w: 0.5, h: 0.5 } // metade fora do quadro
    const free = zoomPose({ x: 0.5, y: 0.5, scale: 1 }, r, HD)
    expect(free.x - free.scale / 2).toBeGreaterThan(0) // sem clamp: a borda esquerda da camada entra no quadro
    const c = zoomPose({ x: 0.5, y: 0.5, scale: 1 }, r, HD, { bw: 1920, bh: 1080, rotation: 0 })
    expect(c.scale).toBeCloseTo(2, 9)
    expect(c.x).toBeCloseTo(1, 9) // camada de 2 quadros de largura encostada na esquerda: centro em 1
    expect(c.y).toBeCloseTo(0, 9) // e na base
    // retângulo no meio: o clamp não mexe
    const mid = { x: 0.6, y: 0.45, w: 0.5, h: 0.5 }
    expect(zoomPose({ x: 0.5, y: 0.5, scale: 1 }, mid, HD, { bw: 1920, bh: 1080, rotation: 0 })).toEqual(zoomPose({ x: 0.5, y: 0.5, scale: 1 }, mid, HD))
  })
  it('clamp com camada menor que o quadro num eixo (contain 4:3 em 16:9): fica inteira dentro do quadro', () => {
    // 1440×1080 a escala 1 → 1,2× = 1728 px < 1920: centro x preso a [864, 1056] px (o zoom à esquerda empurra para a direita)
    const c = zoomPose({ x: 0.5, y: 0.5, scale: 1 }, { x: 0.1, y: 0.5, w: 1 / 1.2, h: 1 / 1.2 }, HD, { bw: 1440, bh: 1080, rotation: 0 })
    expect(c.x * 1920).toBeCloseTo(1056, 6)
    expect(c.y).toBeCloseTo(0.5, 9)
  })
  it('clamp com rotação de 90°: largura e altura da camada trocam', () => {
    const c = zoomPose({ x: 0.5, y: 0.5, scale: 1 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, HD, { bw: 1080, bh: 1920, rotation: 90 })
    // girada: ocupa 1920 (bh) na horizontal × 2 = 3840 → centro x ≤ 1920 px
    expect(c.x).toBeCloseTo(1, 9)
  })
  it('projeto 9:16 (1080×1920): retângulo da proporção do quadro, 2×, centro no centro', () => {
    const V = { w: 1080, h: 1920 }
    const r = aspectRect({ x: 200, y: 400 }, { x: 740, y: 1000 }, V)
    expect(r.w).toBeCloseTo(r.h, 9) // normalizado igual = mesma proporção do quadro
    const m = media((x) => { x.visual!.fit = 'cover' })
    const k = zoomKeys(m, { x: 0.4, y: 0.3, w: 0.5, h: 0.5 }, 0, S, null, 'linear', V)
    const z = withKeys(m, k)
    const src = { w: 1920, h: 1080, rotation: 0 as const }
    const before = frameToContent(m, 0, [0.4 * 1080, 0.3 * 1920], V, src)
    const after = contentToFrame(z, S, before, V, src)
    expect(after[0]).toBeCloseTo(540, 6)
    expect(after[1]).toBeCloseTo(960, 6)
    expect(evalAnim(z.visual!.transform.scale, S)).toBeCloseTo(2, 9)
  })
})

describe('aspectRect: arraste → retângulo na proporção do quadro', () => {
  it('lado maior manda; o canto inicial fica parado', () => {
    const r = aspectRect({ x: 100, y: 100 }, { x: 580, y: 200 }, HD) // 480 px = 0,25 do quadro
    expect(r.w).toBeCloseTo(0.25, 9)
    expect(r.h).toBeCloseTo(0.25, 9)
    expect((r.x - r.w / 2) * 1920).toBeCloseTo(100, 6)
    expect((r.y - r.h / 2) * 1080).toBeCloseTo(100, 6)
  })
  it('arraste para cima/esquerda e tamanho mínimo (5 % = 20×)', () => {
    const r = aspectRect({ x: 1000, y: 500 }, { x: 990, y: 495 }, HD)
    expect(r.w).toBeCloseTo(0.05, 9)
    expect((r.x + r.w / 2) * 1920).toBeCloseTo(1000, 6)
    expect((r.y + r.h / 2) * 1080).toBeCloseTo(500, 6)
  })
})

describe('zoomKeys', () => {
  const r: ZoomRect = { x: 0.7, y: 0.35, w: 0.5, h: 0.5 }
  it('keys de x/y/escala: início no valor atual com o ease; fim no enquadramento', () => {
    const k = zoomKeys(media(), r, 2 * S, S, null, 'inOut', HD)
    for (const a of [k.x, k.y, k.scale]) {
      expect(a.keys!.map((x) => x.tUs)).toEqual([2 * S, 3 * S])
      expect(a.keys![0].ease).toBe('inOut')
    }
    expect(evalAnim(k.scale, 0)).toBe(1)
    expect(evalAnim(k.scale, 2 * S)).toBe(1)
    expect(evalAnim(k.scale, 3 * S)).toBeCloseTo(2, 9)
    expect(evalAnim(k.x, 10 * S)).toBeCloseTo(0.1, 9)
  })
  it('o ponto do conteúdo no centro do retângulo-alvo fica no centro do quadro no instante final', () => {
    // clipe com corte, escala e deslocamento: a conta passa pela geometria base (layerBase)
    const m = media((x) => {
      x.visual!.crop.l = { value: 0.1 }
      x.visual!.crop.t = { value: 0.05 }
      x.visual!.transform.scale = { value: 0.8 }
      x.visual!.transform.x = { value: 0.45 }
      x.visual!.transform.rotation = { value: 12 }
    })
    const z = withKeys(m, zoomKeys(m, r, S, S, null, 'out', HD))
    const target = frameToContent(m, S, [r.x * 1920, r.y * 1080])
    const at = contentToFrame(z, 2 * S, target)
    expect(at[0]).toBeCloseTo(960, 6)
    expect(at[1]).toBeCloseTo(540, 6)
  })
  it('voltar ao normal depois de N s: segura e volta à pose original com a mesma duração', () => {
    const m = media()
    const k = zoomKeys(m, r, S, 500_000, 2 * S, 'inOut', HD)
    expect(k.scale.keys!.map((x) => x.tUs)).toEqual([S, 1_500_000, 3_500_000, 4 * S])
    expect(evalAnim(k.scale, 2 * S)).toBeCloseTo(2, 9)
    expect(evalAnim(k.scale, 3_500_000)).toBeCloseTo(2, 9)
    expect(k.scale.keys![2].ease).toBe('inOut')
    for (const a of [k.x, k.y, k.scale]) expect(evalAnim(a, 4 * S)).toBeCloseTo(evalAnim(a, 0), 12)
  })
  it('preso à duração do item: a volta que não cabe é comprimida; a ida que não cabe termina no fim', () => {
    const m = media((x) => { x.durationUs = 3 * S })
    expect(zoomKeys(m, r, 2_500_000, S, null, 'linear', HD).scale.keys!.map((x) => x.tUs)).toEqual([2_500_000, 3 * S])
    expect(zoomKeys(m, r, S, 500_000, S, 'linear', HD).scale.keys!.map((x) => x.tUs)).toEqual([S, 1_500_000, 2_500_000, 3 * S])
    expect(zoomKeys(m, r, S, 500_000, 2 * S, 'linear', HD).scale.keys!.map((x) => x.tUs)).toEqual([S, 1_500_000]) // volta depois do fim: sem volta
    expect(() => zoomKeys(m, r, 3 * S, S, null, 'linear', HD)).toThrow()
  })
  it('animação existente: antes do zoom fica igual; keys dentro do trecho saem; depois continua', () => {
    const lin = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'linear' as const }, { tUs: 2 * S, value: 1.2, ease: 'linear' as const }, { tUs: 6 * S, value: 1.4, ease: 'linear' as const }] }
    const m = media((x) => { x.visual!.transform.scale = lin })
    const k = zoomKeys(m, r, S, 2 * S, null, 'linear', HD)
    expect(k.scale.keys!.map((x) => x.tUs)).toEqual([0, S, 3 * S, 6 * S])
    expect(evalAnim(k.scale, 500_000)).toBeCloseTo(evalAnim(lin, 500_000), 12)
    expect(evalAnim(k.scale, S)).toBeCloseTo(1.1, 12)
    expect(evalAnim(k.scale, 3 * S)).toBeCloseTo(2.2, 9)
  })
  it('clamp opcional (src): sem bordas no instante final', () => {
    const m = media()
    const k = zoomKeys(m, { x: 0.05, y: 0.5, w: 0.5, h: 0.5 }, 0, S, null, 'linear', HD, { clampSrc: SRC })
    expect(evalAnim(k.x, S)).toBeCloseTo(1, 9)
  })
})

describe('applyZoom / Ken Burns / privacidade', () => {
  function proj(link: boolean): Project {
    const p = createEmptyProject('z')
    p.assets = [vid]
    const m = { ...media(), startUs: S, ...(link ? { linkId: 'l1' } : {}) }
    const fx = { ...createEffectItem('blur', S, 10 * S), id: 'fx', ...(link ? { linkId: 'l1' } : {}) }
    p.tracks = [
      { id: 'tv', kind: 'video', name: 'Vídeo 1', muted: false, hidden: false, locked: false, volume: 1, items: [m] },
      { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
    ]
    return p
  }
  it('applyZoom grava os keys no tempo local (playhead absoluto) e é imutável', () => {
    const p = proj(false)
    const q = applyZoom(p, 'm', { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 3 * S, S, null, 'linear', { clamp: true })
    const m = findItem(q, 'm')!.item as MediaItem
    expect(m.visual!.transform.scale.keys!.map((k) => k.tUs)).toEqual([2 * S, 3 * S])
    expect((findItem(p, 'm')!.item as MediaItem).visual!.transform.scale.keys).toBeUndefined()
  })
  it('Ken Burns: 1 → 1,15 ao longo do item, canto escolhido fixo (pan diagonal), sem bordas', () => {
    const q = applyKenBurns(proj(false), 'm', 'br')
    const m = findItem(q, 'm')!.item as MediaItem
    const t = m.visual!.transform
    expect(t.scale.keys!.map((k) => k.tUs)).toEqual([0, 10 * S])
    expect(evalAnim(t.scale, 10 * S)).toBeCloseTo(KEN_BURNS_SCALE, 9)
    // canto inferior direito da camada encostado no do quadro em todo instante (o conteúdo desliza na diagonal)
    for (const at of [0, 2.5 * S, 5 * S, 10 * S]) {
      const s = evalAnim(t.scale, at)
      expect(evalAnim(t.x, at) + s / 2).toBeCloseTo(1, 9)
      expect(evalAnim(t.y, at) + s / 2).toBeCloseTo(1, 9)
    }
    expect(kenBurnsRect('tl')).toEqual({ x: 0.5 / KEN_BURNS_SCALE, y: 0.5 / KEN_BURNS_SCALE, w: 1 / KEN_BURNS_SCALE, h: 1 / KEN_BURNS_SCALE })
  })
  it('efeitos de região vinculados ao clipe: listados; o zoom gera o aviso transformedUnderEffect', () => {
    const p = proj(true)
    expect(linkedRegionEffects(p, 'm')).toEqual(['fx'])
    expect(linkedRegionEffects(proj(false), 'm')).toEqual([])
    const q = applyZoom(p, 'm', { x: 0.3, y: 0.3, w: 0.5, h: 0.5 }, 2 * S, S, null, 'linear', { clamp: false })
    expect(privacyWarnings(q, 0, 11 * S).some((w) => w.kind === 'transformedUnderEffect' && w.itemId === 'fx')).toBe(true)
  })
})
