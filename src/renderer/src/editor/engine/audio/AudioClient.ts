// Cliente (thread principal) do audio worker: envia o projeto e pede blocos de PCM mixado.
import type { Project, Us } from '@shared/editor/project'
import type { MediaUrls } from '../mediaUrls'
import type { AudioIn, AudioOut } from './protocol'

export interface AudioBlock { fromUs: Us; pcm: Float32Array }

export class AudioClient {
  private readonly worker: Worker
  private seq = 0
  private readonly pending = new Map<number, (b: AudioBlock | null) => void>()
  private readonly errorListeners = new Set<(message: string) => void>()

  constructor() {
    this.worker = new Worker(new URL('./audio.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (e: MessageEvent<AudioOut>) => {
      const m = e.data
      if (m.t === 'block') this.settle(m.seq, { fromUs: m.fromUs, pcm: m.pcm })
      else {
        if (m.seq !== undefined) this.settle(m.seq, null)
        for (const l of this.errorListeners) l(m.message)
      }
    })
    this.worker.addEventListener('error', (e) => {
      for (const [seq] of this.pending) this.settle(seq, null)
      for (const l of this.errorListeners) l(e.message || 'falha no audio worker')
    })
  }

  /** useProxy: mesma variante usada pelo vídeo no preview. */
  setProject(project: Project, mediaUrls: MediaUrls, useProxy: boolean): void {
    this.send({ t: 'project', project, mediaUrls, useProxy })
  }

  /** Bloco mixado [fromUs, fromUs + frames/48 kHz), estéreo intercalado; null em erro. */
  render(fromUs: Us, frames: number): Promise<AudioBlock | null> {
    const seq = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(seq, resolve)
      this.send({ t: 'render', fromUs, frames, seq })
    })
  }

  onError(cb: (message: string) => void): () => void {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  dispose(): void {
    this.send({ t: 'dispose' })
    for (const [seq] of this.pending) this.settle(seq, null)
    this.errorListeners.clear()
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
