// Mensagens trocadas entre o cliente (exportComposer.ts) e o Web Worker (exportComposer.worker.ts).
import type { PipKeyframe, Session } from '@shared/types'

/** Subconjunto da sessão de que o compositor precisa (serializável para o worker). */
export type ComposeSession = Pick<Session, 'pip' | 'strokes' | 'clearEvents'> & { camMirrored: boolean }

export interface ComposeStartMessage {
  type: 'start'
  /** URL cialight-file:// do rec.mp4. */
  recUrl: string
  session: ComposeSession
  includeWebcam: boolean
  includeAnnotations: boolean
  pipOverride: PipKeyframe[] | null
  autoFadeMs: number | null
  trimStartMs: number
  trimEndMs: number
  fps: number
  width: number
  height: number
}

export interface ComposeCancelMessage {
  type: 'cancel'
}

/** Confirmação de gravação de um lote de chunks (contrapressão worker ← cliente). */
export interface ComposeAckMessage {
  type: 'ack'
  seq: number
}

export type ComposeInbound = ComposeStartMessage | ComposeCancelMessage | ComposeAckMessage

export interface ComposeChunkMessage {
  type: 'chunk'
  seq: number
  data: Uint8Array
  position: number
}

export interface ComposeProgressMessage {
  type: 'progress'
  percent: number
  framesDone: number
  frameCount: number
}

export interface ComposeDoneMessage {
  type: 'done'
  /** Último seq de chunk emitido (o cliente espera todas as escritas antes de fechar). */
  lastSeq: number
}

export interface ComposeErrorMessage {
  type: 'error'
  message: string
}

export type ComposeOutbound = ComposeChunkMessage | ComposeProgressMessage | ComposeDoneMessage | ComposeErrorMessage

/** Quantos chunks podem estar "no ar" (sem ack) antes de o worker esperar. */
export const COMPOSE_MAX_INFLIGHT_CHUNKS = 8
