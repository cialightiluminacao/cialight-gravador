// Presets declarativos da exportação do editor e as configurações que o diálogo edita (resolução, fps,
// qualidade por taxa ou tamanho alvo, codec, áudio, quadro-chave). Puro (sem DOM): testado em node.
// O preset só preenche os padrões; depois de qualquer ajuste as configurações (`ExportSettings`) mandam e o
// rótulo vira "Personalizado". Nunca há tarja/corte silenciosos: presets de proporção exata só aparecem
// disponíveis quando o projeto já tem essa proporção (±1 %), e a resolução personalizada mantém a do projeto.
import type { Project, Us } from '@shared/editor/project'
import { h264FitsLevel52 } from '@/engine/encoderSupport'
import { estimateBytes, MIN_TARGET_BPS, rawTargetBitrate, targetBitrate } from './exportPlan'

export type VideoCodecChoice = 'h264' | 'hevc'

export type ExportPresetId =
  | 'whatsapp'
  | 'youtube1080'
  | 'youtube4k'
  | 'reels' // Instagram Reels/Stories 9:16
  | 'feed11'
  | 'feed45'
  | 'original'
  | 'intermediate'
  | 'custom'

export interface ExportPreset {
  id: ExportPresetId
  label: string
  hint: string
  /** fit: cabe na caixa (gira com a orientação do projeto), nunca amplia; exact: só com a proporção do projeto. */
  size: { kind: 'fit'; maxW: number; maxH: number } | { kind: 'exact'; w: number; h: number; aspect: number } | { kind: 'original' }
  /** fps de saída = cap == null ? fps do projeto : min(fps do projeto, cap). */
  fpsCap: number | null
  /** bitrate: bps30 até 30 fps, bps60 acima; target: tamanho alvo (MiB) com teto de bitrate. */
  quality: { kind: 'bitrate'; bps30: number; bps60: number } | { kind: 'target'; mb: number; maxBps: number }
  keyFrameIntervalS: number
  audioKbps: number
  /** O preset aceita HEVC (os de redes sociais/compatibilidade ficam só em H.264). */
  allowHevc: boolean
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'whatsapp', label: 'WhatsApp (até 64 MB)', hint: 'Até 720p · até 30 fps · cabe em 64 MB', size: { kind: 'fit', maxW: 1280, maxH: 720 }, fpsCap: 30, quality: { kind: 'target', mb: 64, maxBps: 8_000_000 }, keyFrameIntervalS: 2, audioKbps: 128, allowHevc: false },
  { id: 'youtube1080', label: 'YouTube 1080p', hint: 'Até 1080p · 12 Mbps (20 Mbps acima de 30 fps)', size: { kind: 'fit', maxW: 1920, maxH: 1080 }, fpsCap: null, quality: { kind: 'bitrate', bps30: 12_000_000, bps60: 20_000_000 }, keyFrameIntervalS: 2, audioKbps: 192, allowHevc: true },
  { id: 'youtube4k', label: 'YouTube 4K', hint: 'Até 2160p · 45 Mbps (68 Mbps acima de 30 fps)', size: { kind: 'fit', maxW: 3840, maxH: 2160 }, fpsCap: null, quality: { kind: 'bitrate', bps30: 45_000_000, bps60: 68_000_000 }, keyFrameIntervalS: 2, audioKbps: 192, allowHevc: true },
  { id: 'reels', label: 'Instagram Reels/Stories (9:16)', hint: '1080×1920 · até 30 fps · Stories: até 60 s por parte', size: { kind: 'exact', w: 1080, h: 1920, aspect: 9 / 16 }, fpsCap: 30, quality: { kind: 'bitrate', bps30: 10_000_000, bps60: 10_000_000 }, keyFrameIntervalS: 2, audioKbps: 128, allowHevc: false },
  { id: 'feed11', label: 'Instagram Feed 1:1', hint: '1080×1080 · até 30 fps', size: { kind: 'exact', w: 1080, h: 1080, aspect: 1 }, fpsCap: 30, quality: { kind: 'bitrate', bps30: 8_000_000, bps60: 8_000_000 }, keyFrameIntervalS: 2, audioKbps: 128, allowHevc: false },
  { id: 'feed45', label: 'Instagram Feed 4:5', hint: '1080×1350 · até 30 fps', size: { kind: 'exact', w: 1080, h: 1350, aspect: 4 / 5 }, fpsCap: 30, quality: { kind: 'bitrate', bps30: 8_000_000, bps60: 8_000_000 }, keyFrameIntervalS: 2, audioKbps: 128, allowHevc: false },
  { id: 'original', label: 'Original (máxima)', hint: 'Resolução do projeto · 20 Mbps (30 Mbps acima de 30 fps)', size: { kind: 'original' }, fpsCap: null, quality: { kind: 'bitrate', bps30: 20_000_000, bps60: 30_000_000 }, keyFrameIntervalS: 2, audioKbps: 192, allowHevc: true },
  { id: 'intermediate', label: 'Edição (intermediário)', hint: 'Para reeditar: 60 Mbps, quadro-chave a cada 0,5 s', size: { kind: 'original' }, fpsCap: null, quality: { kind: 'bitrate', bps30: 60_000_000, bps60: 90_000_000 }, keyFrameIntervalS: 0.5, audioKbps: 192, allowHevc: false }
]

/**
 * O que o diálogo edita. O preset preenche; `presetId` continua sendo o preset de base e qualquer ajuste liga
 * `customized` (rótulo "Personalizado"; as configurações são a verdade). Sem ajustes valem o teto de bitrate, a
 * disponibilidade e o "só H.264" do preset; com ajustes, só os limites genéricos.
 */
export interface ExportSettings {
  presetId: ExportPresetId
  /** O usuário ajustou algo depois de escolher o preset. */
  customized?: boolean
  /** Pares, 16–4096, na proporção do projeto. */
  width: number
  height: number
  /** Uma de FPS_CHOICES ou o fps do projeto. */
  fps: number
  quality: { kind: 'bitrate'; bps: number } | { kind: 'target'; mb: number }
  codec: VideoCodecChoice
  audioKbps: number
  keyFrameIntervalS: number
}

export const FPS_CHOICES = [24, 25, 30, 50, 60] as const

type Canvas = Pick<Project['canvas'], 'width' | 'height' | 'fps'>
type Size = { width: number; height: number }

const MiB = 1024 * 1024
/** Teto do bitrate calculado para um tamanho alvo fora de um preset com teto próprio. */
export const MAX_TARGET_BPS = 50_000_000
/** Faixa aceita na taxa digitada. */
export const MAX_BITRATE_BPS = 100_000_000
/** Abaixo disto o vídeo do tamanho alvo fica visivelmente ruim (aviso, não bloqueio). */
export const LOW_QUALITY_BPS = 500_000
export const MIN_DIM = 16
export const MAX_DIM = 4096
/** Tolerância relativa de proporção (presets exatos e resolução personalizada). */
const ASPECT_TOL = 0.01

const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)
const sameAspect = (a: number, b: number): boolean => Math.abs(a / b - 1) <= ASPECT_TOL
const RATIO_LABEL: Partial<Record<ExportPresetId, string>> = { reels: '9:16', feed11: '1:1', feed45: '4:5' }

export function presetById(id: ExportPresetId): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id)
}

/** Preset efetivo, nunca undefined ('custom' parte do Original). */
export function basePreset(id: ExportPresetId): ExportPreset {
  return presetById(id === 'custom' ? 'original' : id) ?? EXPORT_PRESETS.find((p) => p.id === 'original')!
}
const effective = basePreset

/** Os limites do preset (teto, disponibilidade, só H.264) valem enquanto não houver ajustes. */
const presetRules = (s: ExportSettings): ExportPreset | undefined => (s.customized ? undefined : presetById(s.presetId))

/** Resolução de saída do preset (pares). Exatos devolvem o tamanho fixo mesmo sem a proporção (ver presetAvailability). */
export function presetOutputSize(id: ExportPresetId, canvas: Pick<Canvas, 'width' | 'height'>): Size {
  const p = effective(id)
  const { width: w, height: h } = canvas
  switch (p.size.kind) {
    case 'original':
      return { width: even(w), height: even(h) }
    case 'exact':
      return { width: p.size.w, height: p.size.h }
    case 'fit': {
      // a caixa acompanha a orientação do projeto (vertical: 1080×1920) e nunca amplia
      const [bw, bh] = w >= h ? [p.size.maxW, p.size.maxH] : [p.size.maxH, p.size.maxW]
      const s = Math.min(1, bw / w, bh / h)
      return { width: even(w * s), height: even(h * s) }
    }
  }
}

function presetFps(p: ExportPreset, projectFps: number): number {
  return p.fpsCap == null ? projectFps : Math.min(projectFps, p.fpsCap)
}

export function settingsForPreset(id: ExportPresetId, canvas: Canvas): ExportSettings {
  const p = effective(id)
  const { width, height } = presetOutputSize(id, canvas)
  const fps = presetFps(p, canvas.fps)
  const quality: ExportSettings['quality'] = p.quality.kind === 'bitrate' ? { kind: 'bitrate', bps: fps > 30 ? p.quality.bps60 : p.quality.bps30 } : { kind: 'target', mb: p.quality.mb }
  return { presetId: id, width, height, fps, quality, codec: 'h264', audioKbps: p.audioKbps, keyFrameIntervalS: p.keyFrameIntervalS }
}

export interface PresetAvailability {
  ok: boolean
  reason?: string
}

export function presetAvailability(id: ExportPresetId, canvas: Pick<Canvas, 'width' | 'height'>, durationUs: Us): PresetAvailability {
  const p = presetById(id)
  if (!p) return { ok: true }
  const { width: w, height: h } = canvas
  if (id === 'youtube4k' && !(Math.max(w, h) >= 3840 || Math.min(w, h) >= 2160)) return { ok: false, reason: 'O projeto tem menos de 4K — use YouTube 1080p ou Original' }
  if (p.size.kind === 'exact' && !sameAspect(w / h, p.size.aspect)) {
    const r = RATIO_LABEL[id]
    return { ok: false, reason: `O projeto não é ${r} — use Reenquadrar (${r}) antes` }
  }
  if (p.quality.kind === 'target' && durationUs > 0 && rawTargetBitrate(p.quality.mb, durationUs, p.audioKbps) < MIN_TARGET_BPS) {
    return { ok: false, reason: `Vídeo longo demais para caber em ${p.quality.mb} MB — exporte um trecho menor (I–O)` }
  }
  return { ok: true }
}

/** Bitrate de vídeo (bps): taxa fixa, ou o do tamanho alvo limitado a [MIN_TARGET_BPS, teto do preset (sem ajustes) ou 50 Mbps]. */
export function videoBitrateFor(s: ExportSettings, durationUs: Us): number {
  if (s.quality.kind === 'bitrate') return s.quality.bps
  const p = presetRules(s)
  const max = p?.quality.kind === 'target' ? p.quality.maxBps : MAX_TARGET_BPS
  return Math.min(max, targetBitrate(s.quality.mb, durationUs, s.audioKbps))
}

/** Tamanho estimado (bytes) da saída. */
export function estimateFor(s: ExportSettings, durationUs: Us, hasAudio = true): number {
  return estimateBytes(videoBitrateFor(s, durationUs), hasAudio ? s.audioKbps * 1000 : 0, durationUs)
}

/** Campos do pedido de exportação derivados das configurações (tamanho alvo → targetBytes, ativa a 2ª passada). */
export function exportRequestFor(
  s: ExportSettings,
  durationUs: Us
): { width: number; height: number; fps: number; videoBitrate: number; audioBitrate: number; keyFrameIntervalS: number; codec: VideoCodecChoice; targetBytes?: number } {
  return {
    width: s.width,
    height: s.height,
    fps: s.fps,
    videoBitrate: videoBitrateFor(s, durationUs),
    audioBitrate: s.audioKbps * 1000,
    keyFrameIntervalS: s.keyFrameIntervalS,
    codec: s.codec,
    ...(s.quality.kind === 'target' ? { targetBytes: Math.round(s.quality.mb * MiB) } : {})
  }
}

export interface ExportValidation {
  blocker: string | null
  warnings: string[]
}

const clock = (us: Us): string => {
  const t = Math.round(us / 1e6)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
const mbLabel = (mb: number): string => `${mb.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`

/** Bloqueio (o botão Exportar fica desativado com o motivo) e avisos das configurações para o projeto. */
export function validateExport(s: ExportSettings, canvas: Canvas, durationUs: Us, hevcSupported: boolean): ExportValidation {
  const warnings: string[] = []
  const result = (blocker: string | null): ExportValidation => ({ blocker, warnings: blocker ? [] : warnings })
  if (!(durationUs > 0)) return result('A linha do tempo está vazia.')
  const avail = presetRules(s) ? presetAvailability(s.presetId, canvas, durationUs) : { ok: true }
  if (!avail.ok) return result(avail.reason ?? 'Preset indisponível para este projeto.')
  const { width: w, height: h, fps } = s
  if (!Number.isInteger(w) || !Number.isInteger(h) || w % 2 || h % 2) return result('Largura e altura precisam ser números pares.')
  if (w < MIN_DIM || h < MIN_DIM || w > MAX_DIM || h > MAX_DIM) return result(`A resolução precisa ficar entre ${MIN_DIM} e ${MAX_DIM} pixels.`)
  if (!sameAspect(w / h, canvas.width / canvas.height)) return result(`A proporção ${w}×${h} não é a do projeto (${canvas.width}×${canvas.height}) — use Reenquadrar para mudar a proporção.`)
  if (!fpsChoices(canvas.fps).includes(fps)) return result('Taxa de quadros inválida.')
  // o fallback do HEVC é o H.264: o limite vale para os dois
  if (!h264FitsLevel52(w, h, fps)) return result('Resolução e fps acima do limite do H.264 (nível 5.2): reduza a resolução ou o fps.')
  if (s.codec === 'hevc') {
    const p = presetRules(s)
    if (p && !p.allowHevc) return result(`O preset “${p.label}” usa só H.264 (compatibilidade).`)
    if (!hevcSupported) return result('HEVC não suportado neste computador')
  }
  if (s.quality.kind === 'bitrate') {
    const bps = s.quality.bps
    if (!Number.isFinite(bps) || bps < MIN_TARGET_BPS || bps > MAX_BITRATE_BPS) return result('A taxa precisa ficar entre 0,1 e 100 Mbps.')
  } else {
    const mb = s.quality.mb
    if (!Number.isFinite(mb) || !(mb > 0)) return result('Informe o tamanho alvo em MB.')
    const raw = rawTargetBitrate(mb, durationUs, s.audioKbps)
    if (raw < MIN_TARGET_BPS) return result(`${mbLabel(mb)} é pouco para ${clock(durationUs)} de vídeo: aumente o tamanho alvo ou exporte um trecho menor (I–O).`)
    if (raw < LOW_QUALITY_BPS) warnings.push(`Qualidade baixa: vídeo longo para ${mbLabel(mb)}.`)
  }
  if (s.presetId === 'reels' && durationUs > 90_000_000) warnings.push('Reels acima de 90 s: o Instagram pode recusar ou cortar o vídeo.')
  if (w > even(canvas.width) || h > even(canvas.height)) warnings.push('A resolução é maior que a do projeto: o vídeo não ganha detalhe.')
  return result(null)
}

/** fps oferecidos: 24/25/30/50/60 e o do projeto. */
export function fpsChoices(projectFps: number): number[] {
  const out: number[] = [...FPS_CHOICES]
  if (!out.includes(projectFps)) out.push(projectFps)
  return out.sort((a, b) => a - b)
}

/** Resolução com a largura dada (par) e a proporção do projeto. */
export function sizeForWidth(width: number, canvas: Pick<Canvas, 'width' | 'height'>): Size {
  const w = even(width)
  return { width: w, height: even((w * canvas.height) / canvas.width) }
}

/** Resolução com a altura dada (par) e a proporção do projeto. */
export function sizeForHeight(height: number, canvas: Pick<Canvas, 'width' | 'height'>): Size {
  const h = even(height)
  return { width: even((h * canvas.width) / canvas.height), height: h }
}

const KNOWN_EXT = /\.(mp4|mov|m4v|mkv|webm|gif|png|mp3|wav|m4a)$/i

/** Nome do arquivo com a extensão do formato (troca uma extensão de mídia já digitada). */
export function outputFileName(base: string, ext: 'mp4' | 'gif' | 'png' | 'wav' | 'mp3' | 'm4a'): string {
  return `${base.replace(KNOWN_EXT, '')}.${ext}`
}
