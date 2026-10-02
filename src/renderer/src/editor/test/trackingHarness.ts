import { createEffectItem } from '@shared/editor/factory'
import { applyTrackedRegion } from '@shared/editor/ops'
import type { EffectItem, Project, Track } from '@shared/editor/project'
import { lossMessage, type TrackState } from '@shared/editor/track'
import { brightBox, laplacianVar, localContrast, type PxBox } from '@shared/testing/pixels'
import { TRACK_SCENE, textX } from '@shared/testing/trackingScene'
import { runContentTracking } from '../engine/contentTracking'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// "Seguir conteúdo" (F6 Task 5) no motor real (CIALIGHT_TEST=editor-render): projeto p-editor-tracking-test (vídeo de
// trackingScene.ts gerado pelo main: "CPF 123.456.789-00" andando, com pausa e oclusão). Um blur para texto é posto
// justo no texto do quadro 0 (caixa dos pixels claros + 12 px) e o rastreamento REAL roda do quadro 0 até o fim
// (runContentTracking: worker próprio, quadros compostos abaixo do efeito, NCC); a região com keys é aplicada
// (applyTrackedRegion) e exportada pelo caminho real (runEditorExport). O main mede TODOS os quadros exportados.
// Aqui: o instante da perda (a oclusão), os estados, e no preview — com o efeito rastreado e com o mesmo efeito SEM
// rastrear (controle: o texto sai de baixo da região parada e fica legível) — a legibilidade em alguns quadros.

export const TRACKING_PROJECT_ID = 'p-editor-tracking-test'
const { width: W, height: H, fps: FPS } = TRACK_SCENE
const PAD = 12
/** Quadros do preview medidos: parado no início, na pausa, depois da oclusão. */
export const TRACKING_PREVIEW_FRAMES = [0, 40, 105]

type Legib = { c: number; lap: number }
export interface TrackingReport {
  error?: string
  box0?: PxBox
  frames?: number
  states?: Record<TrackState, number>
  /** Estado por quadro (o / w / l). */
  timeline?: string
  lost?: number[]
  lossMessage?: string
  keys?: number
  analysis?: { width: number; height: number }
  trackMs?: number
  preview?: { frame: number; tracked: Legib; untracked: Legib }[]
  exportPath?: string
  exportError?: string
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4

export async function trackingCheck(outDir: string | null): Promise<TrackingReport> {
  const report: TrackingReport = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '320px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const base = await window.api.project.load(TRACKING_PROJECT_ID)
    const frame = async (p: Project, n: number): Promise<Uint8Array> => {
      client.setProject(p, mediaUrlsFor(p, 'preview'), true)
      const r = await client.requestFrame(Math.round((n * 1e6) / FPS), false)
      if (r.t !== 'rendered') throw new Error(`quadro ${n}: ${JSON.stringify(r)}`)
      return client.readPixels(0, 0, W, H)
    }
    const box0 = brightBox(await frame(base, 0), W, TRACK_SCENE.band.y, TRACK_SCENE.band.y + TRACK_SCENE.band.h)
    if (!box0) throw new Error('texto não encontrado no quadro 0')
    report.box0 = box0
    const dur = TRACK_SCENE.durationS * 1e6
    const fx: EffectItem = {
      ...createEffectItem('blurText', 0, dur, { x: (box0.x0 + box0.x1 + 1) / 2 / W, y: (box0.y0 + box0.y1 + 1) / 2 / H, w: (box0.x1 - box0.x0 + 1 + 2 * PAD) / W, h: (box0.y1 - box0.y0 + 1 + 2 * PAD) / H }),
      id: 'i_track_fx'
    }
    const fxTrack: Track = { id: 't_track_fx', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
    const untracked: Project = { ...base, tracks: [...base.tracks, fxTrack] }

    // rastreamento real, do quadro 0 ao fim
    const t0 = performance.now()
    const out = await runContentTracking({ project: untracked, effectItemId: fx.id, fromUs: 0, cursorTracks: new Map() })
    report.trackMs = Math.round(performance.now() - t0)
    report.frames = out.results.length
    report.analysis = { width: out.geometry.analysisW, height: out.geometry.analysisH }
    report.states = { ok: 0, weak: 0, lost: 0 }
    for (const r of out.results) report.states[r.state]++
    report.timeline = out.results.map((r) => r.state[0]).join('')
    report.lost = out.lost.map((l) => l.tUs)
    if (out.lost.length) report.lossMessage = lossMessage(out.lost[0], false)
    const tracked = applyTrackedRegion(untracked, fx.id, out.region)
    report.keys = out.region.x.keys?.length ?? 0

    // preview: legibilidade (contraste local e laplaciano ÷ os do quadro sem efeito) na caixa do texto
    report.preview = []
    for (const n of TRACKING_PREVIEW_FRAMES) {
      const dx = Math.round(textX(n / FPS) - textX(0))
      const box: PxBox = { x0: box0.x0 + dx, y0: box0.y0, x1: box0.x1 + dx, y1: box0.y1 }
      const ref = await frame(base, n)
      const refC = localContrast(ref, W, H, box), refLap = laplacianVar(ref, W, H, box)
      const ratio = (img: Uint8Array): Legib => ({ c: r4(localContrast(img, W, H, box) / refC), lap: r4(laplacianVar(img, W, H, box) / refLap) })
      report.preview.push({ frame: n, tracked: ratio(await frame(tracked, n)), untracked: ratio(await frame(untracked, n)) })
    }

    if (!outDir) report.exportError = 'sem pasta de saída'
    else {
      try {
        const res = await runEditorExport({ project: tracked, width: W, height: H, fps: FPS, fromUs: 0, toUs: dur, videoBitrate: 12_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: 'seguir-conteudo.mp4', cursorTracks: new Map() })
        report.exportPath = res.path
      } catch (e) {
        report.exportError = e instanceof Error ? e.message : String(e)
      }
    }
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}
