// Pré-processamento de voz (redução de ruído e normalização de loudness) — parte pura: chave de cache, caminho do
// arquivo gerado e a chave da fonte que o mixer lê. O original nunca é alterado: cada combinação de parâmetros e de
// fonte vira um arquivo próprio em generated/<assetId>.audio-<chave>.<impressão>.m4a, onde a impressão digital é o
// tamanho + mtime do arquivo de origem (o importado ou o rec.mp4 da gravação) no momento do processamento: fonte
// trocada (relink, arquivo regravado) nunca acha o cache antigo. Asset.processedAudio: chave → impressão prontas.

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

/** Impressão digital do arquivo de origem: tamanho e mtime (ms inteiros) em base 36. */
export const sourceFingerprint = (size: number, mtimeMs: number): string => `${Math.round(size).toString(36)}-${Math.round(mtimeMs).toString(36)}`
export const isSourceFingerprint = (fp: string): boolean => /^[0-9a-z]+-[0-9a-z]+$/.test(fp)

/** Arquivo gerado (relativo à pasta do projeto) por (asset, chave, impressão da fonte). */
export const processedAudioRel = (assetId: string, key: string, fingerprint: string): string => `generated/${assetId}.audio-${key}.${fingerprint}.m4a`

/** Separador da chave de fonte do mixer (ids de asset não usam '~'). */
const SEP = '~'

/** Fonte de PCM do mixer: o original do asset (assetId) ou uma versão processada (assetId~chave). */
export const audioSourceKey = (assetId: string, processKey: string | null): string => (processKey ? `${assetId}${SEP}${processKey}` : assetId)

export function splitAudioSourceKey(sourceKey: string): { assetId: string; processKey: string | null } {
  const i = sourceKey.indexOf(SEP)
  return i < 0 ? { assetId: sourceKey, processKey: null } : { assetId: sourceKey.slice(0, i), processKey: sourceKey.slice(i + 1) }
}

/** Registra a versão pronta (chave → impressão da fonte); uma fonte nova substitui a antiga; mesma referência se nada muda. */
export function withProcessedAudio(current: Record<string, string> | undefined, key: string, fingerprint: string): Record<string, string> {
  if (current && current[key] === fingerprint) return current
  return { ...(current ?? {}), [key]: fingerprint }
}
