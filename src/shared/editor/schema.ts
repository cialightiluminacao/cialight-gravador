import { z } from 'zod'
import { frameDurUs, itemEndUs } from './time'
import { ANIM_PRESETS, DEFAULT_TEXT_SHADOW, MIN_ITEM_US, MAX_SPEED, MIN_SPEED } from './project'
import type { Anim, AnimPreset, Asset, EffectItem, EffectRegion, Item, MediaItem, PresetAnim, Project, ShapeItem, TextItem, Track, VisualProps } from './project'
import { anchoredUnion } from './attachment'
import { attachedMedia } from './resolve'
import { conservativeRegion } from './contentPose'
import { itemAnimEntries, type AnimPath } from './animPaths'
import { maxTransitionUs, MIN_TRANSITION_US, transitionInOf, transitionPairOk } from './transitions'

const us = z.number().int()
const unit = z.number().min(0).max(1)
// bezier estilo CSS: x1, x2 ∈ [0,1] (x monotônico); y livre (overshoot)
const ease = z.union([
  z.enum(['linear', 'hold', 'in', 'out', 'inOut']),
  z.object({ bezier: z.tuple([unit, z.number(), unit, z.number()]) })
])
const anim = z.object({
  value: z.number(),
  keys: z.array(z.object({ tUs: us, value: z.number(), ease })).optional()
})
/**
 * Propriedade que virou animável na F4 (corte, ajuste, raio, tamanho do texto): projetos v1.1–v1.3 gravavam o número;
 * o schema aceita os dois e normaliza para `{ value }` (sem mudar `version`: o arquivo antigo é um caso particular).
 */
const animOrNumber = z.union([z.number().transform((value) => ({ value })), anim])

// F4: girar, quicar e desfoque e a curva `ease` (sem 'segurar'). No disco (toDiskProject) os presets que a v1.3 não
// conhece vão como o equivalente dela (V13_DISK_PRESET) com o real em `presetV14`, que o parse devolve a `preset`;
// a v1.3 descarta `presetV14` e `ease` e abre o projeto com o equivalente.
const animPreset = z.enum(ANIM_PRESETS)
const presetEase = z.union([
  z.enum(['linear', 'in', 'out', 'inOut']),
  z.object({ bezier: z.tuple([unit, z.number(), unit, z.number()]) })
])
const presetAnim = z
  .object({ preset: animPreset, durationUs: us, ease: presetEase.optional(), presetV14: animPreset.optional() })
  .transform(({ presetV14, ...a }) => (presetV14 ? { ...a, preset: presetV14 } : a))
const transform = z.object({ x: anim, y: anim, scale: anim, rotation: anim, opacity: anim })
const visual = z.object({
  transform,
  crop: z.object({ l: animOrNumber, t: animOrNumber, r: animOrNumber, b: animOrNumber }),
  fit: z.enum(['contain', 'cover', 'fill']),
  fadeInUs: us,
  fadeOutUs: us,
  animIn: presetAnim.optional(),
  animOut: presetAnim.optional(),
  adjust: z.object({ brightness: animOrNumber, contrast: animOrNumber, saturation: animOrNumber }).optional(),
  shape: z.enum(['rect', 'rounded', 'circle']).optional(),
  radius: animOrNumber.optional(),
  border: z.object({ width: z.number(), color: z.string() }).optional(),
  mirror: z.boolean().optional()
})
const audio = z.object({
  enabled: z.boolean(),
  volume: anim,
  fadeInUs: us,
  fadeOutUs: us,
  preservePitch: z.boolean(),
  denoise: z.boolean(),
  normalize: z.boolean(),
  keepFastAudio: z.boolean().optional()
})
const transition = z.object({
  kind: z.enum(['crossfade', 'dipBlack', 'dipWhite', 'slideL', 'slideR', 'slideU', 'slideD', 'wipeL', 'wipeR', 'zoomIn', 'blur']),
  durationUs: us
})
const itemBase = { id: z.string().min(1), startUs: us, durationUs: us, name: z.string().optional(), linkId: z.string().optional(), enabled: z.boolean().optional() }

const mediaItem = z.object({
  ...itemBase,
  type: z.literal('media'),
  assetId: z.string(),
  inUs: us,
  speed: z.number(),
  reverse: z.boolean(),
  freeze: z.object({ atUs: us }).optional(),
  audio,
  visual: visual.optional(),
  transitionIn: transition.optional()
})
// F5 (v1.5): itálico, largura máxima, fundo com margem/cantos e sombra com parâmetros — opcionais, a v1.3 os descarta.
// `shadow` (boolean da v1.3) e `shadowStyle` ficam coerentes: projeto antigo com `shadow: true` ganha a sombra padrão.
const textStyle = z
  .object({
    font: z.string(),
    size: animOrNumber,
    weight: z.number(),
    color: z.string(),
    background: z.string().optional(),
    stroke: z.object({ width: z.number(), color: z.string() }).optional(),
    shadow: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']),
    lineHeight: z.number(),
    italic: z.boolean().optional(),
    maxWidth: z.number().optional(),
    padding: z.number().optional(),
    backgroundRadius: z.number().optional(),
    shadowStyle: z.object({ color: z.string(), blur: z.number(), dx: z.number(), dy: z.number() }).optional()
  })
  .transform((st) => {
    if (st.shadowStyle) return st.shadow ? st : { ...st, shadow: true }
    return st.shadow ? { ...st, shadowStyle: { ...DEFAULT_TEXT_SHADOW } } : st
  })
const textItem = z.object({
  ...itemBase,
  type: z.literal('text'),
  text: z.string(),
  style: textStyle,
  visual,
  transitionIn: transition.optional(),
  counter: z.object({ from: z.number(), to: z.number() }).optional()
})
const shapeItem = z.object({
  ...itemBase,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'arrow']),
  fill: z.string(),
  stroke: z.string(),
  strokeWidth: z.number(),
  visual,
  box: z.object({ w: z.number(), h: z.number() }).optional(),
  cornerRadius: z.number().optional(),
  spotlight: z.object({ dim: z.number() }).optional()
})
const effectRegion = z.object({ shape: z.enum(['rect', 'ellipse']), x: anim, y: anim, w: anim, h: anim, rotation: anim })
const effectItem = z.object({
  ...itemBase,
  type: z.literal('effect'),
  effect: z.enum(['blur', 'pixelate', 'solid']),
  region: effectRegion,
  strength: anim,
  feather: z.number(),
  color: z.string(),
  invert: z.boolean(),
  scope: z.enum(['below', 'track']),
  targetTrackId: z.string().optional(),
  targetMediaOnly: z.literal(true).optional(),
  // no disco a região do ancorado (espaço do conteúdo) fica em attach.region e `region` é a caixa estática do quadro
  // (toDiskProject); parseProject a devolve a `region`
  attach: z.object({ mediaItemId: z.string(), fallback: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(), region: effectRegion.optional() }).optional()
})
const annotationsItem = z.object({ ...itemBase, type: z.literal('annotations'), sessionId: z.string(), inUs: us, autoFadeMs: z.number().nonnegative().nullable().optional() })
const item = z.discriminatedUnion('type', [mediaItem, textItem, shapeItem, effectItem, annotationsItem])
/**
 * Item de um modelo de marca (brand.ts): só mídia, texto e forma, no formato do modelo em memória (os transforms do
 * schema são idempotentes nele). Efeitos e anotações não entram em modelos.
 */
export const BrandItemSchema = z.discriminatedUnion('type', [mediaItem, textItem, shapeItem]) as unknown as z.ZodType<MediaItem | TextItem | ShapeItem>

const assetSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), sessionId: z.string(), stream: z.enum(['screen', 'webcam', 'mic', 'system']) }),
  z.object({ type: z.literal('file'), path: z.string(), size: z.number(), mtimeMs: z.number() }),
  z.object({ type: z.literal('generated'), file: z.string() })
])
const asset = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(['video', 'audio', 'image']),
  source: assetSource,
  durationUs: us.nullable(),
  video: z
    .object({
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      codec: z.string(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      decodable: z.boolean(),
      gopUs: us
    })
    .optional(),
  audio: z.object({ channels: z.number(), sampleRate: z.number(), codec: z.string(), decodable: z.boolean().optional() }).optional(),
  audioTrackIndex: z.number().int().nonnegative().optional(),
  videoTrackIndex: z.number().int().nonnegative().optional(),
  proxy: z.string().optional(),
  intermediate: z.string().optional(),
  filmstrip: z.string().optional(),
  filmstripInfo: z
    .object({ frames: z.number().int().positive(), everyUs: us.positive(), tileW: z.number().int().positive(), tileH: z.number().int().positive() })
    .optional(),
  peaks: z.string().optional(),
  speech: z.string().optional(),
  loudness: z.object({ integrated: z.number(), truePeak: z.number(), lra: z.number() }).optional(),
  processedAudio: z.record(z.string(), z.string()).optional(),
  status: z.enum(['ready', 'processing', 'missing', 'error']),
  error: z.string().optional()
})
const track = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'audio']),
  name: z.string(),
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  volume: z.number(),
  role: z.enum(['voice', 'music', 'sfx', 'effects', 'captions']).optional(),
  // faixa de legendas no disco (a v1.3 recusa role 'captions'): sem `role` e com captionsV15 — o parse devolve o papel
  captionsV15: z.boolean().optional(),
  items: z.array(item)
}).transform(({ captionsV15, ...t }) => (captionsV15 && t.kind === 'video' && t.role === undefined ? { ...t, role: 'captions' as const } : t))

export const ProjectSchema: z.ZodType<Project> = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(), background: z.string() }),
  assets: z.array(asset),
  tracks: z.array(track),
  markers: z.array(z.object({ id: z.string(), tUs: us, label: z.string(), color: z.string() })),
  originSessionId: z.string().optional(),
  audioMix: z
    .object({
      enabled: z.boolean(),
      duckingDb: z.number().min(-60).max(0),
      attackMs: z.number().int().min(0).max(5000),
      releaseMs: z.number().int().min(0).max(10000),
      holdMs: z.number().int().min(0).max(5000)
    })
    .optional()
})

/**
 * Version 1; lança se a versão for maior que a suportada. Faixas de efeitos anteriores ao papel (F2 até a revisão
 * final): faixa de vídeo sem papel chamada "Efeitos"/"Efeitos N" e só com efeitos (ou vazia) ganha role 'effects'.
 * Não muda o objeto recebido.
 */
export function migrateProject(json: unknown): unknown {
  const v = (json as { version?: unknown } | null)?.version
  if (typeof v === 'number' && v > 1) throw new Error(`Versão de projeto não suportada: ${v}`)
  const tracks = (json as { tracks?: unknown } | null)?.tracks
  if (!Array.isArray(tracks)) return json
  const isLegacyFx = (t: unknown): boolean => {
    const x = t as { kind?: unknown; name?: unknown; role?: unknown; items?: unknown; captionsV15?: unknown }
    // faixa de legendas no disco (sem role, captionsV15) nunca vira de efeitos, nem vazia e chamada "Efeitos"
    return x?.kind === 'video' && x.role === undefined && x.captionsV15 !== true && typeof x.name === 'string' && /^Efeitos( \d+)?$/.test(x.name) &&
      Array.isArray(x.items) && x.items.every((i) => (i as { type?: unknown })?.type === 'effect')
  }
  if (!tracks.some(isLegacyFx)) return json
  return { ...(json as object), tracks: tracks.map((t) => (isLegacyFx(t) ? { ...(t as object), role: 'effects' } : t)) }
}

export function parseProject(json: unknown): Project {
  const r = ProjectSchema.safeParse(migrateProject(json))
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')
    throw new Error(`Projeto inválido: ${msg}`)
  }
  return fromDiskAnchors(r.data as Project)
}

/** Efeito ancorado lido do disco: a região do conteúdo (attach.region) volta a `region` (o modelo em memória). */
function fromDiskAnchors(p: Project): Project {
  const anchored = (it: Item): it is EffectItem & { attach: { region?: EffectRegion } } => it.type === 'effect' && !!(it.attach as { region?: EffectRegion } | undefined)?.region
  if (!p.tracks.some((t) => t.items.some(anchored))) return p
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      items: t.items.map((it) => {
        if (!anchored(it)) return it
        const { region, ...attach } = it.attach
        return { ...it, region: region!, attach }
      })
    }))
  }
}

/**
 * Efeito ancorado no disco. Em memória, `region` está no espaço do conteúdo do clipe (resolve.effectRegionAt a leva ao
 * quadro). A v1.3 instalada não conhece `attach` (o zod dela o descarta) e desenharia esses valores como se fossem do
 * quadro — vazamento. Por isso o disco guarda em `region` uma caixa ESTÁTICA do quadro que cobre tudo o que o build
 * novo desenha ao longo do efeito — conservativeRegion da união da região ancorada enquanto o clipe dura
 * (anchoredUnion — com a geometria do build novo e com a que a v1.3 desenha, v13Geometry: presets do disco, zoom/pop
 * como fade, sem curva) com a caixa de reserva usada fora dele (sem clipe nem caixa: o quadro inteiro; elipse ×√2; sem
 * rotação). Invertido (a região é o buraco nítido): o buraco nulo — a v1.3 esconde o quadro inteiro, nunca um buraco
 * maior que o do build novo. A região do conteúdo vai em `attach.region`; parseProject desfaz a troca e a ida e volta
 * pelo parse novo não perde nada.
 */
function diskAnchored(p: Project, fx: EffectItem, cache: UnionCache): unknown {
  const at = fx.attach!
  const m = attachedMedia(p, fx)
  const box = boxUnion(m ? diskUnion(p, fx, m, cache) : null, at.fallback ?? null)
  const r = conservativeRegion(fx, box)
  return {
    ...fx,
    region: { shape: fx.region.shape, x: { value: r.x }, y: { value: r.y }, w: { value: r.w }, h: { value: r.h }, rotation: { value: r.rotation } },
    attach: { ...at, region: fx.region }
  }
}

// Caixa do disco por efeito (o autosave grava a cada 1 s): recalculada só quando o efeito, o clipe da âncora, o asset
// dele ou o quadro mudam (anchoredUnion só lê esses quatro). Mesmos objetos (projeto imutável no renderer): acerto
// direto. O processo principal recebe o projeto pelo IPC e o parseia de novo a cada gravação (objetos novos, mesmo
// conteúdo): aí vale a chave de conteúdo (JSON do que anchoredUnion lê), bem mais barata que as duas uniões.
type UnionEntry = { fx: EffectItem; m: MediaItem; asset: Asset | undefined; canvas: Project['canvas']; key: string | null; u: Box | null }
type UnionCache = { prev: Map<string, UnionEntry>; next: Map<string, UnionEntry> }
/** Por projeto: as entradas da última gravação (efeitos apagados saem na seguinte). */
const unionCaches = new Map<string, Map<string, UnionEntry>>()
const unionKey = (p: Project, fx: EffectItem, m: MediaItem, asset: Asset | undefined): string =>
  JSON.stringify([fx.startUs, fx.durationUs, fx.region, m.startUs, m.durationUs, m.assetId, m.visual, asset?.video ?? null, p.canvas.width, p.canvas.height])
/** União da região ancorada com a geometria do build novo E com a que a v1.3 desenha (presets dela, sem curva). */
function diskUnion(p: Project, fx: EffectItem, m: MediaItem, cache: UnionCache): Box | null {
  const asset = p.assets.find((a) => a.id === m.assetId)
  const c = cache.prev.get(fx.id)
  let e: UnionEntry
  if (c && c.fx === fx && c.m === m && c.asset === asset && c.canvas === p.canvas) e = c
  else {
    const key = unionKey(p, fx, m, asset)
    const u = c && c.key === key ? c.u : boxUnion(anchoredUnion(p, fx, m), m.visual ? anchoredUnion(p, fx, { ...m, visual: v13Geometry(m.visual) }) : null)
    e = { fx, m, asset, canvas: p.canvas, key, u }
  }
  cache.next.set(fx.id, e)
  return e.u
}

type Box = { x: number; y: number; w: number; h: number }
/** Caixa que envolve as duas (null = a outra). */
function boxUnion(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return a ?? b
  const x0 = Math.min(a.x - a.w / 2, b.x - b.w / 2), y0 = Math.min(a.y - a.h / 2, b.y - b.h / 2)
  const x1 = Math.max(a.x + a.w / 2, b.x + b.w / 2), y1 = Math.max(a.y + a.h / 2, b.y + b.h / 2)
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

/** Preset gravado no disco para a v1.3: girar e desfoque → fade, quicar → deslizar de baixo; os outros, o próprio. */
export const V13_DISK_PRESET: Record<AnimPreset, AnimPreset> = {
  fade: 'fade', slideL: 'slideL', slideR: 'slideR', slideU: 'slideU', slideD: 'slideD', zoom: 'zoom', pop: 'pop', rotate: 'fade', bounce: 'slideD', blur: 'fade'
}
/** O que a v1.3 desenha: o preset do disco, com zoom e pop como fade (ela não tem a geometria deles) e sem curva. */
const v13Drawn = (a: PresetAnim): PresetAnim => {
  const d = V13_DISK_PRESET[a.preset]
  return { preset: d === 'zoom' || d === 'pop' ? 'fade' : d, durationUs: a.durationUs }
}
/** Propriedades visuais como a v1.3 as desenha (animações de entrada/saída dela). */
export function v13Geometry(v: VisualProps): VisualProps {
  const { animIn, animOut, ...rest } = v
  return { ...rest, ...(animIn ? { animIn: v13Drawn(animIn) } : {}), ...(animOut ? { animOut: v13Drawn(animOut) } : {}) }
}
/** Animação no disco: preset que a v1.3 conhece + o real em `presetV14` quando difere. */
const diskAnim = (a: PresetAnim): unknown => (V13_DISK_PRESET[a.preset] === a.preset ? a : { ...a, preset: V13_DISK_PRESET[a.preset], presetV14: a.preset })

/** Anim sem keys → número (como a v1.3 gravava); com keys fica Anim. */
const compact = (a: Anim<number>): Anim<number> | number => (a.keys && a.keys.length > 0 ? a : a.value)
function diskVisual(v: VisualProps): unknown {
  const c = v.crop, ad = v.adjust
  return {
    ...v,
    crop: { l: compact(c.l), t: compact(c.t), r: compact(c.r), b: compact(c.b) },
    ...(ad ? { adjust: { brightness: compact(ad.brightness), contrast: compact(ad.contrast), saturation: compact(ad.saturation) } } : {}),
    ...(v.radius ? { radius: compact(v.radius) } : {}),
    ...(v.animIn ? { animIn: diskAnim(v.animIn) } : {}),
    ...(v.animOut ? { animOut: diskAnim(v.animOut) } : {})
  }
}

/**
 * Forma gravada no disco (project.json e versões): as propriedades que viraram animáveis na F4 (corte, ajuste, raio,
 * tamanho do texto) voltam a número quando não têm keys. Assim a v1.3 instalada — que divide a pasta de projetos e
 * recusa (e trocaria por uma versão antiga) o que o schema dela não aceita — continua abrindo todo projeto que não usa
 * keys nessas propriedades. parseProject aceita as duas formas. Efeito ancorado: diskAnchored. Não muda o projeto recebido.
 */
export function toDiskProject(p: Project): unknown {
  const cache: UnionCache = { prev: unionCaches.get(p.id) ?? new Map(), next: new Map() }
  const item = (it: Item): unknown => {
    switch (it.type) {
      case 'media':
        return it.visual ? { ...it, visual: diskVisual(it.visual) } : it
      case 'text':
        // shadow (boolean da v1.3) coerente com os parâmetros da sombra; os campos da v1.5 a v1.3 descarta
        return { ...it, style: { ...it.style, size: compact(it.style.size), ...(it.style.shadowStyle ? { shadow: true } : {}) }, visual: diskVisual(it.visual) }
      case 'shape':
        return { ...it, visual: diskVisual(it.visual) }
      case 'effect':
        return it.attach ? diskAnchored(p, it, cache) : it
      default:
        return it
    }
  }
  // faixa de legendas: a v1.3 recusa role 'captions' — vai sem papel (para ela, uma faixa de vídeo com textos) e com
  // captionsV15, que o parse devolve a role 'captions'
  const track = (t: Track): unknown => {
    const items = t.items.map(item)
    if (t.role !== 'captions') return { ...t, items }
    const { role: _role, ...rest } = t
    return { ...rest, captionsV15: true, items }
  }
  const out = { ...p, tracks: p.tracks.map(track) }
  if (cache.next.size) unionCaches.set(p.id, cache.next)
  else unionCaches.delete(p.id)
  return out
}

/** Nome da propriedade nas mensagens (os de antes da F4 mantidos: volume, x, strength…). */
const animLabel = (pt: AnimPath): string => (pt === 'audio.volume' ? 'volume' : /^(transform|region)\./.test(pt) ? pt.split('.')[1] : pt)

/** Invariantes semânticas; devolve mensagens em português (vazio = válido). */
export function validateProject(p: Project): string[] {
  const errs: string[] = []
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const tol = frameDurUs(p.canvas.fps)
  const captions = p.tracks.filter((t) => t.role === 'captions')
  if (captions.length > 1) errs.push('Há mais de uma faixa de legendas')
  for (const tr of captions) {
    if (tr.kind !== 'video') errs.push(`Faixa "${tr.name}": a faixa de legendas precisa ser de vídeo`)
    for (const it of tr.items) if (it.type !== 'text') errs.push(`Faixa "${tr.name}", item ${it.id}: a faixa de legendas só aceita textos`)
  }
  for (const tr of p.tracks) {
    // compara com o maior fim acumulado (um item longo pode cobrir vários seguintes)
    const sorted = [...tr.items].sort((a, b) => a.startUs - b.startUs)
    let maxEndItem: Item | null = null
    for (const cur of sorted) {
      if (maxEndItem && cur.startUs < itemEndUs(maxEndItem)) errs.push(`Faixa "${tr.name}": item ${cur.id} sobrepõe o item ${maxEndItem.id}`)
      if (!maxEndItem || itemEndUs(cur) > itemEndUs(maxEndItem)) maxEndItem = cur
    }
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i]
      const tin = transitionInOf(b)
      if (!tin) continue
      const tag = `Faixa "${tr.name}", item ${b.id}`
      const a = sorted[i - 1]
      const d = tin.durationUs
      if (!transitionPairOk(tr, a, b)) errs.push(`${tag}: transição sem clipe anterior encostado e elegível na mesma faixa de vídeo`)
      else if (d < MIN_TRANSITION_US) errs.push(`${tag}: transição menor que o mínimo (${MIN_TRANSITION_US} µs)`)
      else if (d > maxTransitionUs(a, b)) errs.push(`${tag}: transição maior que metade do clipe mais curto`)
    }
    for (const it of tr.items) {
      const tag = `Faixa "${tr.name}", item ${it.id}`
      if (it.durationUs < MIN_ITEM_US) errs.push(`${tag}: duração menor que o mínimo (${MIN_ITEM_US} µs)`)
      if (it.type === 'media') {
        if (it.speed < MIN_SPEED || it.speed > MAX_SPEED) errs.push(`${tag}: velocidade fora do intervalo ${MIN_SPEED}–${MAX_SPEED}`)
        const a = assets.get(it.assetId)
        if (!a) errs.push(`${tag}: asset ${it.assetId} não existe`)
        else if (a.durationUs != null && a.kind !== 'image' && !it.freeze && it.inUs + it.durationUs * it.speed > a.durationUs + tol) {
          errs.push(`${tag}: trecho de origem excede a duração do asset`)
        }
        if (it.visual && tr.kind !== 'video') errs.push(`${tag}: item visual só pode ficar em faixa de vídeo`)
      } else if (tr.kind !== 'video') {
        errs.push(`${tag}: item visual só pode ficar em faixa de vídeo`)
      }
      // faixas dos campos da v1.5 (fora do zod: recusar no parse perderia o projeto inteiro)
      const out = (name: string, v: number | undefined, lo: number, hi: number): void => {
        if (v !== undefined && !(v >= lo && v <= hi)) errs.push(`${tag}: ${name} fora do intervalo ${lo}–${hi}`)
      }
      if (it.type === 'text') {
        const st = it.style
        out('maxWidth', st.maxWidth, 0.01, 1)
        out('padding', st.padding, 0, 10)
        out('backgroundRadius', st.backgroundRadius, 0, 10)
        out('sombra (desfoque)', st.shadowStyle?.blur, 0, 10)
      } else if (it.type === 'shape') {
        out('cornerRadius', it.cornerRadius, 0, 0.5)
        out('spotlight.dim', it.spotlight?.dim, 0, 1)
        out('box.w', it.box?.w, 0.001, 10)
        out('box.h', it.box?.h, 0.001, 10)
      }
      for (const [pt, an] of itemAnimEntries(it)) {
        const name = animLabel(pt)
        const keys = an.keys ?? []
        for (let i = 0; i < keys.length; i++) {
          // tempo repetido também é inválido: evalAnim divide por (k1.tUs − k0.tUs)
          if (i > 0 && keys[i].tUs <= keys[i - 1].tUs) errs.push(`${tag}: keyframes de ${name} fora de ordem ou com tempo repetido`)
          if (keys[i].tUs < 0 || keys[i].tUs > it.durationUs) errs.push(`${tag}: keyframe de ${name} fora de [0, duração]`)
        }
      }
    }
  }
  return errs
}
