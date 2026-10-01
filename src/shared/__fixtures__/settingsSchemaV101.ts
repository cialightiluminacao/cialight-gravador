// Cópia literal do schema de settings da v1.0.1 publicada (src/shared/schemas.ts na tag v1.0.1).
// O app instalado divide o settings.json com o build novo: o arquivo gravado aqui tem de continuar válido lá.
import { z } from 'zod'

export const settingsInputSchemaV101 = z.looseObject({
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
      available: z.array(z.enum(['h264_nvenc', 'h264_qsv', 'h264_mf', 'libx264'])),
      preferred: z.enum(['h264_nvenc', 'h264_qsv', 'h264_mf', 'libx264'])
    })
    .nullable()
    .optional(),
  lastSource: z.object({ kind: z.enum(['screen', 'window']), id: z.string(), name: z.string() }).nullable().optional(),
  barPositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional()
})
