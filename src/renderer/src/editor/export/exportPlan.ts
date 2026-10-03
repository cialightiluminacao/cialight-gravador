// Cálculos puros da exportação do editor: intervalo, número de quadros, bitrate para tamanho-alvo,
// estimativa de tamanho e pré-checagem de mídia. Os presets ficam em exportPresets.ts. Sem DOM: testado em node.
import type { Asset, Project, Us } from '@shared/editor/project'

/** Folga do tamanho-alvo para contêiner e variação do encoder. */
export const TARGET_MARGIN = 0.04
/** Piso do bitrate de vídeo calculado (vídeos muito longos para o alvo). */
export const MIN_TARGET_BPS = 100_000
/** Intervalo padrão entre quadros-chave (s). */
export const KEYFRAME_INTERVAL_S = 2

const MiB = 1024 * 1024

/** Bitrate de vídeo (bps) que cabe em `targetMB` (MiB) com o áudio dado e margem de 4 %, SEM piso (pode ser ≤ 0). */
export function rawTargetBitrate(targetMB: number, durationUs: Us, audioKbps: number): number {
  if (!(durationUs > 0) || !(targetMB > 0)) return 0
  return Math.floor((targetMB * MiB * 8 * (1 - TARGET_MARGIN)) / (durationUs / 1e6) - audioKbps * 1000)
}

/** Bitrate de vídeo (bps) para caber em `targetMB` (MiB) com o áudio dado e margem de 4 %, com o piso MIN_TARGET_BPS. */
export function targetBitrate(targetMB: number, durationUs: Us, audioKbps: number): number {
  return Math.max(MIN_TARGET_BPS, rawTargetBitrate(targetMB, durationUs, audioKbps))
}

/**
 * Quadros em [fromUs, toUs) a `fps`: ceil, com tolerância de 1e-3 quadro para o arredondamento de
 * frameToUs (3 033 334 µs a 30 fps ainda são 91 quadros).
 */
export function frameCount(fromUs: Us, toUs: Us, fps: number): number {
  const d = toUs - fromUs
  if (!(d > 0) || !(fps > 0)) return 0
  return Math.max(1, Math.ceil((d * fps) / 1e6 - 1e-3))
}

/** Aviso quando o codificador de áudio não aceitou a taxa pedida e a exportação saiu numa menor (nunca em silêncio). */
export function audioRateWarning(requestedBps: number, actualBps: number, codec: 'aac' | 'opus' | null): string | null {
  if (!codec || !(actualBps > 0) || actualBps >= requestedBps) return null
  return `O áudio saiu em ${codec === 'aac' ? 'AAC' : 'Opus'} ${Math.round(actualBps / 1000)} kbps: o codificador deste computador não aceita ${Math.round(requestedBps / 1000)} kbps.`
}

/** Tamanho estimado (bytes) = bitrate × duração. */
export function estimateBytes(videoBps: number, audioBps: number, durationUs: Us): number {
  return Math.round(((videoBps + audioBps) * (durationUs / 1e6)) / 8)
}

/** Intervalo exportado: tudo, ou I–O (cada ponto opcional) quando pedido e válido. */
export function exportRange(projectDurUs: Us, inUs: Us | null, outUs: Us | null, mode: 'all' | 'inout'): { fromUs: Us; toUs: Us } {
  const all = { fromUs: 0, toUs: projectDurUs }
  if (mode === 'all') return all
  const fromUs = Math.max(0, inUs ?? 0)
  const toUs = Math.min(projectDurUs, outUs ?? projectDurUs)
  return toUs > fromUs ? { fromUs, toUs } : all
}

/** I–O utilizável (pelo menos um ponto definido e intervalo não vazio). */
export function hasInOut(projectDurUs: Us, inUs: Us | null, outUs: Us | null): boolean {
  if (inUs === null && outUs === null) return false
  const r = exportRange(projectDurUs, inUs, outUs, 'inout')
  return r.fromUs !== 0 || r.toUs !== projectDurUs
}

/** 2ª passada do tamanho-alvo: bitrate de vídeo × (alvo/obtido) × 0,97 (com o mesmo piso do cálculo do alvo). */
export function resizeBitrate(videoBps: number, targetBytes: number, actualBytes: number): number {
  if (!(actualBytes > 0)) return videoBps
  return Math.max(MIN_TARGET_BPS, Math.floor(videoBps * (targetBytes / actualBytes) * 0.97))
}

export interface ExportMediaIssue {
  assetId: string
  name: string
  status: Exclude<Asset['status'], 'ready'>
}

/**
 * Pré-checagem: assets usados em [fromUs, toUs) que sairiam como "mídia indisponível" (quadriculado) ou
 * silêncio — ausentes, com erro ou ainda em processamento (intermediário/proxy não pronto). Considera
 * faixas de vídeo visíveis, faixas de áudio não mudas e as anotações (gravação ausente); itens desativados não contam. Um por asset.
 */
export function exportMediaIssues(p: Project, fromUs: Us, toUs: Us): ExportMediaIssue[] {
  const out: ExportMediaIssue[] = []
  const seen = new Set<string>()
  const add = (a: Asset | undefined): void => {
    if (!a || a.status === 'ready' || seen.has(a.id)) return
    seen.add(a.id)
    out.push({ assetId: a.id, name: a.name, status: a.status })
  }
  for (const t of p.tracks) {
    if (t.kind === 'video' ? t.hidden : t.muted) continue
    for (const it of t.items) {
      if (it.enabled === false || it.startUs >= toUs || it.startUs + it.durationUs <= fromUs) continue
      if (it.type === 'media') {
        if (t.kind === 'audio' && !it.audio.enabled) continue
        add(p.assets.find((a) => a.id === it.assetId))
      } else if (it.type === 'annotations') {
        for (const a of p.assets) if (a.source.type === 'session' && a.source.sessionId === it.sessionId && a.status === 'missing') add(a)
      }
    }
  }
  return out
}

/** Fontes de texto que não carregaram a tempo (o texto saiu com a fonte padrão): avisos da tela de concluído. */
export function missingFontWarnings(families: readonly string[] | undefined): string[] {
  return (families ?? []).map((f) => `A fonte “${f}” não carregou a tempo: os textos com ela saíram com uma fonte padrão.`)
}

/** Avisos da tela de concluído para as mídias que não puderam ser lidas durante a exportação. */
export function missingMediaWarnings(p: Pick<Project, 'assets'> | { assets: { id: string; name: string }[] }, missing: { assetId: string; frames: number }[]): string[] {
  return missing.map(({ assetId, frames }) => {
    const name = p.assets.find((a) => a.id === assetId)?.name ?? assetId
    return `“${name}” não pôde ser lido em ${frames} ${frames === 1 ? 'quadro' : 'quadros'} e saiu como “mídia indisponível”.`
  })
}
