// Cálculo do bitrate-alvo para o preset "WhatsApp / e-mail — pequeno" com limite de tamanho (spec §7.2).
// kbps_video = alvo_MB × 8192 × 0,97 / duração_s − kbps_audio  (3 % de folga para contêiner/overhead).

/** Abaixo disto o vídeo desce para 854×480. */
export const LOW_KBPS_480P = 700
/** Abaixo disto avisamos "envie como documento" (qualidade ruim demais). */
export const LOW_KBPS_DOCUMENT_WARN = 350
/** Piso do bitrate de vídeo para nunca gerar 0/negativo no libx264. */
export const MIN_VIDEO_KBPS = 100
/** Margem de segurança: 2-pass só quando a estimativa passa de 98 % do alvo. */
export const TARGET_SAFETY_RATIO = 0.98

export interface TargetPlan {
  /** Bitrate de vídeo em kbps para o 2-pass. */
  kbps: number
  /** Altura de saída (720 normal, 480 quando o bitrate é baixo; nunca maior que a fonte). */
  height: number
  /** 'document' quando a qualidade ficaria ruim demais → sugerir enviar como documento no WhatsApp. */
  warn: 'document' | null
}

/** Bitrate de vídeo (kbps, inteiro ≥ 0) que cabe em `targetMB` para a duração dada, descontando o áudio. */
export function targetVideoKbps(targetMB: number, durationMs: number, audioKbps: number): number {
  if (!(durationMs > 0) || !(targetMB > 0)) return 0
  const seconds = durationMs / 1000
  const kbps = Math.floor((targetMB * 8192 * 0.97) / seconds - audioKbps)
  return Math.max(0, kbps)
}

/** Decide bitrate/altura/aviso para atingir o alvo (spec §7.2, linha "pequeno"). */
export function planForTarget(targetMB: number, durationMs: number, audioKbps: number, srcHeight: number): TargetPlan {
  const raw = targetVideoKbps(targetMB, durationMs, audioKbps)
  const kbps = Math.max(MIN_VIDEO_KBPS, raw)
  const cap = raw < LOW_KBPS_480P ? 480 : 720
  const height = Math.min(cap, srcHeight)
  const warn: TargetPlan['warn'] = raw < LOW_KBPS_DOCUMENT_WARN ? 'document' : null
  return { kbps, height, warn }
}

/** true quando a estimativa em CRF passa de 98 % do alvo → usar libx264 2-pass. */
export function needsTwoPass(estimateMB: number, targetMB: number): boolean {
  return estimateMB > targetMB * TARGET_SAFETY_RATIO
}
