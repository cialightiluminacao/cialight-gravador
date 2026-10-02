// Detecção do HEVC para a exportação (renderer). O HEVC do Chromium só codifica por hardware (spike §4): o
// diálogo só oferece HEVC quando o mediabunny E o VideoEncoder (prefer-hardware) confirmam a configuração
// exata (resolução e fps de saída). Resultado em cache por (w, h, fps) — a pergunta ao driver é lenta.
import { canEncodeVideo } from 'mediabunny'
import { hevcCodecString } from '@/engine/encoderSupport'

const cache = new Map<string, Promise<boolean>>()

/** Bitrate representativo da pergunta (o nível do codec string já cobre a resolução/fps). */
const PROBE_BPS = 10_000_000

async function probe(width: number, height: number, fps: number): Promise<boolean> {
  try {
    if (typeof VideoEncoder === 'undefined') return false
    if (!(await canEncodeVideo('hevc', { width, height, hardwareAcceleration: 'prefer-hardware' }))) return false
    const r = await VideoEncoder.isConfigSupported({ codec: hevcCodecString(width, height, fps), width, height, framerate: fps, bitrate: PROBE_BPS, hardwareAcceleration: 'prefer-hardware' })
    return r.supported === true
  } catch {
    return false
  }
}

/** Este computador codifica HEVC por hardware em (w×h @ fps)? Nunca rejeita; falha = false. */
export function probeHevc(width: number, height: number, fps: number): Promise<boolean> {
  const key = `${width}x${height}@${fps}`
  let p = cache.get(key)
  if (!p) {
    p = probe(width, height, fps)
    cache.set(key, p)
  }
  return p
}
