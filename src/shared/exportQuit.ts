// Texto da confirmação de saída com exportações do editor em andamento/na fila (main: sair do app; renderer:
// sair do editor). Puro.

export interface ExportCounts {
  /** Exportações rodando agora (0 ou 1: uma por vez). */
  running: number
  /** Itens esperando na fila. */
  pending: number
}

const exportacoes = (n: number): string => `${n} ${n === 1 ? 'exportação' : 'exportações'}`

/** "Há 1 exportação em andamento e 2 na fila." + "Sair interrompe as exportações; elas ficam salvas e você pode retomá-las depois." */
export function exportQuitText(c: ExportCounts): { message: string; detail: string } {
  if (c.pending <= 0) return { message: `Há ${exportacoes(Math.max(1, c.running))} em andamento.`, detail: 'Sair interrompe a exportação; ela fica salva e você pode retomá-la depois.' }
  const message = c.running > 0 ? `Há ${exportacoes(c.running)} em andamento e ${c.pending} na fila.` : `Há ${exportacoes(c.pending)} na fila.`
  return { message, detail: 'Sair interrompe as exportações; elas ficam salvas e você pode retomá-las depois.' }
}
