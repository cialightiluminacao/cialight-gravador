import type { RenderOut } from '../engine/protocol'
import { RenderClient } from '../engine/RenderClient'
import { mediaUrlsFor } from '../engine/mediaUrls'

// Teste de integração do render (CIALIGHT_TEST=editor-render), rota index.html#editor-test/<projectId>:
// monta só o RenderClient sobre um canvas 1920×1080, pede quadros e devolve leituras de pixels ao
// main, que valida (editorTestMode.ts).

declare global {
  interface Window {
    __captureTestSend?: (r: unknown) => void
  }
}

const W = 1920
const H = 1080

export async function runRenderHarness(projectId: string): Promise<void> {
  const report: Record<string, unknown> = { errors: [] as string[] }
  const errors = report.errors as string[]
  let ok = false
  try {
    const project = await window.api.project.load(projectId)
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    canvas.style.width = '480px'
    document.body.appendChild(canvas)
    const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
    client.onMessage((m) => {
      if (m.t === 'error') errors.push(m.message)
    })
    await client.ready
    client.setProject(project, mediaUrlsFor(project, 'preview'), true)

    const px = async (x: number, y: number): Promise<number[]> => [...(await client.readPixels(x, y, 1, 1))]
    const region = (x: number, y: number, s: number): Promise<Uint8Array> => client.readPixels(x - s / 2, y - s / 2, s, s)

    const first = await client.requestFrame(1_000_000, false)
    report.first = first
    report.pixels = {
      circleCenter: await px(1680, 135),
      boxCorner: await px(1550, 5),
      missing: await px(240, 945),
      corrupt: await px(720, 945),
      stroke: await px(1056, 324)
    }
    const at1s = await region(W / 2, H / 2, 200)
    report.videoMean = mean(at1s)

    // reprodução sequencial (iterador) e seek
    const seq: RenderOut[] = []
    for (let i = 1; i <= 5; i++) seq.push(await client.requestFrame(1_000_000 + i * 33_333, true))
    report.sequential = seq
    report.seek = await client.requestFrame(2_500_000, false)
    report.videoDiff = meanAbsDiff(at1s, await region(W / 2, H / 2, 200))

    // vários pedidos sem esperar: o worker coalesce, todos resolvem
    const burst = await Promise.all([0, 1, 2, 3, 4].map((i) => client.requestFrame(500_000 + i * 100_000, false)))
    report.burst = burst.map((r) => r.t)
    client.dispose()
    ok = true
  } catch (e) {
    errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
  }
  window.__captureTestSend?.({ ok, report })
}

function mean(d: Uint8Array): number[] {
  const s = [0, 0, 0]
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) s[c] += d[i + c]
  return s.map((v) => Math.round(v / (d.length / 4)))
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i])
  return s / ((a.length / 4) * 3)
}
