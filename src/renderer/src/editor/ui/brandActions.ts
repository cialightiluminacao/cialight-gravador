// Ações da aba Modelos (marca): salvar a seleção como modelo e aplicar um modelo (o main copia os arquivos para a pasta
// do projeto; a aplicação é um passo de desfazer). Toasts em cada caminho (sucesso, aviso, erro).
import { toast } from 'sonner'
import { applyTemplate, templateFromSelection, type ApplyMode, type BrandTemplate, type BrandTemplateKind } from '@shared/editor/brand'
import { EditError } from '@shared/editor/ops'
import type { Asset } from '@shared/editor/project'
import { ipcErrorMessage } from '@/lib/ipcError'
import { flushAutosave, useEditorStore } from '../state/editorStore'
import { applyMessage } from './brandInfo'
import { enqueueAsset } from './mediaImport'

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()

/** Salva os itens selecionados como modelo; devolve o modelo gravado ou null (com toast do motivo). */
export async function saveSelectionAsTemplate(name: string, kind: BrandTemplateKind): Promise<BrandTemplate | null> {
  const p = st().project
  if (!p) return null
  if (st().txBase) st().commitTx()
  let r: ReturnType<typeof templateFromSelection>
  try {
    r = templateFromSelection(st().project!, st().selection, name, kind)
  } catch (e) {
    if (e instanceof EditError) {
      toast.error(e.message)
      return null
    }
    throw e
  }
  try {
    // o main lê os arquivos pelos assets do projeto salvo
    await flushAutosave()
    const saved = await window.api.brand.save(r.template, r.assetsToCopy, p.id)
    if (r.warnings.length) toast.warning(`Modelo “${saved.name}” salvo`, { description: r.warnings.join(' ') })
    else toast.success(`Modelo “${saved.name}” salvo`, { description: 'Está na aba Modelos, pronto para usar em qualquer projeto.' })
    return saved
  } catch (e) {
    toast.error(`Não foi possível salvar o modelo: ${ipcErrorMessage(e)}`)
    return null
  }
}

/**
 * Aplica o modelo no projeto aberto. Os arquivos do modelo são copiados para a pasta do projeto (asset `generated`;
 * o mesmo modelo aplicado de novo reusa a cópia); o projeto passa a não depender do modelo.
 */
export async function applyBrandTemplate(t: BrandTemplate, mode: ApplyMode): Promise<boolean> {
  const p = st().project
  if (!p) return false
  if (st().txBase) st().commitTx()
  const projectId = p.id
  const atUs = st().playheadUs
  const assetMap: Record<string, Asset> = {}
  const fresh: Asset[] = []
  if (t.assets.length) {
    try {
      await flushAutosave()
      const list = await window.api.brand.materialize(t.id, projectId)
      const cur = st().project
      if (cur?.id !== projectId) return false
      for (const { assetId, asset } of list) {
        const src = asset.source
        const existing = src.type === 'generated' ? cur.assets.find((a) => a.source.type === 'generated' && a.source.file === src.file) : undefined
        assetMap[assetId] = existing ?? asset
        if (!existing) fresh.push(asset)
      }
    } catch (e) {
      toast.error(`Não foi possível usar o modelo “${t.name}”: ${ipcErrorMessage(e)}`)
      return false
    }
  }
  let result: ReturnType<typeof applyTemplate> | null = null
  const ok = st().apply((q) => {
    result = applyTemplate(q, t, assetMap, mode, atUs)
    return result.project
  })
  if (!ok || !result) return false
  const r = result as ReturnType<typeof applyTemplate>
  st().select(r.itemIds)
  const msg = applyMessage(mode, t)
  if (r.warnings.length) toast.warning(msg.title, { description: `${r.warnings.join(' ')} ${msg.description}` })
  else toast.success(msg.title, { description: msg.description })
  if (fresh.some((a) => a.status === 'processing')) {
    // o main só enfileira assets que conhece: salva antes de pedir filmstrip/peaks
    await flushAutosave().catch(() => {})
    for (const a of fresh) if (a.status === 'processing') void enqueueAsset(projectId, a)
  }
  return true
}
