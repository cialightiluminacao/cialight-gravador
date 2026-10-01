import { z } from 'zod'
import { DEFAULT_SETTINGS } from './defaults'
import type { Session, Settings } from './types'

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const pipKeyframeSchema = z.object({
  tMs: z.number(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  shape: z.enum(['circle', 'rounded']),
  visible: z.boolean()
})
const strokeSchema = z.object({
  id: z.string(),
  tMs: z.number(),
  tool: z.enum(['pen', 'line', 'arrow']),
  points: z.array(z.object({ x: z.number(), y: z.number(), tMs: z.number() })),
  color: z.string(),
  width: z.number(),
  erasedAtMs: z.number().optional()
})

export const SessionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string(),
  state: z.enum(['recording', 'stopped', 'finalized', 'aborted']),
  source: z.object({
    kind: z.enum(['screen', 'window']),
    id: z.string(),
    name: z.string(),
    displayId: z.string().optional(),
    bounds: rectSchema,
    scaleFactor: z.number()
  }),
  video: z.object({ width: z.number(), height: z.number(), fps: z.number(), codec: z.string(), bitrate: z.number() }),
  webcam: z.object({ deviceId: z.string(), label: z.string(), width: z.number(), height: z.number(), mirrored: z.boolean() }).optional(),
  mic: z
    .object({ deviceId: z.string(), label: z.string(), echoCancellation: z.boolean(), noiseSuppression: z.boolean(), autoGainControl: z.boolean() })
    .optional(),
  systemAudio: z.boolean(),
  tracks: z.object({
    screen: z.literal(0),
    webcam: z.literal(1).optional(),
    mic: z.union([z.literal(0), z.literal(1)]).optional(),
    system: z.union([z.literal(0), z.literal(1)]).optional()
  }),
  durationMs: z.number().optional(),
  pauses: z.array(z.object({ startMs: z.number(), endMs: z.number() })),
  pip: z.array(pipKeyframeSchema),
  strokes: z.array(strokeSchema),
  clearEvents: z.array(z.object({ tMs: z.number() })),
  markers: z.array(z.object({ tMs: z.number(), label: z.string().optional() })),
  engine: z.enum(['webcodecs', 'mediarecorder']),
  files: z.object({
    rec: z.string(),
    proxy: z.string().optional(),
    webcam: z.string().optional(),
    thumbs: z.string().optional(),
    waveform: z.string().optional(),
    fallback: z
      .object({ screen: z.string(), webcam: z.string().optional(), mic: z.string().optional(), system: z.string().optional() })
      .optional()
  }),
  bytes: z.number().optional()
})

export function parseSession(raw: unknown): Session {
  return SessionSchema.parse(raw) as Session
}

/** Schema "frouxo": cada campo é opcional e cai no default; campos desconhecidos são ignorados. */
const settingsInputSchema = z.looseObject({
  version: z.number().optional(),
  devices: z
    .object({
      cameraId: z.string().nullable().optional(),
      micId: z.string().nullable().optional(),
      cameraOn: z.boolean().optional(),
      micOn: z.boolean().optional(),
      systemAudioOn: z.boolean().optional(),
      micMode: z.enum(['headset', 'speakers']).optional()
    })
    .optional(),
  quality: z.enum(['720p', '1080p', '1440p', 'native']).optional(),
  fps: z.union([z.literal(30), z.literal(60)]).optional(),
  countdownSec: z.union([z.literal(0), z.literal(3), z.literal(5)]).optional(),
  startSound: z.boolean().optional(),
  pip: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      shape: z.enum(['circle', 'rounded']),
      mirrored: z.boolean()
    })
    .partial()
    .optional(),
  hotkeys: z.record(z.string(), z.string().nullable()).optional(),
  outputDir: z.string().nullable().optional(),
  rawDir: z.string().nullable().optional(),
  protectWindows: z.boolean().optional(),
  clickHighlight: z.boolean().optional(),
  annotations: z.object({ color: z.string(), width: z.number(), autoFadeSec: z.number().nullable() }).partial().optional(),
  rawRetentionDays: z.number().nullable().optional(),
  lastEncoderProbe: z
    .object({
      gpuKey: z.string(),
      probedAt: z.string(),
      available: z.array(z.enum(['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264'])),
      preferred: z.enum(['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264'])
    })
    .nullable()
    .optional()
    // cache de probe ilegível (ex.: encoder desconhecido) só refaz o probe; não derruba as outras configurações
    .catch(null),
  lastSource: z.object({ kind: z.enum(['screen', 'window']), id: z.string(), name: z.string() }).nullable().optional(),
  barPositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional()
})

/** Aplica defaults e migrações. Se o JSON inteiro for inválido, volta ao padrão. */
export function parseSettings(raw: unknown): Settings {
  const parsed = settingsInputSchema.safeParse(raw ?? {})
  if (!parsed.success) return structuredClone(DEFAULT_SETTINGS)
  const s = parsed.data
  const d = DEFAULT_SETTINGS
  const hotkeys: Settings['hotkeys'] = { ...d.hotkeys }
  for (const key of Object.keys(d.hotkeys) as (keyof Settings['hotkeys'])[]) {
    if (s.hotkeys && key in s.hotkeys) hotkeys[key] = s.hotkeys[key] ?? null
  }
  return {
    version: 1,
    devices: { ...d.devices, ...(s.devices ?? {}) },
    quality: s.quality ?? d.quality,
    fps: s.fps ?? d.fps,
    countdownSec: s.countdownSec ?? d.countdownSec,
    startSound: s.startSound ?? d.startSound,
    pip: { ...d.pip, ...(s.pip ?? {}) },
    hotkeys,
    outputDir: s.outputDir ?? d.outputDir,
    rawDir: s.rawDir ?? d.rawDir,
    protectWindows: s.protectWindows ?? d.protectWindows,
    clickHighlight: s.clickHighlight ?? d.clickHighlight,
    annotations: { ...d.annotations, ...(s.annotations ?? {}) },
    rawRetentionDays: s.rawRetentionDays === undefined ? d.rawRetentionDays : s.rawRetentionDays,
    lastEncoderProbe: s.lastEncoderProbe ?? null,
    lastSource: s.lastSource ?? null,
    barPositions: s.barPositions ?? {}
  }
}

export const ExportOptionsSchema = z.object({
  presetId: z.enum(['small', 'high', 'max', 'separate', 'cutOnly']),
  trimStartMs: z.number().min(0),
  trimEndMs: z.number().min(0).nullable(),
  includeWebcam: z.boolean(),
  includeAnnotations: z.boolean(),
  audioMode: z.enum(['mix', 'micOnly', 'systemOnly', 'separate']),
  micOffsetMs: z.number(),
  targetSizeMB: z.union([z.literal(64), z.literal(20)]).nullable(),
  reels: z.boolean(),
  outputDir: z.string(),
  fileName: z.string().min(1),
  pipOverride: z.array(pipKeyframeSchema).nullable()
})
