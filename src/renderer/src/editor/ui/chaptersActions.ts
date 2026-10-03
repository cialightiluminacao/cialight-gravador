import { toast } from 'sonner'
import { sanitizeFileName } from '@shared/filenames'
import { contentEndUs } from '@shared/editor/ops'
import { baseName, joinDefaultPath } from '@shared/editor/chapters'
import { ipcErrorMessage } from '@/lib/ipcError'
import { showOutputInFolder } from '@/screens/Review/outputActions'
import { useEditorStore } from '../state/editorStore'
import { chaptersForEditor } from './chaptersRange'

// Capítulos do YouTube (texto para a descrição) a partir dos marcadores: copiar e salvar .txt.

/** Copia o texto; toast com o resultado (nenhuma ação silenciosa). */
export async function copyChaptersText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Capítulos copiados')
    return true
  } catch (e) {
    toast.error('Não foi possível copiar os capítulos', { description: ipcErrorMessage(e) })
    return false
  }
}

/** Nome padrão do .txt: "<projeto> - capítulos.txt". */
export function chaptersFileName(projectName: string): string {
  return `${sanitizeFileName(projectName) || 'Projeto'} - capítulos.txt`
}

/** "Salvar .txt": caixa de diálogo no main (CRLF, sem BOM); null se cancelou. */
export async function saveChaptersText(text: string, projectName: string, folder: string | null): Promise<string | null> {
  const name = chaptersFileName(projectName)
  try {
    const path = await window.api.editorExport.saveText(joinDefaultPath(folder, name), text)
    if (path) toast.success(`Capítulos salvos: ${baseName(path)}`, { action: { label: 'Abrir pasta', onClick: () => showOutputInFolder(path) } })
    return path
  } catch (e) {
    toast.error('Não foi possível salvar os capítulos', { description: ipcErrorMessage(e) })
    return null
  }
}

/** Ação da barra superior: copia os capítulos do intervalo I–O (se marcado) ou de tudo. */
export async function copyProjectChapters(): Promise<void> {
  const { project, inUs, outUs } = useEditorStore.getState()
  if (!project) return
  const r = chaptersForEditor(project.markers, contentEndUs(project), inUs, outUs)
  if (!r.chapters.length) {
    toast.info('Adicione marcadores (M) para gerar capítulos')
    return
  }
  if (await copyChaptersText(r.text)) {
    if (r.warnings.length) toast.warning('Atenção com os capítulos', { description: r.warnings.join(' · ') })
  }
}
