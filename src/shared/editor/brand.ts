import { z } from 'zod'
import { sanitizeFileName } from '../filenames'
import { newId } from './ids'
import { aboveGuard, addTrack, contentEndUs, EditError, ensureCaptionsTrack, freeTrackName, insertItems, isCaptionsTrack, isFree, isFxTrack, isOverlayTrack, linkItems, musicTrackName, overlayInsertIndex, shiftAllContent } from './ops'
import { MIN_ITEM_US } from './project'
import type { Asset, AssetKind, Item, MediaItem, Project, ShapeItem, TextItem, Track, Us } from './project'
import { BrandItemSchema } from './schema'
import { itemEndUs } from './time'

// Modelos de marca (F5): um pedaço de linha do tempo (textos, formas e mídias de ARQUIVO) salvo para reaplicar em
// qualquer projeto — no playhead, como abertura (desloca o projeto todo), como encerramento ou como marca d'água.
// Puro: o main guarda o modelo em userData/brand-templates.json (fora do settings.json) e copia os arquivos para
// brand-assets/<id>/; ao aplicar, o main copia de novo para a pasta do PROJETO (asset `generated`) e o renderer passa
// os assets prontos em `assetMap` — o projeto não depende do modelo (apagar o modelo não quebra nada).

export type BrandTemplateKind = 'overlay' | 'intro' | 'outro' | 'watermark'
export const BRAND_TEMPLATE_KINDS: readonly BrandTemplateKind[] = ['overlay', 'intro', 'outro', 'watermark']
export type BrandItem = MediaItem | TextItem | ShapeItem
/** Arquivo do modelo: `file` é relativo a brand-assets/<id do modelo>/ (nome simples, sem pastas). */
export interface BrandTemplateAsset { id: string; name: string; kind: AssetKind; file: string }
/** Faixa do modelo, na ordem relativa de pilha (0 = mais ao fundo); tempos relativos ao início do modelo. */
export interface BrandTemplateTrack { role?: 'captions'; items: BrandItem[] }
export interface BrandTemplate {
  id: string; name: string; kind: BrandTemplateKind; createdAt: string; durationUs: Us
  tracks: BrandTemplateTrack[]
  assets: BrandTemplateAsset[]
}
/** Arquivo a copiar ao salvar: asset do projeto (o id vira o do modelo) e o caminho (absoluto, ou generated/… do projeto). */
export interface AssetToCopy { assetId: string; sourcePath: string }
export type ApplyMode = 'playhead' | 'intro' | 'outro' | 'watermark'

/** Limite da soma dos arquivos de um modelo. */
export const BRAND_MAX_ASSET_BYTES = 500 * 1024 * 1024
export const BRAND_NAME_MAX = 80
export const BRAND_FILE_VERSION = 1

/** Nome de arquivo de modelo aceito: simples (sem pastas nem `..`), sem caracteres proibidos no Windows. */
export const isSafeBrandFileName = (f: string): boolean => f.length > 0 && f.length <= 160 && !/[\\/:*?"<>|\p{Cc}]/u.test(f) && f !== '.' && f !== '..' && !f.startsWith('.') && f === f.trim()
/** Id aceito para modelo/asset (vira nome de pasta): letras, números, _ e -. */
export const isSafeBrandId = (id: string): boolean => /^[A-Za-z0-9_-]{1,80}$/.test(id)

const assetKind = z.enum(['video', 'audio', 'image'])
export const BrandTemplateSchema: z.ZodType<BrandTemplate> = z.object({
  id: z.string().refine(isSafeBrandId, 'id inválido'),
  name: z.string().min(1).max(BRAND_NAME_MAX),
  kind: z.enum(['overlay', 'intro', 'outro', 'watermark']),
  createdAt: z.string(),
  durationUs: z.number().int().min(MIN_ITEM_US),
  tracks: z.array(z.object({ role: z.literal('captions').optional(), items: z.array(BrandItemSchema).min(1) })).min(1),
  assets: z.array(z.object({ id: z.string().refine(isSafeBrandId, 'id inválido'), name: z.string(), kind: assetKind, file: z.string().refine(isSafeBrandFileName, 'arquivo inválido') }))
}).superRefine((t, ctx) => {
  const ids = new Set(t.assets.map((a) => a.id))
  if (ids.size !== t.assets.length) ctx.addIssue({ code: 'custom', message: 'asset repetido' })
  if (new Set(t.assets.map((a) => a.file.toLowerCase())).size !== t.assets.length) ctx.addIssue({ code: 'custom', message: 'arquivo repetido' })
  for (const tr of t.tracks) {
    const sorted = [...tr.items].sort((a, b) => a.startUs - b.startUs)
    sorted.forEach((it, i) => {
      if (it.type === 'media' && !ids.has(it.assetId)) ctx.addIssue({ code: 'custom', message: `item ${it.id} usa um arquivo que não está no modelo` })
      if (it.startUs < 0 || it.durationUs < MIN_ITEM_US || itemEndUs(it) > t.durationUs) ctx.addIssue({ code: 'custom', message: `item ${it.id} fora do modelo` })
      if (i > 0 && itemEndUs(sorted[i - 1]) > it.startUs) ctx.addIssue({ code: 'custom', message: `itens ${sorted[i - 1].id} e ${it.id} se sobrepõem` })
    })
  }
}) as unknown as z.ZodType<BrandTemplate>
export const BrandFileSchema = z.object({ version: z.literal(BRAND_FILE_VERSION), templates: z.array(BrandTemplateSchema) })
export type BrandFile = z.infer<typeof BrandFileSchema>

/** "12 MB" (pt-BR). */
export const formatBrandMb = (b: number): string => `${Math.round(b / (1024 * 1024)).toLocaleString('pt-BR')} MB`

/** Nome do arquivo do asset dentro da pasta do modelo: "<n>-<nome saneado>" (único pelo índice). */
export function brandAssetFileName(index: number, asset: Pick<Asset, 'name'>): string {
  const clean = sanitizeFileName(asset.name).replace(/^\.+/, '')
  const base = `${index + 1}-${clean || 'arquivo'}`
  return isSafeBrandFileName(base) ? base : `${index + 1}-arquivo`
}

/**
 * Modelo a partir dos itens selecionados. Entram textos, formas e mídias de ARQUIVO (`file`/`generated`); efeitos de
 * privacidade ficam de fora com aviso (dependem do conteúdo do projeto). Item de gravação (asset `session`) ou
 * anotações → EditError (o modelo só guarda arquivos). Tempos relativos ao menor início; vínculos entre itens
 * selecionados ficam, para fora saem; transição de entrada só fica se o item anterior da faixa também está no modelo e
 * encosta nele. Arquivos somando mais que BRAND_MAX_ASSET_BYTES → EditError. Faixas na ordem de pilha do projeto.
 */
export function templateFromSelection(p: Project, itemIds: readonly string[], name: string, kind: BrandTemplateKind, now: Date = new Date()): { template: BrandTemplate; assetsToCopy: AssetToCopy[]; warnings: string[] } {
  const title = name.trim().slice(0, BRAND_NAME_MAX)
  if (!title) throw new EditError('invalid', 'Dê um nome ao modelo')
  const wanted = new Set(itemIds)
  const picked: { track: Track; item: Item }[] = []
  for (const track of p.tracks) for (const item of track.items) if (wanted.has(item.id)) picked.push({ track, item })
  if (!picked.length) throw new EditError('notFound', 'Selecione na linha do tempo os itens que vão para o modelo')
  const assetOf = (id: string): Asset => {
    const a = p.assets.find((x) => x.id === id)
    if (!a) throw new EditError('notFound', `Asset não encontrado: ${id}`)
    return a
  }
  const fromRecording = picked.filter(({ item }) => item.type === 'annotations' || (item.type === 'media' && assetOf(item.assetId).source.type === 'session'))
  if (fromRecording.length) {
    throw new EditError('invalid', `${fromRecording.length === 1 ? '1 item selecionado vem' : `${fromRecording.length} itens selecionados vêm`} de uma gravação (tela, câmera, áudio ou anotações): o modelo só guarda textos, formas e arquivos importados. Desmarque esses itens e tente de novo.`)
  }
  const warnings: string[] = []
  const effects = picked.filter(({ item }) => item.type === 'effect').length
  if (effects) warnings.push(`${effects === 1 ? '1 efeito de privacidade ficou' : `${effects} efeitos de privacidade ficaram`} de fora: eles dependem do conteúdo do projeto.`)
  const kept = picked.filter((x): x is { track: Track; item: BrandItem } => x.item.type === 'media' || x.item.type === 'text' || x.item.type === 'shape')
  if (!kept.length) throw new EditError('invalid', 'Nada para salvar: o modelo guarda textos, formas e mídias importadas')

  const base = Math.min(...kept.map((x) => x.item.startUs))
  const durationUs = Math.max(...kept.map((x) => itemEndUs(x.item))) - base
  const links = new Map<string, number>()
  for (const { item } of kept) if (item.linkId) links.set(item.linkId, (links.get(item.linkId) ?? 0) + 1)

  // arquivos: um por asset usado, na ordem em que aparecem
  const assets: BrandTemplateAsset[] = []
  const assetsToCopy: AssetToCopy[] = []
  let knownBytes = 0
  for (const { item } of kept) {
    if (item.type !== 'media' || assets.some((a) => a.id === item.assetId)) continue
    const a = assetOf(item.assetId)
    const src = a.source
    if (src.type === 'session') continue // recusado acima
    assets.push({ id: a.id, name: a.name, kind: a.kind, file: brandAssetFileName(assets.length, a) })
    assetsToCopy.push({ assetId: a.id, sourcePath: src.type === 'file' ? src.path : src.file })
    if (src.type === 'file') knownBytes += src.size
  }
  if (knownBytes > BRAND_MAX_ASSET_BYTES) throw new EditError('invalid', `Os arquivos do modelo somam ${formatBrandMb(knownBytes)}; o limite é ${formatBrandMb(BRAND_MAX_ASSET_BYTES)} por modelo.`)

  const tracks: BrandTemplateTrack[] = []
  for (const track of p.tracks) {
    const items = kept.filter((x) => x.track === track).map((x) => x.item).sort((a, b) => a.startUs - b.startUs)
    if (!items.length) continue
    const out: BrandItem[] = items.map((it, i) => {
      const c = structuredClone(it) as BrandItem
      c.startUs = it.startUs - base
      if (c.linkId && (links.get(c.linkId) ?? 0) < 2) delete c.linkId
      const prev = items[i - 1]
      if ((c.type === 'media' || c.type === 'text') && c.transitionIn && !(prev && itemEndUs(prev) === it.startUs)) delete c.transitionIn
      return c
    })
    tracks.push({ ...(isCaptionsTrack(track) ? { role: 'captions' as const } : {}), items: out })
  }
  const template: BrandTemplate = { id: newId('bt_').replace(/[^A-Za-z0-9_-]/g, ''), name: title, kind, createdAt: now.toISOString(), durationUs, tracks, assets }
  return { template, assetsToCopy, warnings }
}

// ---------------------------------------------------------------- aplicar

type Category = 'captions' | 'audio' | 'overlay' | 'video'
function categoryOf(tt: BrandTemplateTrack): Category {
  if (tt.role === 'captions') return 'captions'
  if (tt.items.every((i) => i.type === 'media' && !i.visual)) return 'audio'
  if (tt.items.every((i) => i.type === 'text' || i.type === 'shape')) return 'overlay'
  return 'video'
}

/** Cópia do item do modelo para o projeto: id novo, início absoluto, vínculo e asset mapeados. */
function instantiate(it: BrandItem, startUs: Us, links: Map<string, string>, assetMap: Readonly<Record<string, Asset>>): BrandItem {
  const c = structuredClone(it) as BrandItem
  c.id = newId('i_')
  c.startUs = startUs
  if (c.linkId) {
    let l = links.get(c.linkId)
    if (!l) links.set(c.linkId, (l = newId('l_')))
    c.linkId = l
  }
  if (c.type === 'media') {
    const a = assetMap[c.assetId]
    if (!a) throw new EditError('notFound', 'Um arquivo do modelo não foi copiado para o projeto')
    c.assetId = a.id
  }
  return c
}

/** Os assets novos do mapa que o projeto ainda não tem. */
function withAssets(p: Project, assetMap: Readonly<Record<string, Asset>>): Project {
  const add = Object.values(assetMap).filter((a, i, all) => !p.assets.some((x) => x.id === a.id) && all.findIndex((b) => b.id === a.id) === i)
  return add.length ? { ...p, assets: [...p.assets, ...add] } : p
}

/**
 * Põe as faixas do modelo a partir de `at` sem ripple. Cada faixa do modelo vai para uma faixa distinta do projeto,
 * livre no trecho: legendas → a faixa de legendas (ocupada → EditError); texto/forma → uma sobreposição (sem efeitos
 * acima) ou uma nova no topo (abaixo das legendas); mídia visual → faixa de conteúdo abaixo dos efeitos (nunca acima;
 * senão uma nova, criada abaixo do bloco de efeitos); áudio → faixa de áudio (só áudio de arquivo de música → Música).
 * Reusando faixas, a ordem de pilha do modelo é mantida (cada faixa acima da anterior).
 */
function place(p0: Project, template: BrandTemplate, assetMap: Readonly<Record<string, Asset>>, at: Us): { project: Project; itemIds: string[] } {
  let q = p0
  const links = new Map<string, string>()
  const itemIds: string[] = []
  const used = new Set<string>()
  const groups = new Map<string, string[]>()
  let floorId: string | null = null
  const linkedToVisual = new Set(template.tracks.flatMap((t) => t.items).filter((i) => i.type === 'media' && i.visual && i.linkId).map((i) => i.linkId!))
  for (const tt of template.tracks) {
    const items = tt.items.map((it) => instantiate(it, at + it.startUs, links, assetMap))
    const s = Math.min(...items.map((i) => i.startUs)), e = Math.max(...items.map(itemEndUs))
    const cat = categoryOf(tt)
    const floor: number = floorId ? q.tracks.findIndex((t) => t.id === floorId) : -1
    const ok = (t: Track): boolean => !used.has(t.id) && !t.locked && !t.hidden && isFree(t, s, e)
    let trackId: string | undefined
    if (cat === 'captions') {
      const r = ensureCaptionsTrack(q)
      q = r.project
      const t = q.tracks.find((x) => x.id === r.trackId)!
      if (t.locked) throw new EditError('locked', `Faixa bloqueada: ${t.name}`)
      if (!isFree(t, s, e)) throw new EditError('overlap', 'Já há legendas no trecho do modelo: as legendas do modelo não cabem aqui')
      trackId = t.id
    } else if (cat === 'audio') {
      const music = tt.items.every((i) => i.type === 'media' && !(i.linkId && linkedToVisual.has(i.linkId)) && assetMap[i.assetId]?.kind === 'audio')
      trackId = q.tracks.find((t) => t.kind === 'audio' && ok(t) && (t.role === 'music') === music && t.role !== 'voice' && t.role !== 'sfx')?.id
      if (!trackId) {
        const r = music ? addTrack(q, 'audio', undefined, musicTrackName(q), 'music') : addTrack(q, 'audio')
        q = r.project
        trackId = r.trackId
      }
    } else if (cat === 'overlay') {
      const lastFx = q.tracks.reduce((m, t, i) => (isFxTrack(t) ? i : m), -1)
      trackId = q.tracks.find((t, i) => i > floor && i > lastFx && isOverlayTrack(t) && ok(t))?.id
      if (!trackId) {
        const r = addTrack(q, 'video', overlayInsertIndex(q), freeTrackName(q, 'Texto'))
        q = r.project
        trackId = r.trackId
      }
    } else {
      trackId = q.tracks.find((t, i) => i > floor && t.kind === 'video' && !isFxTrack(t) && !isCaptionsTrack(t) && !isOverlayTrack(t) && !aboveGuard(q, i) && ok(t))?.id
      if (!trackId) {
        const r = addTrack(q, 'video')
        q = r.project
        trackId = r.trackId
      }
    }
    // o vínculo volta no fim (cada inserção finaliza a faixa e tiraria o linkId ainda sem par)
    for (const it of items) {
      if (!it.linkId) continue
      groups.set(it.linkId, [...(groups.get(it.linkId) ?? []), it.id])
      delete it.linkId
    }
    q = insertItems(q, trackId, items, 'overwrite')
    used.add(trackId)
    if (cat !== 'audio') floorId = trackId
    itemIds.push(...items.map((i) => i.id))
  }
  for (const ids of groups.values()) if (ids.length > 1) q = linkItems(q, ids)
  return { project: q, itemIds }
}

/** Item "parado" (pode ser esticado): texto, forma ou imagem. */
const isStatic = (it: BrandItem, assetMap: Readonly<Record<string, Asset>>): boolean => it.type !== 'media' || assetMap[it.assetId]?.kind === 'image'

/**
 * Marca d'água: cada faixa visual do modelo vira uma faixa "Marca d'água" nova no topo das de vídeo (abaixo da de
 * legendas), de 0 ao fim do conteúdo. Um único item parado (texto, forma, imagem) é esticado; o resto se repete com o
 * período do modelo (o último pedaço é cortado no fim). Áudio fica de fora (aviso).
 */
function placeWatermark(p0: Project, template: BrandTemplate, assetMap: Readonly<Record<string, Asset>>): { project: Project; itemIds: string[]; warnings: string[] } {
  const end = contentEndUs(p0)
  if (end < MIN_ITEM_US) throw new EditError('invalid', "O projeto ainda não tem conteúdo: a marca d'água vai do início ao fim do conteúdo")
  const warnings: string[] = []
  const visual = template.tracks.filter((tt) => categoryOf(tt) !== 'audio' && categoryOf(tt) !== 'captions')
  if (template.tracks.some((tt) => categoryOf(tt) === 'audio')) warnings.push("O áudio do modelo não entra na marca d'água.")
  if (template.tracks.some((tt) => categoryOf(tt) === 'captions')) warnings.push("As legendas do modelo não entram na marca d'água.")
  if (!visual.length) throw new EditError('invalid', "O modelo não tem nada visual para usar como marca d'água")
  let q = p0
  const itemIds: string[] = []
  const period = Math.max(MIN_ITEM_US, template.durationUs)
  for (const tt of visual) {
    const out: BrandItem[] = []
    const noLinks = new Map<string, string>()
    if (tt.items.length === 1 && isStatic(tt.items[0], assetMap)) {
      const c = instantiate(tt.items[0], 0, noLinks, assetMap)
      c.durationUs = end
      out.push(c)
    } else {
      for (let k = 0; k * period < end; k++) {
        for (const it of tt.items) {
          const s = k * period + it.startUs
          const dur = Math.min(it.durationUs, end - s)
          if (dur < MIN_ITEM_US) continue
          const c = instantiate(it, s, noLinks, assetMap)
          c.durationUs = dur
          out.push(c)
        }
      }
    }
    for (const c of out) delete c.linkId
    const r = addTrack(q, 'video', overlayInsertIndex(q), freeTrackName(q, "Marca d'água"))
    q = insertItems(r.project, r.trackId, out, 'overwrite')
    itemIds.push(...out.map((i) => i.id))
  }
  return { project: q, itemIds, warnings }
}

/**
 * Aplica o modelo (um passo de desfazer: devolve um projeto só). `assetMap`: id do asset do modelo → asset novo do
 * projeto (já copiado para a pasta dele; entra em `assets` se ainda não estiver). Ids novos para todos os itens.
 * - playhead: a partir de `atUs`, sem ripple (colocação de `place`).
 * - intro: desloca o projeto INTEIRO (todas as faixas, efeitos, legendas, marcadores) pela duração do modelo e põe o
 *   modelo em 0; faixa bloqueada com itens → EditError.
 * - outro: no fim do conteúdo (contentEndUs), sem ripple.
 * - watermark: ver placeWatermark.
 */
export function applyTemplate(p: Project, template: BrandTemplate, assetMap: Readonly<Record<string, Asset>>, mode: ApplyMode, atUs: Us): { project: Project; itemIds: string[]; warnings: string[] } {
  for (const a of template.assets) if (!assetMap[a.id]) throw new EditError('notFound', `O arquivo “${a.name}” do modelo não foi copiado para o projeto`)
  const base = withAssets(p, assetMap)
  if (mode === 'watermark') return placeWatermark(base, template, assetMap)
  if (mode === 'intro') {
    const shifted = shiftAllContent(base, template.durationUs)
    return { ...place(shifted, template, assetMap, 0), warnings: [] }
  }
  const at = mode === 'outro' ? contentEndUs(p) : Math.max(0, Math.round(atUs))
  return { ...place(base, template, assetMap, at), warnings: [] }
}
