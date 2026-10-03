// Confirmação de saída: gravação ou exportação do editor em andamento perguntam UMA vez por saída. A saída
// passa várias vezes pelo before-quit (flush do editor, cancelamento da exportação no will-quit e o
// app.quit() que cada um refaz): depois de confirmada, não pergunta de novo.
import { exportQuitText, type ExportCounts } from '@shared/exportQuit'

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

export { exportQuitText, type ExportCounts }

/**
 * Estado da fila de exportações informado por cada janela do editor (editorExport.setQueueState). O job do main e o
 * item rodando da fila são a mesma exportação: rodando = 1 se qualquer um dos dois. Janela fechada/recarregada → drop.
 */
export class ExportQueueStates {
  private byOwner = new Map<number, { running: boolean; pending: number }>()

  set(owner: number, s: { running: boolean; pending: number } | null | undefined): void {
    const running = s?.running === true
    const pending = Number.isFinite(s?.pending) ? Math.max(0, Math.floor(Number(s?.pending))) : 0
    if (!running && !pending) this.byOwner.delete(owner)
    else this.byOwner.set(owner, { running, pending })
  }

  drop(owner: number): void {
    this.byOwner.delete(owner)
  }

  counts(jobBusy: boolean): ExportCounts {
    let running = 0
    let pending = 0
    for (const s of this.byOwner.values()) {
      running += s.running ? 1 : 0
      pending += s.pending
    }
    return { running: Math.max(running, jobBusy ? 1 : 0), pending }
  }
}

// exportações do editor em andamento/na fila (registradas pelo IPC, dono dos jobs e do estado das filas)
let exportCounts: () => ExportCounts = () => ({ running: 0, pending: 0 })

export function setExportCountsSource(fn: () => ExportCounts): void {
  exportCounts = fn
}

export function editorExportCounts(): ExportCounts {
  return exportCounts()
}

/** Exportação do editor rodando ou na fila. */
export function isEditorExportBusy(): boolean {
  const c = exportCounts()
  return c.running > 0 || c.pending > 0
}
