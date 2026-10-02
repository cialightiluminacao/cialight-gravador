import { screenToContent, toScreen } from '@shared/editor/contentPose'
import { createEffectItem } from '@shared/editor/factory'
import { findItem } from '@shared/editor/ops'
import type { EffectItem, MediaItem, Project, Track } from '@shared/editor/project'
import { reframeName, reframeProject } from '@shared/editor/reframe'
import { clipFrameAt } from '@shared/editor/resolve'
import { brightBox, laplacianVar, localContrast, redBlob, type PxBox, type RedBlob } from '@shared/testing/pixels'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// Reenquadrar (F4 Task 6) no motor real (CIALIGHT_TEST=editor-render): projeto p-editor-reframe-test (PNG 1920×1080
// com um quadrado vermelho de 24 px fora do centro, em (1500, 540), e o texto "Senha 4821" (Consolas 72) perto dele,
// criado pelo main). Um blur SOLTO (região do quadro) justo no texto; ponto de foco no vermelho; reframeProject para
// 9:16 e a cópia gravada pelo IPC project.duplicate (pasta própria) e relida do disco. No quadro novo 1080×1920 o
// vermelho tem de estar no centro (±3 px) e o texto continuar ilegível (métrica do F2: contraste < 0,15 e laplaciano
// < 0,2 do mesmo quadro sem o efeito). Controle: a mesma região deixada como estava no quadro deixa o texto legível.
// A cópia é exportada em 1080×1920; o main confere as dimensões e mede o mesmo quadro (ffmpeg).

export const REFRAME_PROJECT_ID = 'p-editor-reframe-test'
export const REFRAME_COPY_ID = 'p-editor-reframe-copia'
const W0 = 1920
const H0 = 1080
const W1 = 1080
const H1 = 1920
const DUR_US = 2_000_000
/** Instante medido (quadro 15 a 30 fps). */
export const REFRAME_AT_US = 500_000

type Legib = { c: number; lap: number }
export interface ReframeReport {
  error?: string
  before?: { red: RedBlob | null; text: PxBox | null }
  copy?: { name: string; width: number; height: number; anchored: string[]; warnings: string[] }
  red?: RedBlob | null
  textBox?: PxBox
  ref?: Legib
  preview?: Legib
  control?: Legib
  exportPath?: string
  exportError?: string
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4

export async function reframeCheck(outDir: string | null): Promise<ReframeReport> {
  const report: ReframeReport = {}
  const mk = (w: number, h: number): { canvas: HTMLCanvasElement; client: RenderClient } => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.style.width = '240px'
    document.body.appendChild(canvas)
    return { canvas, client: new RenderClient(canvas, { width: w, height: h, dpr: 1 }) }
  }
  const old = mk(W0, H0)
  const neu = mk(W1, H1)
  const frame = async (c: { client: RenderClient }, p: Project, w: number, h: number): Promise<Uint8Array> => {
    c.client.setProject(p, mediaUrlsFor(p, 'preview'), true)
    const r = await c.client.requestFrame(REFRAME_AT_US, false)
    if (r.t !== 'rendered') throw new Error(`quadro: ${JSON.stringify(r)}`)
    return c.client.readPixels(0, 0, w, h)
  }
  try {
    await old.client.ready
    await neu.client.ready
    const base = await window.api.project.load(REFRAME_PROJECT_ID)
    const clipId = base.tracks[0].items[0].id
    const p: Project = { ...base, tracks: base.tracks.map((t, i) => (i === 0 ? { ...t, items: [{ ...(t.items[0] as MediaItem), durationUs: DUR_US }] } : t)) }
    const img0 = await frame(old, p, W0, H0)
    const red0 = redBlob(img0, W0, H0)
    const text0 = brightBox(img0, W0, 700, 900)
    report.before = { red: red0, text: text0 }
    if (!red0 || !text0) throw new Error('vermelho ou texto não encontrado no quadro original')
    // blur solto (região do quadro) justo no texto + 24 px
    const pad = 24
    const fx: EffectItem = {
      ...createEffectItem('blurText', 0, DUR_US, { x: (text0.x0 + text0.x1 + 1) / 2 / W0, y: (text0.y0 + text0.y1 + 1) / 2 / H0, w: (text0.x1 - text0.x0 + 1 + 2 * pad) / W0, h: (text0.y1 - text0.y0 + 1 + 2 * pad) / H0 }),
      id: 'i_blur_texto'
    }
    const fxTrack: Track = { id: 't_fx', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
    const withFx: Project = { ...p, tracks: [...p.tracks, fxTrack] }
    const r = reframeProject(withFx, '9:16', { mode: 'cover', focus: { [clipId]: [{ localUs: 0, x: red0.cx / W0, y: red0.cy / H0 }] } })
    // a cópia pelo IPC (pasta própria) e relida do disco
    const copy: Project = { ...r.project, id: REFRAME_COPY_ID, name: reframeName(p.name, '9:16') }
    await window.api.project.duplicate(REFRAME_PROJECT_ID, copy)
    const loaded = await window.api.project.load(REFRAME_COPY_ID)
    report.copy = { name: loaded.name, width: loaded.canvas.width, height: loaded.canvas.height, anchored: r.anchored, warnings: r.warnings.map((w) => w.kind) }

    const img1 = await frame(neu, loaded, W1, H1)
    report.red = redBlob(img1, W1, H1)
    // caixa do texto no quadro novo: os cantos levados pelo conteúdo do clipe (geometria antiga → nova)
    const cf0 = clipFrameAt(withFx, findItem(withFx, clipId)!.item as MediaItem, REFRAME_AT_US)!
    const cf1 = clipFrameAt(loaded, findItem(loaded, clipId)!.item as MediaItem, REFRAME_AT_US)!
    const map = (x: number, y: number): { x: number; y: number } => {
      const q = screenToContent(cf0, { x: x / W0, y: y / H0, w: 0, h: 0, rotation: 0 }, 'rect')
      return toScreen(cf1, q.x * cf1.g.dw, q.y * cf1.g.dh)
    }
    const a = map(text0.x0, text0.y0), b = map(text0.x1 + 1, text0.y1 + 1)
    const box: PxBox = { x0: Math.max(4, Math.round(a.x)), y0: Math.max(4, Math.round(a.y)), x1: Math.min(W1 - 5, Math.round(b.x) - 1), y1: Math.min(H1 - 5, Math.round(b.y) - 1) }
    report.textBox = box
    const noFx: Project = { ...loaded, tracks: loaded.tracks.filter((t) => !t.items.some((i) => i.type === 'effect')) }
    const ref = await frame(neu, noFx, W1, H1)
    const refC = localContrast(ref, W1, H1, box), refLap = laplacianVar(ref, W1, H1, box)
    report.ref = { c: refC, lap: refLap }
    const ratio = (img: Uint8Array): Legib => ({ c: r4(localContrast(img, W1, H1, box) / refC), lap: r4(laplacianVar(img, W1, H1, box) / refLap) })
    report.preview = ratio(img1)
    // controle: a região do efeito deixada como estava (normalizada ao quadro), sem âncora
    const naive: Project = { ...loaded, tracks: loaded.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.type === 'effect' ? fx : i)) })) }
    report.control = ratio(await frame(neu, naive, W1, H1))
    if (outDir) {
      try {
        const out = await runEditorExport({ project: loaded, width: W1, height: H1, fps: 30, fromUs: 0, toUs: DUR_US, videoBitrate: 12_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: 'reenquadrar-vertical.mp4' })
        report.exportPath = out.path
      } catch (e) {
        report.exportError = e instanceof Error ? e.message : String(e)
      }
    } else report.exportError = 'sem pasta de saída'
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    old.client.dispose()
    neu.client.dispose()
    old.canvas.remove()
    neu.canvas.remove()
  }
  return report
}
