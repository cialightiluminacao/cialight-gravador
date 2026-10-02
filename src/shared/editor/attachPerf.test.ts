import { describe, expect, it } from 'vitest'
import { createEffectItem, createEmptyProject, createMediaItem } from './factory'
import { attachEffects } from './followTransform'
import { deleteRanges, updateTrack } from './ops'
import type { Asset, EffectItem, MediaItem, Project } from './project'
import { applyKenBurns } from './zoom'

// Desempenho da manutenção das âncoras (maintainAttachments roda em toda edição): projeto de 1 h com um efeito ancorado
// num clipe com Ken Burns, cortado em 301 pedaços (como o corte de silêncios).
const S = 1_000_000
const H1 = 3600 * S
const vid: Asset = { id: 'v', name: 'v', kind: 'video', source: { type: 'file', path: 'C:/v.mp4', size: 1, mtimeMs: 1 }, durationUs: H1 + 10 * S, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready' }

/** Projeto de 1 h com Ken Burns no clipe e o blur vinculado; `anchored` = o blur ancorado ao clipe. */
function hourProject(anchored = true): Project {
  const p = createEmptyProject('perf')
  p.assets = [vid]
  const m = { ...createMediaItem(vid, 0, 'video'), id: 'm', durationUs: H1, linkId: 'l1' } as MediaItem
  const fx = { ...createEffectItem('blur', 0, H1, { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }), id: 'fx', linkId: 'l1' } as EffectItem
  p.tracks = [
    { id: 'tv', kind: 'video', name: 'Vídeo', muted: false, hidden: false, locked: false, volume: 1, items: [m] },
    { id: 'tf', kind: 'video', name: 'Efeitos', role: 'effects', muted: false, hidden: false, locked: false, volume: 1, items: [fx] }
  ]
  const kb = applyKenBurns(p, 'm', 'br').project
  return anchored ? attachEffects(kb, 'm', ['fx']) : kb
}
/** 300 silêncios de 1 s, um a cada 12 s. */
const silences = Array.from({ length: 300 }, (_, i) => ({ fromUs: (i * 12 + 6) * S, toUs: (i * 12 + 7) * S }))
const ms = (f: () => void): number => {
  const t = performance.now()
  f()
  return performance.now() - t
}
/**
 * Custo da âncora sem depender da carga da máquina: `anchored` e `plain` (a mesma edição no mesmo projeto sem âncora)
 * medidos intercalados, depois de aquecer o JIT (`warm` chamadas de cada: com a máquina ocupada o JIT otimiza mais
 * tarde, e uma edição de ~1 ms medida a frio chegou a 14× a outra), e comparados pelo melhor de cada. O tempo
 * absoluto de um teste de desempenho no vitest (arquivos em paralelo, outros processos) varia ~25× com a carga — um
 * limite em ms dava falha intermitente (o corte de 1 h: ~40 ms sozinho, ~95 ms na suíte inteira contra o limite de
 * 200 ms); a razão entre as duas medidas no mesmo instante varia pouco (1,6–2,0).
 */
function overhead(anchored: () => void, plain: () => void, rounds: number, warm = 1): { anchored: number; plain: number; ratio: number } {
  for (let i = 0; i < warm; i++) {
    anchored()
    plain()
  }
  let a = Infinity, b = Infinity
  for (let i = 0; i < rounds; i++) {
    a = Math.min(a, ms(anchored))
    b = Math.min(b, ms(plain))
  }
  return { anchored: a, plain: b, ratio: a / b }
}

// projeto de 1 h montado e cortado várias vezes: com a máquina ocupada passa dos 5 s padrão do vitest
const PERF_TIMEOUT_MS = 30_000

describe('desempenho das âncoras', () => {
  it('corte de silêncios (deleteRanges, 300 trechos) num projeto de 1 h com efeito ancorado: até 3× o corte sem âncora (sozinho ≈ 40 ms; teto 2 s)', () => {
    const p = hourProject()
    const plain = hourProject(false)
    const cut = deleteRanges(p, silences)
    const fxs = cut.tracks[1].items as EffectItem[]
    expect(fxs).toHaveLength(301)
    // cada pedaço ancorado no pedaço do clipe que ele cruza, com a caixa de reserva
    const media = new Set(cut.tracks[0].items.map((i) => i.id))
    expect(fxs.every((f) => f.attach && media.has(f.attach.mediaItemId) && f.attach.fallback)).toBe(true)
    expect(new Set(fxs.map((f) => f.attach!.mediaItemId)).size).toBe(301)
    const t = overhead(() => deleteRanges(p, silences), () => deleteRanges(plain, silences), 5)
    // manter as âncoras não muda a ordem do custo (quadrático nos pedaços daria dezenas de ×)
    expect(t.ratio).toBeLessThan(3)
    // teto de catástrofe (sob carga pesada o corte inteiro chegou a ~1 s)
    expect(t.anchored).toBeLessThan(2000)
  }, PERF_TIMEOUT_MS)
  it('301 pedaços ancorados + edição trivial (renomear faixa): no máximo 5× a mesma edição sem âncora, sem trocar nenhum efeito', () => {
    const cut = deleteRanges(hourProject(), silences)
    const cutPlain = deleteRanges(hourProject(false), silences)
    let n = 0
    const t = overhead(() => updateTrack(cut, 'tv', { name: `Vídeo ${++n}` }), () => updateTrack(cutPlain, 'tv', { name: `Vídeo ${++n}` }), 15, 50)
    // a edição trivial não recalcula nem troca nenhum efeito
    const q = updateTrack(cut, 'tv', { name: 'X' })
    expect(q.tracks[1].items.every((it, i) => it === cut.tracks[1].items[i])).toBe(true)
    // sozinho: ~0,65 ms × ~0,5 ms sem âncora
    expect(t.ratio).toBeLessThan(5)
    expect(t.anchored).toBeLessThan(200)
  }, PERF_TIMEOUT_MS)
})
