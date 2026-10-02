// Importação e ingestão de mídia do editor (renderer). Fluxo (ver IpcApi.media):
// media.import (probe no main) → addAsset no store → canDecode via mediabunny → media.enqueue.
import { ALL_FORMATS, Input, UrlSource } from 'mediabunny'
import { toast } from 'sonner'
import { FILE_HOST_MEDIA, FILE_HOST_PROJECT, FILE_PROTOCOL } from '@shared/ipc'
import { addAsset } from '@shared/editor/ops'
import { newId } from '@shared/editor/ids'
import { sessionAssets } from '@shared/editor/fromSession'
import type { Asset } from '@shared/editor/project'
import { ipcErrorMessage } from '@/lib/ipcError'
import { flushAutosave, useEditorStore } from '../state/editorStore'

const errMsg = ipcErrorMessage

export function mediaUrl(projectId: string, assetId: string, variant: 'original' | 'proxy' = 'original'): string {
  return `${FILE_PROTOCOL}://${FILE_HOST_MEDIA}/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}?v=${variant}`
}

/** Arquivo dentro da pasta do projeto (filmstrip, miniatura…), pelo caminho relativo. */
export function projectFileUrl(projectId: string, rel: string): string {
  return `${FILE_PROTOCOL}://${FILE_HOST_PROJECT}/${encodeURIComponent(projectId)}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * O WebCodecs desta máquina decodifica as faixas da mídia em `url`? `video`: faixa de vídeo principal (mídia
 * só de áudio: true); `audio`: faixa de áudio principal (sem faixa de áudio: true). FLAC, HE-AAC, AC-3…
 * costumam falhar no áudio. Falha ao abrir = nada decodifica (o main gera intermediário).
 */
export async function decodableTracks(url: string, kind: 'video' | 'audio'): Promise<{ video: boolean; audio: boolean }> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  try {
    const v = kind === 'video' ? await input.getPrimaryVideoTrack() : null
    const video = kind === 'video' ? !!v && (await v.canDecode()) : true
    const a = await input.getPrimaryAudioTrack()
    const audio = a ? await a.canDecode() : kind === 'video'
    return { video, audio }
  } catch (e) {
    console.warn(`[editor] canDecode de ${url} falhou`, e)
    return { video: false, audio: false }
  } finally {
    input.dispose()
  }
}

/** `decodable`/`audioDecodable` para media.enqueue. Gravações do app (H.264 + AAC) sempre decodificam. */
export async function decideDecodable(projectId: string, a: Asset): Promise<{ decodable: boolean; audioDecodable: boolean }> {
  if (a.kind === 'image' || a.source.type === 'session') return { decodable: true, audioDecodable: true }
  const r = await decodableTracks(mediaUrl(projectId, a.id), a.kind)
  return a.kind === 'audio' ? { decodable: r.audio, audioDecodable: r.audio } : { decodable: r.video, audioDecodable: r.audio }
}

/** Decide `decodable` e põe o asset na fila de ingestão do main. */
export async function enqueueAsset(projectId: string, a: Asset): Promise<void> {
  try {
    await window.api.media.enqueue(projectId, a.id, await decideDecodable(projectId, a))
  } catch (e) {
    toast.error(`Não foi possível processar “${a.name}”: ${errMsg(e)}`)
  }
}

/** Ao abrir: retoma o que ficou em processamento e gera filmstrip/peaks/fala/loudness das gravações que ainda não têm. */
export function enqueuePending(projectId: string, assets: Asset[]): void {
  for (const a of assets) {
    const fromSession = a.source.type === 'session' && a.status === 'ready'
    // gravações antigas ganham também fala/loudness (análise de áudio da F3)
    const sessionNeedsAnalysis = fromSession && ((a.kind === 'video' ? !a.filmstrip : !a.peaks) || ((a.kind === 'audio' || !!a.audio) && !(a.speech && a.loudness)))
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
    const session = await window.api.session.prepareForEditor(sessionId)
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
