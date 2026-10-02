// Mensagens entre a thread principal (AudioClient) e o audio worker.
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from '../mediaUrls'

export type AudioIn =
  // useProxy: mesma variante do vídeo no preview (o proxy tem o áudio a:0 em AAC);
  // bypassProcessing: comparar A/B (segurando o botão) — toca o original mesmo com o áudio processado pronto
  | { t: 'project'; project: Project; mediaUrls: MediaUrls; useProxy: boolean; bypassProcessing?: boolean }
  // mixa [fromUs, fromUs + frames/48 kHz); rate (shuttle J/K/L, 0 < rate ≤ 2): os frames cobrem frames·rate da timeline
  | { t: 'render'; fromUs: Us; frames: number; seq: number; rate?: number }
  | { t: 'cancel' } // seek/pausa: descarta os pedidos na fila e o aquecimento ainda não iniciado
  | { t: 'dispose' }
  // exportação: porta (MessageChannel) pela qual o render worker pede blocos ('render') e recebe 'block'/'error'
  | { t: 'port'; port: MessagePort }

export type AudioOut =
  | { t: 'block'; seq: number; fromUs: Us; pcm: Float32Array } // estéreo intercalado 48 kHz (transferido)
  | { t: 'error'; message: string; seq?: number; assetId?: string } // assetId: falha de mídia (uma vez por asset)
