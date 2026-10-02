import type { CursorTrackV1 } from '@shared/cursor'
import { evalAnim } from '@shared/editor/anim'
import { applyAutoZoom, planAutoZoom, type AutoZoomOpts } from '@shared/editor/autoZoom'
import { toScreen } from '@shared/editor/contentPose'
import { cursorTimeMap } from '@shared/editor/cursorTime'
import { findItem } from '@shared/editor/ops'
import { applyZoom } from '@shared/editor/zoom'
import type { MediaItem, Project } from '@shared/editor/project'
import { clipFrameAt } from '@shared/editor/resolve'
import { redBlob, type RedBlob } from '@shared/testing/pixels'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'

// Zoom automático nos cliques (F6) no motor real (CIALIGHT_TEST=editor-render): projeto p-editor-autozoom-test
// (vídeo de 6 s do alvo do zoom: fundo 0x203040, quadrado vermelho de 12 px em (1300, 350); quadro do projeto com fundo
// preto, criado pelo main). O harness marca o asset como tendo trilha do cursor (em memória), monta uma trilha
// sintética com cliques e renderiza pelo resolveFrame + Compositor reais:
// - "centrado": cursor parado no vermelho, clique em 2 s, 2× — no zoom cheio o vermelho fica onde a pose diz (≤ 8 px);
// - "seguindo": clique no vermelho, cursor vai ao canto inferior direito e clica de novo, 3×, suavidade 0 — o pan
//   segue até o limite do clamp (borda da camada na borda do quadro).
// Em todo instante amostrado do zoom nenhum pixel da borda do quadro é o fundo preto; antes e depois a escala é 1.

export const AUTO_ZOOM_PROJECT_ID = 'p-editor-autozoom-test'
const W = 1920
const H = 1080
const RED = { x: 1300 / W, y: 350 / H }

export interface AutoZoomShot {
  tUs: number; scale: number; x: number; y: number
  red: RedBlob | null
  /** Onde a pose põe o centro do vermelho (px). */
  expected: { x: number; y: number } | null
  /** Pixels da borda do quadro (1 px em volta) com o fundo preto (máx. canal ≤ 12) e o menor máx. canal visto. */
  borderBg: number; borderMin: number
  /** Folga (px) entre a borda direita/inferior da camada e a do quadro (≥ 0 = cobre). */
  gapRight: number; gapBottom: number
}
export interface AutoZoomScenario { error?: string; segments?: number; inUs?: number; fullUs?: number; outStartUs?: number; outUs?: number; before?: AutoZoomShot; full?: AutoZoomShot; after?: AutoZoomShot; during?: AutoZoomShot[] }
export interface AutoZoomReport { error?: string; centered?: AutoZoomScenario; follow?: AutoZoomScenario; control?: AutoZoomShot }

/** Trilha de 6 s a 60 Hz: posição por função do tempo; cliques nos instantes dados. */
function track(pos: (tMs: number) => { x: number; y: number }, clicks: number[]): CursorTrackV1 {
  const samples: CursorTrackV1['samples'] = []
  for (let t = 0; t <= 6000; t += 16) samples.push({ tMs: t, ...pos(t) })
  return { version: 1, width: W, height: H, samples, clicks: clicks.map((tMs) => ({ tMs, ...pos(tMs), button: 'left' as const })) }
}

async function shot(client: RenderClient, p: Project, itemId: string, tUs: number): Promise<AutoZoomShot> {
  client.setProject(p, mediaUrlsFor(p, 'preview'), true)
  const r = await client.requestFrame(tUs, false)
  if (r.t !== 'rendered') throw new Error(`quadro em ${tUs}: ${JSON.stringify(r)}`)
  const full = await client.readPixels(0, 0, W, H)
  let borderBg = 0, borderMin = 255
  const look = (x: number, y: number): void => {
    const i = (y * W + x) * 4
    const m = Math.max(full[i], full[i + 1], full[i + 2])
    borderMin = Math.min(borderMin, m)
    if (m <= 12) borderBg++
  }
  for (let x = 0; x < W; x++) {
    look(x, 0)
    look(x, H - 1)
  }
  for (let y = 0; y < H; y++) {
    look(0, y)
    look(W - 1, y)
  }
  const item = findItem(p, itemId)!.item as MediaItem
  const t = item.visual!.transform
  const local = tUs - item.startUs
  const scale = evalAnim(t.scale, local), x = evalAnim(t.x, local), y = evalAnim(t.y, local)
  const cf = clipFrameAt(p, item, tUs)
  const expected = cf ? toScreen(cf, RED.x * cf.g.dw, RED.y * cf.g.dh) : null
  return { tUs, scale, x, y, red: redBlob(full, W, H), expected, borderBg, borderMin, gapRight: x * W + (scale * W) / 2 - W, gapBottom: y * H + (scale * H) / 2 - H }
}

async function scenario(client: RenderClient, base: Project, itemId: string, tr: CursorTrackV1, opts: AutoZoomOpts): Promise<AutoZoomScenario> {
  try {
    const item = findItem(base, itemId)!.item as MediaItem
    const seg = planAutoZoom(tr, cursorTimeMap(base, item)!, opts)
    const res = applyAutoZoom(base, itemId, tr, opts)
    const p = res.project
    const s = seg[0]
    const out: AutoZoomScenario = { segments: res.segments, inUs: s.inUs, fullUs: s.fullUs, outStartUs: s.outStartUs, outUs: s.outUs }
    out.before = await shot(client, p, itemId, s.inUs - 300_000)
    out.full = await shot(client, p, itemId, s.fullUs)
    out.during = []
    for (let k = 1; k <= 10; k++) out.during.push(await shot(client, p, itemId, Math.round(s.inUs + ((s.outUs - s.inUs) * k) / 11)))
    // fim da espera (pan no ponto mais longe)
    out.during.push(await shot(client, p, itemId, s.outStartUs - 50_000))
    out.after = await shot(client, p, itemId, Math.min(s.outUs + 200_000, item.durationUs - 50_000))
    return out
  } catch (e) {
    return { error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
  }
}

export async function autoZoomCheck(): Promise<AutoZoomReport> {
  const report: AutoZoomReport = {}
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const loaded = await window.api.project.load(AUTO_ZOOM_PROJECT_ID)
    // trilha do cursor só em memória (o asset é um arquivo comum; o zoom automático só exige a marca)
    const p: Project = { ...loaded, assets: loaded.assets.map((a) => ({ ...a, cursor: 'cursor.json' })) }
    const itemId = p.tracks[0].items[0].id
    report.centered = await scenario(client, p, itemId, track(() => RED, [2000]), { scale: 2, holdMs: 1800, transitionMs: 700, smoothing: 0.6 })
    // vai do vermelho ao canto inferior direito entre 2,2 e 2,6 s e clica lá em 3,2 s
    const corner = { x: 0.97, y: 0.96 }
    const pos = (t: number): { x: number; y: number } => {
      const q = Math.min(1, Math.max(0, (t - 2200) / 400))
      return { x: RED.x + (corner.x - RED.x) * q, y: RED.y + (corner.y - RED.y) * q }
    }
    report.follow = await scenario(client, p, itemId, track(pos, [2000, 3200]), { scale: 3, holdMs: 1500, transitionMs: 700, smoothing: 0 })
    // controle: o mesmo enquadramento do canto SEM o clamp (zoom manual) mostra o fundo na borda — a medida acusa
    const loose = applyZoom(p, itemId, { x: corner.x, y: corner.y, w: 1 / 3, h: 1 / 3 }, 0, 300_000, null, 'linear', { clamp: false }).project
    report.control = await shot(client, loose, itemId, 1_000_000)
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}
