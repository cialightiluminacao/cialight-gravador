import { describe, expect, it } from 'vitest'
import { withDeferredFallbacks } from './attachment'
import { createEmptyProject, createMediaItem } from './factory'
import { findItem, moveItems } from './ops'
import type { Asset, EffectItem, MediaItem, Project, Track, Us } from './project'
import { hideOccurrences } from './sensitiveEffects'
import type { Occurrence, OccurrenceSample } from './sensitiveScan'
import type { OcrBox } from './sensitive'

// Desempenho do G3 (Task 4): hideOccurrences em lote e o arraste de um clipe com 600 efeitos vinculados (invariante 6).
// Arquivo próprio (worker e heap próprios, longe dos oráculos densos de sensitiveEffects.test.ts). Alvos absolutos da
// máquina livre; sob a suíte inteira em paralelo, o padrão do attachPerf (melhor medida, até 3 tentativas espaçadas).

const S = 1_000_000
const W = 1920, H = 1080
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: 20 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }
const vtrack = (id: string, items: MediaItem[]): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, volume: 1, items })
const clip = (id: string, startUs: Us, durationUs: Us, extra: Partial<MediaItem> = {}): MediaItem => ({ ...createMediaItem(vid, startUs, 'video'), id, durationUs, ...extra })
function project(clips: MediaItem[]): Project {
  const p = createEmptyProject('t')
  p.assets = [vid]
  p.tracks = [vtrack('tv', clips)]
  return p
}
const effects = (p: Project): EffectItem[] => p.tracks.flatMap((t) => t.items.filter((i): i is EffectItem => i.type === 'effect'))
/** Ocorrência como a varredura a entrega (amostras a cada 0,5 s; 0,1 s com refinamento). */
function occurrence(id: string, fromUs: Us, toUs: Us, boxAt: (t: Us) => OcrBox, refine = false): Occurrence {
  const samples: OccurrenceSample[] = []
  const step = refine ? 100_000 : 500_000
  for (let t = fromUs; t <= toUs; t += step) samples.push({ tUs: t, box: boxAt(t), src: (t - fromUs) % 500_000 === 0 ? 'ocr' : 'track' })
  return {
    id, kind: 'cpf', masked: '***.456.***-**', confidence: 'validated', samples,
    firstSeenUs: fromUs, lastSeenUs: toUs, startUs: Math.max(0, fromUs - 500_000), endUs: Math.min(vid.durationUs! - 1, toUs + 500_000),
    sourceW: W, sourceH: H
  }
}

describe('hideOccurrences — desempenho', () => {
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  it('200 ocorrências × 3 clipes < 50 ms', async () => {
    const occs = Array.from({ length: 200 }, (_, i) => occurrence(`o${i}`, ((i * 97) % 18) * S, ((i * 97) % 18) * S + 1_500_000, (t) => ({ x: (i % 10) / 11, y: ((i * 7) % 30) / 31 + (t % 1000) / 1e7, w: 0.08, h: 0.03 })))
    const p0 = project([clip('a', 0, 20 * S), clip('b', 20 * S, 10 * S, { speed: 2 }), clip('c', 30 * S, 20 * S, { reverse: true })])
    // melhor medida (padrão do attachPerf), repetindo por até 6 s enquanto passar do alvo: a suíte inteira em paralelo
    // (16 workers) deixa uma medida isolada ~6× mais lenta; a 1ª chamada aquece o JIT. Sozinho (esta máquina): ~20 ms
    // (node) / ~40 ms (vitest).
    hideOccurrences(p0, 'v', occs, { style: 'blur' }) // aquecimento
    // 1ª chamada já aquecida: ≤ 3 × o alvo (pega uma regressão lenta e constante que o melhor-de-N esconderia). Até 3
    // tentativas com uma pausa entre elas (padrão do attachPerf: a carga da suíte em paralelo varia; o alvo não muda)
    let r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
    let first = Infinity
    for (let a = 0; a < 3 && first > 150; a++) {
      if (a > 0) await pause(5000)
      const tw = performance.now()
      r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
      first = Math.min(first, performance.now() - tw)
    }
    let ms = Infinity
    const until = performance.now() + 6000
    while (ms >= 50 && performance.now() < until) {
      const t0 = performance.now()
      r = hideOccurrences(p0, 'v', occs, { style: 'blur' })
      ms = Math.min(ms, performance.now() - t0)
    }
    console.log(`hideOccurrences 200×3: melhor ${ms.toFixed(1)} ms, 1ª aquecida ${first.toFixed(1)} ms, ${r.itemIds.length} efeitos, ${r.project.tracks.filter((t) => t.role === 'effects').length} faixas`)
    expect(r.itemIds.length).toBe(600)
    expect(ms).toBeLessThan(50)
    expect(first).toBeLessThanOrEqual(150)
  }, 60_000)

  it('arrastar o clipe com 600 efeitos vinculados: mediana < 8 ms por passo (transitório, caixas de reserva adiadas)', async () => {
    const occs = Array.from({ length: 600 }, (_, i) => occurrence(`o${i}`, ((i * 37) % 15) * S + 500_000, ((i * 37) % 15) * S + 2_500_000, () => ({ x: (i % 12) / 13, y: ((i * 7) % 30) / 31, w: 0.06, h: 0.03 })))
    const p0 = hideOccurrences(project([clip('a', 0, 20 * S, { linkId: 'L' })]), 'v', occs, { style: 'blur' }).project
    expect(effects(p0).filter((f) => f.linkId === 'L').length).toBe(600)
    // passos de arraste como o store os aplica: cada um sobre o anterior, em withDeferredFallbacks (transação transitória)
    const steps = (n: number): number[] => {
      let p = p0
      const out: number[] = []
      for (let k = 1; k <= n; k++) {
        const t0 = performance.now()
        p = withDeferredFallbacks(() => moveItems(p, ['a'], 33_333))
        out.push(performance.now() - t0)
      }
      expect(findItem(p, 'a')!.item.startUs).toBe(n * 33_333)
      return out
    }
    steps(5) // aquecimento
    // mediana de rodadas de 10 passos; até 3 tentativas (pausa entre elas), cada uma com rodadas por até 2 s: a menor mediana
    // (a suíte em paralelo deixa medidas lentas; o alvo não muda)
    let best = Infinity, median = Infinity
    for (let a = 0; a < 3 && median >= 8; a++) {
      if (a > 0) await pause(5000)
      const until = performance.now() + 2000
      while (median >= 8 && performance.now() < until) {
        const ts = steps(10).sort((x, y) => x - y)
        median = Math.min(median, (ts[4] + ts[5]) / 2)
        best = Math.min(best, ts[0])
      }
    }
    console.log(`arraste com 600 efeitos vinculados: mediana ${median.toFixed(2)} ms/passo (melhor ${best.toFixed(2)} ms)`)
    expect(median).toBeLessThan(8)
  }, 60_000)
})
