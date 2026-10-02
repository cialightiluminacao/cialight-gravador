import { updateItem } from '@shared/editor/ops'
import type { MediaItem, Project } from '@shared/editor/project'
import { ANIM_TIMES, downsample2, measureShot, type AnimShot } from '@shared/testing/animShots'
import { RenderClient } from '../engine/RenderClient'
import { layerBlurRect } from '../engine/compositor/effectsMath'
import { detailEnergy } from '@shared/testing/pixels'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// Animações de entrada/saída (F4 Task 5) no motor real (CIALIGHT_TEST=editor-render), sobre o projeto do zoom
// (p-editor-zoom-test: PNG 1920×1080 escuro, quadrado vermelho de 12 px centrado em (1300, 350) e caixa verde
// 200×120 em (300, 700)). O clipe (3 s) recebe pop na entrada (1 s, linear) e desfoque na saída (1 s, linear):
// - pop: escala medida pela caixa verde (largura/altura) e pelo centro do vermelho (distância ao centro do quadro) —
//   ≈ 0,857 em 0,4 s, 1,05 em 0,7 s, 1 em 1,5 s; em 0 s a camada é invisível (quadro = fundo preto);
// - desfoque: energia de detalhe (ΔL² entre vizinhos, métrica do F2) na caixa verde ÷ a do repouso — 4 px em 2,2 s,
//   10 px em 2,5 s; em 960×540 o raio escala com a altura de saída: a mesma energia que o quadro de 1080 reduzido 2×;
// - paridade: o mesmo projeto exportado (o main mede os mesmos quadros com o ffmpeg);
// - PiP fora do centro (escala 0,4 em (0,75; 0,3): caixa 768×432 de (1056, 108) a (1824, 540) sobre o fundo preto) com
//   desfoque de entrada (1 s, linear; 10 px em 0,5 s): o desfoque age só dentro da caixa da camada + alcance (fora do
//   scissor de layerBlurRect o quadro é idêntico ao do repouso), o halo existe logo fora da caixa e chega a ~0 na margem
//   do scissor (sem degrau duro na "cola" do scissor).

export const ANIM_PROJECT_ID = 'p-editor-zoom-test'
const W = 1920
const H = 1080
export const ANIM_DUR_US = 3_000_000

export interface AnimReport {
  error?: string
  /** quadros do preview em 1920×1080, por instante (chaves de ANIM_TIMES) */
  preview?: Record<keyof typeof ANIM_TIMES, AnimShot>
  /** energia de detalhe em 960×540 (caixa pela metade) no repouso e com 10 px de desfoque: render nativo e o de 1080 reduzido 2× */
  half?: { rest: number; blur10: number; restDown: number; blur10Down: number }
  exportPath?: string
  exportError?: string
  pip?: PipBlurReport
}

/** PiP fora do centro com desfoque de entrada (10 px) × o mesmo quadro em repouso. */
export interface PipBlurReport {
  error?: string
  /** caixa da camada e scissor do desfoque (px, y para baixo, [x0,x1)×[y0,y1)) */
  box?: { x0: number; y0: number; x1: number; y1: number }
  scissor?: { x0: number; y0: number; x1: number; y1: number }
  /** energia de detalhe dentro da caixa (− 20 px): repouso × desfocado */
  inside?: { rest: number; blur: number }
  /** maior diferença por canal fora do scissor (desfocado × repouso) */
  outsideScissorMaxDiff?: number
  /** média da diferença na faixa de 1–3 px logo fora da caixa (o halo) */
  haloMean?: number
  /** maior diferença por canal na faixa de 2 px logo dentro da margem do scissor */
  marginMaxDiff?: number
  /** maior salto de luma entre vizinhos através da margem do scissor (desfocado) */
  marginStep?: number
}

export const PIP_BLUR = { scale: 0.4, x: 0.75, y: 0.3, restUs: 1_500_000, blurUs: 500_000, radiusPx: 10 } as const

/** O projeto do zoom com o clipe de 3 s, pop na entrada e desfoque na saída (1 s cada, linear). */
export function animProject(p: Project): Project {
  return updateItem<MediaItem>(p, p.tracks[0].items[0].id, (d) => {
    d.durationUs = ANIM_DUR_US
    d.visual!.animIn = { preset: 'pop', durationUs: 1_000_000, ease: 'linear' }
    d.visual!.animOut = { preset: 'blur', durationUs: 1_000_000, ease: 'linear' }
  })
}

async function frame(client: RenderClient, tUs: number, w: number, h: number): Promise<Uint8Array> {
  const r = await client.requestFrame(tUs, false)
  if (r.t !== 'rendered') throw new Error(`quadro em ${tUs}: ${JSON.stringify(r)}`)
  return client.readPixels(0, 0, w, h)
}

async function withClient<T>(w: number, h: number, run: (c: RenderClient) => Promise<T>): Promise<T> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: w, height: h, dpr: 1 })
  try {
    await client.ready
    return await run(client)
  } finally {
    client.dispose()
    canvas.remove()
  }
}

export async function animCheck(outDir: string | null): Promise<AnimReport> {
  const report: AnimReport = {}
  try {
    const p = animProject(await window.api.project.load(ANIM_PROJECT_ID))
    const down: { rest?: Uint8Array; blur10?: Uint8Array } = {}
    report.preview = await withClient(W, H, async (client) => {
      client.setProject(p, mediaUrlsFor(p, 'preview'), true)
      const out = {} as Record<keyof typeof ANIM_TIMES, AnimShot>
      for (const [k, t] of Object.entries(ANIM_TIMES) as [keyof typeof ANIM_TIMES, number][]) {
        const px = await frame(client, t, W, H)
        out[k] = measureShot(px, W, H, 4)
        if (k === 'rest' || k === 'blur10') down[k] = downsample2(px, W, H)
      }
      return out
    })
    report.half = await withClient(W / 2, H / 2, async (client) => {
      client.setProject(p, mediaUrlsFor(p, 'preview'), true)
      const at = async (t: number): Promise<number> => measureShot(await frame(client, t, W / 2, H / 2), W / 2, H / 2, 4).detail
      return {
        rest: await at(ANIM_TIMES.rest),
        blur10: await at(ANIM_TIMES.blur10),
        restDown: measureShot(down.rest!, W / 2, H / 2, 4).detail,
        blur10Down: measureShot(down.blur10!, W / 2, H / 2, 4).detail
      }
    })
    report.pip = await pipBlurCheck(await window.api.project.load(ANIM_PROJECT_ID))
    if (outDir) {
      try {
        const out = await runEditorExport({
          project: p, width: W, height: H, fps: p.canvas.fps, fromUs: 0, toUs: ANIM_DUR_US,
          videoBitrate: 16_000_000, audioBitrate: 128_000, outputDir: outDir, fileName: 'anim.mp4'
        })
        report.exportPath = out.path
      } catch (e) {
        report.exportError = e instanceof Error ? e.message : String(e)
      }
    } else report.exportError = 'sem pasta de saída'
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  }
  return report
}

/** O projeto do zoom com o clipe em PiP fora do centro e desfoque de entrada (1 s, linear). */
export function pipBlurProject(p: Project): Project {
  return updateItem<MediaItem>(p, p.tracks[0].items[0].id, (d) => {
    d.durationUs = ANIM_DUR_US
    d.visual!.transform.scale = { value: PIP_BLUR.scale }
    d.visual!.transform.x = { value: PIP_BLUR.x }
    d.visual!.transform.y = { value: PIP_BLUR.y }
    d.visual!.animIn = { preset: 'blur', durationUs: 1_000_000, ease: 'linear' }
  })
}

async function pipBlurCheck(base: Project): Promise<PipBlurReport> {
  try {
    const p = pipBlurProject(base)
    const [rest, blur] = await withClient(W, H, async (client) => {
      client.setProject(p, mediaUrlsFor(p, 'preview'), true)
      return [await frame(client, PIP_BLUR.restUs, W, H), await frame(client, PIP_BLUR.blurUs, W, H)]
    })
    // caixa da camada (contain de 1920×1080 no quadro 1920×1080, escala 0,4) e o scissor do compositor (px GL → y para baixo)
    const bw = W * PIP_BLUR.scale, bh = H * PIP_BLUR.scale
    const box = { x0: Math.round(PIP_BLUR.x * W - bw / 2), y0: Math.round(PIP_BLUR.y * H - bh / 2), x1: Math.round(PIP_BLUR.x * W + bw / 2), y1: Math.round(PIP_BLUR.y * H + bh / 2) }
    const gl = layerBlurRect([[box.x0, H - box.y1], [box.x1, H - box.y1], [box.x1, H - box.y0], [box.x0, H - box.y0]], PIP_BLUR.radiusPx, W, H)
    const sc = { x0: gl.x, y0: H - (gl.y + gl.h), x1: gl.x + gl.w, y1: H - gl.y }
    const luma = (d: Uint8Array, i: number): number => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const diff = (i: number): number => Math.max(Math.abs(rest[i] - blur[i]), Math.abs(rest[i + 1] - blur[i + 1]), Math.abs(rest[i + 2] - blur[i + 2]))
    const inRect = (x: number, y: number, r: { x0: number; y0: number; x1: number; y1: number }, g = 0): boolean => x >= r.x0 - g && x < r.x1 + g && y >= r.y0 - g && y < r.y1 + g
    let outside = 0, haloSum = 0, haloN = 0, margin = 0, step = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (!inRect(x, y, sc)) outside = Math.max(outside, diff(i))
        else if (!inRect(x, y, sc, -2)) margin = Math.max(margin, diff(i))
        if (inRect(x, y, box, 3) && !inRect(x, y, box, 1)) { haloSum += diff(i); haloN++ }
      }
    }
    // degrau através da margem: pares de vizinhos (dentro, fora) em cada lado do scissor, no quadro desfocado
    for (let y = sc.y0; y < sc.y1; y++) {
      if (sc.x0 > 0) step = Math.max(step, Math.abs(luma(blur, (y * W + sc.x0) * 4) - luma(blur, (y * W + sc.x0 - 1) * 4)))
      if (sc.x1 < W) step = Math.max(step, Math.abs(luma(blur, (y * W + sc.x1 - 1) * 4) - luma(blur, (y * W + sc.x1) * 4)))
    }
    for (let x = sc.x0; x < sc.x1; x++) {
      if (sc.y0 > 0) step = Math.max(step, Math.abs(luma(blur, (sc.y0 * W + x) * 4) - luma(blur, ((sc.y0 - 1) * W + x) * 4)))
      if (sc.y1 < H) step = Math.max(step, Math.abs(luma(blur, ((sc.y1 - 1) * W + x) * 4) - luma(blur, (sc.y1 * W + x) * 4)))
    }
    const e = (d: Uint8Array): number => detailEnergy(d, W, box.x0 + 20, box.y0 + 20, box.x1 - 20, box.y1 - 20)
    return { box, scissor: sc, inside: { rest: e(rest), blur: e(blur) }, outsideScissorMaxDiff: outside, haloMean: haloN ? haloSum / haloN : 0, marginMaxDiff: margin, marginStep: step }
  } catch (e) {
    return { error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
  }
}
