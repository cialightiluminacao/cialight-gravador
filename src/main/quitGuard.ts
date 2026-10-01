// Confirmação de saída: gravação ou exportação do editor em andamento perguntam UMA vez por saída. A saída
// passa várias vezes pelo before-quit (flush do editor, cancelamento da exportação no will-quit e o
// app.quit() que cada um refaz): depois de confirmada, não pergunta de novo.

export type QuitReason = 'recording' | 'export'

export interface QuitGuardDeps {
  isRecording: () => boolean
  isExporting: () => boolean
  /** Pergunta ao usuário; true = sair mesmo assim. */
  ask: (reason: QuitReason) => boolean
  /** false nos testes de integração (sem diálogo). */
  enabled: () => boolean
}

export interface QuitGuard {
  /** true = pode sair/fechar. */
  confirm(): boolean
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let confirmed = false
  return {
    confirm() {
      if (confirmed || !deps.enabled()) return true
      const reason: QuitReason | null = deps.isRecording() ? 'recording' : deps.isExporting() ? 'export' : null
      if (!reason) return true
      if (!deps.ask(reason)) return false
      confirmed = true
      return true
    }
  }
}

// instância do app (configurada no bootstrap; a janela do gravador consulta ao fechar)
let appGuard: QuitGuard = { confirm: () => true }

export function setAppQuitGuard(g: QuitGuard): void {
  appGuard = g
}

export function confirmQuit(): boolean {
  return appGuard.confirm()
}

// exportação do editor em andamento (registrada pelo IPC, dono dos jobs)
let exportBusy: () => boolean = () => false

export function setExportBusyCheck(fn: () => boolean): void {
  exportBusy = fn
}

export function isEditorExportBusy(): boolean {
  return exportBusy()
}
