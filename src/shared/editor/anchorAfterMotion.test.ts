import { describe, expect, it } from 'vitest'
import type { CursorTrackV1 } from '../cursor'
import { applyAutoZoom, DEFAULT_AUTO_ZOOM } from './autoZoom'
import { contentPose, toScreen, type RegionValues } from './contentPose'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { anchorBeforeMotion, attachEffects } from './followTransform'
import { EditError, findItem } from './ops'
import { privacyWarnings } from './privacy'
import type { Anim, Asset, EffectItem, Keyframe, MediaItem, Project, Us } from './project'
import { clipFrameAt, effectRegionAt } from './resolve'
import { applyZoom } from './zoom'

// Revisão final da F6, C1 (invariante 2): "Ancorar" / "Vincular e ancorar" DEPOIS de um zoom (automático ou da
// ferramenta) num clipe sob um efeito com keys por quadro ("Seguir conteúdo") convertia cada key com a pose JÁ com
// zoom — a região ancorada ficava onde o key do quadro estava enquanto o conteúdo andava, e o aviso sumia.
// Oráculo denso (1/240 s): normal → os pontos do conteúdo (a caixa dele no instante, levada pela pose do clipe de
// ANTES do zoom ao conteúdo e pela pose de depois de volta à tela) ⊆ região desenhada, enquanto estão no quadro;
// invertido → o buraco nítido (recortado ao quadro) ⊆ caixa do conteúdo na tela, ou buraco nulo.

const S = 1_000_000
const D = 20 * S
const DT = Math.round(S / 240)
const FPS = 30
const W = 1920
const H = 1080

/** Cursor parado em (0,45; 0,4) com cliques em 3 s e 11 s (os zooms automáticos caem sobre o conteúdo). */
function track(): CursorTrackV1 {
  const samples: CursorTrackV1['samples'] = []
  for (let t = 0; t <= D / 1000; t += 16) samples.push({ tMs: t, x: 0.45, y: 0.4 })
  return { version: 1, width: W, height: H, samples, clicks: [3000, 11000].map((tMs) => ({ tMs, x: 0.45, y: 0.4, button: 'left' as const })) }
}

const screenAsset: Asset = {
  id: 'scr', name: 'Tela', kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' }, durationUs: D,
  video: { width: W, height: H, fps: FPS, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready', cursor: 'cursor.json'
}

/** Caixa do conteúdo NO QUADRO com o clipe parado (pose de antes do zoom): parada em (0,3; 0,3) e andando de 8 a 12 s. */
function contentAt(t: Us, moving: boolean): RegionValues {
  const u = moving ? Math.min(1, Math.max(0, (t - 8 * S) / (4 * S))) : 0
  return { x: 0.3 + 0.1 * u, y: 0.3, w: 0.08, h: 0.04, rotation: 0 }
}

/** Keys por quadro, como o "Seguir conteúdo" grava (tempo local ao efeito). */
function perFrame(f: (t: Us) => number): Anim<number> {
  const keys: Keyframe<number>[] = []
  for (let n = 0; n * (S / FPS) < D; n++) {
    const t = Math.round((n * S) / FPS)
    keys.push({ tUs: t, value: f(t), ease: 'linear' })
  }
  return { value: keys[0].value, keys }
}

/**
 * Clipe de tela (0 → 20 s) e um blur solto numa faixa acima com keys por quadro: normal = a caixa do conteúdo com folga;
 * invertido = o buraco dentro dela. `boxAt` (opcional) dá a caixa na tela que os keys seguem (padrão: a do clipe parado).
 */
function scene(invert: boolean, moving: boolean, boxAt?: (t: Us) => RegionValues): Project {
  const p = createEmptyProject('c1', { width: W, height: H, fps: FPS })
  p.assets = [screenAsset]
  const m: MediaItem = { ...createMediaItem(screenAsset, 0, 'video'), id: 'm', durationUs: D }
  p.tracks[0].items = [m]
  const box = boxAt ?? ((t: Us) => contentAt(t, moving))
  const dw = invert ? -0.02 : 0.02, dh = invert ? -0.01 : 0.01
  const fx: EffectItem = { ...createEffectItem('blur', 0, D, { x: 0.3, y: 0.3, w: 0.1, h: 0.05 }), id: 'fx', strength: { value: 80 }, invert }
  fx.region = {
    ...fx.region,
    x: perFrame((t) => box(t).x),
    y: perFrame((t) => box(t).y),
    w: perFrame((t) => box(t).w + dw * (box(t).w / 0.08)),
    h: perFrame((t) => box(t).h + dh * (box(t).h / 0.04))
  }
  p.tracks = [p.tracks[0], { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }]
  return p
}

const mOf = (p: Project): MediaItem => findItem(p, 'm')!.item as MediaItem
const fxOf = (p: Project): EffectItem => findItem(p, 'fx')!.item as EffectItem

/**
 * Oráculo denso. `before` = o projeto de antes do zoom (o clipe parado: a pose em que a caixa do conteúdo foi medida).
 * Devolve as falhas e quantos instantes tiveram o clipe com zoom e o conteúdo no quadro (o teste não pode ser vazio).
 */
function coverage(before: Project, after: Project, moving: boolean): { fails: number; worst: number; zoomedVisible: number } {
  const fx = fxOf(after)
  let fails = 0, worst = 0, zoomedVisible = 0
  for (let t = 0; t < D; t += DT) {
    const cf0 = clipFrameAt(before, mOf(before), t)!
    const cf = clipFrameAt(after, mOf(after), t)!
    const c = contentAt(t, moving)
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const q = contentPose(cf0, { x: c.x + (i / 8 - 0.5) * c.w, y: c.y + (j / 8 - 0.5) * c.h, w: 0, h: 0, rotation: 0 })
      const s = toScreen(cf, q.qx, q.qy)
      pts.push({ x: s.x / W, y: s.y / H })
    }
    const vis = pts.filter((s) => s.x >= 0 && s.y >= 0 && s.x <= 1 && s.y <= 1)
    if (vis.length && cf.sx > W * 1.05) zoomedVisible++
    const r = effectRegionAt(after, fx, t)
    if (!fx.invert) {
      for (const s of vis) {
        const out = Math.max(Math.abs(s.x - r.x) - Math.abs(r.w) / 2, Math.abs(s.y - r.y) - Math.abs(r.h) / 2)
        if (out > 1e-9) {
          fails++
          worst = Math.max(worst, out * W)
        }
      }
    } else {
      if (!(r.w > 0 && r.h > 0)) continue // buraco nulo
      const x0 = Math.max(0, r.x - r.w / 2), x1 = Math.min(1, r.x + r.w / 2), y0 = Math.max(0, r.y - r.h / 2), y1 = Math.min(1, r.y + r.h / 2)
      if (x0 >= x1 || y0 >= y1) continue // buraco fora do quadro
      const bx0 = Math.min(...pts.map((s) => s.x)), bx1 = Math.max(...pts.map((s) => s.x)), by0 = Math.min(...pts.map((s) => s.y)), by1 = Math.max(...pts.map((s) => s.y))
      const out = Math.max(bx0 - x0, x1 - bx1, by0 - y0, y1 - by1)
      if (out > 1e-9) {
        fails++
        worst = Math.max(worst, out * W)
      }
    }
  }
  return { fails, worst, zoomedVisible }
}

type Motion = { name: string; run: (p: Project) => Project }
const MOTIONS: Motion[] = [
  { name: 'zoom automático', run: (p) => applyAutoZoom(p, 'm', track(), DEFAULT_AUTO_ZOOM).project },
  // zoom da ferramenta (F4): 2× sobre o conteúdo, de 2 s a 6 s, e volta
  { name: 'zoom manual', run: (p) => applyZoom(p, 'm', { x: 0.35, y: 0.35, w: 0.5, h: 0.5 }, 2 * S, S, 3 * S, 'inOut', { clamp: true }).project }
]
const CASES = MOTIONS.flatMap((mo) => [false, true].flatMap((invert) => [false, true].map((moving) => ({ mo, invert, moving }))))
const label = (c: (typeof CASES)[number]): string => `${c.mo.name}${c.invert ? ', invertido' : ''}${c.moving ? ', conteúdo que anda' : ''}`

describe('C1: ancorar depois de um zoom num efeito com keys por quadro', () => {
  for (const c of CASES) {
    it(`${label(c)}: ancorar o projeto já com zoom recusa (EditError em pt-BR) ou cobre em todo instante — nunca silêncio`, () => {
      const p0 = scene(c.invert, c.moving)
      const zoomed = c.mo.run(p0)
      // antes de ancorar, o aviso existe (a região do quadro não acompanha o zoom)
      expect(privacyWarnings(zoomed, 0, D).some((w) => w.itemId === 'fx' && (w.kind === 'unlinkedOverMoving' || w.kind === 'transformedUnderEffect'))).toBe(true)
      let q: Project
      try {
        q = attachEffects(zoomed, 'm', ['fx'])
      } catch (e) {
        expect(e).toBeInstanceOf(EditError)
        expect((e as EditError).message).toMatch(/keyframes.*clipe já se move/)
        return
      }
      const cov = coverage(p0, q, c.moving)
      expect(cov.zoomedVisible).toBeGreaterThan(100)
      expect(cov.fails, `pior ${cov.worst.toFixed(1)} px fora`).toBe(0)
    })
    it(`${label(c)}: "Ancorar" pelo aviso ancora sobre o projeto de ANTES do zoom e refaz o zoom — cobre em todo instante, sem aviso`, () => {
      const p0 = scene(c.invert, c.moving)
      const q = anchorBeforeMotion(p0, 'm', ['fx'], c.mo.run)
      expect(fxOf(q).attach?.mediaItemId).toBe('m')
      // o mesmo zoom de antes (refeito sobre o projeto ancorado)
      expect(mOf(q).visual!.transform).toEqual(mOf(c.mo.run(p0)).visual!.transform)
      expect(privacyWarnings(q, 0, D).filter((w) => w.itemId === 'fx' && w.kind !== 'weakBlur')).toEqual([])
      const cov = coverage(p0, q, c.moving)
      expect(cov.zoomedVisible).toBeGreaterThan(100)
      expect(cov.fails, `pior ${cov.worst.toFixed(1)} px fora`).toBe(0)
    })
  }

  it('nos 8 casos acima, ancorar o projeto já com zoom é recusado com a mensagem que manda desfazer, ancorar e refazer', () => {
    for (const c of CASES) {
      const zoomed = c.mo.run(scene(c.invert, c.moving))
      expect(() => attachEffects(zoomed, 'm', ['fx']), label(c)).toThrow(/Desfaça o movimento \(Ctrl\+Z\), ancore e refaça o movimento/)
    }
  })

  it('controle: o oráculo acusa a conversão com a pose do zoom (a de antes da correção)', () => {
    // a região do quadro sem âncora depois do zoom: fica onde estava enquanto o conteúdo anda
    const p0 = scene(false, false)
    const cov = coverage(p0, MOTIONS[0].run(p0), false)
    expect(cov.fails).toBeGreaterThan(0)
  })

  it('keys que já acompanham o conteúdo com zoom (rastreado DEPOIS do zoom): ancorar é aceito e cobre em todo instante', () => {
    const plain = scene(false, false)
    const zoomedPlain = MOTIONS[0].run(plain)
    // caixa do conteúdo na tela COM o zoom, quadro a quadro (o que o "Seguir conteúdo" mede nos quadros com zoom)
    const boxAt = (t: Us): RegionValues => {
      const cf0 = clipFrameAt(plain, mOf(plain), t)!, cf = clipFrameAt(zoomedPlain, mOf(zoomedPlain), t)!
      const c = contentAt(t, false)
      const a = toScreen(cf, contentPose(cf0, { ...c, x: c.x - c.w / 2, y: c.y - c.h / 2, w: 0, h: 0 }).qx, contentPose(cf0, { ...c, x: c.x - c.w / 2, y: c.y - c.h / 2, w: 0, h: 0 }).qy)
      const b = toScreen(cf, contentPose(cf0, { ...c, x: c.x + c.w / 2, y: c.y + c.h / 2, w: 0, h: 0 }).qx, contentPose(cf0, { ...c, x: c.x + c.w / 2, y: c.y + c.h / 2, w: 0, h: 0 }).qy)
      return { x: (a.x + b.x) / 2 / W, y: (a.y + b.y) / 2 / H, w: (b.x - a.x) / W, h: (b.y - a.y) / H, rotation: 0 }
    }
    const tracked = scene(false, false, boxAt)
    const zoomed = MOTIONS[0].run(tracked)
    const q = attachEffects(zoomed, 'm', ['fx'])
    expect(fxOf(q).attach?.mediaItemId).toBe('m')
    const cov = coverage(plain, q, false)
    expect(cov.zoomedVisible).toBeGreaterThan(100)
    expect(cov.fails, `pior ${cov.worst.toFixed(1)} px fora`).toBe(0)
  })

  it('região com keys sobre clipe PARADO no trecho dos keys (o zoom é depois): ancorar continua aceito', () => {
    const p0 = scene(false, true)
    // keys só de 0 a 6 s (depois a região segura); o zoom manual começa em 12 s
    const fx = fxOf(p0)
    const cut = (a: Anim<number>): Anim<number> => ({ value: a.value, keys: a.keys!.filter((k) => k.tUs < 6 * S) })
    const p1: Project = { ...p0, tracks: [p0.tracks[0], { ...p0.tracks[1], items: [{ ...fx, region: { ...fx.region, x: cut(fx.region.x), y: cut(fx.region.y), w: cut(fx.region.w), h: cut(fx.region.h) } }] }] }
    const z = applyZoom(p1, 'm', { x: 0.35, y: 0.35, w: 0.5, h: 0.5 }, 12 * S, S, 3 * S, 'inOut', { clamp: true }).project
    expect(() => attachEffects(z, 'm', ['fx'])).not.toThrow()
  })
})
