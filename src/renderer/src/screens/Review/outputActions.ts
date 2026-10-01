import { toast } from 'sonner'

// Ações sobre um arquivo exportado, compartilhadas pela Revisão (ExportDone) e pelo diálogo de
// exportação do editor.

/** Copia o arquivo para a área de transferência (colar no WhatsApp, e-mail ou Explorer). */
export async function copyOutputFile(path: string): Promise<void> {
  await window.api.app.copyFile(path)
  toast.success('Arquivo copiado — cole no WhatsApp, e-mail ou Explorer.')
}

/** Abre o Explorer com o arquivo selecionado. */
export function showOutputInFolder(path: string): void {
  void window.api.app.showItemInFolder(path)
}
