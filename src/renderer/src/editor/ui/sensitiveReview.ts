// "Procurar dados sensíveis" (G3) — a parte PURA do diálogo: o que varrer (clipes visuais → um pedido por arquivo de
// origem com a união dos trechos usados), as palavras personalizadas, a lista de revisão (linhas, filtros por tipo,
// seleção) e a aplicação (hideOccurrences uma vez por arquivo, num projeto só = um passo de desfazer).
// Privacidade: nada daqui grava em disco/configurações/localStorage; os termos e o resultado vivem só na memória do
// diálogo (state/sensitiveScan.ts), limpos ao fechar.
import type { Asset, MediaItem, Project, Us } from '@shared/editor/project'
import { SENSITIVE_KIND_LABELS, type OcrBox, type SensitiveKind } from '@shared/editor/sensitive'
import { hideOccurrences, occurrenceSpans, type HideResult } from '@shared/editor/sensitiveEffects'
import { occurrenceRegionAt, type Occurrence, type ScanErrorReason, type ScanPhase } from '@shared/editor/sensitiveScan'
import { sourceTimeUs } from '@shared/editor/sourceTime'
import { formatTimecodeUs, frameDurUs, itemEndUs } from '@shared/editor/time'

/** Limites dos termos (os mesmos do main: src/main/sensitive/scanManager.ts). */
export const MAX_CUSTOM_WORDS = 50
export const MAX_CUSTOM_WORD_LEN = 100
/** Trechos usados do mesmo arquivo separados por menos que isto viram uma varredura só (a partida custa ~1 s). */
export const SCAN_MERGE_GAP_US = 30_000_000
/** Linhas desenhadas de uma vez na lista ("Mostrar mais" acrescenta outro tanto). */
export const ROW_PAGE = 100

export const ALL_KINDS = Object.keys(SENSITIVE_KIND_LABELS) as SensitiveKind[]

export const SCAN_DISCLAIMER = 'A busca é uma ajuda: confira o vídeo — textos muito pequenos ou em fonte monoespaçada podem escapar.'
export const OCR_LANG_HINT = 'Instale o idioma Português ou Inglês nas configurações do Windows'
export const OCR_POWERSHELL_HINT = 'O PowerShell do Windows pode estar bloqueado ou ausente neste computador (política da empresa ou antivírus); o reconhecimento de texto depende dele'
export const OCR_STOPPED_HINT = 'O reconhecimento parou no meio da busca. Tente de novo; se continuar, reinicie o computador'

/** Dica do erro 'ocrUnavailable' conforme o motivo vindo do main (a do idioma só quando falta o idioma). */
export function ocrUnavailableHint(reason: ScanErrorReason | undefined): string {
  if (reason === 'noLanguage') return OCR_LANG_HINT
  if (reason === 'stopped') return OCR_STOPPED_HINT
  return OCR_POWERSHELL_HINT
}

// ---------------------------------------------------------------- o que varrer

/** O arquivo de origem pode ser varrido (vídeo de arquivo ou de gravação, presente). */
export function scannableAsset(a: Asset | undefined): a is Asset {
  return !!a && a.kind === 'video' && !!a.video && a.status !== 'missing' && (a.source.type === 'file' || a.source.type === 'session')
}

/** Clipes de mídia visuais (faixas de vídeo) ativos; `onlyClipId` = só esse (menu do clipe). */
export function visualClips(p: Project, onlyClipId?: string | null): { m: MediaItem; asset: Asset | undefined }[] {
  const out: { m: MediaItem; asset: Asset | undefined }[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    for (const it of t.items) {
      if (it.type !== 'media' || !it.visual || it.enabled === false) continue
      if (onlyClipId && it.id !== onlyClipId) continue
      out.push({ m: it, asset: p.assets.find((a) => a.id === it.assetId) })
    }
  }
  return out
}

/** Trecho [fromUs, toUs) da fonte que o clipe mostra (as travas de sourceTimeUs; congelado: o quadro dele). */
export function clipSourceRange(m: MediaItem, asset: Asset): { fromUs: Us; toUs: Us } {
  const max = asset.durationUs != null ? Math.max(0, asset.durationUs - 1) : Infinity
  if (m.freeze) {
    const at = Math.round(Math.min(Math.max(m.freeze.atUs, 0), max))
    return { fromUs: at, toUs: at + 1 }
  }
  const lo = Math.min(Math.max(m.inUs, 0), max)
  const hi = Math.min(Math.max(m.inUs + Math.max(0, Math.ceil(m.durationUs * m.speed) - 1), 0), max)
  return { fromUs: Math.round(lo), toUs: Math.round(hi) + 1 }
}

/** União dos trechos (ordenados; os separados por menos de `gapUs` se juntam). */
export function mergeRanges(ranges: readonly { fromUs: Us; toUs: Us }[], gapUs: Us = SCAN_MERGE_GAP_US): { fromUs: Us; toUs: Us }[] {
  const s = [...ranges].filter((r) => r.toUs > r.fromUs).sort((a, b) => a.fromUs - b.fromUs)
  const out: { fromUs: Us; toUs: Us }[] = []
  for (const r of s) {
    const last = out[out.length - 1]
    if (last && r.fromUs <= last.toUs + gapUs) last.toUs = Math.max(last.toUs, r.toUs)
    else out.push({ ...r })
  }
  return out
}

export interface ScanJob {
  assetId: string
  /** Faixa de vídeo do arquivo (ruling R23); com intermediário, 0 (ele só leva a faixa 0:v:0 do original). */
  videoStreamIndex: number
  /**
   * O editor decodifica o intermediário deste asset (mediaUrls): a varredura lê ELE (o main resolve o caminho), cujo
   * tempo é o do editor — o original pode ter start_time ≠ 0 (.ts) e os quadros sairiam rotulados S adiantados.
   */
  intermediate?: true
  ranges: { fromUs: Us; toUs: Us }[]
  /** Clipes varridos deste arquivo (os efeitos vão só neles quando a busca é pelo menu do clipe). */
  clipIds: string[]
}
export interface ScanPlan {
  jobs: ScanJob[]
  /** Clipes visuais cujo arquivo não pode ser varrido (imagem, mídia ausente, gerada). */
  unsupported: number
}

/** Um pedido por arquivo de origem, na ordem da linha do tempo, com a união dos trechos usados pelos clipes. */
export function planScan(p: Project, onlyClipId?: string | null): ScanPlan {
  const byAsset = new Map<string, { asset: Asset; ranges: { fromUs: Us; toUs: Us }[]; clipIds: string[]; first: Us }>()
  let unsupported = 0
  for (const { m, asset } of visualClips(p, onlyClipId)) {
    if (!scannableAsset(asset)) {
      unsupported++
      continue
    }
    let e = byAsset.get(asset.id)
    if (!e) byAsset.set(asset.id, (e = { asset, ranges: [], clipIds: [], first: m.startUs }))
    e.ranges.push(clipSourceRange(m, asset))
    e.clipIds.push(m.id)
    e.first = Math.min(e.first, m.startUs)
  }
  const jobs = [...byAsset.values()]
    .sort((a, b) => a.first - b.first)
    .map((e) => ({ assetId: e.asset.id, ...(e.asset.intermediate ? { videoStreamIndex: 0, intermediate: true as const } : { videoStreamIndex: e.asset.videoTrackIndex ?? 0 }), ranges: mergeRanges(e.ranges), clipIds: e.clipIds }))
  return { jobs, unsupported }
}

export const SCAN_CONVERSION_PENDING = 'Este vídeo ainda não tem a cópia convertida para edição (conversão em andamento ou com erro). Aguarde a conversão terminar para procurar dados sensíveis: a busca lê a mesma cópia que o editor mostra.'

/**
 * O arquivo não pode ser varrido AGORA: vídeo ou áudio que o WebCodecs não decodifica ganha um intermediário (que passa
 * a ser o que o editor mostra, com outro tempo quando o original tem start_time ≠ 0); antes dele existir, varrer o
 * original daria tempos que não valem depois. null = pode.
 */
export function scanBlockedReason(a: Asset): string | null {
  if (a.intermediate) return null
  return a.video?.decodable === false || a.audio?.decodable === false ? SCAN_CONVERSION_PENDING : null
}

// ---------------------------------------------------------------- palavras personalizadas

/** Uma por linha ou separadas por vírgula; sem repetidas (maiúsculas não contam); até 50, cada uma com até 100 caracteres. */
export function parseCustomWords(text: string): { words: string[]; dropped: number; tooLong: number } {
  const seen = new Set<string>()
  const words: string[] = []
  let dropped = 0, tooLong = 0
  for (const raw of text.split(/[\n,;]+/)) {
    const w = raw.trim().replace(/\s+/g, ' ')
    if (!w) continue
    if (w.length > MAX_CUSTOM_WORD_LEN) {
      tooLong++
      continue
    }
    const k = w.toLocaleLowerCase('pt-BR')
    if (seen.has(k)) continue
    seen.add(k)
    if (words.length >= MAX_CUSTOM_WORDS) dropped++
    else words.push(w)
  }
  return { words, dropped, tooLong }
}

// ---------------------------------------------------------------- lista de revisão

/** O que a busca leu de um arquivo: os trechos da fonte e os clipes de então. */
export interface ScannedSpan {
  ranges: { fromUs: Us; toUs: Us }[]
  clipIds: string[]
}

export interface ScanOutcome {
  assetId: string
  /** Só estes clipes recebem efeitos (menu do clipe); ausente = todos os do arquivo. */
  clipIds?: string[]
  /** Trechos varridos e clipes de então (aviso se os clipes mudarem até a aplicação). */
  scanned?: ScannedSpan
  occurrences: Occurrence[]
}

export interface ReviewRow {
  /** = occ.id (`${scanId}:oN`, único entre varreduras). */
  id: string
  assetId: string
  clipIds?: string[]
  scanned?: ScannedSpan
  occ: Occurrence
  kind: SensitiveKind
  /** Clipe onde ela aparece primeiro e o instante (timeline) para onde o playhead vai. */
  clipId: string
  atUs: Us
  /** Caixa (fonte, topo-esquerda 0–1) no instante `atUs`. */
  box: OcrBox
  /** Trecho da timeline em que o clipe `clipId` a mostra. */
  fromUs: Us
  toUs: Us
  /** Quantos clipes a mostram. */
  clips: number
}

/** Instante da timeline em que o clipe mostra o quadro da fonte `srcUs` (ou o mais próximo dentro do clipe). */
function timelineAt(m: MediaItem, asset: Asset, srcUs: Us): Us {
  const S = m.startUs, E = itemEndUs(m)
  if (m.freeze) return S
  const fd = frameDurUs(asset.video?.fps || 30)
  const t = m.reverse ? S + m.durationUs - (srcUs - m.inUs + fd) / m.speed : S + (srcUs - m.inUs) / m.speed
  return Math.min(E - 1, Math.max(S, Math.ceil(t)))
}

/**
 * Linhas da revisão (ordenadas pelo instante na timeline). Ocorrência que nenhum clipe varrido mostra (trecho entre
 * clipes da mesma varredura) não entra: não há o que esconder nem para onde levar o playhead.
 */
export function buildRows(p: Project, outcomes: readonly ScanOutcome[]): ReviewRow[] {
  const rows: ReviewRow[] = []
  for (const o of outcomes) {
    const asset = p.assets.find((a) => a.id === o.assetId)
    if (!asset) continue
    const only = o.clipIds ? new Set(o.clipIds) : null
    const clips: MediaItem[] = []
    for (const t of p.tracks) {
      if (t.kind !== 'video') continue
      for (const it of t.items) if (it.type === 'media' && it.visual && it.assetId === asset.id && (!only || only.has(it.id))) clips.push(it)
    }
    for (const occ of o.occurrences) {
      let best: { m: MediaItem; a: Us; b: Us } | null = null
      let n = 0
      for (const m of clips) {
        const spans = occurrenceSpans(p, m, asset, occ)
        if (spans.length === 0) continue
        n++
        // o primeiro clipe (ativo, se houver) que a mostra
        const better = !best || (best.m.enabled === false && m.enabled !== false) || ((best.m.enabled === false) === (m.enabled === false) && spans[0].a < best.a)
        if (better) best = { m, a: spans[0].a, b: spans[spans.length - 1].b }
      }
      if (!best) continue
      const m = best.m
      // forward: o 1º quadro em que foi vista; reverso: o último (é o que aparece primeiro na timeline)
      let at = timelineAt(m, asset, m.reverse ? occ.lastSeenUs : occ.firstSeenUs)
      let box = occurrenceRegionAt(occ, sourceTimeUs(m, asset, at))
      if (!box) {
        at = Math.max(m.startUs, best.a)
        box = occurrenceRegionAt(occ, sourceTimeUs(m, asset, at)) ?? occ.samples[0]?.box ?? { x: 0, y: 0, w: 0, h: 0 }
      }
      rows.push({ id: occ.id, assetId: o.assetId, ...(o.clipIds ? { clipIds: o.clipIds } : {}), ...(o.scanned ? { scanned: o.scanned } : {}), occ, kind: occ.kind, clipId: m.id, atUs: at, box, fromUs: best.a, toUs: best.b, clips: n })
    }
  }
  return rows.sort((a, b) => a.atUs - b.atUs || a.box.y - b.box.y || a.box.x - b.box.x)
}

/** Contagem por tipo (na ordem dos rótulos), só os tipos presentes. */
export function kindCounts(rows: readonly ReviewRow[]): { kind: SensitiveKind; label: string; n: number }[] {
  const m = new Map<SensitiveKind, number>()
  for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1)
  return ALL_KINDS.filter((k) => m.has(k)).map((k) => ({ kind: k, label: SENSITIVE_KIND_LABELS[k], n: m.get(k)! }))
}

/** Linhas visíveis: sem as ignoradas e, com filtro, só dos tipos dele (filtro vazio/null = todos). */
export function visibleRows(rows: readonly ReviewRow[], filter: ReadonlySet<SensitiveKind> | null, ignored: ReadonlySet<string>): ReviewRow[] {
  const all = !filter || filter.size === 0
  const out: ReviewRow[] = []
  for (const r of rows) if (!ignored.has(r.id) && (all || filter.has(r.kind))) out.push(r)
  return out
}

/** As marcadas entre as visíveis (o que "Esconder selecionados" esconde). */
export function checkedRows(rows: readonly ReviewRow[], unchecked: ReadonlySet<string>): ReviewRow[] {
  return rows.filter((r) => !unchecked.has(r.id))
}

export interface HideOutcome extends Omit<HideResult, 'skipped'> {
  skipped: HideResult['skipped']
  /** Ocorrências pedidas. */
  requested: number
  /** Ocorrências com algum efeito pulado (não ficaram escondidas em todo clipe). */
  notHidden: number
  notHiddenIds: Set<string>
}

/**
 * Esconde as ocorrências das linhas: hideOccurrences UMA vez por arquivo de origem, encadeadas num único projeto
 * (quem chama aplica num `apply` só = um passo de desfazer).
 */
export function hideRows(p: Project, rows: readonly ReviewRow[], style: 'blur' | 'solid'): HideOutcome {
  const groups = new Map<string, { clipIds?: string[]; occs: Occurrence[] }>()
  for (const r of rows) {
    const key = `${r.assetId}|${r.clipIds?.join(',') ?? '*'}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { ...(r.clipIds ? { clipIds: r.clipIds } : {}), occs: [] }))
    g.occs.push(r.occ)
  }
  let project = p
  const itemIds: string[] = []
  const skipped: HideResult['skipped'] = []
  for (const [key, g] of groups) {
    const assetId = key.slice(0, key.indexOf('|'))
    const r = hideOccurrences(project, assetId, g.occs, { style, ...(g.clipIds ? { clipIds: g.clipIds } : {}) })
    project = r.project
    itemIds.push(...r.itemIds)
    skipped.push(...r.skipped)
  }
  const notHiddenIds = new Set(skipped.map((s) => s.occurrenceId))
  return { project, itemIds, skipped, requested: rows.length, notHidden: notHiddenIds.size, notHiddenIds }
}

export const SCAN_COVERAGE_CHANGED = 'O clipe mudou desde a busca; procure de novo para cobrir o trecho novo.'

/**
 * Os clipes mudaram desde a busca de forma que parte do que vai receber efeitos nunca foi lida: algum clipe-alvo (os
 * que hideOccurrences usa: visuais do arquivo, só os do menu quando a busca foi por clipe) mostra um trecho da fonte
 * fora dos trechos varridos, ou algum clipe varrido não existe mais (dividido/apagado). Os efeitos da parte coberta
 * continuam valendo; quem chama avisa (nunca silêncio).
 */
export function scanCoverageChanged(p: Project, rows: readonly ReviewRow[]): boolean {
  const groups = new Map<string, { assetId: string; clipIds?: string[]; scanned: ScannedSpan }>()
  for (const r of rows) {
    if (!r.scanned) continue
    const key = `${r.assetId}|${r.clipIds?.join(',') ?? '*'}`
    if (!groups.has(key)) groups.set(key, { assetId: r.assetId, ...(r.clipIds ? { clipIds: r.clipIds } : {}), scanned: r.scanned })
  }
  if (groups.size === 0) return false
  const ids = new Set<string>()
  for (const t of p.tracks) for (const it of t.items) ids.add(it.id)
  for (const g of groups.values()) {
    if (g.scanned.clipIds.some((id) => !ids.has(id))) return true
    const asset = p.assets.find((a) => a.id === g.assetId)
    if (!asset) return true
    const only = g.clipIds ? new Set(g.clipIds) : null
    for (const t of p.tracks) {
      if (t.kind !== 'video') continue
      for (const it of t.items) {
        if (it.type !== 'media' || it.assetId !== asset.id || !it.visual || (only && !only.has(it.id))) continue
        const r = clipSourceRange(it, asset)
        if (!g.scanned.ranges.some((s) => s.fromUs <= r.fromUs && r.toUs <= s.toUs)) return true
      }
    }
  }
  return false
}

/** Texto do aviso do resultado (nunca silêncio), com o motivo real de cada ocorrência pulada. */
export function hideToast(o: Pick<HideOutcome, 'requested' | 'notHidden' | 'itemIds' | 'skipped'>): { title: string; description?: string } {
  const n = o.requested - o.notHidden, m = o.itemIds.length
  const title = `${n === 1 ? '1 dado escondido' : `${n} dados escondidos`} (${m === 1 ? '1 efeito criado' : `${m} efeitos criados`})`
  if (!o.notHidden) return { title }
  // uma ocorrência pulada por mais de um motivo conta como bloqueada (é o que o usuário pode resolver)
  const locked = new Set(o.skipped.filter((s) => s.reason === 'locked').map((s) => s.occurrenceId))
  const notIn = new Set(o.skipped.filter((s) => s.reason === 'notInClip' && !locked.has(s.occurrenceId)).map((s) => s.occurrenceId))
  const head = o.notHidden === 1 ? '1 não pôde ser escondido' : `${o.notHidden} não puderam ser escondidos`
  let why: string
  if (locked.size && notIn.size) why = `${locked.size} em faixa bloqueada; ${notIn.size} ${notIn.size === 1 ? 'não aparece' : 'não aparecem'} em nenhum clipe da linha do tempo`
  else if (notIn.size) why = `o trecho não aparece em nenhum clipe da linha do tempo`
  else why = 'faixa bloqueada'
  return { title, description: `${head} (${why})` }
}

// ---------------------------------------------------------------- formatos

export const PHASE_LABELS: Record<ScanPhase, string> = { amostrando: 'Amostrando quadros…', lendo: 'Lendo texto…', analisando: 'Analisando…' }

/** "00:01:15 – 00:03:02" no formato do transporte. */
export function formatSpan(fromUs: Us, toUs: Us, fps: number): string {
  return `${formatTimecodeUs(fromUs, fps)} – ${formatTimecodeUs(Math.max(fromUs, toUs - 1), fps)}`
}

/** Retângulo (px da fonte) a recortar para a miniatura: a caixa com folga, na proporção da miniatura, dentro do quadro. */
export function thumbCrop(box: OcrBox, W: number, H: number, aspect: number): { x: number; y: number; w: number; h: number } {
  let w = box.w * W * 1.3 + 8, h = box.h * H * 1.6 + 8
  if (w / h > aspect) h = w / aspect
  else w = h * aspect
  w = Math.min(w, W)
  h = Math.min(h, H)
  const cx = (box.x + box.w / 2) * W, cy = (box.y + box.h / 2) * H
  const x = Math.min(Math.max(0, cx - w / 2), W - w), y = Math.min(Math.max(0, cy - h / 2), H - h)
  return { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) }
}
