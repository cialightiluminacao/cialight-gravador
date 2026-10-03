import type { CursorTrackV1 } from '@shared/cursor'
import { toScreen } from '@shared/editor/contentPose'
import { timelineUsAtCursorMs } from '@shared/editor/cursorTime'
import { createEffectItem } from '@shared/editor/factory'
import { findItem, updateItem } from '@shared/editor/ops'
import { DEFAULT_CURSOR_FX, type CursorFx, type MediaItem, type Project, type Track } from '@shared/editor/project'
import { reframeProject } from '@shared/editor/reframe'
import { clipFrameAt } from '@shared/editor/resolve'
import { magentaBlob, type RedBlob } from '@shared/testing/pixels'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// Realce de cliques e cursor ampliado (F6 Task 4) no motor real (CIALIGHT_TEST=editor-render): projeto
// p-editor-cursorfx-test (vídeo de 6 s, fundo 0x203040 com um quadrado vermelho; criado pelo main). Trilha sintética em
// memória (entrada lateral do worker, como no editor): cursor parado em (900, 500) px da fonte e um clique em 920 ms,
// que aparece no quadro de 1,0 s (atraso R11 de 80 ms). Pelo resolveFrame + Compositor reais:
// - o centro do anel (centróide dos pixels magenta) fica onde a geometria do clipe põe o ponto clicado (±2 px) — na
//   identidade, num zoom 2× deslocado e num projeto reenquadrado para 9:16;
// - o anel some depois de durationMs; um blur por cima do ponto deixa o anel irreconhecível (privacidade);
// - a seta (cursor ampliado) tem a ponta no ponto do cursor; o mesmo blur por cima dela a deixa irreconhecível;
// - a exportação do cenário da identidade: o main mede o mesmo anel no quadro de 1,0 s (preview = exportação).

export const CURSOR_FX_PROJECT_ID = 'p-editor-cursorfx-test'
const W = 1920
const H = 1080
const PT = { x: 900 / W, y: 500 / H }
const CLICK_MS = 920
const FX: CursorFx = { highlight: { ...DEFAULT_CURSOR_FX.highlight, enabled: true, color: '#ff00ff', sizePx: 40, durationMs: 450 }, cursor: { ...DEFAULT_CURSOR_FX.cursor, enabled: false } }

export interface RingShot { tUs: number; ring: RedBlob | null; expected: { x: number; y: number } | null }
export interface CursorFxReport {
  error?: string
  identity?: RingShot
  zoom?: RingShot
  reframed?: RingShot & { width: number; height: number }
  /** Pixels magenta no instante do clique + durationMs (o anel já sumiu). */
  afterDuration?: number
  /** Pixels magenta sem e com um blur sobre o ponto clicado. */
  privacy?: { plain: number; blurred: number }
  /** Seta: ponta (menor x/y dos pixels brancos perto do ponto), altura da seta branca e pixels pretos do contorno. */
  sprite?: { tip: { x: number; y: number } | null; expected: { x: number; y: number } | null; whiteH: number; dark: number }
  /** Seta (pixels brancos e do contorno preto perto do ponto) sem e com o blur sobre o ponto do cursor. */
  spritePrivacy?: { plainWhite: number; blurredWhite: number; plainDark: number; blurredDark: number }
  exportPath?: string
  exportError?: string
}

function track(): CursorTrackV1 {
  const samples: CursorTrackV1['samples'] = []
  for (let t = 0; t <= 6000; t += 16) samples.push({ tMs: t, x: PT.x, y: PT.y })
  return { version: 1, width: W, height: H, samples, clicks: [{ tMs: CLICK_MS, x: PT.x, y: PT.y, button: 'left' }] }
}

const mk = (w: number, h: number): { canvas: HTMLCanvasElement; client: RenderClient } => {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.style.width = '240px'
  document.body.appendChild(canvas)
  return { canvas, client: new RenderClient(canvas, { width: w, height: h, dpr: 1 }) }
}

async function frame(client: RenderClient, p: Project, tUs: number): Promise<Uint8Array> {
  client.setProject(p, mediaUrlsFor(p, 'preview'), true)
  const r = await client.requestFrame(tUs, false)
  if (r.t !== 'rendered') throw new Error(`quadro em ${tUs}: ${JSON.stringify(r)}`)
  return client.readPixels(0, 0, p.canvas.width, p.canvas.height)
}

const expectedAt = (p: Project, itemId: string, tUs: number): { x: number; y: number } | null => {
  const cf = clipFrameAt(p, findItem(p, itemId)!.item as MediaItem, tUs)
  return cf ? toScreen(cf, PT.x * cf.g.dw, PT.y * cf.g.dh) : null
}

async function ring(client: RenderClient, p: Project, itemId: string, tUs: number): Promise<RingShot> {
  const img = await frame(client, p, tUs)
  return { tUs, ring: magentaBlob(img, p.canvas.width, p.canvas.height), expected: expectedAt(p, itemId, tUs) }
}

export async function cursorFxCheck(outDir: string | null): Promise<CursorFxReport> {
  const report: CursorFxReport = {}
  const wide = mk(W, H)
  const tall = mk(1080, 1920)
  try {
    await wide.client.ready
    await tall.client.ready
    const loaded = await window.api.project.load(CURSOR_FX_PROJECT_ID)
    const itemId = loaded.tracks[0].items[0].id
    const assetId = (loaded.tracks[0].items[0] as MediaItem).assetId
    const tracks = new Map([[assetId, track()]])
    wide.client.setCursorTracks(tracks)
    tall.client.setCursorTracks(tracks)
    const p = updateItem<MediaItem>({ ...loaded, assets: loaded.assets.map((a) => ({ ...a, cursor: 'cursor.json' })) }, itemId, (d) => { d.cursorFx = FX })
    const at = timelineUsAtCursorMs(p, findItem(p, itemId)!.item as MediaItem, CLICK_MS)
    if (at !== 1_000_000) throw new Error(`o clique devia aparecer em 1,0 s (veio ${at})`)

    report.identity = await ring(wide.client, p, itemId, at)
    const zoomed = updateItem<MediaItem>(p, itemId, (d) => {
      const t = d.visual!.transform
      t.scale = { value: 2 }
      t.x = { value: 0.6 }
      t.y = { value: 0.55 }
    })
    report.zoom = await ring(wide.client, zoomed, itemId, at)
    const vertical = reframeProject(p, '9:16', { mode: 'cover' }).project
    report.reframed = { ...(await ring(tall.client, vertical, itemId, at)), width: vertical.canvas.width, height: vertical.canvas.height }
    report.afterDuration = magentaBlob(await frame(wide.client, p, at + FX.highlight.durationMs * 1000), W, H)?.n ?? 0

    // privacidade: blur forte (efeito "tudo abaixo") centrado no ponto clicado
    const e = report.identity.expected!
    const blur = { ...createEffectItem('blur', 0, 6_000_000, { x: e.x / W, y: e.y / H, w: 0.15, h: 0.25 }), strength: { value: 100 }, id: 'i_blur_clique' }
    const fxTrack: Track = { id: 't_fx', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [blur] }
    const blurred: Project = { ...p, tracks: [...p.tracks, fxTrack] }
    report.privacy = { plain: report.identity.ring?.n ?? 0, blurred: magentaBlob(await frame(wide.client, blurred, at), W, H)?.n ?? 0 }

    // seta: só o cursor ampliado (o anel desligado)
    const arrow = updateItem<MediaItem>(p, itemId, (d) => { d.cursorFx = { highlight: { ...FX.highlight, enabled: false }, cursor: { ...FX.cursor, enabled: true, smoothing: 0 } } })
    const ex = expectedAt(arrow, itemId, at)
    const arrowPixels = (img: Uint8Array): { minX: number; minY: number; maxY: number; white: number; dark: number } => {
      let minX = Infinity, minY = Infinity, maxY = -Infinity, white = 0, dark = 0
      if (ex) {
        for (let y = Math.max(0, Math.round(ex.y) - 20); y < Math.min(H, Math.round(ex.y) + 80); y++) {
          for (let x = Math.max(0, Math.round(ex.x) - 20); x < Math.min(W, Math.round(ex.x) + 60); x++) {
            const i = (y * W + x) * 4
            if (img[i] >= 225 && img[i + 1] >= 225 && img[i + 2] >= 225) {
              minX = Math.min(minX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); white++
            } else if (Math.max(img[i], img[i + 1], img[i + 2]) <= 12) dark++
          }
        }
      }
      return { minX, minY, maxY, white, dark }
    }
    const a0 = arrowPixels(await frame(wide.client, arrow, at))
    report.sprite = { tip: Number.isFinite(a0.minX) ? { x: a0.minX, y: a0.minY } : null, expected: ex, whiteH: Number.isFinite(a0.maxY) ? a0.maxY - a0.minY + 1 : 0, dark: a0.dark }
    // privacidade da seta: o mesmo blur forte sobre o ponto do cursor (a seta é desenhada na camada, antes dos efeitos)
    const a1 = arrowPixels(await frame(wide.client, { ...arrow, tracks: [...arrow.tracks, fxTrack] }, at))
    report.spritePrivacy = { plainWhite: a0.white, blurredWhite: a1.white, plainDark: a0.dark, blurredDark: a1.dark }

    if (outDir) {
      try {
        const out = await runEditorExport({ project: p, width: W, height: H, fps: 30, fromUs: 0, toUs: 1_500_000, videoBitrate: 12_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: 'realce-cliques.mp4', cursorTracks: tracks })
        report.exportPath = out.path
      } catch (err) {
        report.exportError = err instanceof Error ? err.message : String(err)
      }
    } else report.exportError = 'sem pasta de saída'
  } catch (err) {
    report.error = err instanceof Error ? (err.stack ?? err.message) : String(err)
  } finally {
    wide.client.dispose()
    tall.client.dispose()
    wide.canvas.remove()
    tall.canvas.remove()
  }
  return report
}
