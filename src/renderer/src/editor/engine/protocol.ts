// Mensagens entre a thread principal (RenderClient) e o render worker. Um único caminho de render
// para preview e exportação ("preview = export").
import type { CursorTrackV1 } from '@shared/cursor'
import type { Project, Us } from '@shared/editor/project'
import type { TrackBox, TrackOpts, TrackResult } from '@shared/editor/track'
import type { MediaUrls } from './mediaUrls'
import type { CompositorMemStats } from './compositor/compositor'

export type HwPref = 'prefer-hardware' | 'prefer-software'

export interface ExportJobSpec {
  jobId: string
  width: number
  height: number
  fps: number
  /** Intervalo da timeline exportado; o arquivo começa em 0 = fromUs. */
  fromUs: Us
  toUs: Us
  /** codec: 'avc' (H.264) ou 'hevc' (só por hardware; MP4 com a tag hvc1). */
  video: { codec: 'avc' | 'hevc'; bitrate: number; hw: HwPref; keyFrameIntervalS: number }
  /** null: sem faixa de áudio (projeto sem áudio). Codec escolhido no worker: AAC, ou Opus se AAC indisponível. */
  audio: { bitrate: number } | null
  /** Testes: simula falha do encoder de hardware antes do 1º pacote. */
  simulateHwFailure?: boolean
  /** Testes: simula falha do encoder H.264 em software antes do 1º pacote (exercita o codificador de reserva). */
  simulateSoftwareFailure?: boolean
  /** Testes: simula falha do encoder HEVC antes do 1º pacote (exercita a volta para H.264). */
  simulateHevcFailure?: boolean
}

/**
 * Quadros RGBA da exportação (GIF; fallback libx264): o mesmo caminho de quadros da exportação de vídeo
 * (tUs = fromUs + frameToUs(n, fps), frameCount, composeAt sequencial), lidos do canvas em vez de codificados.
 */
export interface FramesJobSpec {
  jobId: string
  width: number
  height: number
  fps: number
  fromUs: Us
  toUs: Us
}

/**
 * "Seguir conteúdo" (F6, instância própria do worker, canvas width×height na resolução de análise): quadros de
 * trackFrameTimes(fromUs, toUs, fps) compostos só com as camadas abaixo do efeito `effectItemId` (R10) → cinza → NCC
 * (shared/editor/track.ts) a partir do molde `box` (px da análise).
 */
export interface TrackJobSpec {
  jobId: string
  width: number
  height: number
  fps: number
  fromUs: Us
  toUs: Us
  effectItemId: string
  box: TrackBox
  opts?: Partial<TrackOpts>
}

export type RenderIn =
  | { t: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { t: 'project'; project: Project; mediaUrls: MediaUrls; useProxy: boolean }
  // trilhas do cursor por id do asset (entrada lateral do resolveFrame, F6): só as entradas que mudaram; null = remover
  | { t: 'cursorTracks'; tracks: Record<string, CursorTrackV1 | null> }
  | { t: 'resize'; width: number; height: number }
  | { t: 'frame'; tUs: Us; seq: number; playing: boolean } // pede render do quadro tUs
  | { t: 'overlay'; selection: string[]; guides: boolean } // contorno do selecionado (só preview)
  | { t: 'idle' } // pausa/ociosidade: libera os buffers de reprodução dos decoders
  | { t: 'dispose' } // libera GL e decoders; responde `disposed`
  // exportação (instância própria do worker, canvas na resolução de saída): ver render.worker.ts
  | { t: 'exportStart'; job: ExportJobSpec; audioPort: MessagePort | null }
  | { t: 'exportCancel'; jobId: string }
  // chunk (exportChunk) ou quadro (exportFrame) `seq` gravado: libera o worker (contrapressão)
  | { t: 'chunkAck'; jobId: string; seq: number }
  // rastreamento de conteúdo (instância própria do worker): ver TrackJobSpec
  | { t: 'trackStart'; job: TrackJobSpec }
  | { t: 'trackCancel'; jobId: string }
  | { t: 'exportFramesStart'; job: FramesJobSpec }
  // quadro único em tUs no tamanho do canvas, como PNG (canvas.convertToBlob)
  | { t: 'exportStill'; id: number; tUs: Us }
  // testes: lê pixels do último quadro (coordenadas do canvas, origem em cima à esquerda)
  | { t: 'readPixels'; id: number; x: number; y: number; w: number; h: number }
  // testes: trava a thread do worker por `ms` (simula decoder/GPU pendurado para o watchdog)
  | { t: 'testStall'; ms: number }
  // testes: reprodução sequencial de `frames` quadros a partir de tUs medindo desenho + GPU (sync) por quadro
  | { t: 'testBench'; id: number; tUs: Us; frames: number; fps: number }
  // memória do compositor (QA/testes): texturas das camadas e do passe de efeitos
  | { t: 'memStats'; id: number }
  // testes: orçamento das texturas das camadas (null = o padrão, 512 MiB)
  | { t: 'testTextureBudget'; bytes: number | null }

export type RenderOut =
  | { t: 'ready' }
  // fontsPending: algum texto saiu com a fonte de reserva (ainda carregando); o worker redesenha quando ela carregar
  | { t: 'rendered'; seq: number; tUs: Us; ms: number; missing: string[]; fontsPending?: boolean }
  // seq: erro ao renderizar esse pedido de quadro (encerra os pedidos até ele); sem seq: erro de outra mensagem
  | { t: 'error'; message: string; fatal: boolean; seq?: number }
  | { t: 'disposed' }
  | { t: 'exportProgress'; jobId: string; frame: number; total: number }
  // bytes do MP4 a gravar em `position` (o cliente responde chunkAck depois de gravar: contrapressão)
  | { t: 'exportChunk'; jobId: string; seq: number; data: Uint8Array; position: number }
  // missing: assets desenhados como "mídia indisponível" (quadros por asset); missingAnnotations: gravações
  // cujas anotações não puderam ser lidas — viram avisos na tela de concluído
  | { t: 'exportDone'; jobId: string; lastSeq: number; videoCodec: string; audioCodec: 'aac' | 'opus' | null; audioBitrate: number; hardware: HwPref; missing: { assetId: string; frames: number }[]; missingAnnotations: string[]; missingFonts: string[] }
  // encoderError: a falha veio do codificador; beforeFirstPacket: antes de qualquer pacote de vídeo
  // (só as duas juntas justificam tentar outro modo de hardware)
  | { t: 'exportError'; jobId: string; message: string; cancelled: boolean; beforeFirstPacket: boolean; encoderError: boolean }
  // rastreamento: um quadro analisado; no fim todos (em ordem); erro (cancelled: pedido pelo cliente)
  | { t: 'trackProgress'; jobId: string; frame: number; total: number; result: TrackResult }
  | { t: 'trackDone'; jobId: string; results: TrackResult[] }
  | { t: 'trackError'; jobId: string; message: string; cancelled: boolean }
  // quadro n = seq − 1 de `total`: RGBA w×h linha a linha de cima para baixo (buffer transferido); responder chunkAck
  | { t: 'exportFrame'; jobId: string; seq: number; total: number; rgba: ArrayBuffer; w: number; h: number }
  | { t: 'exportFramesDone'; jobId: string; frames: number; missing: { assetId: string; frames: number }[]; missingAnnotations: string[]; missingFonts?: string[] }
  // png null: falhou (error)
  | { t: 'still'; id: number; png: ArrayBuffer | null; error?: string; missing: string[]; missingAnnotations: string[]; missingFonts?: string[] }
  // fontes de texto que não carregaram (erro ou prazo de 10 s): o texto aparece com a fonte padrão; o editor avisa
  | { t: 'fontWarning'; families: string[] }
  // testes: RGBA linha a linha de cima para baixo
  | { t: 'pixels'; id: number; data: Uint8Array }
  // testes: drawMs = compositor (desenho + espera da GPU); frameMs = quadro inteiro (decodificação inclusa)
  | { t: 'bench'; id: number; drawMs: number[]; frameMs: number[]; error?: string }
  // stats null: worker sem compositor (antes do init/depois do dispose)
  | { t: 'memStats'; id: number; stats: CompositorMemStats | null }
