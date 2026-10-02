import { describe, expect, it } from 'vitest'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import { evalAnim } from './anim'
import { screenToContent, toScreen, type ClipFrame, type RegionValues } from './contentPose'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachEffects } from './followTransform'
import { findItem } from './ops'
import { privacyWarnings } from './privacy'
import type { Asset, EffectItem, Item, MediaItem, Project, TextItem, Track, Us } from './project'
import { clipFrameAt, effectRegionAt } from './resolve'
import { parseProject, toDiskProject } from './schema'
import { frameToUs, itemEndUs } from './time'
import { applyKenBurns, coversFrame, sourceOf } from './zoom'
import { mainClipAt, reframeCanvas, reframeName, reframeProject, reframeWindow, type FocusPoint } from './reframe'

const S = 1_000_000
const vid: Asset = { id: 'v', name: 'tela', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const cam: Asset = { ...vid, id: 'c', name: 'webcam', video: { ...vid.video!, width: 1280, height: 720 } }
const track = (id: string, items: Item[], extra: Partial<Track> = {}): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items, ...extra })
const clip = (id: string, asset: Asset, startUs: Us, durationUs: Us, extra: Partial<MediaItem> = {}): MediaItem => ({ ...createMediaItem(asset, startUs, 'video'), id, durationUs, inUs: startUs, ...extra })
const fxOf = (p: Project, id: string): EffectItem => findItem(p, id)!.item as EffectItem
const mOf = (p: Project, id: string): MediaItem => findItem(p, id)!.item as MediaItem

/** Clipe 10 s da tela (1920×1080) em tela cheia. */
function single(edit?: (m: MediaItem) => void): Project {
  const p = createEmptyProject('Aula')
  p.assets = [vid]
  const m = clip('m', vid, 0, 10 * S)
  edit?.(m)
  p.tracks = [track('tv', [m])]
  return p
}

describe('reframeCanvas / reframeName', () => {
  it('mantém o lado menor e usa lados pares', () => {
    const c = { width: 1920, height: 1080 }
    expect(reframeCanvas(c, '9:16')).toEqual({ width: 1080, height: 1920 })
    expect(reframeCanvas(c, '1:1')).toEqual({ width: 1080, height: 1080 })
    expect(reframeCanvas(c, '4:5')).toEqual({ width: 1080, height: 1350 })
    expect(reframeCanvas({ width: 1280, height: 720 }, '9:16')).toEqual({ width: 720, height: 1280 })
  })
  it('nome da cópia pela proporção', () => {
    expect(reframeName('Aula 3', '9:16')).toBe('Aula 3 (Vertical)')
    expect(reframeName('Aula 3', '1:1')).toBe('Aula 3 (Quadrado)')
    expect(reframeName('Aula 3', '4:5')).toBe('Aula 3 (4:5)')
  })
})

describe('reframeProject: clipe principal com pontos de foco', () => {
  // camada 1920×1080 em 'cover' num quadro 1080×1920: 3413,3 × 1920 px; o ponto u da fonte fica em 540 + (u − ½)·3413,3
  const LW = (1920 * 1920) / 1080
  const xFor = (u: number): number => 0.5 - ((u - 0.5) * LW) / 1080
  const X_MIN = (1080 - LW / 2) / 1080

  it('16:9 → 9:16 com foco à direita: fit cover, x que centraliza o ponto, y no centro', () => {
    const p = single()
    const r = reframeProject(p, '9:16', { mode: 'cover', focus: { m: [{ tUs: 2 * S, x: 0.8, y: 0.5 }] } })
    expect(r.project.canvas).toMatchObject({ width: 1080, height: 1920 })
    const v = mOf(r.project, 'm').visual!
    expect(v.fit).toBe('cover')
    expect(v.transform.x.value).toBeCloseTo(xFor(0.8), 9)
    expect(v.transform.x.keys).toBeUndefined()
    expect(v.transform.y).toEqual({ value: 0.5 })
    // o conteúdo do ponto marcado cai no centro do quadro novo
    const cf = clipFrameAt(r.project, mOf(r.project, 'm'), 2 * S)!
    const s = toScreen(cf, 0.8 * 1920, 0.5 * 1080)
    expect(s.x).toBeCloseTo(540, 6)
    expect(s.y).toBeCloseTo(960, 6)
  })

  it('dois pontos: keys de x nos instantes marcados com Suavizar ambos', () => {
    const r = reframeProject(single(), '9:16', { mode: 'cover', focus: { m: [{ tUs: 6 * S, x: 0.3, y: 0.4 }, { tUs: 2 * S, x: 0.8, y: 0.5 }] } })
    const x = mOf(r.project, 'm').visual!.transform.x
    expect(x.keys?.map((k) => k.tUs)).toEqual([2 * S, 6 * S])
    expect(x.keys![0].value).toBeCloseTo(xFor(0.8), 9)
    expect(x.keys![1].value).toBeCloseTo(xFor(0.3), 9)
    expect(x.keys![0].ease).toBe('inOut')
    // antes do 1º ponto segura; no meio, a curva suave
    expect(evalAnim(x, 0)).toBeCloseTo(xFor(0.8), 9)
    expect(evalAnim(x, 4 * S)).toBeCloseTo((xFor(0.8) + xFor(0.3)) / 2, 9)
    expect(mOf(r.project, 'm').visual!.transform.y).toEqual({ value: 0.5 })
  })

  it('foco perto da borda: x preso para não aparecer borda preta', () => {
    const r = reframeProject(single(), '9:16', { mode: 'cover', focus: { m: [{ tUs: 0, x: 0.98, y: 0.5 }] } })
    expect(mOf(r.project, 'm').visual!.transform.x.value).toBeCloseTo(X_MIN, 9)
    const v = mOf(r.project, 'm').visual!
    expect(coversFrame(v, sourceOf(r.project, mOf(r.project, 'm')), { w: 1080, h: 1920 }, 0)).toBe(true)
  })

  it('1:1 e 4:5: a mesma conta no quadro novo', () => {
    const sq = reframeProject(single(), '1:1', { mode: 'cover', focus: { m: [{ tUs: 0, x: 0.6, y: 0.5 }] } })
    expect(mOf(sq.project, 'm').visual!.transform.x.value).toBeCloseTo(0.5 - (0.1 * 1920) / 1080, 9)
    const p45 = reframeProject(single(), '4:5', { mode: 'cover', focus: { m: [{ tUs: 0, x: 0.6, y: 0.5 }] } })
    // 4:5 (1080×1350): camada 2400×1350
    expect(mOf(p45.project, 'm').visual!.transform.x.value).toBeCloseTo(0.5 - (0.1 * 2400) / 1080, 9)
  })

  it('sem pontos: o centro do clipe (x = y = ½, sem keys)', () => {
    const r = reframeProject(single(), '9:16', { mode: 'cover' })
    const t = mOf(r.project, 'm').visual!.transform
    expect(t.x).toEqual({ value: 0.5 })
    expect(t.y).toEqual({ value: 0.5 })
  })

  it('pontos de outro clipe ou fora do clipe são ignorados', () => {
    const r = reframeProject(single(), '9:16', { mode: 'cover', focus: { m: [{ tUs: 12 * S, x: 0.9, y: 0.5 }], outro: [{ tUs: 0, x: 0.9, y: 0.5 }] } })
    expect(mOf(r.project, 'm').visual!.transform.x).toEqual({ value: 0.5 })
  })

  it('Ken Burns sem pontos: acompanha o centro antigo e nunca mostra borda (todo quadro)', () => {
    const p = applyKenBurns(single(), 'm', 'br').project
    const r = reframeProject(p, '9:16', { mode: 'cover' })
    const m1 = mOf(r.project, 'm'), m0 = mOf(p, 'm')
    const src = sourceOf(r.project, m1)
    let maxOff = 0
    for (let k = 0; k < 300; k++) {
      const t = frameToUs(k, 30)
      expect(coversFrame(m1.visual!, src, { w: 1080, h: 1920 }, t)).toBe(true)
      // o ponto da fonte que estava no centro antigo fica no centro novo (x livre: ±0,5 % do quadro)
      const q = screenToContent(clipFrameAt(p, m0, t)!, { x: 0.5, y: 0.5, w: 0, h: 0, rotation: 0 }, 'rect')
      const s = toScreen(clipFrameAt(r.project, m1, t)!, q.x * 1920, q.y * 1080)
      maxOff = Math.max(maxOff, Math.abs(s.x - 540))
    }
    expect(maxOff).toBeLessThanOrEqual(0.005 * 1920 + 1e-6)
    expect((m1.visual!.transform.x.keys?.length ?? 0)).toBeGreaterThan(1)
  })

  it("modo 'contain': fit contain, posição intacta, pontos ignorados", () => {
    const r = reframeProject(single(), '9:16', { mode: 'contain', focus: { m: [{ tUs: 0, x: 0.9, y: 0.5 }] } })
    const v = mOf(r.project, 'm').visual!
    expect(v.fit).toBe('contain')
    expect(v.transform.x).toEqual({ value: 0.5 })
  })

  it('não muda o projeto de entrada e reenquadra faixas bloqueadas', () => {
    const p = single()
    p.tracks[0].locked = true
    const before = JSON.stringify(p)
    const r = reframeProject(p, '9:16', { mode: 'cover', focus: { m: [{ tUs: 0, x: 0.8, y: 0.5 }] } })
    expect(JSON.stringify(p)).toBe(before)
    expect(mOf(r.project, 'm').visual!.transform.x.value).toBeCloseTo(xFor(0.8), 9)
  })

  it('reframeWindow: o quadro novo no quadro atual (prévia)', () => {
    const p = single()
    const r = reframeProject(p, '9:16', { mode: 'cover', focus: { m: [{ tUs: 0, x: 0.8, y: 0.5 }] } })
    const w = reframeWindow(p, r.project, 'm', S)!
    const xs = w.map((c) => c.x), ys = w.map((c) => c.y)
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0.8, 6)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1080 / LW, 6)
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
    expect(Math.max(...ys)).toBeCloseTo(1, 6)
  })
})

describe('mainClipAt', () => {
  it('o clipe principal de cima no instante (PiP não conta; desativado/fora do tempo também não)', () => {
    const p = privacyScene()
    expect(mainClipAt(p, S)?.id).toBe('a')
    expect(mainClipAt(p, 7 * S)?.id).toBe('b')
    expect(mainClipAt(p, 11 * S)).toBeNull()
    const off: Project = { ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === 'a' ? { ...i, enabled: false } : i)) })) }
    expect(mainClipAt(off, S)).toBeNull()
  })
})

describe('reframeProject: sobreposições e textos', () => {
  it('PiP mantém o tamanho em px pelo lado menor e fica dentro do quadro', () => {
    const p = single()
    p.assets.push(cam)
    const pip = clip('pip', cam, 0, 10 * S)
    pip.visual!.transform.scale = { value: 0.25 }
    pip.visual!.transform.x = { value: 0.85 }
    pip.visual!.transform.y = { value: 0.8 }
    p.tracks.push(track('tp', [pip]))
    const r = reframeProject(p, '9:16', { mode: 'cover' })
    const v = mOf(r.project, 'pip').visual!
    expect(v.fit).toBe('contain')
    const cf = clipFrameAt(r.project, mOf(r.project, 'pip'), 0)!
    expect(cf.sx).toBeCloseTo(480, 6)
    expect(cf.sy).toBeCloseTo(270, 6)
    expect(v.transform.x.value).toBeCloseTo(1 - 240 / 1080, 9)
    expect(v.transform.y.value).toBeCloseTo(0.8, 9)
  })

  it('texto: posição proporcional e tamanho pelo lado menor', () => {
    const p = single()
    const txt: TextItem = {
      id: 'txt', type: 'text', startUs: 0, durationUs: 5 * S, text: 'Olá',
      style: { font: 'Inter', size: { value: 48 }, weight: 600, color: '#fff', align: 'center', lineHeight: 1.2 },
      visual: { ...createMediaItem(vid, 0, 'video').visual!, transform: { ...createMediaItem(vid, 0, 'video').visual!.transform, x: { value: 0.3 }, y: { value: 0.9 } } }
    }
    p.tracks.push(track('tt', [txt]))
    const r = reframeProject(p, '9:16', { mode: 'cover' })
    const t = findItem(r.project, 'txt')!.item as TextItem
    expect(t.visual.transform.x).toEqual({ value: 0.3 })
    expect(t.visual.transform.y).toEqual({ value: 0.9 })
    expect(t.style.size).toEqual({ value: 48 })
  })
})

// ---------------------------------------------------------------- privacidade

/**
 * Projeto de privacidade: tela 0–6 s ('a') e 6–10 s ('b', mesmo arquivo) na faixa 0, webcam PiP ('pip') acima, e um
 * efeito por faixa (todas acima): A blur solto sobre a tela; B pixelizar elipse já ancorado; C invertido solto sobre a
 * tela; D tarja que atravessa o corte a|b; E blur perto da borda esquerda (sai do quadro vertical); F região com keys;
 * G rosto (elipse) sobre o PiP; H invertido na borda do PiP (metade sobre a tela); I blur girado 25°.
 */
function privacyScene(): Project {
  const p = createEmptyProject('Aula')
  p.assets = [vid, cam]
  const a = clip('a', vid, 0, 6 * S)
  const b = clip('b', vid, 6 * S, 4 * S)
  const pip = clip('pip', cam, 0, 10 * S)
  pip.visual!.transform.scale = { value: 0.25 }
  pip.visual!.transform.x = { value: 0.85 }
  pip.visual!.transform.y = { value: 0.8 }
  const fx = (id: string, preset: Parameters<typeof createEffectItem>[0], s: Us, d: Us, region: Parameters<typeof createEffectItem>[3]): EffectItem => ({ ...createEffectItem(preset, s, d, region), id })
  const F = fx('F', 'blur', 0, 4 * S, { x: 0.6, y: 0.2, w: 0.08, h: 0.06 })
  F.region.x = { value: 0.6, keys: [{ tUs: 0, value: 0.6, ease: 'linear' }, { tUs: 4 * S, value: 0.8, ease: 'linear' }] }
  const effects = [
    fx('A', 'blurText', 0, 5 * S, { x: 0.75, y: 0.3, w: 0.12, h: 0.06 }),
    fx('B', 'pixelate', 0, 6 * S, { x: 0.6, y: 0.55, w: 0.1, h: 0.12, shape: 'ellipse' }),
    fx('C', 'blurAllExcept', S, 4 * S, { x: 0.7, y: 0.35, w: 0.2, h: 0.2 }),
    fx('D', 'solid', 4 * S, 4 * S, { x: 0.65, y: 0.25, w: 0.1, h: 0.1 }),
    fx('E', 'blur', 0, 5 * S, { x: 0.1, y: 0.5, w: 0.08, h: 0.08 }),
    F,
    fx('G', 'blurFace', 0, 10 * S, { x: 0.85, y: 0.8, w: 0.08, h: 0.16 }),
    fx('H', 'blurAllExcept', 6 * S, 3 * S, { x: 0.72, y: 0.8, w: 0.1, h: 0.15, shape: 'ellipse' }),
    fx('I', 'blur', 2 * S, 3 * S, { x: 0.7, y: 0.5, w: 0.15, h: 0.05, rotation: 25 })
  ]
  p.tracks = [track('tv', [a, b]), track('tp', [pip]), ...effects.map((e) => track(`t${e.id}`, [e], { role: 'effects' }))]
  return attachEffects(p, 'a', ['B'])
}
const FOCUS: Record<string, FocusPoint[]> = { a: [{ tUs: 0, x: 0.8, y: 0.5 }, { tUs: 3 * S, x: 0.6, y: 0.4 }] }
const FX_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']

/** Ponto (px do quadro) dentro da região (normalizada ao quadro W×H)? `slack` px de folga. */
function inRegion(r: RegionValues, shape: 'rect' | 'ellipse', X: number, Y: number, W: number, H: number, slack = 1e-6): boolean {
  const hw = (Math.abs(r.w) * W) / 2, hh = (Math.abs(r.h) * H) / 2
  if (hw <= 0 || hh <= 0) return false
  const th = (-r.rotation * Math.PI) / 180, dx = X - r.x * W, dy = Y - r.y * H
  const u = dx * Math.cos(th) - dy * Math.sin(th), v = dx * Math.sin(th) + dy * Math.cos(th)
  return shape === 'rect' ? Math.abs(u) <= hw + slack && Math.abs(v) <= hh + slack : (u / (hw + slack)) ** 2 + (v / (hh + slack)) ** 2 <= 1
}

/** Grade de pontos (px) DENTRO da região (fração 0,98 da meia-extensão, n×n). */
function gridIn(r: RegionValues, shape: 'rect' | 'ellipse', W: number, H: number, n = 9): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const hw = (Math.abs(r.w) * W) / 2 * 0.98, hh = (Math.abs(r.h) * H) / 2 * 0.98
  if (!(hw > 0 && hh > 0)) return out
  const th = (r.rotation * Math.PI) / 180
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = -1 + (2 * i) / (n - 1), b = -1 + (2 * j) / (n - 1)
    if (shape === 'ellipse' && a * a + b * b > 1) continue
    const u = a * hw, v = b * hh
    out.push({ x: r.x * W + u * Math.cos(th) - v * Math.sin(th), y: r.y * H + u * Math.sin(th) + v * Math.cos(th) })
  }
  return out
}

/** Ponto do quadro → fração da fonte exibida no clipe; null se cai fora do trecho exibido (corte). */
function toContent(cf: ClipFrame, X: number, Y: number): { x: number; y: number } | null {
  const q = screenToContent(cf, { x: X / cf.W, y: Y / cf.H, w: 0, h: 0, rotation: 0 }, 'rect')
  const [u0, v0, u1, v1] = cf.g.uv
  return q.x >= u0 && q.x <= u1 && q.y >= v0 && q.y <= v1 ? q : null
}

/** Clipes de vídeo ativos em t abaixo da faixa do efeito (os que ele esconde), do topo para o fundo. */
function clipsUnder(p: Project, fxId: string, t: Us): MediaItem[] {
  const ti = p.tracks.findIndex((tr) => tr.items.some((i) => i.id === fxId))
  const out: MediaItem[] = []
  for (let k = ti - 1; k >= 0; k--) {
    const m = p.tracks[k].items.find((i) => i.type === 'media' && t >= i.startUs && t < itemEndUs(i))
    if (m?.type === 'media' && m.visual) out.push(m)
  }
  return out
}

/**
 * Verificação densa (cada quadro a 30 fps do efeito): normal — todo ponto do conteúdo de cada clipe sob a região antiga
 * que continua no quadro novo cai dentro da região nova; invertido — todo ponto do quadro novo dentro do buraco novo
 * mostra (pelo clipe visível de cima) conteúdo que estava dentro do buraco antigo. Devolve as falhas e quantos pontos
 * foram conferidos.
 */
function coverage(before: Project, after: Project, id: string): { fails: string[]; checked: number } {
  const fx0 = fxOf(before, id), fx1 = fxOf(after, id)
  const W0p = before.canvas.width, H0p = before.canvas.height, W1 = after.canvas.width, H1 = after.canvas.height
  const fails: string[] = []
  let checked = 0
  for (let k = Math.ceil((fx0.startUs * 30) / S); ; k++) {
    const t = frameToUs(k, 30)
    if (t >= itemEndUs(fx0)) break
    const r0 = effectRegionAt(before, fx0, t), r1 = effectRegionAt(after, fx1, t)
    if (!fx0.invert) {
      for (const m0 of clipsUnder(before, id, t)) {
        const cf0 = clipFrameAt(before, m0, t), cf1 = clipFrameAt(after, mOf(after, m0.id), t)
        if (!cf0 || !cf1) continue
        for (const P of gridIn(r0, fx0.region.shape, W0p, H0p)) {
          const q = toContent(cf0, P.x, P.y)
          if (!q) continue
          const s = toScreen(cf1, q.x * cf1.g.dw, q.y * cf1.g.dh)
          if (s.x < 0 || s.y < 0 || s.x > W1 || s.y > H1) continue
          checked++
          if (!inRegion(r1, fx1.region.shape, s.x, s.y, W1, H1)) fails.push(`${id} t=${t} ${m0.id} (${s.x.toFixed(1)}, ${s.y.toFixed(1)}) fora de ${JSON.stringify(r1)}`)
        }
      }
    } else {
      const under1 = clipsUnder(after, id, t)
      for (const P of gridIn(r1, fx1.region.shape, W1, H1)) {
        if (P.x < 0 || P.y < 0 || P.x > W1 || P.y > H1) continue
        // o clipe de cima que aparece neste ponto no quadro novo
        let shown: { m: MediaItem; q: { x: number; y: number } } | null = null
        for (const m1 of under1) {
          const cf1 = clipFrameAt(after, m1, t)
          const q = cf1 && toContent(cf1, P.x, P.y)
          if (q) { shown = { m: m1, q }; break }
        }
        if (!shown) continue
        const cf0 = clipFrameAt(before, mOf(before, shown.m.id), t)
        checked++
        if (!cf0) { fails.push(`${id} t=${t}: ${shown.m.id} invisível antes e nítido agora`); continue }
        const s = toScreen(cf0, shown.q.x * cf0.g.dw, shown.q.y * cf0.g.dh)
        if (!inRegion(r0, fx0.region.shape, s.x, s.y, W0p, H0p)) fails.push(`${id} t=${t} ${shown.m.id}: conteúdo de (${s.x.toFixed(1)}, ${s.y.toFixed(1)}) nítido agora, escondido antes`)
        // e não estava coberto por outro clipe por cima no quadro antigo
        else {
          const top = clipsUnder(before, id, t).find((m) => { const c = clipFrameAt(before, m, t); return !!c && !!toContent(c, s.x, s.y) })
          if (top && top.id !== shown.m.id) fails.push(`${id} t=${t}: ${shown.m.id} aparece onde antes ${top.id} o cobria`)
        }
      }
    }
  }
  return { fails, checked }
}

describe('reframeProject: privacidade (cada quadro, cada efeito)', () => {
  const before = privacyScene()
  const res = reframeProject(before, '9:16', { mode: 'cover', focus: FOCUS })
  const after = res.project

  it.each(FX_IDS)('efeito %s cobre o mesmo conteúdo antes e depois em todos os quadros', (id) => {
    const { fails, checked } = coverage(before, after, id)
    expect(fails.slice(0, 5)).toEqual([])
    // E sai do quadro novo e H vira buraco nulo: sem pontos a conferir; os outros têm
    if (id !== 'E' && id !== 'H') expect(checked).toBeGreaterThan(50)
  })

  it('soltos sobre um único clipe são ancorados a ele; os que atravessam clipes são assados no quadro novo', () => {
    expect(res.anchored.sort()).toEqual(['A', 'C', 'E', 'F', 'I'])
    for (const id of ['A', 'C', 'E', 'F', 'I']) expect(fxOf(after, id).attach?.mediaItemId).toBe('a')
    expect(fxOf(after, 'B').attach?.mediaItemId).toBe('a')
    expect(res.baked.sort()).toEqual(['D', 'G', 'H'])
    for (const id of ['D', 'G', 'H']) expect(fxOf(after, id).attach).toBeUndefined()
    // o ancorado entra no grupo de vínculo do clipe
    expect(fxOf(after, 'A').linkId).toBeTruthy()
    expect(fxOf(after, 'A').linkId).toBe(mOf(after, 'a').linkId)
  })

  it('região que sai do quadro novo é mantida e avisada (no instante em que sai)', () => {
    const ws = res.warnings.filter((w) => w.kind === 'outsideFrame')
    expect(ws.map((w) => w.itemId)).toContain('E')
    for (const w of ws) {
      const r = effectRegionAt(after, fxOf(after, w.itemId), w.tUs, 0)
      const out = r.x - r.w / 2 < 0 || r.x + r.w / 2 > 1 || r.y - r.h / 2 < 0 || r.y + r.h / 2 > 1 || r.rotation !== 0
      expect(out).toBe(true)
    }
    // mantida: o efeito existe, ancorado ao mesmo conteúdo (fora do quadro)
    expect(fxOf(after, 'E').attach?.mediaItemId).toBe('a')
  })

  it('região que continua no quadro novo não é avisada', () => {
    const p = single()
    p.tracks.push(track('tf', [{ ...createEffectItem('blur', 0, 5 * S, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }), id: 'mid' }, { ...createEffectItem('blur', 5 * S, 5 * S, { x: 0.05, y: 0.5, w: 0.05, h: 0.1 }), id: 'edge' }]))
    const ws = reframeProject(p, '9:16', { mode: 'cover' }).warnings
    expect(ws.map((w) => [w.itemId, w.kind])).toEqual([['edge', 'outsideFrame']])
  })

  it('invertido sobre o PiP que não dá para mapear com segurança: buraco reduzido (esconde tudo) e avisado', () => {
    expect(res.warnings.some((w) => w.kind === 'holeReduced' && w.itemId === 'H')).toBe(true)
  })

  it('invertido sobre a tela onde o PiP passa a ficar no quadro novo: o PiP nunca aparece no buraco', () => {
    // tela com foco no centro: o ponto (0,588; 0,8) da tela vai a (840, 1536) no 9:16 — onde o PiP reposicionado fica
    const p = single()
    p.assets.push(cam)
    const pip = clip('pip', cam, 0, 10 * S)
    pip.visual!.transform.scale = { value: 0.25 }
    pip.visual!.transform.x = { value: 0.85 }
    pip.visual!.transform.y = { value: 0.8 }
    p.tracks.push(track('tp', [pip]), track('tf', [{ ...createEffectItem('blurAllExcept', 0, 4 * S, { x: 0.588, y: 0.8, w: 0.03, h: 0.05 }), id: 'hole' }]))
    const r = reframeProject(p, '9:16', { mode: 'cover' })
    expect(r.warnings.some((w) => w.kind === 'holeReduced' && w.itemId === 'hole')).toBe(true)
    expect(fxOf(r.project, 'hole').attach).toBeUndefined()
    const { fails } = coverage(p, r.project, 'hole')
    expect(fails.slice(0, 3)).toEqual([])
    // sem o PiP no caminho, o mesmo buraco é só ancorado (nada reduzido)
    const q = { ...p, tracks: p.tracks.filter((t) => t.id !== 'tp') }
    const rq = reframeProject(q, '9:16', { mode: 'cover' })
    expect(rq.anchored).toEqual(['hole'])
    expect(rq.warnings.filter((w) => w.kind === 'holeReduced')).toEqual([])
    expect(coverage(q, rq.project, 'hole').checked).toBeGreaterThan(50)
  })

  it('efeito sobre nada (fundo): região mantida normalizada', () => {
    const p = single((m) => { m.visual!.transform.scale = { value: 0.5 } })
    p.tracks.push(track('tf', [{ ...createEffectItem('blur', 0, 4 * S, { x: 0.05, y: 0.05, w: 0.05, h: 0.05 }), id: 'bg' }]))
    const r = reframeProject(p, '9:16', { mode: 'cover' })
    expect(fxOf(r.project, 'bg').region).toEqual(fxOf(p, 'bg').region)
    expect(r.anchored).toEqual([])
    expect(r.baked).toEqual([])
  })

  it('ancorados pelo reenquadrar não geram aviso de privacidade de movimento', () => {
    const ws = privacyWarnings(after, 0, 10 * S).filter((w) => ['A', 'B', 'C', 'E', 'F', 'I'].includes(w.itemId))
    expect(ws.filter((w) => w.kind === 'transformedUnderEffect' || w.kind === 'unlinkedOverMoving' || w.kind === 'attachBeyondClip' || w.kind === 'attachLost')).toEqual([])
  })

  it('controle: manter as regiões como estavam no quadro deixaria conteúdo descoberto', () => {
    const naive: Project = { ...after, tracks: after.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.type === 'effect' ? fxOf(before, i.id) : i)) })) }
    expect(coverage(before, naive, 'A').fails.length).toBeGreaterThan(0)
  })

  it('o disco continua legível pela v1.3 e pelo schema atual', () => {
    const disk = JSON.parse(JSON.stringify(toDiskProject(after)))
    expect(parseProjectV13(disk).success).toBe(true)
    expect(parseProject(disk).canvas).toMatchObject({ width: 1080, height: 1920 })
  })

  it('caixa de reserva dos ancorados recalculada para o quadro novo', () => {
    const fb = fxOf(after, 'A').attach!.fallback!
    const r = effectRegionAt(after, fxOf(after, 'A'), 0)
    // contém a região do instante 0
    expect(fb.x - fb.w / 2).toBeLessThanOrEqual(r.x - r.w / 2 + 1e-9)
    expect(fb.x + fb.w / 2).toBeGreaterThanOrEqual(r.x + r.w / 2 - 1e-9)
  })

  it('anotações da gravação: aviso (ocupam o quadro inteiro, não acompanham o clipe)', () => {
    const p0 = privacyScene()
    const p: Project = { ...p0, tracks: [...p0.tracks, track('ta', [{ id: 'ann', type: 'annotations', sessionId: 's', inUs: 0, startUs: 0, durationUs: 5 * S }])] }
    expect(reframeProject(p, '1:1', { mode: 'cover' }).warnings.some((w) => w.kind === 'annotations' && w.itemId === 'ann')).toBe(true)
  })

  it.each(['1:1', '4:5'] as const)('%s: cobertura em todos os quadros, todos os efeitos', (aspect) => {
    const r = reframeProject(before, aspect, { mode: 'cover', focus: FOCUS })
    for (const id of FX_IDS) expect(coverage(before, r.project, id).fails.slice(0, 3)).toEqual([])
  })

  it("'contain': cobertura em todos os quadros, todos os efeitos", () => {
    const r = reframeProject(before, '9:16', { mode: 'contain' })
    for (const id of FX_IDS) expect(coverage(before, r.project, id).fails.slice(0, 3)).toEqual([])
  })
})
