import { evalAnim } from '@shared/editor/anim'
import { createEffectItem, createMediaItem } from '@shared/editor/factory'
import { fitEffectsToMotion } from '@shared/editor/followTransform'
import { findItem } from '@shared/editor/ops'
import type { EffectItem, MediaItem, Project, Track } from '@shared/editor/project'
import { applyZoom } from '@shared/editor/zoom'
import { brightBox, laplacianVar, localContrast, type PxBox } from '@shared/testing/pixels'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// "Ajustar efeitos ao movimento" (F4 Task 4) no motor real (CIALIGHT_TEST=editor-render): o texto "CPF 123.456.789-00"
// (47 px, asset a_text do projeto de efeitos) com um blur vinculado justo nele; zoom 2× no clipe centrado no texto
// (0,3 s → 1,5 s, suavizar ambos) e depois fitEffectsToMotion. Em cada instante medido, a caixa do texto na tela é a
// do quadro sem zoom levada pela transformação do clipe; legibilidade = contraste local e laplaciano com o efeito ÷ os
// do mesmo quadro sem efeito (métrica do F2: ilegível = contraste < 0,15 e laplaciano < 0,2). Preview aqui; o main
// mede os mesmos instantes na exportação (ffmpeg). Controle: o zoom SEM ajuste deixa o texto legível em algum instante.

export const FOLLOW_PROJECT_ID = 'p-editor-effects-test'
const W = 1920
const H = 1080
const FPS = 30
const ZOOM_AT_US = 300_000
const ZOOM_DUR_US = 1_200_000
/** Quadros medidos (30 fps): antes, 6 durante o zoom e depois. */
export const FOLLOW_FRAMES = [6, 12, 18, 24, 30, 36, 42, 48, 54]
const EXPORT_TO_US = 2_000_000

export interface FollowInstant { frame: number; tUs: number; box: PxBox; ref: { c: number; lap: number }; preview: { c: number; lap: number }; unadjusted: { c: number; lap: number } }
export interface FollowReport { error?: string; instants?: FollowInstant[]; keys?: number; exportPath?: string; exportError?: string }

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
    const adjusted = fitEffectsToMotion(zoomed, clip.id)
    const fxAdj = findItem(adjusted, fx.id)!.item as EffectItem
    report.keys = fxAdj.region.w.keys?.length ?? 0
    const noFx: Project = { ...zoomed, tracks: [zoomed.tracks[0]] }
    const v = (findItem(zoomed, clip.id)!.item as MediaItem).visual!.transform
    const instants: FollowInstant[] = []
    for (const k of FOLLOW_FRAMES) {
      const tUs = Math.round((k * 1e6) / FPS)
      // caixa do texto na tela: x' = x(t) + s(t)·(x − ½) (camada em tela cheia, sem giro)
      const s = evalAnim(v.scale, tUs), x = evalAnim(v.x, tUs), y = evalAnim(v.y, tUs)
      const mapX = (px: number): number => Math.round((x + s * (px / W - 0.5)) * W)
      const mapY = (py: number): number => Math.round((y + s * (py / H - 0.5)) * H)
      const box: PxBox = { x0: Math.max(4, mapX(box0.x0)), y0: Math.max(4, mapY(box0.y0)), x1: Math.min(W - 5, mapX(box0.x1 + 1) - 1), y1: Math.min(H - 5, mapY(box0.y1 + 1) - 1) }
      const ref = await frame(noFx, tUs)
      const refC = localContrast(ref, W, H, box), refLap = laplacianVar(ref, W, H, box)
      const ratio = (img: Uint8Array): { c: number; lap: number } => ({ c: r4(localContrast(img, W, H, box) / refC), lap: r4(laplacianVar(img, W, H, box) / refLap) })
      instants.push({ frame: k, tUs, box, ref: { c: refC, lap: refLap }, preview: ratio(await frame(adjusted, tUs)), unadjusted: ratio(await frame(zoomed, tUs)) })
    }
    report.instants = instants
    if (outDir) {
      try {
        const out = await runEditorExport({
          project: adjusted, width: W, height: H, fps: FPS, fromUs: 0, toUs: EXPORT_TO_US,
          videoBitrate: 12_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: 'follow.mp4'
        })
        report.exportPath = out.path
      } catch (e) {
        report.exportError = e instanceof Error ? e.message : String(e)
      }
    } else report.exportError = 'sem pasta de saída'
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}
