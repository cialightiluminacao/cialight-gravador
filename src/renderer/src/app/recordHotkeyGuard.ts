// Atalho de gravação (toggleRecord) com o editor aberto: decide o que fazer. Puro.
// - fora do editor (e sem editor "suspenso" em Histórico/Configurações): grava como sempre ('start');
// - no editor SEM fila ativa: recusa, como antes ("Saia do editor para gravar.");
// - com fila de exportações ativa (no editor, ou com o editor aberto por baixo de Histórico/Configurações): é uma
//   saída do editor — pergunta o mesmo que os outros caminhos ('confirm-leave'); cancelar = nada muda, nada grava.

export type RecordHotkeyDecision = 'start' | 'refuse-in-editor' | 'confirm-leave'

export function decideRecordHotkey(s: { screen: string; editorProjectId: string | null; queueActive: boolean }): RecordHotkeyDecision {
  const inEditor = s.screen === 'editor'
  const editorOpen = inEditor || s.editorProjectId !== null
  if (editorOpen && s.queueActive) return 'confirm-leave'
  return inEditor ? 'refuse-in-editor' : 'start'
}
