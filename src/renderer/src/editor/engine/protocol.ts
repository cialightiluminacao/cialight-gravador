// Mensagens entre a thread principal (RenderClient) e o render worker. Um único caminho de render
// para preview e exportação ("preview = export").
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from './mediaUrls'

export type RenderIn =
  | { t: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { t: 'project'; project: Project; mediaUrls: MediaUrls; useProxy: boolean }
  | { t: 'resize'; width: number; height: number }
  | { t: 'frame'; tUs: Us; seq: number; playing: boolean } // pede render do quadro tUs
  | { t: 'overlay'; selection: string[]; guides: boolean } // contorno do selecionado (só preview)
  | { t: 'idle' } // pausa/ociosidade: libera os buffers de reprodução dos decoders
  | { t: 'dispose' } // libera GL e decoders; responde `disposed`
  | { t: 'exportStart'; width: number; height: number; fps: number; fromUs: Us; toUs: Us; jobId: string; video: { codec: 'avc' | 'hevc'; bitrate: number; hw: 'prefer-hardware' | 'prefer-software' } }
  | { t: 'exportCancel'; jobId: string }
  | { t: 'chunkAck'; seq: number }
  // testes: lê pixels do último quadro (coordenadas do canvas, origem em cima à esquerda)
  | { t: 'readPixels'; id: number; x: number; y: number; w: number; h: number }

export type RenderOut =
  | { t: 'ready' }
  | { t: 'rendered'; seq: number; tUs: Us; ms: number; missing: string[] }
  // seq: erro ao renderizar esse pedido de quadro (encerra os pedidos até ele); sem seq: erro de outra mensagem
  | { t: 'error'; message: string; fatal: boolean; seq?: number }
  | { t: 'disposed' }
  | { t: 'exportFrame'; jobId: string; frame: number; total: number } // progresso
  | { t: 'exportVideoChunk'; jobId: string; seq: number; data: Uint8Array; meta: unknown } // ver Task 12 (encoder vive no worker)
  | { t: 'exportDone'; jobId: string }
  | { t: 'exportError'; jobId: string; message: string }
  // testes: RGBA linha a linha de cima para baixo
  | { t: 'pixels'; id: number; data: Uint8Array }
