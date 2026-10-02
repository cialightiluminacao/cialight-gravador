import { updateItem } from '@shared/editor/ops'
import type { MediaItem, Project } from '@shared/editor/project'
import { ANIM_TIMES, downsample2, measureShot, type AnimShot } from '@shared/testing/animShots'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { runEditorExport } from '../export/editorExport'

// Animações de entrada/saída (F4 Task 5) no motor real (CIALIGHT_TEST=editor-render), sobre o projeto do zoom
// (p-editor-zoom-test: PNG 1920×1080 escuro, quadrado vermelho de 12 px centrado em (1300, 350) e caixa verde
// 200×120 em (300, 700)). O clipe (3 s) recebe pop na entrada (1 s, linear) e desfoque na saída (1 s, linear):
// - pop: escala medida pela caixa verde (largura/altura) e pelo centro do vermelho (distância ao centro do quadro) —
//   ≈ 0,857 em 0,4 s, 1,05 em 0,7 s, 1 em 1,5 s; em 0 s a camada é invisível (quadro = fundo preto);
// - desfoque: energia de detalhe (ΔL² entre vizinhos, métrica do F2) na caixa verde ÷ a do repouso — 4 px em 2,2 s,
//   10 px em 2,5 s; em 960×540 o raio escala com a altura de saída: a mesma energia que o quadro de 1080 reduzido 2×;
// - paridade: o mesmo projeto exportado (o main mede os mesmos quadros com o ffmpeg).

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
}

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
