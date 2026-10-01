// Mensagens entre a thread principal (AudioClient) e o audio worker.
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from '../mediaUrls'

export type AudioIn =
  // useProxy: mesma variante do vídeo no preview (o proxy tem o áudio a:0 em AAC)
  | { t: 'project'; project: Project; mediaUrls: MediaUrls; useProxy: boolean }
  | { t: 'render'; fromUs: Us; frames: number; seq: number } // mixa [fromUs, fromUs + frames/48 kHz)
  | { t: 'dispose' }

export type AudioOut =
  | { t: 'block'; seq: number; fromUs: Us; pcm: Float32Array } // estéreo intercalado 48 kHz (transferido)
  | { t: 'error'; message: string; seq?: number }
