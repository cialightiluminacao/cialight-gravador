import { toast } from 'sonner'
import type { AppInfo } from '@shared/ipc'
import type { Settings } from '@shared/types'
import { useAppStore } from '@/app/store'
import { ipcErrorMessage } from '@/lib/ipcError'
import { showOutputInFolder } from '@/screens/Review/outputActions'
import { useEditorStore } from '../state/editorStore'
import { editorExportRunning } from '../export/exportLock'
import { exportStill } from '../export/formatExport'
import { stillFileName } from '../export/formatPlan'
import { stillNotice, stillPrivacyWarnings } from '../export/stillNotice'

// "Exportar quadro (PNG)" do editor (botão da barra superior e Ctrl+Shift+E): o quadro do cursor, no tamanho
// do projeto, vai direto para a pasta de exportação padrão com o nome "<projeto> - 00m12s.png"; um toast avisa
// (com "Abrir pasta"). Nenhuma ação silenciosa: sem projeto/pasta ou com outra exportação em andamento, toast de erro;
// com aviso de privacidade no instante (os mesmos do diálogo), toast de aviso com todos eles e "Revisar" — nunca um
// sucesso simples.

/** Pasta padrão das exportações do editor (QA fora do pacote: window.__qaEditor.exportDir; nunca a pasta real). */
export function defaultExportFolder(settings: Pick<Settings, 'outputDir'>, appInfo: AppInfo | null): string | null {
  const qaDir = appInfo?.isPackaged === false ? window.__qaEditor?.exportDir : undefined
  return qaDir ?? settings.outputDir ?? appInfo?.paths.output ?? null
}

export async function exportCurrentFrame(): Promise<void> {
  const { project, playheadUs } = useEditorStore.getState()
  if (!project) return
  if (editorExportRunning()) {
    toast.error('Já existe uma exportação em andamento', { description: 'Espere ela terminar para exportar o quadro.' })
    return
  }
  const { settings, appInfo } = useAppStore.getState()
  const dir = defaultExportFolder(settings, appInfo)
  if (!dir) {
    toast.error('Não há pasta de destino para o quadro', { description: 'Escolha uma pasta de saída nas configurações.' })
    return
  }
  try {
    const r = await exportStill({ project, tUs: playheadUs, outputDir: dir, fileName: stillFileName(project.name, playheadUs) })
    const n = stillNotice(project, r, stillPrivacyWarnings(project, playheadUs))
    const openFolder = { label: 'Abrir pasta', onClick: () => showOutputInFolder(r.path) }
    const reviewId = n.reviewItemId
    if (reviewId) {
      // "Revisar": seleciona o efeito (o cursor já está no instante do quadro)
      toast.warning(n.title, { description: n.description, duration: 15_000, action: { label: 'Revisar', onClick: () => useEditorStore.getState().select([reviewId]) }, cancel: openFolder })
    } else toast.success(n.title, { description: n.description, action: openFolder })
  } catch (e) {
    toast.error('Não foi possível exportar o quadro', { description: ipcErrorMessage(e) })
  }
}
