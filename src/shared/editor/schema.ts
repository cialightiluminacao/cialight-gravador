import { z } from 'zod'
import { frameDurUs, itemEndUs } from './time'
import { MIN_ITEM_US, MAX_SPEED, MIN_SPEED } from './project'
import type { Anim, EffectItem, EffectRegion, Item, Project, VisualProps } from './project'
import { anchoredUnion } from './attachment'
import { attachedMedia } from './resolve'
import { conservativeRegion } from './contentPose'
import { itemAnimEntries, type AnimPath } from './animPaths'

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

const animPreset = z.enum(['fade', 'slideL', 'slideR', 'slideU', 'slideD', 'zoom', 'pop'])
const presetAnim = z.object({ preset: animPreset, durationUs: us })
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
const textStyle = z.object({
  font: z.string(),
  size: animOrNumber,
  weight: z.number(),
  color: z.string(),
  background: z.string().optional(),
  stroke: z.object({ width: z.number(), color: z.string() }).optional(),
  shadow: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']),
  lineHeight: z.number()
})
const textItem = z.object({
  ...itemBase,
  type: z.literal('text'),
  text: z.string(),
  style: textStyle,
  visual,
  transitionIn: transition.optional()
})
const shapeItem = z.object({
  ...itemBase,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'arrow']),
  fill: z.string(),
  stroke: z.string(),
  strokeWidth: z.number(),
  visual
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
  // no disco a região do ancorado (espaço do conteúdo) fica em attach.region e `region` é a caixa estática do quadro
  // (toDiskProject); parseProject a devolve a `region`
  attach: z.object({ mediaItemId: z.string(), fallback: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(), region: effectRegion.optional() }).optional()
})
const annotationsItem = z.object({ ...itemBase, type: z.literal('annotations'), sessionId: z.string(), inUs: us, autoFadeMs: z.number().nonnegative().nullable().optional() })
const item = z.discriminatedUnion('type', [mediaItem, textItem, shapeItem, effectItem, annotationsItem])

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
  role: z.enum(['voice', 'music', 'sfx', 'effects']).optional(),
  items: z.array(item)
})

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
    const x = t as { kind?: unknown; name?: unknown; role?: unknown; items?: unknown }
    return x?.kind === 'video' && x.role === undefined && typeof x.name === 'string' && /^Efeitos( \d+)?$/.test(x.name) &&
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
 * (anchoredUnion) com a caixa de reserva usada fora dele (sem clipe nem caixa: o quadro inteiro; elipse ×√2; sem
 * rotação). Invertido (a região é o buraco nítido): o buraco nulo — a v1.3 esconde o quadro inteiro, nunca um buraco
 * maior que o do build novo. A região do conteúdo vai em `attach.region`; parseProject desfaz a troca e a ida e volta
 * pelo parse novo não perde nada.
 */
function diskAnchored(p: Project, fx: EffectItem): unknown {
  const at = fx.attach!
  const m = attachedMedia(p, fx)
  const u = m ? anchoredUnion(p, fx, m) : null
  const f = at.fallback
  const box = u && f
    ? ((x0, y0, x1, y1) => ({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }))(Math.min(u.x - u.w / 2, f.x - f.w / 2), Math.min(u.y - u.h / 2, f.y - f.h / 2), Math.max(u.x + u.w / 2, f.x + f.w / 2), Math.max(u.y + u.h / 2, f.y + f.h / 2))
    : (u ?? f ?? null)
  const r = conservativeRegion(fx, box)
  return {
    ...fx,
    region: { shape: fx.region.shape, x: { value: r.x }, y: { value: r.y }, w: { value: r.w }, h: { value: r.h }, rotation: { value: r.rotation } },
    attach: { ...at, region: fx.region }
  }
}

/** Anim sem keys → número (como a v1.3 gravava); com keys fica Anim. */
const compact = (a: Anim<number>): Anim<number> | number => (a.keys && a.keys.length > 0 ? a : a.value)
function diskVisual(v: VisualProps): unknown {
  const c = v.crop, ad = v.adjust
  return {
    ...v,
    crop: { l: compact(c.l), t: compact(c.t), r: compact(c.r), b: compact(c.b) },
    ...(ad ? { adjust: { brightness: compact(ad.brightness), contrast: compact(ad.contrast), saturation: compact(ad.saturation) } } : {}),
    ...(v.radius ? { radius: compact(v.radius) } : {})
  }
}

/**
 * Forma gravada no disco (project.json e versões): as propriedades que viraram animáveis na F4 (corte, ajuste, raio,
 * tamanho do texto) voltam a número quando não têm keys. Assim a v1.3 instalada — que divide a pasta de projetos e
 * recusa (e trocaria por uma versão antiga) o que o schema dela não aceita — continua abrindo todo projeto que não usa
 * keys nessas propriedades. parseProject aceita as duas formas. Efeito ancorado: diskAnchored. Não muda o projeto recebido.
 */
export function toDiskProject(p: Project): unknown {
  const item = (it: Item): unknown => {
    switch (it.type) {
      case 'media':
        return it.visual ? { ...it, visual: diskVisual(it.visual) } : it
      case 'text':
        return { ...it, style: { ...it.style, size: compact(it.style.size) }, visual: diskVisual(it.visual) }
      case 'shape':
        return { ...it, visual: diskVisual(it.visual) }
      case 'effect':
        return it.attach ? diskAnchored(p, it) : it
      default:
        return it
    }
  }
  return { ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map(item) })) }
}

/** Nome da propriedade nas mensagens (os de antes da F4 mantidos: volume, x, strength…). */
const animLabel = (pt: AnimPath): string => (pt === 'audio.volume' ? 'volume' : /^(transform|region)\./.test(pt) ? pt.split('.')[1] : pt)

/** Invariantes semânticas; devolve mensagens em português (vazio = válido). */
export function validateProject(p: Project): string[] {
  const errs: string[] = []
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const tol = frameDurUs(p.canvas.fps)
  for (const tr of p.tracks) {
    // compara com o maior fim acumulado (um item longo pode cobrir vários seguintes)
    const sorted = [...tr.items].sort((a, b) => a.startUs - b.startUs)
    let maxEndItem: Item | null = null
    for (const cur of sorted) {
      if (maxEndItem && cur.startUs < itemEndUs(maxEndItem)) errs.push(`Faixa "${tr.name}": item ${cur.id} sobrepõe o item ${maxEndItem.id}`)
      if (!maxEndItem || itemEndUs(cur) > itemEndUs(maxEndItem)) maxEndItem = cur
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
