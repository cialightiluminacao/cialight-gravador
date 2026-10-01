import type { ProjectSummary } from '@shared/ipc'
import { useAppStore } from '@/app/store'

// Gravação → editor. "Editar" reabre o projeto mais recente já criado daquela gravação (se houver);
// "Novo projeto desta gravação" (forceNew) sempre cria outro.

export function pickProjectForSession(list: ProjectSummary[], sessionId: string): ProjectSummary | null {
  let best: ProjectSummary | null = null
  for (const p of list) if (p.originSessionId === sessionId && (!best || p.updatedAt > best.updatedAt)) best = p
  return best
}

export async function openRecordingInEditor(sessionId: string, opts?: { forceNew?: boolean }): Promise<void> {
  if (!opts?.forceNew) {
    const existing = pickProjectForSession(await window.api.project.list(), sessionId)
    if (existing) {
      useAppStore.getState().openEditor(existing.id)
      return
    }
  }
  const project = await window.api.project.fromSession(sessionId)
  useAppStore.getState().openEditor(project.id)
}
