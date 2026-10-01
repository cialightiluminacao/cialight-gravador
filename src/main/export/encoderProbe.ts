import { app } from 'electron'
import { execFile } from 'child_process'
import type { EncoderProbe, HwEncoder } from '@shared/types'
import { usableCachedProbe, v1ProbeProjection } from '@shared/encoderCache'
import { ffmpegPath } from './ffmpegPath'
import { getSettings, setSettings } from '../settings/settingsStore'
import { log } from '../log'

// Detecta encoders H.264 de hardware por encode-teste real (a listagem
// `-encoders` só diz o que foi compilado). Ordem por vendor da GPU ativa.
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

export function testEncoder(enc: HwEncoder, timeoutMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=gray:s=256x256:r=30', '-frames:v', '8', '-c:v', enc, '-f', 'null', '-']
    execFile(ffmpegPath(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        log.info(`encoder ${enc}: indisponível (${String(stderr).split('\n').filter(Boolean).slice(-2).join(' | ')})`)
        resolve(false)
      } else {
        log.info(`encoder ${enc}: OK`)
        resolve(true)
      }
    })
  })
}

/** Probe em cache (encoderProbeV2), sem disparar o probe. */
export function cachedEncoderProbe(): EncoderProbe | null {
  return usableCachedProbe(getSettings(), null)
}

export async function probeEncoders(force = false): Promise<EncoderProbe> {
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
  const probe: EncoderProbe = { gpuKey: key, probedAt: new Date().toISOString(), available, preferred }
  setSettings({ encoderProbeV2: probe, lastEncoderProbe: v1ProbeProjection(probe) })
  log.info(`probe de encoders: ${JSON.stringify(probe)}`)
  return probe
}
