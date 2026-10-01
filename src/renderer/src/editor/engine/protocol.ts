// Mensagens entre a thread principal (RenderClient) e o render worker. Um único caminho de render
// para preview e exportação ("preview = export").
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from './mediaUrls'

export type HwPref = 'prefer-hardware' | 'prefer-software'

export interface ExportJobSpec {
  jobId: string
  width: number
  height: number
  fps: number
  /** Intervalo da timeline exportado; o arquivo começa em 0 = fromUs. */
  fromUs: Us
  toUs: Us
  video: { bitrate: number; hw: HwPref; keyFrameIntervalS: number }
  /** null: sem faixa de áudio (projeto sem áudio). Codec escolhido no worker: AAC, ou Opus se AAC indisponível. */
  audio: { bitrate: number } | null
  /** Testes: simula falha do encoder de hardware antes do 1º pacote. */
  simulateHwFailure?: boolean
}

export type RenderIn =
  | { t: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { t: 'project'; project: Project; mediaUrls: MediaUrls; useProxy: boolean }
  | { t: 'resize'; width: number; height: number }
  | { t: 'frame'; tUs: Us; seq: number; playing: boolean } // pede render do quadro tUs
  | { t: 'overlay'; selection: string[]; guides: boolean } // contorno do selecionado (só preview)
  | { t: 'idle' } // pausa/ociosidade: libera os buffers de reprodução dos decoders
  | { t: 'dispose' } // libera GL e decoders; responde `disposed`
  // exportação (instância própria do worker, canvas na resolução de saída): ver render.worker.ts
  | { t: 'exportStart'; job: ExportJobSpec; audioPort: MessagePort | null }
  | { t: 'exportCancel'; jobId: string }
  | { t: 'chunkAck'; jobId: string; seq: number }
  // testes: lê pixels do último quadro (coordenadas do canvas, origem em cima à esquerda)
  | { t: 'readPixels'; id: number; x: number; y: number; w: number; h: number }

export type RenderOut =
  | { t: 'ready' }
  | { t: 'rendered'; seq: number; tUs: Us; ms: number; missing: string[] }
  // seq: erro ao renderizar esse pedido de quadro (encerra os pedidos até ele); sem seq: erro de outra mensagem
  | { t: 'error'; message: string; fatal: boolean; seq?: number }
  | { t: 'disposed' }
  | { t: 'exportProgress'; jobId: string; frame: number; total: number }
  // bytes do MP4 a gravar em `position` (o cliente responde chunkAck depois de gravar: contrapressão)
  | { t: 'exportChunk'; jobId: string; seq: number; data: Uint8Array; position: number }
  | { t: 'exportDone'; jobId: string; lastSeq: number; videoCodec: string; audioCodec: 'aac' | 'opus' | null; hardware: HwPref }
  // beforeFirstPacket: o encoder de vídeo falhou antes de produzir qualquer pacote (dá para tentar outro modo)
  | { t: 'exportError'; jobId: string; message: string; cancelled: boolean; beforeFirstPacket: boolean }
  // testes: RGBA linha a linha de cima para baixo
  | { t: 'pixels'; id: number; data: Uint8Array }
