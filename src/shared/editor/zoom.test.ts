import { describe, expect, it } from 'vitest'
import { evalAnim } from './anim'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { layerBase } from './layerGeometry'
import { itemAnimEntries } from './animPaths'
import { findItem } from './ops'
import type { Asset, MediaItem, Project } from './project'
import { privacyWarnings } from './privacy'
import { validateProject } from './schema'
import { applyKenBurns, applyZoom, aspectRect, KEN_BURNS_SCALE, kenBurnsRect, linkedEffectIds, zoomKeys, zoomPose, type ZoomRect } from './zoom'

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
    const q = applyZoom(p, 'm', { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 3 * S, S, null, 'linear', { clamp: true }).project
    const m = findItem(q, 'm')!.item as MediaItem
    expect(m.visual!.transform.scale.keys!.map((k) => k.tUs)).toEqual([2 * S, 3 * S])
    expect((findItem(p, 'm')!.item as MediaItem).visual!.transform.scale.keys).toBeUndefined()
  })
  it('Ken Burns: 1 → 1,15 ao longo do item, canto escolhido fixo (pan diagonal), sem bordas', () => {
    const q = applyKenBurns(proj(false), 'm', 'br').project
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
    expect(linkedEffectIds(p, 'm')).toEqual(['fx'])
    expect(linkedEffectIds(proj(false), 'm')).toEqual([])
    const q = applyZoom(p, 'm', { x: 0.3, y: 0.3, w: 0.5, h: 0.5 }, 2 * S, S, null, 'linear', { clamp: false }).project
    expect(privacyWarnings(q, 0, 11 * S).some((w) => w.kind === 'transformedUnderEffect' && w.itemId === 'fx')).toBe(true)
  })
})

describe('revisão: espera zero, volta à curva original, rotação, keys substituídos, Ken Burns em PiP', () => {
  const r: ZoomRect = { x: 0.7, y: 0.35, w: 0.5, h: 0.5 }
  /** Nenhuma animação do item com dois keys no mesmo instante (ou fora de ordem). */
  const strictlyIncreasing = (m: MediaItem): boolean => itemAnimEntries(m).every(([, a]) => (a.keys ?? []).every((k, i, ks) => i === 0 || k.tUs > ks[i - 1].tUs))
  function proj(edit?: (m: MediaItem) => void): Project {
    const p = createEmptyProject('z')
    p.assets = [vid]
    p.tracks[0].items = [media(edit)]
    return p
  }
  const itemOf = (p: Project): MediaItem => findItem(p, 'm')!.item as MediaItem

  it('voltar ao normal com espera 0: a volta começa no key do enquadramento, sem key repetido', () => {
    const k = zoomKeys(media(), r, S, 500_000, 0, 'inOut', HD)
    for (const a of [k.x, k.y, k.scale]) {
      expect(a.keys!.map((x) => x.tUs)).toEqual([S, 1_500_000, 2 * S])
      expect(a.keys!.map((x) => x.ease)).toEqual(['inOut', 'inOut', 'linear'])
    }
    expect(evalAnim(k.scale, 1_500_000)).toBeCloseTo(2, 9)
    expect(evalAnim(k.scale, 2 * S)).toBe(1)
    // espera negativa = 0
    expect(zoomKeys(media(), r, S, 500_000, -5, 'inOut', HD).scale.keys!.map((x) => x.tUs)).toEqual([S, 1_500_000, 2 * S])
    const q = applyZoom(proj(), 'm', r, S, 500_000, 0, 'inOut', { clamp: true }).project
    expect(strictlyIncreasing(itemOf(q))).toBe(true)
    expect(validateProject(q)).toEqual([])
  })
  it('nenhum caso gera keys com o mesmo instante (espera, volta comprimida, sem volta, animação existente)', () => {
    const lin = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'linear' as const }, { tUs: 1_500_000, value: 1.2, ease: 'linear' as const }, { tUs: 9 * S, value: 1.4, ease: 'linear' as const }] }
    for (const [at, dur, hold] of [[S, 500_000, 0], [S, 500_000, S], [8 * S, S, 0], [9 * S, S, 0], [9_500_000, S, 2 * S], [0, 3 * S, null]] as const) {
      for (const m of [media(), media((x) => { x.visual!.transform.scale = lin })]) {
        const q = applyZoom(proj((x) => Object.assign(x, m)), 'm', r, at, dur, hold, 'out', { clamp: true }).project
        expect(strictlyIncreasing(itemOf(q))).toBe(true)
        expect(validateProject(q)).toEqual([])
      }
    }
  })
  it('a volta termina no valor da curva original naquele instante e ela continua como antes', () => {
    const lin = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'linear' as const }, { tUs: 6 * S, value: 1.4, ease: 'linear' as const }] }
    const m = media((x) => { x.visual!.transform.scale = lin })
    const k = zoomKeys(m, r, S, 500_000, S, 'linear', HD)
    expect(k.scale.keys!.map((x) => x.tUs)).toEqual([0, S, 1_500_000, 2_500_000, 3 * S, 6 * S])
    for (const t of [3 * S, 4 * S, 5 * S, 6 * S, 8 * S]) expect(evalAnim(k.scale, t)).toBeCloseTo(evalAnim(lin, t), 12)
    expect(evalAnim(k.scale, 500_000)).toBeCloseTo(evalAnim(lin, 500_000), 12)
  })
  it('rotação fora de 90°: clamp conservador — os cantos do quadro ficam dentro da camada girada', () => {
    const base = { bw: 1920, bh: 1080, rotation: 30 }
    const cur = { x: 0.5, y: 0.5, scale: 1 }
    const corner: ZoomRect = { x: 0.1, y: 0.9, w: 0.5, h: 0.5 }
    const inside = (p: { x: number; y: number; scale: number }): boolean => {
      const th = (30 * Math.PI) / 180
      return [[0, 0], [1920, 0], [0, 1080], [1920, 1080]].every(([fx, fy]) => {
        const dx = fx - p.x * 1920, dy = fy - p.y * 1080
        const lx = Math.cos(th) * dx + Math.sin(th) * dy, ly = -Math.sin(th) * dx + Math.cos(th) * dy
        return Math.abs(lx) <= (1920 * p.scale) / 2 + 1e-6 && Math.abs(ly) <= (1080 * p.scale) / 2 + 1e-6
      })
    }
    expect(inside(zoomPose(cur, corner, HD))).toBe(false) // sem clamp descobre o fundo
    const c = zoomPose(cur, corner, HD, base)
    expect(c.scale).toBeCloseTo(2, 9)
    expect(inside(c)).toBe(true)
    // no centro, o clamp não mexe
    expect(zoomPose(cur, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, HD, base)).toEqual(zoomPose(cur, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, HD))
  })
  it('conta os keys existentes substituídos no trecho', () => {
    const lin = { value: 1, keys: [{ tUs: 0, value: 1, ease: 'linear' as const }, { tUs: 2 * S, value: 1.2, ease: 'linear' as const }, { tUs: 6 * S, value: 1.4, ease: 'linear' as const }] }
    const m = media((x) => { x.visual!.transform.scale = lin; x.visual!.transform.x = { value: 0.5, keys: [{ tUs: S, value: 0.5, ease: 'linear' }, { tUs: 7 * S, value: 0.6, ease: 'linear' }] } })
    expect(zoomKeys(m, r, S, 2 * S, null, 'linear', HD).replaced).toBe(2) // escala@2 s e x@1 s
    expect(zoomKeys(media(), r, S, 2 * S, null, 'linear', HD).replaced).toBe(0)
    expect(applyZoom(proj((x) => { x.visual!.transform.scale = lin }), 'm', r, S, 2 * S, null, 'linear', { clamp: false }).replaced).toBe(1)
  })
  it('Ken Burns num clipe que não cobre o quadro (PiP): a caixa fica parada e o conteúdo se aproxima dentro dela (corte)', () => {
    const pip = (mirror: boolean): Project => proj((x) => { x.visual!.transform.scale = { value: 0.3 }; x.visual!.transform.x = { value: 0.8 }; x.visual!.transform.y = { value: 0.2 }; x.visual!.mirror = mirror })
    const { project, replaced } = applyKenBurns(pip(false), 'm', 'br')
    expect(replaced).toBe(0)
    const v = itemOf(project).visual!
    for (const k of ['x', 'y', 'scale'] as const) expect(v.transform[k].keys).toBeUndefined()
    const D = 10 * S
    const s = 1 / KEN_BURNS_SCALE
    expect(v.crop.l.keys!.map((k) => k.tUs)).toEqual([0, D])
    expect(evalAnim(v.crop.l, D)).toBeCloseTo(1 - s, 9)
    expect(evalAnim(v.crop.t, D)).toBeCloseTo(1 - s, 9)
    expect(evalAnim(v.crop.r, D)).toBe(0)
    expect(evalAnim(v.crop.b, D)).toBe(0)
    // tamanho da caixa no quadro igual em todo instante (o trecho visível encolhe na proporção)
    const box = (t: number): [number, number] => {
      const g = layerBase({ l: evalAnim(v.crop.l, t), t: evalAnim(v.crop.t, t), r: evalAnim(v.crop.r, t), b: evalAnim(v.crop.b, t) }, v.fit, SRC, HD)
      return [g.bw, g.bh]
    }
    for (const t of [D / 3, D]) {
      expect(box(t)[0]).toBeCloseTo(box(0)[0], 6)
      expect(box(t)[1]).toBeCloseTo(box(0)[1], 6)
    }
    // espelhado: o canto direito da tela é o esquerdo da fonte
    const mv = itemOf(applyKenBurns(pip(true), 'm', 'br').project).visual!
    expect(evalAnim(mv.crop.l, D)).toBe(0)
    expect(evalAnim(mv.crop.r, D)).toBeCloseTo(1 - s, 9)
    expect(strictlyIncreasing(itemOf(project))).toBe(true)
  })
})
