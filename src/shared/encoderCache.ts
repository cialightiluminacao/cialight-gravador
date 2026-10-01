import type { EncoderProbe, Settings } from './types'

// Cache do probe de encoders no settings.json, que a v1.0.1 instalada também lê (schema sem h264_amf):
// o probe completo fica em encoderProbeV2; lastEncoderProbe recebe só a projeção sem AMF. Puro.

/** Projeção para o lastEncoderProbe da v1.0.1: sem h264_amf; preferido = o primeiro não-AMF. */
export function v1ProbeProjection(p: EncoderProbe): EncoderProbe {
  const available = p.available.filter((e) => e !== 'h264_amf')
  const preferred = p.preferred !== 'h264_amf' ? p.preferred : (available.find((e) => e !== 'libx264') ?? available[0] ?? 'libx264')
  return { ...p, available: available.length ? available : ['libx264'], preferred }
}

/** Cache utilizável: só o encoderProbeV2 (da mesma GPU, se gpuKey dada). Sem ele — instalação antiga — refaz o probe uma vez. */
export function usableCachedProbe(s: Pick<Settings, 'encoderProbeV2'>, gpuKey: string | null): EncoderProbe | null {
  const c = s.encoderProbeV2
  if (!c || c.available.length === 0) return null
  return gpuKey === null || c.gpuKey === gpuKey ? c : null
}
