// Cliente do compositor de exportação: sobe o Worker (mediabunny), grava os bytes de
// composed.mp4 na pasta da sessão via IPC (session.writeOpen/write/writeClose) e devolve o
// caminho absoluto. Progresso 0–100 e cancelamento por AbortSignal.
import type { ExportOptions, Session } from '@shared/types'
import ComposeWorker from './exportComposer.worker?worker'
import type { ComposeInbound, ComposeOutbound, ComposeStartMessage } from './composeProtocol'

export { needsComposition } from './composeMath'

export const COMPOSED_FILE = 'composed.mp4'

export interface ComposeSessionArgs {
  sessionId: string
  session: Session
  options: ExportOptions
  fps: number
  width: number
  height: number
  /** Duração conhecida da gravação (ms) — usada como fim quando não há corte final. */
  durationMs: number
  /** Sumiço automático das anotações (ms) ou null — vem de settings.annotations.autoFadeSec. */
  autoFadeMs: number | null
  onProgress: (percent: number) => void
  signal: AbortSignal
}

export class ComposeCancelledError extends Error {
  constructor() {
    super('Composição cancelada')
    this.name = 'ComposeCancelledError'
  }
}

/**
 * Descarta o composed.mp4 da sessão (intermediário pesado, ~20 Mbps): abrir para escrita com
 * flag 'w' zera o arquivo — não há IPC de exclusão de arquivo avulso na pasta bruta.
 */
export async function discardComposed(sessionId: string): Promise<void> {
  const api = window.api
  const handle = await api.session.writeOpen(sessionId, COMPOSED_FILE)
  await api.session.writeClose(handle)
}

/** Compõe tela + PiP + traços em composed.mp4 (fMP4, só vídeo) e devolve o caminho absoluto. */
export async function composeSession(args: ComposeSessionArgs): Promise<string> {
  const { sessionId, session, options, signal } = args
  if (signal.aborted) throw new ComposeCancelledError()
  const api = window.api
  const durationMs = args.durationMs > 0 ? args.durationMs : (session.durationMs ?? 0)
  const trimEndMs = options.trimEndMs !== null && options.trimEndMs > options.trimStartMs ? options.trimEndMs : durationMs

  const start: ComposeStartMessage = {
    type: 'start',
    recUrl: api.session.fileUrl(sessionId, session.files.rec),
    session: { pip: session.pip, strokes: session.strokes, clearEvents: session.clearEvents, camMirrored: session.webcam?.mirrored ?? false },
    includeWebcam: options.includeWebcam && session.tracks.webcam !== undefined,
    includeAnnotations: options.includeAnnotations && session.strokes.length > 0,
    pipOverride: options.pipOverride,
    autoFadeMs: args.autoFadeMs,
    trimStartMs: Math.max(0, options.trimStartMs),
    trimEndMs,
    fps: args.fps,
    width: args.width,
    height: args.height
  }

  const handle = await api.session.writeOpen(sessionId, COMPOSED_FILE)
  const worker = new ComposeWorker()
  const send = (m: ComposeInbound): void => worker.postMessage(m)

  return new Promise<string>((resolve, reject) => {
    let writes: Promise<void> = Promise.resolve()
    let settled = false
    let writeError: Error | null = null

    const finish = async (outcome: { ok: true } | { ok: false; error: Error }): Promise<void> => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      await writes.catch(() => {})
      worker.terminate()
      await api.session.writeClose(handle).catch(() => {})
      if (!outcome.ok) {
        reject(outcome.error)
        return
      }
      resolve(await api.session.filePath(sessionId, COMPOSED_FILE))
    }

    const onAbort = (): void => {
      send({ type: 'cancel' })
      void finish({ ok: false, error: new ComposeCancelledError() })
    }
    signal.addEventListener('abort', onAbort)

    worker.addEventListener('message', (evt: MessageEvent<ComposeOutbound>) => {
      const msg = evt.data
      if (settled) return
      switch (msg.type) {
        case 'chunk':
          writes = writes
            .then(() => api.session.write(handle, msg.data, msg.position))
            .then(
              () => send({ type: 'ack', seq: msg.seq }),
              (e: unknown) => {
                writeError = e instanceof Error ? e : new Error(String(e))
                send({ type: 'cancel' })
                void finish({ ok: false, error: writeError })
              }
            )
          break
        case 'progress':
          args.onProgress(msg.percent)
          break
        case 'done':
          void writes.then(
            () => finish({ ok: true }),
            () => finish({ ok: false, error: writeError ?? new Error('Falha ao gravar composed.mp4') })
          )
          break
        case 'error':
          void finish({ ok: false, error: msg.message === 'cancelado' ? new ComposeCancelledError() : new Error(msg.message) })
          break
      }
    })
    worker.addEventListener('error', (evt) => {
      void finish({ ok: false, error: new Error(evt.message || 'Falha no compositor de vídeo') })
    })
    send(start)
  })
}
