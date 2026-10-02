// "Ajustar efeitos ao movimento" (F4): a região de um efeito vinculado passa a acompanhar o conteúdo de um clipe que
// se move (zoom, pan, rotação, corte ou animação de entrada/saída). Puro.
// A pose da região no espaço do conteúdo no início do trecho em comum clipe ∩ efeito fica fixa; em cada instante a
// região do quadro é a inversa exata dessa pose (contentPose.regionFromPose — a mesma conta do aviso
// transformedUnderEffect da privacidade, que por isso some por construção). Amostragem densa (quadros a ≥ 60 fps, keys
// do clipe e as bordas das animações), depois simplificação Douglas–Peucker com keys lineares: entre dois keys, a
// região interpolada nunca se afasta da pose em nenhuma amostra mais que FIT_TOL do quadro (FIT_TOL_DEG na rotação).
import { insertKeyExact } from './anim'
import { clipFrameAt, clipMoves, contentPose, poseError, regionFromPose, regionValuesAt, type ClipFrame, type RegionValues } from './contentPose'
import { EditError, findItem, linkItems, updateItem } from './ops'
import type { Anim, EffectItem, EffectRegion, Keyframe, MediaItem, Project, Us } from './project'
import { frameToUs, itemEndUs } from './time'

/** Desvio máximo da região simplificada: 0,5 % do maior lado do quadro (metade da tolerância do aviso). */
export const FIT_TOL = 0.005
export const FIT_TOL_DEG = 0.5
/** Amostragem mínima: 60 amostras por segundo (exportar a 60 fps não cai entre amostras). */
const MIN_SAMPLE_FPS = 60

type Channel = keyof RegionValues
const CHANNELS: readonly Channel[] = ['x', 'y', 'w', 'h', 'rotation']

/**
 * Instantes (absolutos, ordenados) de [a, b) para amostrar: a grade de quadros num múltiplo do fps do projeto ≥ 60
 * (contém todos os quadros do projeto) e as pontas; `must` = os que viram key sempre (pontas, keys do clipe — com o
 * instante 1 µs antes do salto de um 'segurar' — e as bordas das animações de entrada/saída: quinas da trajetória).
 */
function sampleTimes(p: Project, m: MediaItem, a: Us, b: Us): { times: Us[]; must: Set<Us> } {
  const v = m.visual!
  const fps = p.canvas.fps > 0 ? p.canvas.fps : 30
  const grid = fps * Math.max(1, Math.ceil(MIN_SAMPLE_FPS / fps))
  const must = new Set<Us>([a, b - 1])
  const t = v.transform, c = v.crop
  for (const an of [t.x, t.y, t.scale, t.rotation, c.l, c.t, c.r, c.b]) {
    const ks = an.keys ?? []
    ks.forEach((k, i) => {
      const at = m.startUs + k.tUs
      must.add(at)
      if (i > 0 && ks[i - 1].ease === 'hold') must.add(at - 1)
    })
  }
  if (v.animIn) must.add(m.startUs + v.animIn.durationUs)
  if (v.animOut) must.add(itemEndUs(m) - v.animOut.durationUs)
  const kept = new Set([...must].filter((x) => x >= a && x < b))
  const set = new Set<Us>(kept)
  for (let k = Math.ceil((a * grid) / 1e6); ; k++) {
    const at = frameToUs(k, grid)
    if (at >= b) break
    if (at >= a) set.add(at)
  }
  return { times: [...set].sort((x, y) => x - y), must: kept }
}

/**
 * Keys (tempo local do efeito) da região que acompanha o clipe `m` no trecho em comum; null = sem trecho em comum ou
 * conteúdo invisível o tempo todo. Fora do trecho a animação original continua (corte exato nas bordas, salto de 1 µs).
 */
export function followRegion(p: Project, fx: EffectItem, m: MediaItem): EffectRegion | null {
  if (!m.visual) return null
  const W = p.canvas.width, H = p.canvas.height
  const a = Math.max(m.startUs, fx.startUs), b = Math.min(itemEndUs(m), itemEndUs(fx))
  if (a >= b) return null
  const { times, must } = sampleTimes(p, m, a, b)
  const samples: { t: Us; cf: ClipFrame; r: RegionValues; must: boolean }[] = []
  for (const t of times) {
    const cf = clipFrameAt(p, m, t)
    if (cf) samples.push({ t, cf, r: { x: 0, y: 0, w: 0, h: 0, rotation: 0 }, must: must.has(t) })
  }
  if (samples.length === 0) return null
  // pose fixa: a região original no primeiro instante visível do trecho (o início, normalmente)
  const ref = contentPose(samples[0].cf, regionValuesAt(fx, samples[0].t), W, H)
  for (const s of samples) s.r = regionFromPose(s.cf, ref, W, H)

  // Douglas–Peucker: erro de uma amostra = desvio (na tela) da região interpolada em relação à pose, em tolerâncias
  const tolPx = FIT_TOL * Math.max(W, H)
  const err = (k: number, i: number, j: number): number => {
    const si = samples[i], sj = samples[j], sk = samples[k]
    const u = (sk.t - si.t) / (sj.t - si.t)
    const r = Object.fromEntries(CHANNELS.map((c) => [c, si.r[c] + (sj.r[c] - si.r[c]) * u])) as unknown as RegionValues
    const e = poseError(ref, contentPose(sk.cf, r, W, H))
    return Math.max(e.px / tolPx, e.deg / FIT_TOL_DEG)
  }
  const keep = samples.map((s, i) => s.must || i === 0 || i === samples.length - 1)
  const fixed = keep.flatMap((k, i) => (k ? [i] : []))
  const stack: [number, number][] = fixed.slice(1).map((j, n) => [fixed[n], j])
  while (stack.length) {
    const [i, j] = stack.pop()!
    let worst = -1, at = -1
    for (let k = i + 1; k < j; k++) {
      const e = err(k, i, j)
      if (e > worst) { worst = e; at = k }
    }
    if (worst > 1) {
      keep[at] = true
      stack.push([i, at], [at, j])
    }
  }
  const kept = samples.filter((_, i) => keep[i])

  const la = a - fx.startUs, lb = b - fx.startUs // [la, lb) local ao efeito
  const before = la > 0, after = lb < fx.durationUs
  const channel = (c: Channel): Anim<number> => {
    const orig = fx.region[c]
    const own: Keyframe<number>[] = kept.map((s) => ({ tUs: s.t - fx.startUs, value: s.r[c], ease: 'linear' }))
    if (!before && !after && own.every((k) => Math.abs(k.value - own[0].value) < 1e-12)) return { value: own[0].value }
    const outside = (tUs: Us, side: 'before' | 'after'): Keyframe<number>[] => {
      if (!orig.keys?.length) return [{ tUs, value: orig.value, ease: 'linear' }]
      const cut = insertKeyExact(orig, tUs).keys!
      return side === 'before' ? cut.filter((k) => k.tUs <= tUs) : cut.filter((k) => k.tUs >= tUs)
    }
    const keys = [...(before ? outside(la - 1, 'before').map((k) => (k.tUs === la - 1 ? { ...k, ease: 'linear' as const } : k)) : []), ...own, ...(after ? outside(lb, 'after') : [])]
    return { value: own[0].value, keys }
  }
  return { ...fx.region, x: channel('x'), y: channel('y'), w: channel('w'), h: channel('h'), rotation: channel('rotation') }
}

function mustMovingMedia(p: Project, mediaItemId: string): MediaItem {
  const f = findItem(p, mediaItemId)
  if (!f || f.item.type !== 'media' || f.track.kind !== 'video' || !f.item.visual) throw new EditError('invalid', 'Os efeitos só acompanham clipes de vídeo ou imagem')
  return f.item
}

/**
 * Ajusta os efeitos vinculados ao clipe (ou só `effectIds`) para acompanhar o movimento dele (followRegion). Um passo
 * de desfazer. Clipe parado ou nenhum efeito no trecho → o mesmo projeto. Faixa do efeito bloqueada → EditError.
 */
export function fitEffectsToMotion(p: Project, mediaItemId: string, effectIds?: readonly string[]): Project {
  const m = mustMovingMedia(p, mediaItemId)
  if (!clipMoves(m)) return p
  const ids = effectIds ?? (m.linkId ? p.tracks.flatMap((t) => t.items.filter((i) => i.type === 'effect' && i.linkId === m.linkId).map((i) => i.id)) : [])
  let q = p
  for (const id of ids) {
    const fx = findItem(q, id)?.item
    if (fx?.type !== 'effect') continue
    const region = followRegion(q, fx, m)
    if (region) q = updateItem<EffectItem>(q, id, (d) => { d.region = region })
  }
  return q
}

/**
 * "Vincular e ajustar": o efeito entra no grupo de vínculo do clipe (sem tirar o clipe do grupo dele; clipe sem
 * vínculo → grupo novo com os dois) e passa a acompanhar o movimento. Um passo de desfazer.
 */
export function linkAndFitEffect(p: Project, effectId: string, mediaItemId: string): Project {
  const m = mustMovingMedia(p, mediaItemId)
  if (findItem(p, effectId)?.item.type !== 'effect') throw new EditError('invalid', 'Item não é um efeito')
  const linked = m.linkId ? updateItem<EffectItem>(p, effectId, (d) => { d.linkId = m.linkId }) : linkItems(p, [mediaItemId, effectId])
  return fitEffectsToMotion(linked, mediaItemId, [effectId])
}
