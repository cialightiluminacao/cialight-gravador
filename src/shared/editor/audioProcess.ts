// Pré-processamento de voz (redução de ruído e normalização de loudness) — parte pura: chave de cache, caminho do
// arquivo gerado e a chave da fonte que o mixer lê. O original nunca é alterado: cada combinação de parâmetros vira
// um arquivo de áudio próprio em generated/<assetId>.audio-<chave>.m4a; Asset.processedAudio lista as chaves prontas.

export interface AudioProcessOpts { denoise: boolean; normalize: boolean }

/** Modelo RNNoise (somnolent-hogwash, "speech" em ambiente de gravação) — arquivo em resources/models/rnnoise/. */
export const DENOISE_MODEL = { id: 'sh', file: 'sh.rnnn' } as const
/** Alvo da normalização (EBU R128): −16 LUFS integrado, true peak −1,5 dBTP, LRA 11 LU. */
export const LOUDNORM_TARGET = { i: -16, tp: -1.5, lra: 11 } as const

const DN = `dn-${DENOISE_MODEL.id}`
const LN = `ln-i${-LOUDNORM_TARGET.i}-tp${-LOUDNORM_TARGET.tp}`

/**
 * Chave de cache por parâmetros (com o asset, identifica o arquivo gerado). Mudar o modelo ou o alvo muda a chave:
 * as chaves antigas deixam de ser reconhecidas e o áudio é reprocessado. null = nada a processar.
 */
export function audioProcessKey(o: AudioProcessOpts): string | null {
  const parts = [o.denoise ? DN : null, o.normalize ? LN : null].filter((x): x is string => !!x)
  return parts.length ? parts.join('_') : null
}

/** Flags de uma chave dos parâmetros atuais; null se a chave não é (mais) válida. */
export function parseAudioProcessKey(key: string): AudioProcessOpts | null {
  for (const denoise of [false, true]) {
    for (const normalize of [false, true]) {
      if (audioProcessKey({ denoise, normalize }) === key) return { denoise, normalize }
    }
  }
  return null
}

export const isAudioProcessKey = (key: string): boolean => parseAudioProcessKey(key) !== null

/** Arquivo gerado (relativo à pasta do projeto). */
export const processedAudioRel = (assetId: string, key: string): string => `generated/${assetId}.audio-${key}.m4a`

/** Separador da chave de fonte do mixer (ids de asset não usam '~'). */
const SEP = '~'

/** Fonte de PCM do mixer: o original do asset (assetId) ou uma versão processada (assetId~chave). */
export const audioSourceKey = (assetId: string, processKey: string | null): string => (processKey ? `${assetId}${SEP}${processKey}` : assetId)

export function splitAudioSourceKey(sourceKey: string): { assetId: string; processKey: string | null } {
  const i = sourceKey.indexOf(SEP)
  return i < 0 ? { assetId: sourceKey, processKey: null } : { assetId: sourceKey.slice(0, i), processKey: sourceKey.slice(i + 1) }
}

/** União das chaves prontas (o resultado de um processamento nunca apaga outra chave já pronta); mesma referência se nada muda. */
export function mergeProcessedAudio(current: string[] | undefined, add: string[]): string[] {
  const missing = add.filter((k) => !(current ?? []).includes(k))
  return missing.length || !current ? [...(current ?? []), ...missing] : current
}
