// Arquivo da narração em generated/ (renderer): abre pelo IPC (project.writeGenerated*) e liga o encoder ao handle.
// Separado de narration.ts (AudioWorklet, mediabunny) para ser testável: qualquer falha entre abrir o arquivo e o
// encoder começar fecha o handle e descarta o arquivo e o marcador — nada fica para "recuperar" de uma gravação que
// nem começou.
import type { GeneratedMeta, IpcApi } from '@shared/ipc'

export type NarrationFileApi = Pick<IpcApi['project'], 'writeGeneratedOpen' | 'writeGenerated' | 'writeGeneratedClose' | 'clearPendingGenerated'>

/** Fragmento do MP4 da narração: numa queda perde-se no máximo isto do final. */
export const NARRATION_FRAGMENT_SEC = 0.25

export interface OpenedNarrationFile<T> { handle: number; rel: string; out: T }

/**
 * Abre `generated/narracao-<n>.m4a`, monta a saída com `make(write)` — `write` grava por posição no handle e avisa
 * `onWriteError` na 1ª falha (disco cheio, handle perdido) antes de repassá-la — e chama `start()` dela. Falhou depois
 * de abrir (ou `cancelled()` virou true no meio): fecha e descarta (arquivo + marcador) e lança.
 */
export async function openNarrationFile<T extends { start(): Promise<void> }>(
  api: NarrationFileApi,
  projectId: string,
  meta: GeneratedMeta,
  make: (write: (data: Uint8Array, position: number) => Promise<void>) => T,
  opts: { onWriteError?: (e: unknown) => void; cancelled?: () => boolean } = {}
): Promise<OpenedNarrationFile<T>> {
  const { handle, rel } = await api.writeGeneratedOpen(projectId, 'narracao', 'm4a', meta)
  let failed = false
  const write = async (data: Uint8Array, position: number): Promise<void> => {
    try {
      await api.writeGenerated(handle, data, position)
    } catch (e) {
      if (!failed) {
        failed = true
        opts.onWriteError?.(e)
      }
      throw e
    }
  }
  try {
    const out = make(write)
    await out.start()
    if (opts.cancelled?.()) throw new NarrationCancelled()
    return { handle, rel, out }
  } catch (e) {
    await discardNarrationFile(api, projectId, handle, rel)
    throw e
  }
}

/** Fecha o handle e apaga o arquivo e o marcador (gravação que não valeu). Nunca lança. */
export async function discardNarrationFile(api: NarrationFileApi, projectId: string, handle: number | null, rel: string): Promise<void> {
  if (handle !== null) await api.writeGeneratedClose(handle).catch(() => {})
  await api.clearPendingGenerated(projectId, rel, { discardFile: true }).catch(() => {})
}

/** A gravação foi cancelada enquanto começava. */
export class NarrationCancelled extends Error {
  constructor() {
    super('gravação cancelada')
    this.name = 'NarrationCancelled'
  }
}
