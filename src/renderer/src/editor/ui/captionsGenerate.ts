// "Gerar legendas" (G2) — lógica pura do diálogo: rótulos dos modelos, resumo da fonte, rótulo/percentual de cada
// etapa do progresso e a montagem das legendas a partir das palavras da transcrição (tempo da fonte).
import { generateCaptions, nonCaptionContentEndUs } from '@shared/editor/ops'
import { segmentCaptions } from '@shared/editor/captionSegment'
import { planTranscription, wordsToTimeline, type SourceWord, type TranscribeSourcePlan } from '@shared/editor/transcribePlan'
import type { Project, Us } from '@shared/editor/project'
import type { WhisperModelStatus } from '@shared/ipc'

export type GenerateMode = 'replace' | 'fill'

/** Bytes → "148 MB" (MB decimais, como o tamanho anunciado do download). */
export function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1e6).toLocaleString('pt-BR')} MB`
}

const SPEED: Record<WhisperModelStatus['id'], string> = { base: 'mais rápido', small: 'mais lento' }

export function modelChoiceLabel(m: WhisperModelStatus): string {
  return `${m.label} (${formatMb(m.sizeBytes)}, ${SPEED[m.id]})`
}

export function modelStatusText(m: WhisperModelStatus): string {
  return m.present ? 'baixado' : `precisa baixar (${formatMb(m.sizeBytes)})`
}

/** "40 s", "1 min 20 s", "2 min", "1 h 05 min". */
export function formatDuration(us: Us): string {
  const s = Math.round(Math.max(0, us) / 1_000_000)
  if (s < 60) return `${s} s`
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60
    return r ? `${m} min ${r} s` : `${m} min`
  }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return `${h} h ${String(m).padStart(2, '0')} min`
}

/** O que será transcrito, com a duração total de áudio (na timeline). */
export function sourceSummary(plan: TranscribeSourcePlan): string {
  const total = plan.segments.reduce((a, s) => a + s.durationUs, 0)
  const what = plan.scope === 'voice' ? 'Faixas de voz' : 'Áudio dos clipes (não há faixa de voz)'
  return `${what} · ${formatDuration(total)} de áudio`
}

export type GenerateStage =
  | { kind: 'download'; receivedBytes: number; totalBytes: number }
  | { kind: 'extract'; fraction: number }
  | { kind: 'transcribe'; fraction: number }
  | { kind: 'build' }

const pct = (f: number): number => Math.max(0, Math.min(100, Math.round(f * 100)))

export function progressView(s: GenerateStage): { label: string; percent: number } {
  switch (s.kind) {
    case 'download': {
      const mb = (b: number): string => Math.round(b / 1e6).toLocaleString('pt-BR')
      return { label: `Baixando modelo (${mb(s.receivedBytes)} de ${mb(s.totalBytes)} MB)`, percent: s.totalBytes > 0 ? pct(s.receivedBytes / s.totalBytes) : 0 }
    }
    case 'extract':
      return { label: 'Extraindo áudio', percent: pct(s.fraction) }
    case 'transcribe':
      return { label: `Transcrevendo (${pct(s.fraction)}%)`, percent: pct(s.fraction) }
    case 'build':
      return { label: 'Montando legendas', percent: 100 }
  }
}

export function generatedToast(count: number, skipped: number, mode: GenerateMode): string {
  const head = count === 1 ? '1 legenda gerada' : `${count} legendas geradas`
  if (mode !== 'fill' || !skipped) return head
  return `${head} · ${skipped === 1 ? '1 pulada' : `${skipped} puladas`} (já havia legenda)`
}

export type BuildResult = { kind: 'noSpeech' } | { kind: 'ok'; project: Project; count: number; skipped: number; warnings: string[] }

/**
 * Palavras da transcrição (tempo da FONTE, por asset) → legendas no projeto `p` (o ATUAL: se ele mudou durante a
 * transcrição, o plano é refeito sobre ele — as palavras estão em tempo da fonte, então a conta continua válida; asset
 * removido some com as palavras dele). Nenhuma palavra na timeline → 'noSpeech'. As legendas nunca passam do fim do
 * conteúdo (sem contar a faixa de legendas). Faixa de legendas bloqueada → EditError (do generateCaptions).
 */
export function buildGenerated(p: Project, words: Readonly<Record<string, readonly SourceWord[]>>, mode: GenerateMode): BuildResult {
  const plan = planTranscription(p)
  const timed = wordsToTimeline(plan.segments, words)
  if (!timed.length) return { kind: 'noSpeech' }
  const cues = segmentCaptions(timed, { endLimitUs: nonCaptionContentEndUs(p) })
  if (!cues.length) return { kind: 'noSpeech' }
  return { kind: 'ok', ...generateCaptions(p, cues, mode) }
}
