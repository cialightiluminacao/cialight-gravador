// Saída do editor registrada pela EditorScreen (assenta a narração, pausa, grava o autosave e fecha) — para quem sai
// do editor por fora da tela (atalho de gravação). Sem editor montado: só fecha.
import { useAppStore } from '@/app/store'

let handler: (() => Promise<void>) | null = null

export function registerEditorLeave(fn: () => Promise<void>): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

export async function leaveEditorNow(): Promise<void> {
  if (handler) await handler()
  else if (useAppStore.getState().editorProjectId) useAppStore.getState().closeEditor()
}
