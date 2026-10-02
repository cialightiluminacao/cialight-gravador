import { updateItem } from '@shared/editor/ops'
import type { MediaItem, Project } from '@shared/editor/project'
import { applyZoom } from '@shared/editor/zoom'
import { redBlob, type RedBlob } from '@shared/testing/pixels'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// Zoom/pan (F4) no motor real (CIALIGHT_TEST=editor-render): projeto p-editor-zoom-test (PNG 1920×1080 escuro com um
// quadrado vermelho de 12 px fora do centro, criado pelo main). O alvo é o centro do quadrado medido no quadro
// renderizado sem zoom; depois de applyZoom 2× (retângulo da proporção do quadro centrado nele) o centro do vermelho
// tem de estar no centro do quadro no instante final (±2 px). Dois cenários: clipe em tela cheia e clipe cortado,
// reduzido e deslocado (a conta passa pela geometria base: corte/fit). Paridade: o 1º cenário exportado (o main lê o
// quadro do instante final com o ffmpeg e mede o mesmo centro).

export const ZOOM_PROJECT_ID = 'p-editor-zoom-test'
const W = 1920
const H = 1080
const AT_US = 500_000
const DUR_US = 1_000_000
export const ZOOM_END_US = AT_US + DUR_US

export interface ZoomScenario { before: RedBlob | null; after: RedBlob | null; mid: RedBlob | null; error?: string }
export interface ZoomReport { error?: string; full?: ZoomScenario; cropped?: ZoomScenario; exportPath?: string; exportError?: string }

async function frameBlob(client: RenderClient, p: Project, tUs: number): Promise<RedBlob | null> {
  client.setProject(p, mediaUrlsFor(p, 'preview'), true)
  const r = await client.requestFrame(tUs, false)
  if (r.t !== 'rendered') throw new Error(`quadro em ${tUs}: ${JSON.stringify(r)}`)
  return redBlob(await client.readPixels(0, 0, W, H), W, H)
}

/** Mede o alvo sem zoom, aplica o zoom 2× centrado nele e mede no fim (e no meio, só informativo). */
async function scenario(client: RenderClient, p: Project, itemId: string): Promise<{ s: ZoomScenario; zoomed: Project | null }> {
  try {
    const before = await frameBlob(client, p, AT_US)
    if (!before) return { s: { before, after: null, mid: null, error: 'quadrado vermelho não encontrado antes do zoom' }, zoomed: null }
    const rect = { x: before.cx / W, y: before.cy / H, w: 0.5, h: 0.5 }
    const zoomed = applyZoom(p, itemId, rect, AT_US, DUR_US, null, 'inOut', { clamp: false }).project
    const after = await frameBlob(client, zoomed, ZOOM_END_US)
    const mid = await frameBlob(client, zoomed, AT_US + DUR_US / 2)
    return { s: { before, after, mid }, zoomed }
  } catch (e) {
    return { s: { before: null, after: null, mid: null, error: e instanceof Error ? e.message : String(e) }, zoomed: null }
  }
}

export async function zoomCheck(outDir: string | null): Promise<ZoomReport> {
  const report: ZoomReport = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const p = await window.api.project.load(ZOOM_PROJECT_ID)
    const itemId = p.tracks[0].items[0].id
    const full = await scenario(client, p, itemId)
    report.full = full.s
    // clipe cortado (10 % à esquerda, 5 % no topo), a 70 % e fora do centro
    const cropped = updateItem<MediaItem>(p, itemId, (d) => {
      const v = d.visual!
      v.crop.l = { value: 0.1 }
      v.crop.t = { value: 0.05 }
      v.transform.scale = { value: 0.7 }
      v.transform.x = { value: 0.45 }
      v.transform.y = { value: 0.55 }
    })
    report.cropped = (await scenario(client, cropped, itemId)).s
    // paridade com a exportação: o 1º cenário inteiro (o main mede o quadro do instante final)
    if (full.zoomed && outDir) {
      try {
        const out = await runEditorExport({
          project: full.zoomed, width: W, height: H, fps: p.canvas.fps, fromUs: 0, toUs: 2_000_000,
          videoBitrate: 12_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: 'zoom.mp4'
        })
        report.exportPath = out.path
      } catch (e) {
        report.exportError = e instanceof Error ? e.message : String(e)
      }
    } else report.exportError = outDir ? 'cenário sem zoom' : 'sem pasta de saída'
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}
