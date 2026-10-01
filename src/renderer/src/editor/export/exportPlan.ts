// Cálculos puros da exportação do editor: presets (resolução e bitrate), intervalo, número de quadros,
// bitrate para tamanho-alvo e estimativa de tamanho. Sem DOM: testado em node.
import type { Asset, Project, Us } from '@shared/editor/project'

export type EditorExportPresetId = 'high1080' | 'whatsapp' | 'original' | 'vertical'

export interface EditorExportPreset {
  id: EditorExportPresetId
  label: string
  hint: string
}

export const EDITOR_EXPORT_PRESETS: EditorExportPreset[] = [
  { id: 'high1080', label: 'Alta 1080p', hint: 'H.264 · 12 Mbps (20 Mbps a 60 fps)' },
  { id: 'whatsapp', label: 'WhatsApp', hint: '720p · até 64 MB' },
  { id: 'original', label: 'Original', hint: 'Resolução do projeto · 20 Mbps' },
  { id: 'vertical', label: 'Vertical 9:16', hint: '1080×1920 (projeto 9:16)' }
]

export const AUDIO_KBPS = 128
export const WHATSAPP_TARGET_MB = 64
/** Folga do tamanho-alvo para contêiner e variação do encoder. */
export const TARGET_MARGIN = 0.04
/** Piso do bitrate de vídeo calculado (vídeos muito longos para o alvo). */
export const MIN_TARGET_BPS = 100_000
/** Teto do WhatsApp em 720p: vídeos curtos não precisam de bitrate maior que isto. */
export const WHATSAPP_MAX_BPS = 8_000_000
/** Intervalo entre quadros-chave do H.264 (s). */
export const KEYFRAME_INTERVAL_S = 2

const MiB = 1024 * 1024

/** Bitrate de vídeo (bps) para caber em `targetMB` (MiB) com o áudio dado e margem de 4 %. */
export function targetBitrate(targetMB: number, durationUs: Us, audioKbps: number): number {
  if (!(durationUs > 0) || !(targetMB > 0)) return MIN_TARGET_BPS
  const bps = Math.floor((targetMB * MiB * 8 * (1 - TARGET_MARGIN)) / (durationUs / 1e6) - audioKbps * 1000)
  return Math.max(MIN_TARGET_BPS, bps)
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

const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)

/** 9:16 com tolerância de 1 %. */
export function isVertical916(canvas: { width: number; height: number }): boolean {
  return Math.abs(canvas.width / canvas.height - 9 / 16) < 0.01
}

/** Resolução de saída do preset (pares); null quando o preset não se aplica ao projeto (Vertical em projeto não 9:16). */
export function outputSize(preset: EditorExportPresetId, canvas: { width: number; height: number }): { width: number; height: number } | null {
  const { width: w, height: h } = canvas
  const fit = (long: number, short: number): { width: number; height: number } => {
    const [bw, bh] = w >= h ? [long, short] : [short, long]
    const s = Math.min(bw / w, bh / h)
    return { width: even(w * s), height: even(h * s) }
  }
  switch (preset) {
    case 'high1080':
      return fit(1920, 1080)
    case 'whatsapp':
      return fit(1280, 720)
    case 'original':
      return { width: even(w), height: even(h) }
    case 'vertical':
      return isVertical916(canvas) ? { width: 1080, height: 1920 } : null
  }
}

/** Bitrate de vídeo (bps) do preset para a duração exportada. */
export function presetVideoBitrate(preset: EditorExportPresetId, fps: number, durationUs: Us): number {
  switch (preset) {
    case 'high1080':
    case 'vertical':
      return fps > 30 ? 20_000_000 : 12_000_000
    case 'original':
      return 20_000_000
    case 'whatsapp':
      return Math.min(WHATSAPP_MAX_BPS, targetBitrate(WHATSAPP_TARGET_MB, durationUs, AUDIO_KBPS))
  }
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
 * faixas de vídeo visíveis, faixas de áudio não mudas e as anotações (gravação ausente). Um por asset.
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
      if (it.startUs >= toUs || it.startUs + it.durationUs <= fromUs) continue
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

/** Avisos da tela de concluído para as mídias que não puderam ser lidas durante a exportação. */
export function missingMediaWarnings(p: Pick<Project, 'assets'> | { assets: { id: string; name: string }[] }, missing: { assetId: string; frames: number }[]): string[] {
  return missing.map(({ assetId, frames }) => {
    const name = p.assets.find((a) => a.id === assetId)?.name ?? assetId
    return `“${name}” não pôde ser lido em ${frames} ${frames === 1 ? 'quadro' : 'quadros'} e saiu como “mídia indisponível”.`
  })
}
