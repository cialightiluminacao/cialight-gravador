import type { HwEncoder } from '@shared/types'

// Encoder que falha de verdade na hora (driver, sessão de hardware ocupada, combinação recusada): tenta o
// próximo da cadeia (encoderFallbackChain: preferido → outros disponíveis → libx264). Erros que não são do
// encoder (cancelamento, disco cheio) não trocam de encoder.

export async function runWithEncoderFallback<T>(
  chain: HwEncoder[],
  attempt: (encoder: HwEncoder) => Promise<T>,
  opts: { retryable: (e: unknown) => boolean; onFallback?: (from: HwEncoder, to: HwEncoder, error: unknown) => void }
): Promise<{ value: T; encoder: HwEncoder }> {
  let lastError: unknown = new Error('nenhum encoder para tentar')
  for (let i = 0; i < chain.length; i++) {
    const enc = chain[i]
    try {
      return { value: await attempt(enc), encoder: enc }
    } catch (e) {
      lastError = e
      const next = chain[i + 1]
      if (!next || !opts.retryable(e)) throw e
      opts.onFallback?.(enc, next, e)
    }
  }
  throw lastError
}
