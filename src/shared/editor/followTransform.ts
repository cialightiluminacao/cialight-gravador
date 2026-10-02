// "Ancorar ao clipe" (F4): o efeito passa a ter a região no espaço do conteúdo de um clipe de mídia (EffectItem.attach)
// e o resolve a leva ao quadro em cada instante — acompanha zoom, pan, corte, rotação, animações e edições futuras do
// clipe sem nada "assado". Puro.
// Ancorar converte a região atual do quadro (no início do trecho em comum ou em cada key, cada um no seu instante) para
// o espaço do conteúdo. Desancorar faz o caminho inverso "assando" o comportamento atual em keys do quadro: amostragem
// densa (quadros a ≥ 60 fps, keys do efeito e do clipe, bordas das animações) simplificada por Douglas–Peucker com
// keys lineares — nenhuma amostra se afasta mais que FIT_TOL do quadro (FIT_TOL_DEG na rotação).
import { insertKeyExact } from './anim'
import { anchoredUnion, regionTouchesOver } from './attachment'
import { screenToContent, type ClipFrame, type RegionValues } from './contentPose'
import { EditError, findItem, linkItems, updateItem } from './ops'
import type { Anim, Ease, EffectItem, EffectRegion, Keyframe, MediaItem, Project, Us } from './project'
import { attachedMedia, clipFrameAt, effectRegionAt } from './resolve'
import { frameToUs, itemEndUs } from './time'

/** Desvio máximo da região assada ao desancorar: 0,5 % do maior lado do quadro e 0,5°. */
export const FIT_TOL = 0.005
export const FIT_TOL_DEG = 0.5
/** Invertido: o desancorar simplifica com tolerância este tanto menor (menos margem tirada do buraco). */
const HOLE_TOL_DIV = 4
/** Amostragem mínima do assar: 60 amostras por segundo (exportar a 60 fps não cai entre amostras). */
const MIN_SAMPLE_FPS = 60

type Channel = keyof RegionValues
const CHANNELS: readonly Channel[] = ['x', 'y', 'w', 'h', 'rotation']

function mustMedia(p: Project, mediaItemId: string): MediaItem {
  const f = findItem(p, mediaItemId)
  if (!f || f.item.type !== 'media' || f.track.kind !== 'video' || !f.item.visual) throw new EditError('invalid', 'Os efeitos só se ancoram a clipes de vídeo ou imagem')
  if (f.item.enabled === false) throw new EditError('invalid', 'O clipe está desativado: ative-o para ancorar efeitos nele')
  return f.item
}

function mustEffect(p: Project, effectId: string): EffectItem {
  const it = findItem(p, effectId)?.item
  if (it?.type !== 'effect') throw new EditError('invalid', 'Item não é um efeito')
  return it
}

/** Geometria visível do clipe em `at`; invisível (escala 0) → a mais próxima visível em [a, b) (30 amostras); null = nunca. */
function visibleFrame(p: Project, m: MediaItem, at: Us, a: Us, b: Us): ClipFrame | null {
  const cf = clipFrameAt(p, m, at)
  if (cf) return cf
  const tries = Array.from({ length: 31 }, (_, i) => a + Math.round(((b - a) * i) / 30)).sort((x, y) => Math.abs(x - at) - Math.abs(y - at))
  for (const t of tries) {
    const c = clipFrameAt(p, m, t)
    if (c) return c
  }
  return null
}

/**
 * Região do efeito convertida para o espaço do conteúdo do clipe: sem keys, a região do quadro no início do trecho em
 * comum (o início do efeito, se não se cruzam); com keys, cada key (a união dos instantes das 5 propriedades; as
 * curvas cortadas exatamente — insertKeyExact — para manter os eases) convertido no próprio instante.
 */
function toContentRegion(p: Project, fx: EffectItem, m: MediaItem): EffectRegion {
  const r = fx.region
  const a = Math.max(m.startUs, fx.startUs), b = Math.min(itemEndUs(m), itemEndUs(fx))
  const span: [Us, Us] = a < b ? [a, b] : [fx.startUs, itemEndUs(fx)]
  const convert = (at: Us): RegionValues => {
    const cf = visibleFrame(p, m, at, span[0], span[1])
    if (!cf) throw new EditError('invalid', 'O clipe não aparece em nenhum instante do efeito: não há onde ancorar')
    return screenToContent(cf, effectRegionAt(p, fx, at), r.shape)
  }
  const times = [...new Set(CHANNELS.flatMap((c) => (r[c].keys ?? []).map((k) => k.tUs)))].sort((x, y) => x - y)
  if (times.length === 0) {
    const v = convert(span[0])
    return { shape: r.shape, x: { value: v.x }, y: { value: v.y }, w: { value: v.w }, h: { value: v.h }, rotation: { value: v.rotation } }
  }
  const values = times.map((t) => convert(fx.startUs + t))
  const channel = (c: Channel): Anim<number> => {
    let cut: Anim<number> = r[c]
    if (cut.keys?.length) for (const t of times) cut = insertKeyExact(cut, t)
    const easeAt = (t: Us): Ease => cut.keys?.find((k) => k.tUs === t)?.ease ?? 'linear'
    const keys: Keyframe<number>[] = times.map((t, i) => ({ tUs: t, value: values[i][c], ease: easeAt(t) }))
    return { value: keys[0].value, keys }
  }
  return { shape: r.shape, x: channel('x'), y: channel('y'), w: channel('w'), h: channel('h'), rotation: channel('rotation') }
}

/**
 * "Ancorar ao clipe" / "Vincular e ancorar": os efeitos passam a acompanhar o clipe (attach + região no espaço do
 * conteúdo). Efeito fora do grupo de vínculo do clipe entra nele (a âncora segue o grupo nas edições — dividir,
 * duplicar, mover…), sem tirar o clipe do grupo dele; clipe sem vínculo → grupo novo com ele e os efeitos. Um passo
 * de desfazer. Já ancorado a este clipe → igual. Faixa do efeito bloqueada → EditError.
 */
export function attachEffects(p: Project, mediaItemId: string, effectIds: readonly string[]): Project {
  let m = mustMedia(p, mediaItemId)
  const todo = effectIds.filter((id) => {
    const fx = mustEffect(p, id)
    return !(fx.attach?.mediaItemId === m.id && attachedMedia(p, fx))
  })
  if (todo.length === 0) return p
  let q = p
  const outside = todo.filter((id) => !m.linkId || mustEffect(q, id).linkId !== m.linkId)
  if (outside.length) {
    if (m.linkId) for (const id of outside) q = updateItem<EffectItem>(q, id, (d) => { d.linkId = m.linkId })
    else q = linkItems(q, [mediaItemId, ...outside])
    m = mustMedia(q, mediaItemId)
  }
  for (const id of todo) {
    const fx = mustEffect(q, id)
    const region = toContentRegion(q, fx, m)
    // a caixa de reserva já nasce com a âncora (edições transitórias adiam o recálculo; o resolve nunca fica sem ela)
    const fallback = anchoredUnion(q, { ...fx, region, attach: { mediaItemId: m.id } }, m)
    q = updateItem<EffectItem>(q, id, (d) => {
      d.region = region
      d.attach = { mediaItemId: m.id, ...(fallback ? { fallback } : {}) }
    })
  }
  return q
}

/**
 * Instantes (absolutos, ordenados) de [a, b) para assar a região: a grade num múltiplo do fps do projeto ≥ 60 (contém
 * todos os quadros do projeto) e `must` = os que viram key sempre (pontas, keys do efeito e do clipe — com o instante
 * 1 µs antes do salto de um 'segurar' — e as bordas das animações de entrada/saída).
 */
function sampleTimes(p: Project, fx: EffectItem, m: MediaItem | null, a: Us, b: Us): { times: Us[]; must: Set<Us> } {
  const fps = p.canvas.fps > 0 ? p.canvas.fps : 30
  const grid = fps * Math.max(1, Math.ceil(MIN_SAMPLE_FPS / fps))
  const must = new Set<Us>([a, b - 1])
  const addKeys = (offset: Us, as: Anim<number>[]): void => {
    for (const an of as) {
      const ks = an.keys ?? []
      ks.forEach((k, i) => {
        must.add(offset + k.tUs)
        if (i > 0 && ks[i - 1].ease === 'hold') must.add(offset + k.tUs - 1)
      })
    }
  }
  const r = fx.region
  addKeys(fx.startUs, [r.x, r.y, r.w, r.h, r.rotation])
  if (m?.visual) {
    const v = m.visual, t = v.transform, c = v.crop
    addKeys(m.startUs, [t.x, t.y, t.scale, t.rotation, c.l, c.t, c.r, c.b])
    if (v.animIn) must.add(m.startUs + v.animIn.durationUs)
    if (v.animOut) must.add(itemEndUs(m) - v.animOut.durationUs)
    // bordas do clipe com o instante 1 µs antes: dentro/fora dele a região salta (fora: a reserva) — sem rampa entre
    must.add(m.startUs - 1)
    must.add(m.startUs)
    must.add(itemEndUs(m) - 1)
    must.add(itemEndUs(m))
  }
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
 * A região do quadro que o efeito tem hoje (ancorado: como o resolve a desenha), assada em keys do quadro ao longo do
 * efeito, simplificada (Douglas–Peucker) a FIT_TOL / FIT_TOL_DEG em todas as amostras.
 * Assa SEM a folga de 1 px do resolve (ATTACH_PAD_PX): a folga é constante na TELA, então no espaço do conteúdo ela
 * vale 1 px ÷ escala — 1 px com o clipe em 1×, 0,05 px a 20×. Assada, a região perderia esse 1 px de conteúdo à
 * medida que o clipe se aproxima, e a privacidade (que mede o desvio no espaço do conteúdo, × escala atual) acusaria
 * "não acompanha" num zoom forte (~19×: 1,9 px de conteúdo × 19 ≈ 36 px na tela, acima da tolerância de 1 %). Sem a
 * folga, a pose assada é constante no conteúdo; a folga só serve à renderização do ancorado.
 * Invertido (a região é o buraco nítido): as amostras são o buraco contido na região exata ('hole', effectRegionAt) e
 * a simplificação não pode alargá-lo. Com tolerância HOLE_TOL_DIV× menor, cada amostra encolhe antes pela margem μ que
 * cobre o desvio máximo da interpolação (centro ≤ tol, meio-tamanho ≤ tol/2 em cada eixo, rotação ≤ tolDeg num raio
 * de meia-diagonal R): μ = tol + tol·√2/2 + R·tolDeg. Retângulo: meias-larguras − μ; elipse: × (1 − μ/min(a, b))
 * (a elipse assim encolhida, somada a um disco de raio μ, cabe na original). O desvio fica dentro dela ⇒ o buraco
 * interpolado cabe no buraco de cada amostra.
 */
export function bakeScreenRegion(p: Project, fx: EffectItem): EffectRegion {
  const W = p.canvas.width, H = p.canvas.height
  const a = fx.startUs, b = itemEndUs(fx)
  const { times, must } = sampleTimes(p, fx, attachedMedia(p, fx), a, b)
  const div = fx.invert ? HOLE_TOL_DIV : 1
  const tolPx = (FIT_TOL * Math.max(W, H)) / div, tolDeg = FIT_TOL_DEG / div
  const shrink = (r: RegionValues): RegionValues => {
    const hx = (r.w * W) / 2, hy = (r.h * H) / 2
    const mu = tolPx * (1 + Math.SQRT1_2) + Math.hypot(hx, hy) * ((tolDeg * Math.PI) / 180)
    const [ex, ey] = fx.region.shape === 'rect'
      ? [Math.max(0, hx - mu), Math.max(0, hy - mu)]
      : ((k) => [hx * k, hy * k])(Math.max(0, 1 - mu / Math.max(1e-9, Math.min(hx, hy))))
    return { ...r, w: (2 * ex) / W, h: (2 * ey) / H }
  }
  const samples = times.map((t) => {
    const r = effectRegionAt(p, fx, t, 0)
    return { t, r: fx.invert ? shrink(r) : r, must: must.has(t) }
  })
  const err = (k: number, i: number, j: number): number => {
    const si = samples[i], sj = samples[j], sk = samples[k]
    const u = (sk.t - si.t) / (sj.t - si.t)
    const at = (c: Channel): number => si.r[c] + (sj.r[c] - si.r[c]) * u - sk.r[c]
    const px = Math.max(Math.hypot(at('x') * W, at('y') * H), Math.abs(at('w')) * W, Math.abs(at('h')) * H)
    return Math.max(px / tolPx, Math.abs(at('rotation')) / tolDeg)
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
  const channel = (c: Channel): Anim<number> => {
    const keys: Keyframe<number>[] = kept.map((s) => ({ tUs: s.t - fx.startUs, value: s.r[c], ease: 'linear' }))
    return keys.every((k) => Math.abs(k.value - keys[0].value) < 1e-12) ? { value: keys[0].value } : { value: keys[0].value, keys }
  }
  return { shape: fx.region.shape, x: channel('x'), y: channel('y'), w: channel('w'), h: channel('h'), rotation: channel('rotation') }
}

/** "Desancorar": a região volta ao espaço do quadro com o comportamento atual assado (bakeScreenRegion). Um passo. */
export function detachEffect(p: Project, effectId: string): Project {
  const fx = mustEffect(p, effectId)
  if (!fx.attach) return p
  const region = bakeScreenRegion(p, fx)
  return updateItem<EffectItem>(p, effectId, (d) => {
    d.region = region
    delete d.attach
  })
}

/**
 * Efeitos sobre o clipe (cruzam o tempo dele e a região encosta na camada em algum instante — regionTouchesOver) que
 * não estão ancorados (nem a ele nem a outro clipe): `linked` = do grupo de vínculo do clipe; `unlinked` = sem mídia no grupo deles e que
 * agem sobre o clipe (faixa acima dele; escopo `track`: com ele na faixa-alvo).
 */
export function effectsOverClip(p: Project, mediaItemId: string): { linked: string[]; unlinked: string[] } {
  const m = mustMedia(p, mediaItemId)
  const mTrack = findItem(p, mediaItemId)!.trackIndex
  const groupHasMedia = (link: string | undefined): boolean => !!link && p.tracks.some((t) => t.items.some((i) => i.type !== 'effect' && i.linkId === link))
  const linked: string[] = [], unlinked: string[] = []
  p.tracks.forEach((t, ti) => {
    for (const fx of t.items) {
      // já ancorado (a este ou a outro clipe): a oferta nunca troca a âncora
      if (fx.type !== 'effect' || fx.attach) continue
      const a = Math.max(m.startUs, fx.startUs), b = Math.min(itemEndUs(m), itemEndUs(fx))
      if (a >= b) continue
      const inGroup = !!m.linkId && fx.linkId === m.linkId
      const loose = !groupHasMedia(fx.linkId)
      if (!inGroup && !loose) continue
      if (!inGroup) {
        const acts = fx.scope === 'track' ? fx.targetTrackId === p.tracks[mTrack].id : ti > mTrack
        if (!acts) continue
      }
      if (!regionTouchesOver(p, fx, m, a, b)) continue
      ;(inGroup ? linked : unlinked).push(fx.id)
    }
  })
  return { linked, unlinked }
}

/**
 * Clipe a que o inspetor do efeito oferece ancorar: o ancorado (perdido — apagado/desativado: null) ou, sem âncora, o
 * clipe de vídeo ATIVO do grupo de vínculo que mais cruza o tempo do efeito.
 */
export function attachCandidate(p: Project, effectId: string): MediaItem | null {
  const fx = mustEffect(p, effectId)
  if (fx.attach) return attachedMedia(p, fx)
  if (!fx.linkId) return null
  let best: MediaItem | null = null, bo = 0
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    for (const m of t.items) {
      if (m.type !== 'media' || !m.visual || m.enabled === false || m.linkId !== fx.linkId) continue
      const o = Math.min(itemEndUs(m), itemEndUs(fx)) - Math.max(m.startUs, fx.startUs)
      if (o > bo) { best = m; bo = o }
    }
  }
  return best
}
