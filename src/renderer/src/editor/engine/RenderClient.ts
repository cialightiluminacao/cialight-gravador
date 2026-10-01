// Cliente (thread principal) do render worker: transfere o canvas, envia projeto/pedidos de quadro e
// resolve as promessas. Pedidos coalescidos pelo worker são resolvidos com o quadro posterior que os cobriu.
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from './mediaUrls'
import type { ExportJobSpec, RenderIn, RenderOut } from './protocol'

type Rendered = Extract<RenderOut, { t: 'rendered' }>
type ErrorOut = Extract<RenderOut, { t: 'error' }>

export class RenderClient {
  private readonly worker: Worker
  private seq = 0
  private pixelId = 0
  private readonly frames = new Map<number, (r: Rendered | ErrorOut) => void>()
  private readonly pixels = new Map<number, (d: Uint8Array) => void>()
  private readonly listeners = new Set<(m: RenderOut) => void>()
  readonly ready: Promise<void>

  /**
   * `width`/`height` em pixels CSS; o worker desenha em width·dpr × height·dpr. Um OffscreenCanvas (instância
   * de exportação, sem elemento na página) é transferido direto.
   */
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, size: { width: number; height: number; dpr?: number }) {
    this.worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
    let onReady: () => void = () => {}
    let onFail: (e: Error) => void = () => {}
    this.ready = new Promise<void>((res, rej) => {
      onReady = res
      onFail = rej
    })
    this.worker.addEventListener('message', (e: MessageEvent<RenderOut>) => {
      const m = e.data
      if (m.t === 'ready') onReady()
      else if (m.t === 'rendered') this.settleFrames(m.seq, m)
      else if (m.t === 'pixels') {
        this.pixels.get(m.id)?.(m.data)
        this.pixels.delete(m.id)
      } else if (m.t === 'error') {
        if (m.fatal) {
          onFail(new Error(m.message))
          this.settleFrames(Infinity, m) // worker inutilizável: encerra todos os pedidos
        } else if (m.seq !== undefined) this.settleFrames(m.seq, m) // falha desse quadro (e dos coalescidos antes dele)
        // erro de outra mensagem (sem seq): não afeta pedidos de quadro
      } else if (m.t === 'disposed') this.worker.terminate()
      for (const l of this.listeners) l(m)
    })
    this.ready.catch(() => {}) // quem não espera `ready` não gera rejeição não tratada
    this.worker.addEventListener('error', (e) => {
      const err: ErrorOut = { t: 'error', message: e.message || 'falha no render worker', fatal: true }
      onFail(new Error(err.message))
      this.settleFrames(Infinity, err)
      for (const l of this.listeners) l(err)
    })
    const off = canvas instanceof OffscreenCanvas ? canvas : canvas.transferControlToOffscreen()
    this.send({ t: 'init', canvas: off, width: size.width, height: size.height, dpr: size.dpr ?? 1 }, [off])
  }

  setProject(project: Project, mediaUrls: MediaUrls, useProxy: boolean): void {
    this.send({ t: 'project', project, mediaUrls, useProxy })
  }

  resize(width: number, height: number): void {
    this.send({ t: 'resize', width, height })
  }

  setOverlay(selection: string[], guides = false): void {
    this.send({ t: 'overlay', selection, guides })
  }

  /** Pausa/ociosidade: o worker libera os quadros que os decoders guardam para a reprodução. */
  idle(): void {
    this.send({ t: 'idle' })
  }

  /** Renderiza o quadro em tUs; resolve com `rendered` (ou `error`). */
  requestFrame(tUs: Us, playing: boolean): Promise<RenderOut> {
    const seq = ++this.seq
    return new Promise<RenderOut>((resolve) => {
      this.frames.set(seq, resolve)
      this.send({ t: 'frame', tUs, seq, playing })
    })
  }

  /** Testes: pixels do último quadro (origem em cima à esquerda, linhas de cima para baixo). */
  readPixels(x: number, y: number, w: number, h: number): Promise<Uint8Array> {
    const id = ++this.pixelId
    return new Promise((resolve) => {
      this.pixels.set(id, resolve)
      this.send({ t: 'readPixels', id, x, y, w, h })
    })
  }

  /** Exportação: inicia o job (a porta do audio worker de exportação é transferida). */
  exportStart(job: ExportJobSpec, audioPort: MessagePort | null): void {
    this.send({ t: 'exportStart', job, audioPort }, audioPort ? [audioPort] : [])
  }

  exportCancel(jobId: string): void {
    this.send({ t: 'exportCancel', jobId })
  }

  /** Chunk `seq` gravado: libera o encoder (contrapressão). */
  chunkAck(jobId: string, seq: number): void {
    this.send({ t: 'chunkAck', jobId, seq })
  }

  /** Mensagens do worker (progresso/chunks de exportação, erros). Devolve a função de remoção. */
  onMessage(cb: (m: RenderOut) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Pede ao worker para liberar GL/decoders e termina-o (ao receber `disposed`, ou após 1 s). */
  dispose(): void {
    this.send({ t: 'dispose' })
    setTimeout(() => this.worker.terminate(), 1000)
    this.settleFrames(Infinity, { t: 'error', message: 'render encerrado', fatal: true })
    this.pixels.clear()
    this.listeners.clear()
  }

  private send(m: RenderIn, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer)
  }

  private settleFrames(upTo: number, out: Rendered | ErrorOut): void {
    for (const [seq, resolve] of this.frames) {
      if (seq > upTo) continue
      this.frames.delete(seq)
      resolve(out)
    }
  }
}
