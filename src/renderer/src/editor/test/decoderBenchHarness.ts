import { createMediaItem } from '@shared/editor/factory'
import type { Project } from '@shared/editor/project'
import { RenderClient } from '../engine/RenderClient'
import type { DecoderAccel } from '../engine/decoderPool'
import { mediaUrlsFor } from '../engine/mediaUrls'

// G1: medição da reprodução (preview) com o decoder em software × hardware (sem preferência), em 1080p e 4K
// (testsrc2 sintético do main, projeto DECODER_BENCH_PROJECT_ID). Reprodução sequencial pelo testBench do render
// worker (frameMs = quadro inteiro, decodificação inclusa; drawMs = compositor + GPU), canvas 1920×1080 como o
// preview. As rodadas se alternam (hw, sw, hw, sw) para a carga da máquina pesar igual nos dois. Só registra os
// números (decisão do preview: trocar para software só se o p95 de frameMs não piorar em nenhuma resolução) — sem
// asserção de tempo. Fora da rodada normal do test:editor: liga com CIALIGHT_DECODER_BENCH=1, ex.:
//   node C:/Users/Eduardo/projetos/_locks/run-locked.mjs "npx cross-env CIALIGHT_DECODER_BENCH=1 npm run test:editor"

export const DECODER_BENCH_PROJECT_ID = 'p-editor-decoder-bench'
const W = 1920
const H = 1080
const FPS = 30
const FRAMES = 90
const WARMUP = 5

type Stats = { n: number; median: number; p95: number; max: number }
export interface DecoderBenchRun { res: '1080p' | '4k'; accel: DecoderAccel; frameMs: Stats; drawMs: Stats; error?: string }
export interface DecoderBenchReport { error?: string; runs: DecoderBenchRun[]; summary?: Record<string, { hwP95: number; swP95: number; hwMedian: number; swMedian: number }> }

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b)
  const r = (v: number): number => Math.round(v * 100) / 100
  return { n: s.length, median: r(s[Math.floor(s.length / 2)] ?? 0), p95: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0), max: r(s[s.length - 1] ?? 0) }
}

export async function decoderBenchCheck(): Promise<DecoderBenchReport> {
  const out: DecoderBenchReport = { runs: [] }
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = '480px'
  document.body.appendChild(canvas)
  const client = new RenderClient(canvas, { width: W, height: H, dpr: 1 })
  try {
    await client.ready
    const base = await window.api.project.load(DECODER_BENCH_PROJECT_ID)
    for (const [res, assetId] of [['1080p', 'a_hd'], ['4k', 'a_4k']] as const) {
      const asset = base.assets.find((a) => a.id === assetId)
      if (!asset) throw new Error(`asset ${assetId} ausente`)
      const item = createMediaItem(asset, 0, 'video')
      const p: Project = { ...base, assets: [asset], tracks: [{ id: 't_v', kind: 'video', name: 'Vídeo', muted: false, hidden: false, locked: false, volume: 1, items: [item] }] }
      client.setProject(p, mediaUrlsFor(p, 'preview'), true)
      for (const accel of ['no-preference', 'prefer-software', 'no-preference', 'prefer-software'] as const) {
        client.testDecoder(accel) // descarta os decoders abertos com a outra opção
        await client.testBench(0, WARMUP, FPS) // abre o decoder e aquece
        const b = await client.testBench(500_000, FRAMES, FPS)
        out.runs.push({ res, accel, frameMs: stats(b.frameMs.slice(WARMUP)), drawMs: stats(b.drawMs.slice(WARMUP)), ...(b.error ? { error: b.error } : {}) })
      }
    }
    client.testDecoder('no-preference')
    out.summary = {}
    for (const res of ['1080p', '4k'] as const) {
      const pick = (accel: DecoderAccel): DecoderBenchRun[] => out.runs.filter((r) => r.res === res && r.accel === accel)
      const worst = (rs: DecoderBenchRun[], k: 'p95' | 'median'): number => Math.max(...rs.map((r) => r.frameMs[k]))
      const hw = pick('no-preference')
      const sw = pick('prefer-software')
      out.summary[res] = { hwP95: worst(hw, 'p95'), swP95: worst(sw, 'p95'), hwMedian: worst(hw, 'median'), swMedian: worst(sw, 'median') }
    }
  } catch (e) {
    out.error = e instanceof Error ? (e.stack ?? e.message) : String(e)
  } finally {
    client.dispose()
    canvas.remove()
  }
  return out
}
