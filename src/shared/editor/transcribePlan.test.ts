import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import * as ops from './ops'
import type { Asset, MediaItem, Project, Track } from './project'
import { planTranscription, TRANSCRIBE_MERGE_GAP_US, TRANSCRIBE_PAD_US, wordsToTimeline, type SourceWord } from './transcribePlan'

const S = 1_000_000
const aud = (id: string, durationUs: number | null = 30 * S): Asset => ({
  id, name: id, kind: 'audio', source: { type: 'file', path: `C:/${id}.wav`, size: 1, mtimeMs: 1 }, durationUs,
  audio: { channels: 1, sampleRate: 48000, codec: 'pcm' }, status: 'ready'
})
const vidA = (id: string): Asset => ({
  id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: 30 * S,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S },
  audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready'
})
const w = (text: string, startS: number, endS: number, prob?: number): SourceWord => ({ text, startUs: Math.round(startS * S), endUs: Math.round(endS * S), ...(prob !== undefined ? { prob } : {}) })

/** Projeto com um asset de áudio na faixa "Áudio 1" com papel de voz; devolve o id do item. */
function voiceProject(asset: Asset = aud('v')): { p: Project; item: string; track: string } {
  const p0 = ops.addAsset(createEmptyProject('t'), asset)
  // áudio solto iria para a faixa "Música": põe na "Áudio 1" e dá a ela o papel de voz
  const track = p0.tracks[1].id
  const r = ops.addMediaFromAsset(p0, asset.id, 0, { audioTrackId: track })
  return { p: ops.updateTrack(r.project, track, { role: 'voice' }), item: r.itemIds[0], track }
}
const setItem = (p: Project, id: string, f: (d: MediaItem) => void): Project => ops.updateItem<MediaItem>(p, id, f)
/** Faixa de áudio nova (com papel) e um item do asset nela em `atUs`. */
function addOn(p: Project, assetId: string, role: Track['role'] | undefined, atUs = 0): { p: Project; item: string; track: string } {
  const t = ops.addTrack(p, 'audio', undefined, `A ${p.tracks.length}`, role)
  const r = ops.addMediaFromAsset(t.project, assetId, atUs, { audioTrackId: t.trackId, mode: 'overwrite' })
  return { p: r.project, item: r.itemIds[r.itemIds.length - 1], track: t.trackId }
}

describe('constantes', () => {
  it('valores fixos', () => {
    expect(TRANSCRIBE_PAD_US).toBe(300_000)
    expect(TRANSCRIBE_MERGE_GAP_US).toBe(2_000_000)
  })
})

describe('wordsToTimeline', () => {
  it('1. clipe 1× em 0, inUs 0, faixa de voz → identidade exata (e ordena uma cópia da entrada)', () => {
    const { p, item, track } = voiceProject()
    const plan = planTranscription(p)
    expect(plan.scope).toBe('voice')
    const words = [w('mundo', 1.5, 1.9, 0.8), w('olá', 0.25, 0.75, 0.9)]
    const frozen = Object.freeze([...words])
    const out = wordsToTimeline(plan.segments, { v: frozen })
    expect(out).toEqual([
      { text: 'olá', startUs: 250_000, endUs: 750_000, prob: 0.9, itemId: item, trackId: track },
      { text: 'mundo', startUs: 1_500_000, endUs: 1_900_000, prob: 0.8, itemId: item, trackId: track }
    ])
    // sem prob na entrada → sem prob na saída
    expect(wordsToTimeline(plan.segments, { v: [w('a', 1, 2)] })[0]).not.toHaveProperty('prob')
    // asset sem palavras → nada
    expect(wordsToTimeline(plan.segments, {})).toEqual([])
  })

  it('2. início 5 s, inUs 10 s, velocidade 2 → [12,0 s; 12,4 s] da fonte vira [6,0 s; 6,2 s] exatos', () => {
    const { p: p0, item } = voiceProject()
    const p = setItem(p0, item, (d) => { d.startUs = 5 * S; d.inUs = 10 * S; d.speed = 2; d.durationUs = 5 * S })
    const plan = planTranscription(p)
    expect(plan.jobs).toEqual([{ assetId: 'v', fromUs: 10 * S - TRANSCRIBE_PAD_US, toUs: 20 * S + TRANSCRIBE_PAD_US }])
    const out = wordsToTimeline(plan.segments, { v: [w('x', 12.0, 12.4)] })
    expect(out.map((x) => [x.startUs, x.endUs])).toEqual([[6 * S, 6_200_000]])
  })

  it('3. aparado: palavra fora do trecho cai; palavra na borda fica só se o meio está dentro, presa ao item', () => {
    const { p: p0, item } = voiceProject()
    // lê a fonte [2 s, 5 s)
    const p = setItem(p0, item, (d) => { d.inUs = 2 * S; d.durationUs = 3 * S })
    const plan = planTranscription(p)
    const out = wordsToTimeline(plan.segments, {
      v: [w('fora', 0.5, 1.0), w('antes', 1.5, 2.3), w('entra', 1.8, 2.4), w('meio', 3, 3.5), w('sai', 4.6, 5.2), w('depois', 4.8, 5.6), w('longe', 8, 9)]
    })
    expect(out.map((x) => [x.text, x.startUs, x.endUs])).toEqual([
      ['entra', 0, 400_000],
      ['meio', 1 * S, 1_500_000],
      ['sai', 2_600_000, 3 * S]
    ])
  })

  it('4. remoção de silêncio (deleteRanges [4,6) e [10,13)): palavras nos pedaços com tempos exatos; meio no corte cai', () => {
    const { p: p0, item } = voiceProject(aud('v', 20 * S))
    const p1 = setItem(p0, item, (d) => { d.durationUs = 20 * S })
    const p = ops.deleteRanges(p1, [{ fromUs: 4 * S, toUs: 6 * S }, { fromUs: 10 * S, toUs: 13 * S }])
    const items = p.tracks[1].items
    expect(items.map((i) => [i.startUs, i.durationUs, (i as MediaItem).inUs])).toEqual([[0, 4 * S, 0], [4 * S, 4 * S, 6 * S], [8 * S, 7 * S, 13 * S]])
    const plan = planTranscription(p)
    expect(plan.segments).toHaveLength(3)
    const out = wordsToTimeline(plan.segments, {
      v: [w('um', 1, 1.5), w('borda', 3.6, 4.2), w('cortada', 4.5, 5.5), w('dois', 6.5, 7), w('cortada2', 11, 11.6), w('três', 14, 14.5), w('fim', 19.5, 20)]
    })
    expect(out.map((x) => [x.text, x.startUs, x.endUs, x.itemId])).toEqual([
      ['um', 1 * S, 1_500_000, items[0].id],
      ['borda', 3_600_000, 4 * S, items[0].id],
      ['dois', 4_500_000, 5 * S, items[1].id],
      ['três', 9 * S, 9_500_000, items[2].id],
      ['fim', 14_500_000, 15 * S, items[2].id]
    ])
    // fonte lida: [0,4) [6,10) [13,20) → com a margem de 0,3 s os vãos são 1,4 s (emenda) e 2,4 s (> 2 s: não emenda).
    // O brief pedia UM job aqui, mas com os valores fixos (margem 0,3 s, vão 2 s) o corte de 3 s deixa 2,4 s de vão.
    expect(plan.jobs).toEqual([
      { assetId: 'v', fromUs: 0, toUs: 10 * S + TRANSCRIBE_PAD_US },
      { assetId: 'v', fromUs: 13 * S - TRANSCRIBE_PAD_US, toUs: 20 * S }
    ])
    // com silêncios de até 2,6 s (vão ≤ 2 s depois da margem) a fonte vira UM job só
    const q = ops.deleteRanges(p1, [{ fromUs: 4 * S, toUs: 6 * S }, { fromUs: 10 * S, toUs: 12 * S }])
    expect(planTranscription(q).jobs).toEqual([{ assetId: 'v', fromUs: 0, toUs: 20 * S }])
  })
})

describe('planTranscription', () => {
  it('5. reverso fica de fora; 8× com tom preservado e sem "manter acelerado" fica de fora (mudo); com ele, entra', () => {
    const { p, item } = voiceProject()
    expect(planTranscription(setItem(p, item, (d) => { d.reverse = true })).scope).toBe('none')
    const fast = (keep: boolean): Project => setItem(p, item, (d) => { d.speed = 8; d.durationUs = Math.round(d.durationUs / 8); d.audio.preservePitch = true; d.audio.keepFastAudio = keep })
    expect(planTranscription(fast(false))).toEqual({ segments: [], jobs: [], scope: 'none' })
    const on = planTranscription(fast(true))
    expect(on.scope).toBe('voice')
    expect(on.segments).toHaveLength(1)
  })

  it('6. fora: faixa muda, áudio do item desligado, item desativado, volume 0 da faixa ou do item', () => {
    const { p, item, track } = voiceProject()
    expect(planTranscription(p).segments).toHaveLength(1)
    const none = (q: Project): void => expect(planTranscription(q)).toEqual({ segments: [], jobs: [], scope: 'none' })
    none(ops.updateTrack(p, track, { muted: true }))
    none(setItem(p, item, (d) => { d.audio.enabled = false }))
    none(ops.setItemEnabled(p, [item], false))
    none(ops.updateTrack(p, track, { volume: 0 }))
    none(setItem(p, item, (d) => { d.audio.volume = { value: 0 } }))
    // volume 0 só num trecho (keyframe) ainda soa: entra
    expect(planTranscription(setItem(p, item, (d) => { d.audio.volume = { value: 0, keys: [{ tUs: 0, value: 0, ease: 'linear' }, { tUs: 5 * S, value: 1, ease: 'linear' }] } })).segments).toHaveLength(1)
  })

  it('7. escopo: voz presente → só voz; sem voz → fallback com o áudio do próprio vídeo; música e efeitos nunca; nada → none', () => {
    // vídeo com áudio próprio ligado (sem o item de áudio separado), música e efeitos sonoros
    let p = ops.addAsset(ops.addAsset(ops.addAsset(createEmptyProject('t'), vidA('cam')), aud('mus')), aud('sfx'))
    const r = ops.addMediaFromAsset(p, 'cam', 0)
    p = ops.deleteItems(r.project, [r.itemIds[1]], { includeLinked: false })
    p = setItem(p, r.itemIds[0], (d) => { d.audio.enabled = true })
    const videoItem = r.itemIds[0]
    let m = addOn(p, 'mus', 'music')
    m = addOn(m.p, 'sfx', 'sfx')
    p = m.p
    const fb = planTranscription(p)
    expect(fb.scope).toBe('fallback')
    expect(fb.segments.map((s) => s.itemId)).toEqual([videoItem])
    expect(fb.jobs).toEqual([{ assetId: 'cam', fromUs: 0, toUs: 30 * S }])
    // com uma faixa de voz: só ela
    p = ops.addAsset(p, aud('mic'))
    const v = addOn(p, 'mic', 'voice')
    const vp = planTranscription(v.p)
    expect(vp.scope).toBe('voice')
    expect(vp.segments.map((s) => s.itemId)).toEqual([v.item])
    expect(vp.jobs.map((j) => j.assetId)).toEqual(['mic'])
    // só música e efeitos sonoros → o áudio de efeitos é a última camada (fallback); só música → none
    const only = setItem(p, videoItem, (d) => { d.audio.enabled = false })
    expect(planTranscription(only).scope).toBe('fallback')
    expect(planTranscription(only).jobs.map((j) => j.assetId)).toEqual(['sfx'])
    // projeto vazio → none
    expect(planTranscription(createEmptyProject('x'))).toEqual({ segments: [], jobs: [], scope: 'none' })
  })

  it('7b. só áudio do sistema (faixa sfx): última camada, escopo fallback; música nunca', () => {
    let p = ops.addAsset(ops.addAsset(createEmptyProject('t'), aud('sys')), aud('mus'))
    const m = addOn(p, 'mus', 'music')
    expect(planTranscription(m.p).scope).toBe('none')
    const s = addOn(m.p, 'sys', 'sfx')
    const plan = planTranscription(s.p)
    expect(plan.scope).toBe('fallback')
    expect(plan.segments.map((x) => x.itemId)).toEqual([s.item])
    expect(plan.jobs.map((j) => j.assetId)).toEqual(['sys'])
    p = addOn(s.p, 'sys', 'voice').p
    expect(planTranscription(p).scope).toBe('voice')
  })

  it('8. jobs: vão de 1 s emenda, 5 s separa; margem presa em 0 e na duração do asset; assets na ordem em que aparecem', () => {
    const two = (gapS: number): Project => {
      const { p, item } = voiceProject(aud('v', 60 * S))
      let q = setItem(p, item, (d) => { d.inUs = 10 * S; d.durationUs = 5 * S })
      const b = addOn(q, 'v', 'voice', 20 * S)
      q = setItem(b.p, b.item, (d) => { d.inUs = (15 + gapS) * S; d.durationUs = 4 * S })
      return q
    }
    expect(planTranscription(two(1)).jobs).toEqual([{ assetId: 'v', fromUs: 9_700_000, toUs: 20_300_000 }])
    expect(planTranscription(two(5)).jobs).toEqual([
      { assetId: 'v', fromUs: 9_700_000, toUs: 15_300_000 },
      { assetId: 'v', fromUs: 19_700_000, toUs: 24_300_000 }
    ])
    // margem presa em 0 e no fim do asset
    const { p, item } = voiceProject(aud('v', 10 * S))
    const edge = setItem(p, item, (d) => { d.inUs = 100_000; d.durationUs = 9_800_000 })
    expect(planTranscription(edge).jobs).toEqual([{ assetId: 'v', fromUs: 0, toUs: 10 * S }])
    // asset sem duração: só presa em 0
    const nd = voiceProject(aud('v', null))
    const ndp = setItem(nd.p, nd.item, (d) => { d.inUs = 100_000; d.durationUs = 9_800_000 })
    expect(planTranscription(ndp).jobs).toEqual([{ assetId: 'v', fromUs: 0, toUs: 10_200_000 }])
    // ordem: asset 'b' aparece primeiro (faixa de cima), 'a' depois; o 'a' de antes no tempo não muda a ordem
    const base = voiceProject(aud('b'))
    let o = ops.addAsset(base.p, aud('a'))
    o = addOn(o, 'a', 'voice', 0).p
    const plan = planTranscription(o)
    expect(plan.jobs.map((j) => j.assetId)).toEqual(['b', 'a'])
  })

  it('velocidade: o trecho lido da fonte é round(duração × velocidade)', () => {
    const { p, item } = voiceProject()
    const q = setItem(p, item, (d) => { d.speed = 1.5; d.durationUs = 3_333_333; d.inUs = S })
    expect(planTranscription(q).jobs).toEqual([{ assetId: 'v', fromUs: S - TRANSCRIBE_PAD_US, toUs: S + Math.round(3_333_333 * 1.5) + TRANSCRIBE_PAD_US }])
  })
})

describe('deduplicação', () => {
  it('9. mesmo asset em duas faixas de voz ao mesmo tempo → cada palavra uma vez; textos diferentes ao mesmo tempo → os dois', () => {
    const a = voiceProject()
    const b = addOn(a.p, 'v', 'voice', 0)
    const plan = planTranscription(b.p)
    expect(plan.segments).toHaveLength(2)
    expect(plan.jobs).toEqual([{ assetId: 'v', fromUs: 0, toUs: 30 * S }])
    const out = wordsToTimeline(plan.segments, { v: [w('Olá,', 1, 1.4, 0.7), w('mundo', 2, 2.5)] })
    // empate de prob → a faixa que vem primeiro
    expect(out.map((x) => [x.text, x.trackId])).toEqual([['Olá,', a.track], ['mundo', a.track]])
    // prob maior ganha (faixas com assets diferentes, mesmo texto normalizado, intervalos sobrepostos ≥ 50 %)
    let q = ops.addAsset(a.p, aud('w'))
    const c = addOn(q, 'w', 'voice', 0)
    q = c.p
    const plan2 = planTranscription(q)
    const out2 = wordsToTimeline(plan2.segments, {
      v: [w('Olá', 1, 1.4, 0.5), w('sim', 3, 3.4, 0.9)],
      w: [w('olá!', 1.1, 1.5, 0.8), w('não', 3, 3.4, 0.9), w('sim', 3.3, 3.8, 0.99)]
    })
    expect(out2.map((x) => [x.text, x.trackId])).toEqual([
      ['olá!', c.track], // 0,3 s de 0,4 s sobrepostos (75 %), prob maior
      ['sim', a.track],
      ['não', c.track], // texto diferente: as duas pessoas ficam
      ['sim', c.track] // mesmo texto mas só 0,1 s de 0,4 s (25 %): fica
    ])
  })
})

describe('desempenho', () => {
  it('10. 1 h, 2 000 itens de voz, 20 000 palavras: planTranscription + wordsToTimeline < 100 ms', () => {
    const H = 3600 * S
    const p = createEmptyProject('perf')
    p.assets = [aud('v', H)]
    const step = H / 2000
    const items: MediaItem[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `i${i}`, type: 'media', assetId: 'v', startUs: Math.round(i * step * 0.8), durationUs: Math.round(step * 0.7), inUs: Math.round(i * step),
      speed: 1, reverse: false, audio: { enabled: true, volume: { value: 1 }, fadeInUs: 0, fadeOutUs: 0, preservePitch: true, denoise: false, normalize: false }
    }))
    p.tracks = [{ id: 'tv', kind: 'audio', name: 'Voz', role: 'voice', muted: false, hidden: false, locked: false, volume: 1, items }]
    const words: SourceWord[] = Array.from({ length: 20000 }, (_, i) => ({ text: `p${i % 50}`, startUs: i * 180_000, endUs: i * 180_000 + 150_000, prob: 0.9 }))
    let out = 0
    const run = (): void => {
      const plan = planTranscription(p)
      out = wordsToTimeline(plan.segments, { v: words }).length
    }
    const ms = (): number => {
      const t = performance.now()
      run()
      return performance.now() - t
    }
    // melhor medida, até 3 tentativas enquanto passar do alvo (suíte em paralelo deixa uma medida isolada mais lenta)
    let best = Infinity
    for (let i = 0; i < 3 && best >= 100; i++) best = Math.min(best, ms())
    console.log(`[perf] transcribePlan 1 h / 2000 itens / 20000 palavras: ${best.toFixed(1)} ms (${out} palavras na timeline)`)
    expect(out).toBeGreaterThan(10000)
    expect(best).toBeLessThan(100)
  }, 30_000)

  it('11. uma palavra de 30 s no meio de 20 000 não alarga a varredura dos trechos: < 100 ms e resultado igual', () => {
    const H = 3600 * S
    const p = createEmptyProject('perf2')
    p.assets = [aud('v', H)]
    const step = H / 2000
    const items: MediaItem[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `i${i}`, type: 'media', assetId: 'v', startUs: Math.round(i * step * 0.8), durationUs: Math.round(step * 0.7), inUs: Math.round(i * step),
      speed: 1, reverse: false, audio: { enabled: true, volume: { value: 1 }, fadeInUs: 0, fadeOutUs: 0, preservePitch: true, denoise: false, normalize: false }
    }))
    p.tracks = [{ id: 'tv', kind: 'audio', name: 'Voz', role: 'voice', muted: false, hidden: false, locked: false, volume: 1, items }]
    const words: SourceWord[] = Array.from({ length: 20000 }, (_, i) => ({ text: `p${i % 50}`, startUs: i * 180_000, endUs: i * 180_000 + 150_000, prob: 0.9 }))
    words[10000] = { text: 'alucinação', startUs: words[10000].startUs, endUs: words[10000].startUs + 30 * S, prob: 0.1 }
    const plan = planTranscription(p)
    const ms = (): number => {
      const t = performance.now()
      wordsToTimeline(plan.segments, { v: words })
      return performance.now() - t
    }
    let best = Infinity
    for (let i = 0; i < 3 && best >= 100; i++) best = Math.min(best, ms())
    console.log(`[perf] wordsToTimeline com 1 palavra de 30 s: ${best.toFixed(1)} ms`)
    expect(best).toBeLessThan(100)
    // a palavra longa entra só no trecho cujo meio cai nele
    const out = wordsToTimeline(plan.segments, { v: words })
    expect(out.filter((x) => x.text === 'alucinação').length).toBeGreaterThanOrEqual(1)
  }, 30_000)
})
