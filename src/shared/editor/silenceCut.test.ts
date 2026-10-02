import { describe, expect, it } from 'vitest'
import { createEmptyProject, createMediaItem } from './factory'
import type { AnnotationsItem, Asset, Item, MediaItem, Project, Track } from './project'
import { MIN_ITEM_US } from './project'
import type { SpeechInterval } from './speech'
import * as ops from './ops'
import { sourceTimeUs } from './resolve'
import { validateProject } from './schema'
import { itemEndUs as end } from './time'
import { applySilenceCuts, planSilenceCuts, type SilenceCut } from './silenceCut'

// Remover silêncios: cortes a partir da fala das faixas de voz (já na timeline) aplicados em todas as faixas.

const S = 1_000_000
const vid = (id: string, durS = 20): Asset => ({
  id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: durS * S,
  video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, status: 'ready'
})
const mic = (id = 'mic', durS = 20): Asset => ({
  id, name: id, kind: 'audio', source: { type: 'file', path: `C:/${id}.m4a`, size: 1, mtimeMs: 1 }, durationUs: durS * S,
  audio: { channels: 1, sampleRate: 48000, codec: 'mp4a' }, status: 'ready', speech: `cache/${id}.speech.json`
})
const sp = (...iv: [number, number][]): SpeechInterval[] => iv.map(([a, b]) => ({ fromUs: Math.round(a * S), toUs: Math.round(b * S) }))
const cutsS = (c: SilenceCut[]): [number, number][] => c.map((x) => [x.fromUs / S, x.toUs / S])
/** Fala do microfone (tempo da fonte): silêncios em 3–5 s e 8–12 s. */
const SPEECH = { mic: sp([0, 3], [5, 8], [12, 20]) }
const OPTS = { sourceTrackIds: ['t_mic'], minSilenceUs: 500_000, paddingUs: 150_000 }

/** Como uma gravação: Tela (vinculada ao microfone), Webcam, Anotações e Microfone (voz), tudo [0, 20 s). */
function recording(micOver: Partial<MediaItem> = {}): Project {
  const assets = [vid('scr'), vid('cam'), mic()]
  const media = (id: string, a: Asset, kind: 'video' | 'audio', over: Partial<MediaItem> = {}): MediaItem => ({ ...createMediaItem(a, 0, kind), id, ...over })
  const ann: AnnotationsItem = { id: 'i_ann', type: 'annotations', name: 'Anotações', sessionId: 's1', inUs: 0, startUs: 0, durationUs: 20 * S }
  const track = (id: string, kind: 'video' | 'audio', name: string, items: Item[], role?: Track['role']): Track => ({ id, kind, name, muted: false, hidden: false, locked: false, volume: 1, ...(role ? { role } : {}), items })
  const tracks: Track[] = [
    track('t_scr', 'video', 'Tela', [media('i_scr', assets[0], 'video', { linkId: 'L' })]),
    track('t_cam', 'video', 'Webcam', [media('i_cam', assets[1], 'video')]),
    track('t_ann', 'video', 'Anotações', [ann]),
    track('t_mic', 'audio', 'Microfone', [media('i_mic', assets[2], 'audio', { linkId: 'L', ...micOver })], 'voice')
  ]
  return { ...createEmptyProject('t'), assets, tracks }
}

const itemAt = (t: Track, us: number): Item | undefined => t.items.find((i) => us >= i.startUs && us < end(i))
const trackNamed = (p: Project, name: string): Track => p.tracks.find((t) => t.name === name)!
/** Tempo (original) → tempo depois dos cortes; null se o instante foi cortado. */
function mapTime(cuts: SilenceCut[], t: number): number | null {
  let shift = 0
  for (const c of cuts) {
    if (t >= c.fromUs && t < c.toUs) return null
    if (t >= c.toUs) shift += c.toUs - c.fromUs
  }
  return t - shift
}
/**
 * Sincronia depois dos cortes, a cada 10 ms do original que sobrou: cada faixa de mídia mostra o mesmo instante da
 * fonte (tela, webcam, microfone, anotações), e os efeitos cobrem exatamente o mesmo conteúdo (privacidade).
 */
function expectInSync(before: Project, after: Project, cuts: SilenceCut[]): void {
  const total = ops.projectDurationUs(before)
  const bad: string[] = []
  for (let t = 0; t < total; t += 10_000) {
    const t2 = mapTime(cuts, t)
    if (t2 === null) continue
    for (const tb of before.tracks) {
      const ta = after.tracks.find((x) => x.id === tb.id)!
      const a = itemAt(tb, t), b = itemAt(ta, t2)
      if (!a && !b) continue
      if (!a || !b || a.type !== b.type) { bad.push(`${tb.name} @${t}: ${a?.type} → ${b?.type}`); continue }
      if (a.type === 'media' && b.type === 'media') {
        const asset = before.assets.find((x) => x.id === a.assetId)!
        if (sourceTimeUs(a, asset, t) !== sourceTimeUs(b, asset, t2)) bad.push(`${tb.name} @${t}: fonte ${sourceTimeUs(a, asset, t)} → ${sourceTimeUs(b, asset, t2)}`)
      }
      if (a.type === 'annotations' && b.type === 'annotations' && a.inUs + (t - a.startUs) !== b.inUs + (t2 - b.startUs)) bad.push(`${tb.name} @${t}: anotações fora`)
    }
    if (bad.length > 5) break
  }
  expect(bad).toEqual([])
}

describe('planSilenceCuts', () => {
  it('silêncios da voz viram cortes com margem; silêncio curto fica; total economizado', () => {
    const p = recording()
    const r = planSilenceCuts(p, OPTS, SPEECH)
    expect(cutsS(r.cuts)).toEqual([[3.15, 4.85], [8.15, 11.85]])
    expect(r.savedUs).toBe(5_400_000)
    expect(r.lockedTrackIds).toEqual([])
    expect(r.blocked).toBeNull()
    // silêncio de 2 s não chega a 2,5 s: só o de 4 s sai
    expect(cutsS(planSilenceCuts(p, { ...OPTS, minSilenceUs: 2_500_000 }, SPEECH).cuts)).toEqual([[8.15, 11.85]])
    // margem maior encolhe os cortes
    expect(cutsS(planSilenceCuts(p, { ...OPTS, paddingUs: 400_000 }, SPEECH).cuts)).toEqual([[3.4, 4.6], [8.4, 11.6]])
  })

  it('intervalo (I–O): só corta dentro dele', () => {
    const r = planSilenceCuts(recording(), { ...OPTS, range: { fromUs: 4 * S, toUs: 10 * S } }, SPEECH)
    expect(cutsS(r.cuts)).toEqual([[4, 4.85], [8.15, 10]])
  })

  it('mapa de tempo do item: velocidade 2× com trim (inUs) e reverso', () => {
    // lê a fonte de 2 s a 18 s em 8 s de timeline: fala em 0–0,5, 1,5–3 e 5–8 s
    const fast = recording({ inUs: 2 * S, speed: 2, durationUs: 8 * S })
    expect(cutsS(planSilenceCuts(fast, OPTS, SPEECH).cuts)).toEqual([[0.65, 1.35], [3.15, 4.85]])
    // reverso: a fonte de trás para frente — fala em 0–8, 12–15 e 17–20 s
    const rev = recording({ reverse: true })
    expect(cutsS(planSilenceCuts(rev, OPTS, SPEECH).cuts)).toEqual([[8.15, 11.85], [15.15, 16.85]])
  })

  it('sem dados de fala (ou fora dos itens de voz) não corta: só onde a voz foi analisada', () => {
    const p = recording({ durationUs: 10 * S }) // voz só até 10 s: o resto (sem voz) não é "silêncio"
    expect(cutsS(planSilenceCuts(p, OPTS, SPEECH).cuts)).toEqual([[3.15, 4.85], [8.15, 9.85]])
    const none = planSilenceCuts(p, OPTS, {})
    expect(none.cuts).toEqual([])
    expect(none.missingAssetIds).toEqual(['mic'])
  })

  it('faixa bloqueada: avisada; com efeitos de privacidade (ou a voz bloqueada) o corte é recusado', () => {
    const p = ops.updateTrack(recording(), 't_cam', { locked: true })
    const r = planSilenceCuts(p, OPTS, SPEECH)
    expect(r.lockedTrackIds).toEqual(['t_cam'])
    expect(r.blocked).toBeNull()
    const fx = ops.addEffect(p, 'blur', 2 * S, { durationUs: 8 * S }).project
    expect(planSilenceCuts(fx, OPTS, SPEECH).blocked).toMatch(/efeitos/)
    expect(planSilenceCuts(ops.updateTrack(recording(), 't_mic', { locked: true }), OPTS, SPEECH).blocked).toMatch(/voz/)
  })

  it('efeito que acabaria com uma lasca < 1 quadro: o corte encolhe para o efeito continuar cobrindo o conteúdo', () => {
    // efeito termina 10 ms depois do fim do 1º corte (4,85 s): sobraria [4,85; 4,86) — menor que um quadro, sumiria
    const p = ops.addEffect(recording(), 'blur', 2 * S, { durationUs: 2_860_000 }).project
    const r = planSilenceCuts(p, OPTS, SPEECH)
    expect(r.cuts[0]).toEqual({ fromUs: 3_150_000, toUs: 4_860_000 - MIN_ITEM_US })
    expectInSync(p, applySilenceCuts(p, r.cuts), r.cuts)
  })
})

describe('applySilenceCuts', () => {
  it('corta tela, webcam, anotações e microfone em sincronia; efeito vinculado segue cobrindo o conteúdo', () => {
    let p = recording()
    const fx = ops.addEffect(p, 'blur', 2 * S, { durationUs: 8 * S })
    p = ops.toggleKeyframe(fx.project, fx.itemId, 'region.x', 2 * S)
    p = ops.toggleKeyframe(p, fx.itemId, 'region.x', 10 * S)
    p = ops.setAnimValue(p, fx.itemId, 'region.x', 10 * S, 0.9)
    const fxTrack = ops.findItem(p, fx.itemId)!.track.id
    expect(ops.findItem(p, fx.itemId)!.item.linkId).toBeDefined()
    const { cuts } = planSilenceCuts(p, OPTS, SPEECH)
    const q = applySilenceCuts(p, cuts)
    expect(validateProject(q)).toEqual([])
    expect(ops.projectDurationUs(q)).toBe(20 * S - 5_400_000)
    expectInSync(p, q, cuts)
    // o efeito [2, 10) virou [2, 3,15) + [3,15; 6,3) — ainda dois pedaços sobre o mesmo conteúdo, ainda vinculados
    const pieces = q.tracks.find((t) => t.id === fxTrack)!.items
    expect(pieces.map((i) => [i.startUs, end(i)])).toEqual([[2 * S, 3_150_000], [3_150_000, 6_450_000]])
    for (const piece of pieces) expect(piece.linkId).toBeDefined()
  })

  it('nada é cortado em faixa bloqueada', () => {
    const p = ops.updateTrack(recording(), 't_cam', { locked: true })
    const { cuts } = planSilenceCuts(p, OPTS, SPEECH)
    const q = applySilenceCuts(p, cuts)
    expect(trackNamed(q, 'Webcam')).toEqual(trackNamed(p, 'Webcam'))
    expect(ops.findItem(q, 'i_mic')!.item.durationUs).toBe(3_150_000)
  })

  it('sem cortes devolve o mesmo projeto', () => {
    const p = recording()
    expect(applySilenceCuts(p, [])).toBe(p)
  })
})
