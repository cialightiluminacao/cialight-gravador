// Importação e ingestão de mídia do editor (renderer). Fluxo (ver IpcApi.media):
// media.import (probe no main) → addAsset no store → canDecode via mediabunny → media.enqueue.
import { ALL_FORMATS, Input, UrlSource } from 'mediabunny'
import { toast } from 'sonner'
import { FILE_HOST_MEDIA, FILE_HOST_PROJECT, FILE_PROTOCOL } from '@shared/ipc'
import { addAsset } from '@shared/editor/ops'
import { newId } from '@shared/editor/ids'
import { sessionAssets } from '@shared/editor/fromSession'
import type { Asset } from '@shared/editor/project'
import { flushAutosave, useEditorStore } from '../state/editorStore'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function mediaUrl(projectId: string, assetId: string, variant: 'original' | 'proxy' = 'original'): string {
  return `${FILE_PROTOCOL}://${FILE_HOST_MEDIA}/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}?v=${variant}`
}

/** Arquivo dentro da pasta do projeto (filmstrip, miniatura…), pelo caminho relativo. */
export function projectFileUrl(projectId: string, rel: string): string {
  return `${FILE_PROTOCOL}://${FILE_HOST_PROJECT}/${encodeURIComponent(projectId)}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * O WebCodecs desta máquina decodifica a mídia? Vídeo: faixa de vídeo principal; só áudio: faixa de áudio.
 * Gravações do app (H.264) sempre decodificam. Falha ao abrir = não decodificável (o main gera intermediário).
 */
export async function decideDecodable(projectId: string, a: Asset): Promise<boolean> {
  if (a.kind === 'image' || a.source.type === 'session') return true
  const input = new Input({ source: new UrlSource(mediaUrl(projectId, a.id)), formats: ALL_FORMATS })
  try {
    if (a.kind === 'video') {
      const track = await input.getPrimaryVideoTrack()
      return !!track && (await track.canDecode())
    }
    const track = await input.getPrimaryAudioTrack()
    return !!track && (await track.canDecode())
  } catch (e) {
    console.warn(`[editor] canDecode de ${a.name} falhou`, e)
    return false
  } finally {
    input.dispose()
  }
}

/** Decide `decodable` e põe o asset na fila de ingestão do main. */
export async function enqueueAsset(projectId: string, a: Asset): Promise<void> {
  try {
    const decodable = await decideDecodable(projectId, a)
    await window.api.media.enqueue(projectId, a.id, { decodable })
  } catch (e) {
    toast.error(`Não foi possível processar “${a.name}”: ${errMsg(e)}`)
  }
}

/** Ao abrir: retoma o que ficou em processamento e gera filmstrip/peaks das gravações que ainda não têm. */
export function enqueuePending(projectId: string, assets: Asset[]): void {
  for (const a of assets) {
    const sessionNeedsAnalysis = a.source.type === 'session' && a.status === 'ready' && (a.kind === 'video' ? !a.filmstrip : !a.peaks)
    if (a.status === 'processing' || sessionNeedsAnalysis) void enqueueAsset(projectId, a)
  }
}

/** Importa arquivos do disco para o projeto aberto; devolve os assets adicionados. */
export async function importPaths(projectId: string, paths: string[]): Promise<Asset[]> {
  if (paths.length === 0) return []
  let assets: Asset[]
  try {
    assets = await window.api.media.import(projectId, paths)
  } catch (e) {
    toast.error(`Não foi possível importar: ${errMsg(e)}`)
    return []
  }
  const ok = useEditorStore.getState().apply((p) => assets.reduce((q, a) => addAsset(q, a), p))
  if (!ok) return []
  const failed = assets.filter((a) => a.status === 'error')
  if (failed.length) toast.error(failed.length === 1 ? `“${failed[0].name}” não pôde ser lido.` : `${failed.length} arquivos não puderam ser lidos.`)
  const good = assets.length - failed.length
  if (good > 0) toast.success(good === 1 ? `“${assets.find((a) => a.status !== 'error')!.name}” importado.` : `${good} arquivos importados.`)
  for (const a of assets) if (a.status === 'processing') void enqueueAsset(projectId, a)
  return assets
}

/** Gravação do Histórico → assets 'session' (tela, webcam, microfone, sistema) no projeto aberto. */
export async function importSession(projectId: string, sessionId: string, label: string): Promise<Asset[]> {
  try {
    const session = await window.api.session.get(sessionId)
    if (!session) throw new Error('gravação não encontrada no disco')
    const assets = sessionAssets(session, newId('rec_'), label)
    if (!useEditorStore.getState().apply((p) => assets.reduce((q, a) => addAsset(q, a), p))) return []
    // o main só enfileira assets que conhece: salva antes de pedir filmstrip/peaks
    await flushAutosave()
    for (const a of assets) void enqueueAsset(projectId, a)
    toast.success(`Gravação adicionada (${assets.length} ${assets.length === 1 ? 'mídia' : 'mídias'}).`)
    return assets
  } catch (e) {
    toast.error(`Não foi possível adicionar a gravação: ${errMsg(e)}`)
    return []
  }
}

/** Mídia ausente: o usuário escolhe o novo caminho; o asset volta a processar. */
export async function relinkAsset(projectId: string, a: Asset): Promise<void> {
  const [path] = await window.api.project.pickMedia()
  if (!path) return
  try {
    const next = await window.api.media.relink(projectId, a.id, path)
    useEditorStore.getState().applyAssetPatch(a.id, next)
    await enqueueAsset(projectId, next)
  } catch (e) {
    toast.error(`Não foi possível localizar a mídia: ${errMsg(e)}`)
  }
}
