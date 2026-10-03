import type { CompositorMemStats } from '../engine/compositor/compositor'
import { TEXTURE_BUDGET_BYTES } from '../engine/compositor/textureCache'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'

// Memória do compositor (F7, spec §13 "texturas 512 MB") no motor real (CIALIGHT_TEST=editor-render): projeto
// p-editor-memory-test (criado pelo main) com 12 imagens 1920×1080 distintas em sequência (0,5 s cada, 0–6 s) e 4
// itens de vídeo 1080p (1 s cada, 6–10 s). Passa por todos os itens lendo memStats (≤ 512 MiB sempre; as texturas
// ficam no cache entre quadros); depois baixa o orçamento para 64 MiB (mensagem de teste), passa de novo (descarte
// LRU) e redesenha o 1º quadro de imagem e o 1º de vídeo: os pixels têm de ser idênticos aos de antes do descarte.

export const MEMORY_PROJECT_ID = 'p-editor-memory-test'
const W = 1920
const H = 1080
const LOW_BUDGET = 64 * 2 ** 20
// meio de cada item: 12 imagens de 0,5 s e 4 vídeos de 1 s
const STOPS = [...Array.from({ length: 12 }, (_, k) => k * 500_000 + 250_000), ...Array.from({ length: 4 }, (_, k) => 6_000_000 + k * 1_000_000 + 500_000)]
const IMAGE_AT = STOPS[0]
const VIDEO_AT = STOPS[12]

export interface MemoryReport {
  error?: string
  budget?: number
  /** maior textureBytes visto em cada passada */
  maxDefault?: number
  maxLow?: number
  afterDefault?: CompositorMemStats
  afterLow?: CompositorMemStats
  /** depois de redesenhar os quadros comparados (com o orçamento baixo) */
  afterRedraw?: CompositorMemStats
  /** diferença máx. por canal: quadro redesenhado depois do descarte × o mesmo quadro antes */
  imageMaxDiff?: number
  videoMaxDiff?: number
  /** quadros com pixels diferentes de zero (o quadro comparado não é vazio) */
  imageNonBlack?: number
  frameErrors?: string[]
}

export async function memoryCheck(): Promise<MemoryReport> {
  const report: MemoryReport = { budget: TEXTURE_BUDGET_BYTES, frameErrors: [] }
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const project = await window.api.project.load(MEMORY_PROJECT_ID)
    client.setProject(project, mediaUrlsFor(project, 'preview'), true)
    const draw = async (tUs: number): Promise<void> => {
      const r = await client.requestFrame(tUs, false)
      if (r.t !== 'rendered') report.frameErrors!.push(`${tUs}: ${JSON.stringify(r)}`)
      else if (r.missing.length) report.frameErrors!.push(`${tUs}: ausentes ${r.missing.join(', ')}`)
    }
    const pass = async (): Promise<number> => {
      let max = 0
      for (const tUs of STOPS) {
        await draw(tUs)
        const s = await client.memStats()
        if (!s) throw new Error('memStats sem compositor')
        max = Math.max(max, s.textureBytes)
      }
      return max
    }

    // 1ª passada no orçamento padrão; os quadros de referência são lidos no começo (nada descartado ainda)
    await draw(IMAGE_AT)
    const imageBefore = await client.readPixels(0, 0, W, H)
    await draw(VIDEO_AT)
    const videoBefore = await client.readPixels(0, 0, W, H)
    report.imageNonBlack = countNonBlack(imageBefore)
    report.maxDefault = await pass()
    report.afterDefault = (await client.memStats()) ?? undefined

    // orçamento baixo: as texturas dos itens fora do quadro saem pela ordem do último uso
    client.testTextureBudget(LOW_BUDGET)
    report.maxLow = await pass()
    report.afterLow = (await client.memStats()) ?? undefined

    await draw(IMAGE_AT)
    report.imageMaxDiff = maxDiff(imageBefore, await client.readPixels(0, 0, W, H))
    await draw(VIDEO_AT)
    report.videoMaxDiff = maxDiff(videoBefore, await client.readPixels(0, 0, W, H))
    report.afterRedraw = (await client.memStats()) ?? undefined
    client.testTextureBudget(null)
  } catch (e) {
    report.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return report
}

function maxDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 255
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

function countNonBlack(px: Uint8Array): number {
  let n = 0
  for (let i = 0; i < px.length; i += 4) if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16) n++
  return n
}
