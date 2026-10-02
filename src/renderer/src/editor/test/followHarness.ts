import { evalAnim } from '@shared/editor/anim'
import { createEffectItem, createMediaItem } from '@shared/editor/factory'
import { attachEffects } from '@shared/editor/followTransform'
import { findItem } from '@shared/editor/ops'
import type { EffectItem, MediaItem, Project, Track } from '@shared/editor/project'
import { applyZoom } from '@shared/editor/zoom'
import { brightBox, laplacianVar, localContrast, type PxBox } from '@shared/testing/pixels'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// "Ancorar ao clipe" (F4 Task 4) no motor real (CIALIGHT_TEST=editor-render): o texto "CPF 123.456.789-00" (47 px, asset
// a_text do projeto de efeitos) com um blur vinculado justo nele; zoom 2× no clipe centrado no texto (0,3 s → 1,5 s,
// suavizar ambos) e o efeito ancorado ao clipe. Depois, uma edição posterior do zoom (mais 1,6× em direção ao começo
// do texto, 1,6 s → 2,2 s) SEM mexer no efeito: a âncora acompanha sozinha. Em cada instante medido, a caixa do texto
// na tela é a do quadro sem zoom levada pela transformação do clipe; legibilidade = contraste local e laplaciano com
// o efeito ÷ os do mesmo quadro sem efeito (métrica do F2: ilegível = contraste < 0,15 e laplaciano < 0,2). Preview
// aqui; o main mede os mesmos instantes nas duas exportações (ffmpeg). Controle: o zoom sem âncora deixa o texto
// legível em algum instante.

export const FOLLOW_PROJECT_ID = 'p-editor-effects-test'
const W = 1920
const H = 1080
const FPS = 30
const ZOOM_AT_US = 300_000
const ZOOM_DUR_US = 1_200_000
const LATER_AT_US = 1_600_000
const LATER_DUR_US = 600_000
const EXPORT_TO_US = 2_400_000
/** Quadros medidos (30 fps): antes, durante o zoom, parado, durante a edição posterior e depois. */
export const FOLLOW_FRAMES = [6, 12, 18, 24, 30, 36, 42, 51, 57, 63, 69]

type Legib = { c: number; lap: number }
export interface FollowInstant { frame: number; tUs: number; box: PxBox; ref: Legib; preview: Legib; unadjusted?: Legib }
export interface FollowRun { instants: FollowInstant[]; exportPath?: string; exportError?: string }
export interface FollowReport { error?: string; attached?: FollowRun; later?: FollowRun }

const track = (id: string, item: MediaItem | EffectItem): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items: [item] })
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4

export async function followCheck(outDir: string | null): Promise<FollowReport> {
  const report: FollowReport = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const base = await window.api.project.load(FOLLOW_PROJECT_ID)
    const frame = async (p: Project, tUs: number): Promise<Uint8Array> => {
      client.setProject(p, mediaUrlsFor(p, 'preview'), true)
      const r = await client.requestFrame(tUs, false)
      if (r.t !== 'rendered') throw new Error(`quadro ${tUs}: ${JSON.stringify(r)}`)
      return client.readPixels(0, 0, W, H)
    }
    const textAsset = base.assets.find((a) => a.id === 'a_text')!
    const clip: MediaItem = { ...createMediaItem(textAsset, 0, 'video'), id: 'i_text', durationUs: EXPORT_TO_US, linkId: 'l_follow' }
    const plain: Project = { ...base, tracks: [track('t_text', clip)] }
    // caixa do texto sem zoom; região do blur = caixa + 24 px (blur para texto: 80, sem borda suave)
    const box0 = brightBox(await frame(plain, 0), W, 150, 320)
    if (!box0) throw new Error('texto não encontrado')
    const pad = 24
    const cx = (box0.x0 + box0.x1 + 1) / 2 / W, cy = (box0.y0 + box0.y1 + 1) / 2 / H
    const fx: EffectItem = { ...createEffectItem('blurText', 0, EXPORT_TO_US, { x: cx, y: cy, w: (box0.x1 - box0.x0 + 1 + 2 * pad) / W, h: (box0.y1 - box0.y0 + 1 + 2 * pad) / H }), id: 'i_blur', linkId: 'l_follow' }
    const zoomed = applyZoom({ ...plain, tracks: [...plain.tracks, track('t_fx', fx)] }, clip.id, { x: cx, y: cy, w: 0.5, h: 0.5 }, ZOOM_AT_US, ZOOM_DUR_US, null, 'inOut', { clamp: false }).project
    const attached = attachEffects(zoomed, clip.id, [fx.id])
    // edição posterior do zoom, sem tocar no efeito: mais 1,6× em direção ao começo do texto (no quadro já ampliado)
    const v1 = (findItem(attached, clip.id)!.item as MediaItem).visual!.transform
    const s1 = evalAnim(v1.scale, LATER_AT_US), x1 = evalAnim(v1.x, LATER_AT_US), y1 = evalAnim(v1.y, LATER_AT_US)
    const leftX = x1 + s1 * ((box0.x0 + 200) / W - 0.5), midY = y1 + s1 * (cy - 0.5)
    const later = applyZoom(attached, clip.id, { x: leftX, y: midY, w: 1 / 1.6, h: 1 / 1.6 }, LATER_AT_US, LATER_DUR_US, null, 'out', { clamp: false }).project

    const measure = async (withFx: Project, control: Project | null): Promise<FollowInstant[]> => {
      const noFx: Project = { ...withFx, tracks: [withFx.tracks[0]] }
      const v = (findItem(withFx, clip.id)!.item as MediaItem).visual!.transform
      const out: FollowInstant[] = []
      for (const k of FOLLOW_FRAMES) {
        const tUs = Math.round((k * 1e6) / FPS)
        // caixa do texto na tela: x' = x(t) + s(t)·(x − ½) (camada em tela cheia, sem giro)
        const s = evalAnim(v.scale, tUs), x = evalAnim(v.x, tUs), y = evalAnim(v.y, tUs)
        const mapX = (px: number): number => Math.round((x + s * (px / W - 0.5)) * W)
        const mapY = (py: number): number => Math.round((y + s * (py / H - 0.5)) * H)
        const box: PxBox = { x0: Math.max(4, mapX(box0.x0)), y0: Math.max(4, mapY(box0.y0)), x1: Math.min(W - 5, mapX(box0.x1 + 1) - 1), y1: Math.min(H - 5, mapY(box0.y1 + 1) - 1) }
        const ref = await frame(noFx, tUs)
        const refC = localContrast(ref, W, H, box), refLap = laplacianVar(ref, W, H, box)
        const ratio = (img: Uint8Array): Legib => ({ c: r4(localContrast(img, W, H, box) / refC), lap: r4(laplacianVar(img, W, H, box) / refLap) })
        out.push({ frame: k, tUs, box, ref: { c: refC, lap: refLap }, preview: ratio(await frame(withFx, tUs)), ...(control ? { unadjusted: ratio(await frame(control, tUs)) } : {}) })
      }
      return out
    }
    const exportRun = async (project: Project, fileName: string, run: FollowRun): Promise<void> => {
      if (!outDir) {
        run.exportError = 'sem pasta de saída'
        return
      }
      try {
        const out = await runEditorExport({ project, width: W, height: H, fps: FPS, fromUs: 0, toUs: EXPORT_TO_US, videoBitrate: 12_000_000, audioBitrate: 128_000, outputDir: outDir, fileName })
        run.exportPath = out.path
      } catch (e) {
        run.exportError = e instanceof Error ? e.message : String(e)
      }
    }
    report.attached = { instants: await measure(attached, zoomed) }
    await exportRun(attached, 'follow.mp4', report.attached)
    report.later = { instants: await measure(later, null) }
    await exportRun(later, 'follow-depois.mp4', report.later)
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}
