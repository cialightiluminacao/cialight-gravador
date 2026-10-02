// Cópia literal do schema de projeto da v1.3 publicada (src/shared/editor/schema.ts no commit e7cc387, só a parte
// zod + migrateProject/parseProject). O app instalado v1.3 abre os mesmos projetos que o build novo grava: o que
// toDiskProject produz sem os recursos novos (keys em corte/ajuste/raio/tamanho do texto) tem de continuar válido lá.
import { z } from 'zod'

const us = z.number().int()
const ease = z.union([
  z.enum(['linear', 'hold', 'in', 'out', 'inOut']),
  z.object({ bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]) })
])
const anim = z.object({
  value: z.number(),
  keys: z.array(z.object({ tUs: us, value: z.number(), ease })).optional()
})

const animPreset = z.enum(['fade', 'slideL', 'slideR', 'slideU', 'slideD', 'zoom', 'pop'])
const presetAnim = z.object({ preset: animPreset, durationUs: us })
const transform = z.object({ x: anim, y: anim, scale: anim, rotation: anim, opacity: anim })
const visual = z.object({
  transform,
  crop: z.object({ l: z.number(), t: z.number(), r: z.number(), b: z.number() }),
  fit: z.enum(['contain', 'cover', 'fill']),
  fadeInUs: us,
  fadeOutUs: us,
  animIn: presetAnim.optional(),
  animOut: presetAnim.optional(),
  adjust: z.object({ brightness: z.number(), contrast: z.number(), saturation: z.number() }).optional(),
  shape: z.enum(['rect', 'rounded', 'circle']).optional(),
  radius: z.number().optional(),
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
  size: z.number(),
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
const effectItem = z.object({
  ...itemBase,
  type: z.literal('effect'),
  effect: z.enum(['blur', 'pixelate', 'solid']),
  region: z.object({ shape: z.enum(['rect', 'ellipse']), x: anim, y: anim, w: anim, h: anim, rotation: anim }),
  strength: anim,
  feather: z.number(),
  color: z.string(),
  invert: z.boolean(),
  scope: z.enum(['below', 'track']),
  targetTrackId: z.string().optional()
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

export const ProjectSchemaV13 = z.object({
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

export function migrateProjectV13(json: unknown): unknown {
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

/** parseProject da v1.3 (sem lançar): sucesso = a v1.3 abre o arquivo. */
export function parseProjectV13(json: unknown): ReturnType<typeof ProjectSchemaV13.safeParse> {
  return ProjectSchemaV13.safeParse(migrateProjectV13(json))
}
