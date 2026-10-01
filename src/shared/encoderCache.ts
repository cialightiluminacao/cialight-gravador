import type { EncoderProbe, HwEncoder, Settings } from './types'

// Cache do probe de encoders no settings.json, que a v1.0.1 instalada também lê (schema sem h264_amf):
// o probe completo fica em encoderProbeV2; lastEncoderProbe recebe só a projeção sem AMF. Puro.

/**
 * Versão da validação do probe: 1 = cada encoder passa por um encode-teste com os argumentos reais da
 * exportação v1 (todos os presets) e do proxy/intermediário. Probe gravado antes disso é refeito uma vez.
 */
export const PROBE_ARGS_VERSION = 1

/** Projeção para o lastEncoderProbe da v1.0.1: sem h264_amf nem campos novos; preferido = o primeiro não-AMF. */
export function v1ProbeProjection(p: EncoderProbe): EncoderProbe {
  const available = p.available.filter((e) => e !== 'h264_amf')
  const preferred = p.preferred !== 'h264_amf' ? p.preferred : (available.find((e) => e !== 'libx264') ?? available[0] ?? 'libx264')
  return { gpuKey: p.gpuKey, probedAt: p.probedAt, available: available.length ? available : ['libx264'], preferred }
}

/**
 * Cache utilizável: só o encoderProbeV2 validado com os argumentos reais (argsVersion atual) e da mesma GPU,
 * se gpuKey dada. Sem ele — instalação antiga ou probe antigo — refaz o probe uma vez.
 */
export function usableCachedProbe(s: Pick<Settings, 'encoderProbeV2'>, gpuKey: string | null): EncoderProbe | null {
  const c = s.encoderProbeV2
  if (!c || c.available.length === 0 || c.argsVersion !== PROBE_ARGS_VERSION) return null
  return gpuKey === null || c.gpuKey === gpuKey ? c : null
}

/**
 * Ordem de tentativa quando um encoder falha de verdade (driver, sessão de hardware ocupada…): o pedido
 * (ou o preferido do probe), depois os outros disponíveis na ordem do probe e, por último, libx264.
 */
export function encoderFallbackChain(probe: EncoderProbe | null, first?: HwEncoder): HwEncoder[] {
  const start = first ?? probe?.preferred ?? 'libx264'
  const out: HwEncoder[] = [start]
  for (const e of [...(probe?.available ?? []), 'libx264' as const]) if (!out.includes(e)) out.push(e)
  return out
}
