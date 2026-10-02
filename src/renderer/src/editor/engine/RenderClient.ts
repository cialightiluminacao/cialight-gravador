// Cliente (thread principal) do render worker: transfere o canvas, envia projeto/pedidos de quadro e
// resolve as promessas. Pedidos coalescidos pelo worker são resolvidos com o quadro posterior que os cobriu.
// `restart` (watchdog do preview, spec §13) troca o worker travado por um novo num canvas novo — o
// OffscreenCanvas só pode ser transferido uma vez — e restaura projeto, seleção e tamanho.
import type { CursorTrackV1 } from '@shared/cursor'
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from './mediaUrls'
import type { ExportJobSpec, RenderIn, RenderOut } from './protocol'

type Rendered = Extract<RenderOut, { t: 'rendered' }>
type ErrorOut = Extract<RenderOut, { t: 'error' }>

export class RenderClient {
  private worker!: Worker
  private seq = 0
  private pixelId = 0
  private readonly frames = new Map<number, (r: Rendered | ErrorOut) => void>()
  private readonly pixels = new Map<number, (d: Uint8Array) => void>()
  private readonly listeners = new Set<(m: RenderOut) => void>()
  readonly ready: Promise<void>
  private onReady: () => void = () => {}
  private onFail: (e: Error) => void = () => {}
  // estado a restaurar num worker novo
  private size: { width: number; height: number; dpr: number }
  private project: { project: Project; mediaUrls: MediaUrls; useProxy: boolean } | null = null
  private overlay: { selection: string[]; guides: boolean } | null = null
  /** Trilhas do cursor já enviadas ao worker (por id do asset). */
  private cursors = new Map<string, CursorTrackV1>()
  private disposed = false

  /**
   * `width`/`height` em pixels CSS; o worker desenha em width·dpr × height·dpr. Um OffscreenCanvas (instância
   * de exportação, sem elemento na página) é transferido direto.
   */
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, size: { width: number; height: number; dpr?: number }) {
    this.size = { width: size.width, height: size.height, dpr: size.dpr ?? 1 }
    this.ready = new Promise<void>((res, rej) => {
      this.onReady = res
      this.onFail = rej
    })
    this.ready.catch(() => {}) // quem não espera `ready` não gera rejeição não tratada
    this.spawn(canvas)
  }

  /** Worker novo, com mensagens de um worker anterior (já trocado) ignoradas. */
  private spawn(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    const current = (): boolean => this.worker === worker
    worker.addEventListener('message', (e: MessageEvent<RenderOut>) => {
      if (!current()) return
      const m = e.data
      if (m.t === 'ready') this.onReady()
      else if (m.t === 'rendered') this.settleFrames(m.seq, m)
      else if (m.t === 'pixels') {
        this.pixels.get(m.id)?.(m.data)
        this.pixels.delete(m.id)
      } else if (m.t === 'error') {
        if (m.fatal) {
          this.onFail(new Error(m.message))
          this.settleFrames(Infinity, m) // worker inutilizável: encerra todos os pedidos
        } else if (m.seq !== undefined) this.settleFrames(m.seq, m) // falha desse quadro (e dos coalescidos antes dele)
        // erro de outra mensagem (sem seq): não afeta pedidos de quadro
      } else if (m.t === 'disposed') worker.terminate()
      for (const l of this.listeners) l(m)
    })
    worker.addEventListener('error', (e) => {
      if (!current()) return
      const err: ErrorOut = { t: 'error', message: e.message || 'falha no render worker', fatal: true }
      this.onFail(new Error(err.message))
      this.settleFrames(Infinity, err)
      for (const l of this.listeners) l(err)
    })
    const off = canvas instanceof OffscreenCanvas ? canvas : canvas.transferControlToOffscreen()
    this.send({ t: 'init', canvas: off, width: this.size.width, height: this.size.height, dpr: this.size.dpr }, [off])
  }

  /**
   * Troca o worker (travado/caído) por um novo desenhando em `canvas` (um canvas NOVO: o anterior já foi
   * transferido) e restaura projeto, seleção e tamanho. Pedidos pendentes resolvem com erro não fatal.
   */
  restart(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    if (this.disposed) return
    const old = this.worker
    old.terminate()
    this.settleFrames(Infinity, { t: 'error', message: 'render reiniciado', fatal: false })
    this.pixels.clear()
    this.spawn(canvas)
    if (this.project) this.send({ t: 'project', ...this.project })
    if (this.overlay) this.send({ t: 'overlay', ...this.overlay })
    if (this.cursors.size) this.send({ t: 'cursorTracks', tracks: Object.fromEntries(this.cursors) })
  }

  setProject(project: Project, mediaUrls: MediaUrls, useProxy: boolean): void {
    this.project = { project, mediaUrls, useProxy }
    this.send({ t: 'project', project, mediaUrls, useProxy })
  }

  /**
   * Trilhas do cursor (F6) que o worker usa, por id do asset: só as entradas novas/trocadas vão ao worker (uma trilha
   * de 1 h tem ~200 mil amostras); as que saíram do mapa são removidas lá.
   */
  setCursorTracks(tracks: ReadonlyMap<string, CursorTrackV1>): void {
    const diff: Record<string, CursorTrackV1 | null> = {}
    let changed = false
    for (const [id, tr] of tracks) {
      if (this.cursors.get(id) === tr) continue
      diff[id] = tr
      changed = true
    }
    for (const id of this.cursors.keys()) {
      if (tracks.has(id)) continue
      diff[id] = null
      changed = true
    }
    if (!changed) return
    this.cursors = new Map(tracks)
    this.send({ t: 'cursorTracks', tracks: diff })
  }

  resize(width: number, height: number): void {
    this.size = { ...this.size, width, height }
    this.send({ t: 'resize', width, height })
  }

  setOverlay(selection: string[], guides = false): void {
    this.overlay = { selection, guides }
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

  /** Pedidos de quadro ainda sem resposta (o watchdog só conta prazo com algum pendente). */
  get pendingFrames(): number {
    return this.frames.size
  }

  /** Testes: pixels do último quadro (origem em cima à esquerda, linhas de cima para baixo). */
  readPixels(x: number, y: number, w: number, h: number): Promise<Uint8Array> {
    const id = ++this.pixelId
    return new Promise((resolve) => {
      this.pixels.set(id, resolve)
      this.send({ t: 'readPixels', id, x, y, w, h })
    })
  }

  /** Testes: `frames` quadros sequenciais a partir de tUs com o tempo do compositor (desenho + GPU) por quadro. */
  testBench(tUs: Us, frames: number, fps: number): Promise<Extract<RenderOut, { t: 'bench' }>> {
    const id = ++this.pixelId
    return new Promise((resolve) => {
      const off = this.onMessage((m) => {
        if (m.t !== 'bench' || m.id !== id) return
        off()
        resolve(m)
      })
      this.send({ t: 'testBench', id, tUs, frames, fps })
    })
  }

  /** Testes: trava o worker por `ms` (simula decoder/GPU pendurado para o watchdog). */
  testStall(ms: number): void {
    this.send({ t: 'testStall', ms })
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
    this.disposed = true
    const worker = this.worker
    this.send({ t: 'dispose' })
    setTimeout(() => worker.terminate(), 1000)
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
