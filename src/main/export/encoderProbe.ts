import { app } from 'electron'
import { execFile } from 'child_process'
import type { EncoderProbe, HwEncoder } from '@shared/types'
import { PROBE_ARGS_VERSION, usableCachedProbe, v1ProbeProjection } from '@shared/encoderCache'
import { PRESET_ORDER, PRESETS } from '@shared/presets/presets'
import { presetVideoCodecArgs } from '@shared/presets/ffmpegArgs'
import { ingestVideoCodecArgs } from '../media/proxyPolicy'
import { ffmpegPath } from './ffmpegPath'
import { getSettings, setSettings } from '../settings/settingsStore'
import { log } from '../log'
import { singleFlight } from './singleFlight'

// Detecta encoders H.264 de hardware por encode-teste real (a listagem
// `-encoders` só diz o que foi compilado), com os MESMOS argumentos da exportação v1 (cada preset) e do
// proxy/intermediário do editor: combinação que o driver recusa nunca entra como disponível. Ordem por vendor.
// Cache em settings.encoderProbeV2 por chave de GPU/driver; settings.lastEncoderProbe recebe só a projeção
// sem AMF, que a v1.0.1 instalada (mesmo settings.json, schema sem h264_amf) consegue ler.

export const PROBE_CANDIDATES: HwEncoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']

export function gpuVendorOrder(gpus: { vendor: string }[]): HwEncoder[] {
  const v = gpus.map((g) => g.vendor.toLowerCase()).join(' ')
  const hasNvidia = /nvidia|0x10de/.test(v)
  const hasIntel = /intel|0x8086/.test(v)
  const hasAmd = /\bamd\b|advanced micro|radeon|\bati\b|0x1002/.test(v)
  // AMF (AMD) entra em todas as ordens: primeiro na AMD, logo depois do QSV nas outras
  if (hasNvidia) return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264']
  if (hasIntel) return ['h264_qsv', 'h264_amf', 'h264_mf', 'h264_nvenc', 'libx264']
  if (hasAmd) return ['h264_amf', 'h264_mf', 'h264_qsv', 'h264_nvenc', 'libx264']
  return ['h264_mf', 'h264_qsv', 'h264_amf', 'h264_nvenc', 'libx264']
}

interface GpuDeviceInfo {
  vendorId?: number
  deviceId?: number
  driverVersion?: string
  vendorString?: string
  deviceString?: string
  active?: boolean
}

async function gpuInfo(): Promise<{ vendors: { vendor: string }[]; key: string }> {
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: GpuDeviceInfo[] }
    const devs = info.gpuDevice ?? []
    const vendorName = (d: GpuDeviceInfo): string => {
      if (d.vendorString) return d.vendorString
      if (d.vendorId === 0x10de) return 'NVIDIA'
      if (d.vendorId === 0x8086) return 'Intel'
      if (d.vendorId === 0x1002) return 'AMD'
      return `0x${(d.vendorId ?? 0).toString(16)}`
    }
    // GPU ativa primeiro (é a que o Chromium usa); as demais em seguida
    const sorted = [...devs].sort((a, b) => Number(!!b.active) - Number(!!a.active))
    const vendors = sorted.map((d) => ({ vendor: vendorName(d) }))
    const key = sorted.map((d) => `${vendorName(d)}:${d.deviceId ?? 0}:${d.driverVersion ?? ''}`).join('|') || 'unknown'
    return { vendors, key }
  } catch (e) {
    log.warn('getGPUInfo falhou', e)
    return { vendors: [], key: 'unknown' }
  }
}

/**
 * Encodes-teste (30 quadros 256×256 → null) com o bloco de vídeo real de cada preset reencodado da exportação
 * v1 e do proxy/intermediário (sem repetição). O vídeo entra em yuv420p como no filtro da exportação.
 */
export function validationArgSets(enc: HwEncoder): string[][] {
  const blocks = [
    ...PRESET_ORDER.filter((id) => !PRESETS[id].copyVideo).map((id) => presetVideoCodecArgs(PRESETS[id], enc, 30)),
    ingestVideoCodecArgs(enc, 'proxy'),
    ingestVideoCodecArgs(enc, 'intermediate')
  ]
  const seen = new Set<string>()
  const out: string[][] = []
  for (const b of blocks) {
    const key = b.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=256x256:r=30', '-frames:v', '30', '-vf', 'format=yuv420p', ...b, '-f', 'null', '-'])
  }
  return out
}

function runOnce(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve(err ? String(stderr).split('\n').filter(Boolean).slice(-2).join(' | ') || err.message : null)
    })
  })
}

/** O encoder passa em todos os conjuntos de argumentos reais? Para no primeiro que falhar. */
export async function testEncoder(enc: HwEncoder, timeoutMs = 20000): Promise<boolean> {
  for (const args of validationArgSets(enc)) {
    const err = await runOnce(args, timeoutMs)
    if (err !== null) {
      log.info(`encoder ${enc}: indisponível com ${args.slice(args.indexOf('-c:v'), -3).join(' ')} (${err})`)
      return false
    }
  }
  log.info(`encoder ${enc}: OK (${validationArgSets(enc).length} conjuntos de argumentos)`)
  return true
}

/** Probe em cache (encoderProbeV2), sem disparar o probe. */
export function cachedEncoderProbe(): EncoderProbe | null {
  return usableCachedProbe(getSettings(), null)
}

/**
 * Probe (ou o cache, sem `force`). Uma execução por vez: a exportação v1 que chega durante o probe da
 * manutenção adiada reaproveita o mesmo, em vez de rodar um segundo encode-teste em paralelo.
 */
export const probeEncoders: (force?: boolean) => Promise<EncoderProbe> = singleFlight(runProbe)

async function runProbe(force: boolean): Promise<EncoderProbe> {
  const { vendors, key } = await gpuInfo()
  const cached = usableCachedProbe(getSettings(), key)
  if (!force && cached) return cached
  const order = gpuVendorOrder(vendors)
  const available: HwEncoder[] = []
  for (const enc of order) {
    if (enc === 'libx264') {
      available.push('libx264')
      continue
    }
    if (!PROBE_CANDIDATES.includes(enc)) continue
    if (await testEncoder(enc)) available.push(enc)
  }
  const preferred = order.find((e) => available.includes(e)) ?? 'libx264'
  const probe: EncoderProbe = { gpuKey: key, probedAt: new Date().toISOString(), available, preferred, argsVersion: PROBE_ARGS_VERSION }
  setSettings({ encoderProbeV2: probe, lastEncoderProbe: v1ProbeProjection(probe) })
  log.info(`probe de encoders: ${JSON.stringify(probe)}`)
  return probe
}
