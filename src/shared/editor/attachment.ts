// Âncoras dos efeitos (puro): a caixa conservadora que envolve a região ancorada, a manutenção depois de cada edição
// (pedaço certo do clipe e caixa de reserva) e o teste "a região encosta no clipe".
import { current, isDraft, original } from 'immer'
import { contentToScreen, followCheckTimes, regionAabb, regionTouchesClip, type RegionValues } from './contentPose'
import { evalAnim } from './anim'
import type { EffectItem, Item, MediaItem, Project, Us } from './project'
import { clipFrameAt, effectRegionAt } from './resolve'
import { itemEndUs } from './time'

/** Caixa do quadro (normalizada, sem rotação): centro e tamanho. */
export interface ScreenBox { x: number; y: number; w: number; h: number }

/** Amostragem da caixa conservadora: pelo menos UNION_MIN_SAMPLES no trecho, no máximo UNION_STEP_US entre elas. */
const UNION_MIN_SAMPLES = 30
const UNION_STEP_US = 250_000

const overlapUs = (a: { startUs: Us; durationUs: Us }, b: { startUs: Us; durationUs: Us }): Us => Math.max(0, Math.min(itemEndUs(a), itemEndUs(b)) - Math.max(a.startUs, b.startUs))

/** Valores guardados da região (espaço do conteúdo, no ancorado) no instante absoluto `at`. */
function storedRegion(fx: EffectItem, at: Us): RegionValues {
  const r = fx.region, l = at - fx.startUs
  return { x: evalAnim(r.x, l), y: evalAnim(r.y, l), w: evalAnim(r.w, l), h: evalAnim(r.h, l), rotation: evalAnim(r.rotation, l) }
}

/**
 * Caixa do quadro que envolve TODA a região ancorada enquanto o clipe `m` dura (trecho efeito ∩ clipe), como o resolve
 * a desenha: amostras nas pontas, nos keys da região e do clipe (com o instante 1 µs antes, para o salto do 'segurar'),
 * nas bordas das animações de entrada/saída e a cada ≤ UNION_STEP_US (≥ UNION_MIN_SAMPLES); a união é alargada, em
 * cada lado, pelo maior passo daquele lado entre amostras vizinhas (o que a região pode andar entre duas amostras).
 * null = não se cruzam. Elipse: quem usa a caixa a faz crescer √2 (a elipse que contém a caixa).
 */
export function anchoredUnion(p: Project, fx: EffectItem, m: MediaItem): ScreenBox | null {
  const a = Math.max(m.startUs, fx.startUs), b = Math.min(itemEndUs(m), itemEndUs(fx))
  if (a >= b || !m.visual) return null
  const times = new Set<Us>([a, b - 1])
  const n = Math.max(UNION_MIN_SAMPLES, Math.ceil((b - a) / UNION_STEP_US))
  for (let i = 1; i < n; i++) times.add(a + Math.round(((b - a) * i) / n))
  const addKeys = (offset: Us, ...as: { keys?: { tUs: Us }[] }[]): void => {
    for (const an of as) for (const k of an.keys ?? []) { times.add(offset + k.tUs); times.add(offset + k.tUs - 1) }
  }
  const r = fx.region, v = m.visual, t = v.transform, c = v.crop
  addKeys(fx.startUs, r.x, r.y, r.w, r.h, r.rotation)
  addKeys(m.startUs, t.x, t.y, t.scale, t.rotation, c.l, c.t, c.r, c.b)
  if (v.animIn) times.add(m.startUs + v.animIn.durationUs)
  if (v.animOut) times.add(itemEndUs(m) - v.animOut.durationUs)
  const W = p.canvas.width, H = p.canvas.height
  const sorted = [...times].filter((x) => x >= a && x < b).sort((x, y) => x - y)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  let dx0 = 0, dy0 = 0, dx1 = 0, dy1 = 0
  let prev: { x0: number; y0: number; x1: number; y1: number } | null = null
  for (const at of sorted) {
    const box = regionAabb(contentToScreen(clipFrameAt(p, m, at, true)!, storedRegion(fx, at), r.shape), W, H)
    x0 = Math.min(x0, box.x0); y0 = Math.min(y0, box.y0); x1 = Math.max(x1, box.x1); y1 = Math.max(y1, box.y1)
    if (prev) {
      dx0 = Math.max(dx0, Math.abs(box.x0 - prev.x0)); dy0 = Math.max(dy0, Math.abs(box.y0 - prev.y0))
      dx1 = Math.max(dx1, Math.abs(box.x1 - prev.x1)); dy1 = Math.max(dy1, Math.abs(box.y1 - prev.y1))
    }
    prev = box
  }
  x0 -= dx0; y0 -= dy0; x1 += dx1; y1 += dy1
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

// Caixa de reserva adiada: durante uma transação (arraste no visualizador, campo do inspetor) as edições transitórias
// não recalculam a caixa; o editor chama refreshAttachments(project, base) ao confirmar. Escopo dinâmico síncrono
// (withDeferredFallbacks), sem estado entre chamadas.
let deferFallbacks = 0
/** Roda `fn` sem recalcular as caixas de reserva das âncoras (edições transitórias). */
export function withDeferredFallbacks<T>(fn: () => T): T {
  deferFallbacks++
  try {
    return fn()
  } finally {
    deferFallbacks--
  }
}

/** O que o asset muda na geometria do clipe (clipFrameAt): tamanho e rotação do vídeo. */
const assetGeom = (p: Project, id: string): string => {
  const v = p.assets.find((a) => a.id === id)?.video
  return v ? `${v.width}x${v.height}r${v.rotation}` : ''
}

const sameBox = (a: ScreenBox | undefined, b: ScreenBox | null): boolean => !!a && !!b && Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12 && Math.abs(a.w - b.w) < 1e-12 && Math.abs(a.h - b.h) < 1e-12

/**
 * Âncoras depois de uma edição (`d`: rascunho do immer, mutado; lido por current/original — sem criar rascunhos à toa):
 * 1. Efeito vinculado cujo clipe-âncora sumiu, saiu do grupo de vínculo dele ou não cruza mais o tempo dele (dividir,
 *    duplicar/colar, congelar, apagar trechos, mover) passa ao clipe de vídeo do grupo que mais o cruza (empate: o do
 *    mesmo asset). Sem candidato, fica como está (apagado → attachLost).
 * 2. A caixa de reserva (anchoredUnion) é recalculada só para os efeitos cujo item ou clipe-âncora mudou em relação a
 *    `base` (padrão: o original do rascunho), cujo asset mudou de geometria (religar a outro tamanho/rotação) ou quando
 *    o tamanho do quadro mudou — e não durante edições transitórias (withDeferredFallbacks).
 * O item é sempre trocado, nunca mutado: pedaços copiados (dividir, duplicar) dividem o mesmo `attach`, às vezes congelado.
 */
export function maintainAttachments(d: Project, base?: Project): void {
  const cur = isDraft(d) ? current(d) : d
  const fxs: { fx: EffectItem; ti: number; ii: number }[] = []
  const media = new Map<string, MediaItem>()
  const byLink = new Map<string, MediaItem[]>()
  cur.tracks.forEach((t, ti) => t.items.forEach((it, ii) => {
    if (it.type === 'effect' && it.attach) fxs.push({ fx: it, ti, ii })
    else if (it.type === 'media' && t.kind === 'video' && it.visual) {
      media.set(it.id, it)
      if (it.linkId) (byLink.get(it.linkId) ?? byLink.set(it.linkId, []).get(it.linkId)!).push(it)
    }
  }))
  if (fxs.length === 0) return
  const before = base ?? (isDraft(d) ? original(d) : undefined)
  const old = new Map<string, Item>()
  if (before) for (const t of before.tracks) for (const it of t.items) old.set(it.id, it)
  const canvasChanged = !!before && (before.canvas.width !== cur.canvas.width || before.canvas.height !== cur.canvas.height)
  const geomChanged = new Map<string, boolean>()
  const assetChanged = (id: string): boolean => {
    if (!before) return true
    if (!geomChanged.has(id)) geomChanged.set(id, assetGeom(before, id) !== assetGeom(cur, id))
    return geomChanged.get(id)!
  }
  for (const { fx, ti, ii } of fxs) {
    const at = fx.attach!
    const curM = media.get(at.mediaItemId)
    let id = at.mediaItemId
    if (fx.linkId && !(curM && curM.linkId === fx.linkId && overlapUs(curM, fx) > 0)) {
      let best: MediaItem | null = null
      for (const m of byLink.get(fx.linkId) ?? []) {
        const o = overlapUs(m, fx)
        if (o <= 0) continue
        const bo = best ? overlapUs(best, fx) : 0
        if (!best || o > bo || (o === bo && curM && m.assetId === curM.assetId && best.assetId !== curM.assetId)) best = m
      }
      if (best) id = best.id
    }
    const target = media.get(id)
    let fallback = at.fallback
    const changed = !before || canvasChanged || old.get(fx.id) !== fx || id !== at.mediaItemId || (!!target && (old.get(target.id) !== target || assetChanged(target.assetId))) || !fallback
    if (changed && !deferFallbacks && target) fallback = anchoredUnion(cur, { ...fx, attach: { ...at, mediaItemId: id } }, target) ?? fallback
    if (id === at.mediaItemId && (fallback === at.fallback || sameBox(at.fallback, fallback ?? null))) continue
    // item trocado (não mutado): funciona no rascunho e na cópia rasa de refreshAttachments
    d.tracks[ti].items[ii] = { ...fx, attach: { ...at, mediaItemId: id, ...(fallback ? { fallback } : {}) } }
  }
}

/**
 * As caixas de reserva das âncoras de `p` em dia em relação a `base` (o projeto antes de uma transação de edições
 * transitórias): o que mudou é recalculado (maintainAttachments). Igual se nada mudou.
 */
export function refreshAttachments(p: Project, base: Project): Project {
  if (!p.tracks.some((t) => t.items.some((i) => i.type === 'effect' && i.attach))) return p
  // sem immer aqui: cópia rasa das faixas/itens tocados
  const d: Project = { ...p, tracks: p.tracks.map((t) => ({ ...t, items: [...t.items] })) }
  const before = d.tracks.map((t) => [...t.items])
  maintainAttachments(d, base)
  const changed = d.tracks.some((t, ti) => t.items.some((it, ii) => it !== before[ti][ii]))
  return changed ? d : p
}

/** Amostras mínimas do teste "a região encosta no clipe" (além dos keys e pontos de followCheckTimes). */
const TOUCH_SAMPLES = 30

/**
 * A região do efeito (no quadro) encosta na camada do clipe em algum instante de [a, b)? Amostras: followCheckTimes
 * (keys do clipe e da região, pontas, entre-pontos) e TOUCH_SAMPLES instantes uniformes.
 */
export function regionTouchesOver(p: Project, fx: EffectItem, m: MediaItem, a: Us, b: Us): boolean {
  if (a >= b || !m.visual) return false
  const times = new Set(followCheckTimes(fx, m, a, b))
  for (let i = 0; i < TOUCH_SAMPLES; i++) times.add(a + Math.round(((b - a) * i) / TOUCH_SAMPLES))
  for (const at of times) {
    const cf = clipFrameAt(p, m, at)
    if (cf && regionTouchesClip(fx, effectRegionAt(p, fx, at), cf)) return true
  }
  return false
}
