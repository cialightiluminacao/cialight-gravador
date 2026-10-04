// Fala e loudness a partir da saída do ffmpeg (silencedetect / ebur128). Funções puras; tempos em Us inteiros.
import type { Asset, Us } from './project'

/** Silêncio detectado; `toUs` null = começou e o arquivo acabou antes de terminar (até o fim da mídia). */
export interface Silence { fromUs: Us; toUs: Us | null }
export interface SpeechInterval { fromUs: Us; toUs: Us }
export interface Loudness { integrated: number; truePeak: number; lra: number }

/**
 * Formato do cache/<id>.speech.json: os silêncios BRUTOS do silencedetect. Os intervalos de fala (padding, mescla)
 * saem sob demanda de `speechFromFile`, para ducking e remoção de silêncio ajustarem os parâmetros sem reanalisar.
 * O limiar (`thresholdDb`/`minSilenceUs`) é fixado na ingestão (-35 dB, 0,35 s); reanalisar com outro limiar
 * é uma ação futura.
 */
export interface SpeechFile { version: 1; thresholdDb: number; minSilenceUs: Us; silences: Silence[]; durationUs: Us }

export const SPEECH_DEFAULTS = { thresholdDb: -35, minSilenceUs: 350_000, padUs: 120_000, minSpeechUs: 100_000, mergeGapUs: 250_000 } as const

const toUs = (sec: string): Us => Math.round(Number(sec) * 1_000_000)

/** Filtro do ffmpeg da detecção de silêncio (ingestão e transcrição usam o mesmo critério). */
export function silencedetectFilter(thresholdDb: number = SPEECH_DEFAULTS.thresholdDb, minSilenceUs: Us = SPEECH_DEFAULTS.minSilenceUs): string {
  return `silencedetect=n=${thresholdDb}dB:d=${minSilenceUs / 1_000_000}`
}

/** Lê os `silence_start` / `silence_end` do stderr (aceita CRLF). Início negativo (offset do stream) vira 0. */
export function parseSilencedetect(stderr: string): Silence[] {
  const out: Silence[] = []
  let open: Us | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+(?:e[+-]?\d+)?)/i.exec(line)
    if (s) {
      if (open !== null) out.push({ fromUs: open, toUs: null }) // início duplicado: o anterior ficou sem fim
      open = Math.max(0, toUs(s[1]))
      continue
    }
    const e = /silence_end:\s*(-?[\d.]+(?:e[+-]?\d+)?)/i.exec(line)
    if (e && open !== null) {
      out.push({ fromUs: open, toUs: Math.max(open, toUs(e[1])) })
      open = null
    }
  }
  if (open !== null) out.push({ fromUs: open, toUs: null })
  return out
}

/**
 * Intervalos de fala = complemento dos silêncios em [0, durationUs]. Descarta fala menor que `minSpeechUs`
 * (estalo), aplica `padUs` nas duas pontas e mescla o que ficar a menos de `mergeGapUs` um do outro.
 */
export function speechIntervals(silences: Silence[], durationUs: Us, padUs: Us, minSpeechUs: Us, mergeGapUs: Us): SpeechInterval[] {
  if (!(durationUs > 0)) return []
  const sorted = silences
    .map((s) => ({ fromUs: Math.max(0, Math.min(durationUs, s.fromUs)), toUs: Math.max(0, Math.min(durationUs, s.toUs ?? durationUs)) }))
    .sort((a, b) => a.fromUs - b.fromUs)
  const speech: SpeechInterval[] = []
  let cursor = 0
  for (const s of sorted) {
    if (s.fromUs > cursor) speech.push({ fromUs: cursor, toUs: s.fromUs })
    cursor = Math.max(cursor, s.toUs)
  }
  if (cursor < durationUs) speech.push({ fromUs: cursor, toUs: durationUs })
  const out: SpeechInterval[] = []
  for (const sp of speech) {
    if (sp.toUs - sp.fromUs < minSpeechUs) continue
    const p = { fromUs: Math.max(0, sp.fromUs - padUs), toUs: Math.min(durationUs, sp.toUs + padUs) }
    const last = out[out.length - 1]
    if (last && p.fromUs - last.toUs < mergeGapUs) last.toUs = Math.max(last.toUs, p.toUs)
    else out.push(p)
  }
  return out
}

/** Resumo do ebur128 (`peak=true`): LUFS integrado, true peak (dBFS) e LRA (LU). -inf (áudio mudo) → piso. Sem resumo: null. */
export function parseEbur128(stderr: string): Loudness | null {
  const text = stderr.replace(/\r/g, '')
  const i = text.lastIndexOf('Summary:')
  if (i < 0) return null
  const part = text.slice(i)
  const pick = (re: RegExp, floor: number): number | null => {
    const m = re.exec(part)
    if (!m) return null
    if (/inf/i.test(m[1])) return floor
    const v = Number(m[1])
    return Number.isFinite(v) ? v : null
  }
  const integrated = pick(/^\s*I:\s*(-?[\d.]+|-?inf)\s*LUFS/m, -70)
  const lra = pick(/^\s*LRA:\s*(-?[\d.]+|-?inf)\s*LU/m, 0)
  const truePeak = pick(/^\s*Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/m, -120)
  if (integrated === null || lra === null || truePeak === null) return null
  return { integrated, truePeak, lra }
}

/** Intervalos de fala de um speech.json, com o padding/mescla padrão (SPEECH_DEFAULTS) ou os do chamador. */
export function speechFromFile(file: SpeechFile, opts: { padUs?: Us; minSpeechUs?: Us; mergeGapUs?: Us } = {}): SpeechInterval[] {
  return speechIntervals(
    file.silences,
    file.durationUs,
    opts.padUs ?? SPEECH_DEFAULTS.padUs,
    opts.minSpeechUs ?? SPEECH_DEFAULTS.minSpeechUs,
    opts.mergeGapUs ?? SPEECH_DEFAULTS.mergeGapUs
  )
}

/**
 * Análises de áudio (fala + loudness) prontas? Não entram em `derivedComplete`: são opcionais (falha não quebra o
 * asset); quem precisa delas (ducking, remoção de silêncio, normalização) consulta aqui. Sem áudio: sempre completo.
 */
export function audioAnalysisComplete(a: Asset): boolean {
  if (a.kind === 'image') return true
  if (a.kind !== 'audio' && !a.audio) return true
  return !!a.speech && !!a.loudness
}
