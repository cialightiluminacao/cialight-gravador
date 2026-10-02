// Cliente (thread principal) do audio worker: envia o projeto e pede blocos de PCM mixado.
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from '../mediaUrls'
import type { AudioIn, AudioOut } from './protocol'

export interface AudioBlock { fromUs: Us; pcm: Float32Array }

export class AudioClient {
  private readonly worker: Worker
  private seq = 0
  private readonly pending = new Map<number, (b: AudioBlock | null) => void>()
  private readonly errorListeners = new Set<(message: string, assetId?: string) => void>()
  private readonly fatalListeners = new Set<(message: string) => void>()

  constructor() {
    this.worker = new Worker(new URL('./audio.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (e: MessageEvent<AudioOut>) => {
      const m = e.data
      if (m.t === 'block') this.settle(m.seq, { fromUs: m.fromUs, pcm: m.pcm })
      else {
        if (m.seq !== undefined) this.settle(m.seq, null)
        for (const l of this.errorListeners) l(m.message, m.assetId)
      }
    })
    this.worker.addEventListener('error', (e) => {
      for (const [seq] of this.pending) this.settle(seq, null)
      for (const l of this.errorListeners) l(e.message || 'falha no audio worker')
      for (const l of this.fatalListeners) l(e.message || 'falha no audio worker')
    })
  }

  /** useProxy: mesma variante usada pelo vídeo no preview. */
  setProject(project: Project, mediaUrls: MediaUrls, useProxy: boolean): void {
    this.send({ t: 'project', project, mediaUrls, useProxy })
  }

  /**
   * Bloco mixado [fromUs, fromUs + frames/48 kHz), estéreo intercalado; null em erro. rate (shuttle, até 2×): o bloco
   * cobre frames·rate da timeline, esticado com o tom preservado.
   */
  render(fromUs: Us, frames: number, rate = 1): Promise<AudioBlock | null> {
    const seq = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(seq, resolve)
      this.send({ t: 'render', fromUs, frames, seq, ...(rate !== 1 ? { rate } : {}) })
    })
  }

  /** Seek/pausa: o worker descarta a fila; os pedidos pendentes resolvem com null. */
  cancel(): void {
    this.send({ t: 'cancel' })
    for (const [seq] of this.pending) this.settle(seq, null)
  }

  /** Exportação: o worker passa a atender pedidos de blocos também por esta porta (do render worker). */
  connectPort(port: MessagePort): void {
    this.worker.postMessage({ t: 'port', port } satisfies AudioIn, [port])
  }

  /** O worker caiu (exceção não tratada / falha ao carregar): a exportação não pode esperar por ele. */
  onFatal(cb: (message: string) => void): () => void {
    this.fatalListeners.add(cb)
    return () => this.fatalListeners.delete(cb)
  }

  /** assetId: falha de mídia de um asset (o worker avisa uma vez por asset). */
  onError(cb: (message: string, assetId?: string) => void): () => void {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  dispose(): void {
    this.send({ t: 'dispose' })
    for (const [seq] of this.pending) this.settle(seq, null)
    this.errorListeners.clear()
    this.fatalListeners.clear()
    this.worker.terminate()
  }

  private send(m: AudioIn): void {
    this.worker.postMessage(m)
  }

  private settle(seq: number, b: AudioBlock | null): void {
    const r = this.pending.get(seq)
    if (!r) return
    this.pending.delete(seq)
    r(b)
  }
}
