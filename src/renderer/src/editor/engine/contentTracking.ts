// "Seguir conteúdo" (F6) na thread principal: sobe uma instância PRÓPRIA do render worker (OffscreenCanvas na
// resolução de análise, como a exportação: o preview continua intocado), manda o projeto de análise (o efeito entra no
// resolve mesmo desativado, para o corte das camadas — track.trackingProject) e o pedido `trackStart`; o worker compõe
// cada quadro só com o que está abaixo do efeito e roda o NCC (shared/editor/track.ts). No fim, trackToKeys converte o
// resultado em keys da região. Cancelar (signal) = nada aplicado (TrackingCancelled). Não grava nada no projeto: quem
// chama aplica (applyTrackedRegion, um passo de desfazer).
import type { CursorTrackV1 } from '@shared/cursor'
import { EditError, findItem } from '@shared/editor/ops'
import type { EffectItem, Project, Us } from '@shared/editor/project'
import { itemEndUs } from '@shared/editor/time'
import {
  analysisSize,
  DEFAULT_TRACK_OPTS,
  regionExtentPx,
  resolveRedetections,
  templateBox,
  trackingBlocker,
  trackingProject,
  trackToKeys,
  type TrackGeometry,
  type TrackKeysResult,
  type TrackOpts,
  type TrackResult
} from '@shared/editor/track'
import { cursorTracks, loadCursorTracks } from './cursorTracks'
import { mediaUrlsFor } from './mediaUrls'
import type { RenderOut } from './protocol'
import { RenderClient } from './RenderClient'

export class TrackingCancelled extends Error {
  constructor() {
    super('Rastreamento cancelado')
    this.name = 'TrackingCancelled'
  }
}

export interface ContentTrackingRequest {
  project: Project
  effectItemId: string
  /** Instante (absoluto) de partida — o playhead; preso ao trecho do efeito. */
  fromUs: Us
  opts?: Partial<TrackOpts>
  /** Trilhas do cursor já prontas (testes); ausente = lidas como no preview para os clipes com efeitos de cursor. */
  cursorTracks?: ReadonlyMap<string, CursorTrackV1>
}

export interface ContentTrackingResult extends TrackKeysResult {
  results: TrackResult[]
  geometry: TrackGeometry
  /** Instante (absoluto) de partida efetivo. */
  fromUs: Us
}

export interface ContentTrackingProgress { frame: number; total: number; result: TrackResult }

let seq = 0

export async function runContentTracking(req: ContentTrackingRequest, o: { onProgress?: (p: ContentTrackingProgress) => void; signal?: AbortSignal } = {}): Promise<ContentTrackingResult> {
  const p = req.project
  const blocked = trackingBlocker(p, req.effectItemId)
  if (blocked) throw new EditError('invalid', blocked)
  const fx = findItem(p, req.effectItemId)!.item as EffectItem
  const end = itemEndUs(fx)
  const fromUs = Math.min(end - 1, Math.max(fx.startUs, Math.round(req.fromUs)))
  const local = fromUs - fx.startUs
  const W = p.canvas.width, H = p.canvas.height
  const size = analysisSize(W, H, regionExtentPx(fx, local, W, H))
  const geometry: TrackGeometry = { analysisW: size.width, analysisH: size.height, canvasW: W, canvasH: H }
  const box = templateBox(fx, local, geometry)
  const ap = trackingProject(p, fx.id)
  if (o.signal?.aborted) throw new TrackingCancelled()
  const cursors = req.cursorTracks ?? (await loadCursorTracks(ap, cursorTracks)).tracks
  if (o.signal?.aborted) throw new TrackingCancelled()

  const render = new RenderClient(new OffscreenCanvas(size.width, size.height), { width: size.width, height: size.height, dpr: 1 })
  const jobId = `track-${++seq}`
  try {
    render.setProject(ap, mediaUrlsFor(ap, 'preview'), true)
    render.setCursorTracks(cursors)
    const results = await new Promise<TrackResult[]>((resolve, reject) => {
      const onAbort = (): void => {
        render.trackCancel(jobId)
        done(() => reject(new TrackingCancelled()))
      }
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        off()
        o.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const off = render.onMessage((m: RenderOut) => {
        if (m.t === 'trackProgress' && m.jobId === jobId) o.onProgress?.({ frame: m.frame, total: m.total, result: m.result })
        else if (m.t === 'trackDone' && m.jobId === jobId) done(() => resolve(m.results))
        else if (m.t === 'trackError' && m.jobId === jobId) done(() => reject(m.cancelled ? new TrackingCancelled() : new Error(m.message)))
        else if (m.t === 'error' && m.fatal) done(() => reject(new Error(`O render do rastreamento parou (${m.message}).`)))
      })
      o.signal?.addEventListener('abort', onAbort)
      render.trackStart({ jobId, width: size.width, height: size.height, fps: p.canvas.fps, fromUs, toUs: end, effectItemId: fx.id, box, ...(req.opts ? { opts: req.opts } : {}) })
    })
    // escala sempre estimada (R20): a folga de meio passo das sondas é a de trackToKeys
    const scaleTol = (req.opts?.scaleStep ?? DEFAULT_TRACK_OPTS.scaleStep) / 2
    // redetecção (G4): os candidatos confirmados viram 'ok' (o worker manda os quadros como saíram, um a um)
    const resolved = resolveRedetections(results)
    return { ...trackToKeys(fx, resolved, geometry, { scaleTol }), results: resolved, geometry, fromUs }
  } finally {
    render.dispose()
  }
}
