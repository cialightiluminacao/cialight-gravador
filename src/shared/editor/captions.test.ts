import { describe, expect, it } from 'vitest'
import { createEmptyProject, TEXT_PRESETS } from './factory'
import { MIN_ITEM_US } from './project'
import type { Asset, Project, TextItem, Track } from './project'
import * as ops from './ops'
import { parseProject, toDiskProject } from './schema'
import { parseProjectV13 } from '../__fixtures__/projectSchemaV13'
import type { Cue } from './srt'

const S = 1_000_000
const vid = (id: string, dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
const withClip = (): Project => ops.addMediaFromAsset(ops.addAsset(createEmptyProject('t'), vid('a')), 'a', 0).project
const capTrack = (p: Project): Track => p.tracks.find(ops.isCaptionsTrack)!
const caps = (p: Project): TextItem[] => capTrack(p).items as TextItem[]
const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return `${(e as ops.EditError).code}: ${(e as Error).message}` }
  return 'ok'
}
const cue = (s: number, e: number, text: string): Cue => ({ startUs: s * S, endUs: e * S, text })

describe('importCaptions', () => {
  it('replace sem faixa: cria a faixa de legendas e uma legenda por cue (estilo do modelo)', () => {
    const p = withClip()
    const r = ops.importCaptions(p, [cue(1, 2, 'A'), cue(3, 4.5, 'B\nC')], { mode: 'replace' })
    expect(r.count).toBe(2)
    expect(r.warnings).toEqual([])
    const t = capTrack(r.project)
    expect(t.items.map((i) => [i.startUs, i.durationUs, (i as TextItem).text])).toEqual([[S, S, 'A'], [3 * S, 1.5 * S, 'B\nC']])
    expect(caps(r.project)[0].style).toEqual(TEXT_PRESETS.caption.style)
    expect(caps(r.project)[0].visual.transform.y.value).toBe(TEXT_PRESETS.caption.y)
    expect(r.project.tracks.filter((x) => x.kind === 'video').at(-1)!.role).toBe('captions')
  })

  it('replace limpa a faixa; usa o estilo e a posição comuns atuais', () => {
    let p = ops.addCaption(withClip(), 0, 'velha').project
    p = ops.setCaptionStyle(p, { color: '#ff0000', size: { value: 60 } })
    p = ops.setCaptionPosition(p, 0.1)
    const r = ops.importCaptions(p, [cue(5, 6, 'nova')], { mode: 'replace' })
    expect(caps(r.project).map((i) => i.text)).toEqual(['nova'])
    expect(caps(r.project)[0].style.color).toBe('#ff0000')
    expect(caps(r.project)[0].style.size).toEqual({ value: 60 })
    expect(caps(r.project)[0].visual.transform.y.value).toBe(0.1)
  })

  it('offsetUs desloca; cue que fica antes de 0 é cortada/descartada com aviso', () => {
    const r = ops.importCaptions(withClip(), [cue(0, 1, 'fora'), cue(1, 3, 'cortada'), cue(4, 5, 'ok')], { mode: 'replace', offsetUs: -2 * S })
    expect(caps(r.project).map((i) => [i.startUs, i.durationUs, i.text])).toEqual([[0, S, 'cortada'], [2 * S, S, 'ok']])
    expect(r.count).toBe(2)
    expect(r.warnings).toHaveLength(2)
  })

  it('append respeita as legendas existentes: colisão → encurtada ou descartada (aviso)', () => {
    let p = ops.addCaption(withClip(), 2 * S, 'X', { durationUs: 2 * S }).project // [2,4)
    p = ops.addCaption(p, 6 * S, 'Y', { durationUs: S }).project // [6,7)
    const r = ops.importCaptions(p, [cue(0, 1, 'livre'), cue(1, 3, 'fim cortado'), cue(3, 5, 'início empurrado'), cue(6.2, 6.8, 'dentro'), cue(8, 9, 'livre 2')], { mode: 'append' })
    expect(caps(r.project).map((i) => [i.startUs / S, (i.startUs + i.durationUs) / S, i.text])).toEqual([
      [0, 1, 'livre'], [1, 2, 'fim cortado'], [2, 4, 'X'], [4, 5, 'início empurrado'], [6, 7, 'Y'], [8, 9, 'livre 2']
    ])
    expect(r.count).toBe(4)
    expect(r.warnings).toHaveLength(3)
    expect(r.warnings.join('|')).toMatch(/descartada/)
  })

  it('cue curta demais (< MIN_ITEM_US) é descartada com aviso', () => {
    const r = ops.importCaptions(withClip(), [{ startUs: 0, endUs: MIN_ITEM_US - 1, text: 'curta' }, cue(1, 2, 'ok')], { mode: 'replace' })
    expect(r.count).toBe(1)
    expect(r.warnings).toHaveLength(1)
  })

  it('faixa bloqueada → EditError locked', () => {
    const p = ops.addCaption(withClip(), 0, 'A').project
    const locked = ops.updateTrack(p, capTrack(p).id, { locked: true })
    expect(code(() => ops.importCaptions(locked, [cue(5, 6, 'B')], { mode: 'append' }))).toMatch(/^locked: /)
  })

  it('1000 cues numa única edição, rápido', () => {
    const many = Array.from({ length: 1000 }, (_, i) => cue(i * 2, i * 2 + 1.5, `Legenda ${i}`))
    const t0 = performance.now()
    const r = ops.importCaptions(withClip(), many, { mode: 'replace' })
    const dt = performance.now() - t0
    expect(r.count).toBe(1000)
    expect(dt).toBeLessThan(500)
  })

  it('v1.3 lê o projeto com as legendas importadas; ida e volta pelo disco', () => {
    const r = ops.importCaptions(withClip(), [cue(1, 2, 'Olá'), cue(3, 4, 'Ação')], { mode: 'replace' })
    const disk = JSON.parse(JSON.stringify(toDiskProject(r.project)))
    expect(() => parseProjectV13(disk)).not.toThrow()
    expect(parseProject(disk)).toEqual(r.project)
  })
})

describe('captionCues', () => {
  it('legendas habilitadas da faixa, em ordem; sem faixa → []', () => {
    expect(ops.captionCues(withClip())).toEqual([])
    let p = ops.importCaptions(withClip(), [cue(3, 4, 'B'), cue(1, 2, 'A'), cue(5, 6, 'C')], { mode: 'replace' }).project
    const b = caps(p).find((i) => i.text === 'B')!
    p = ops.updateItem<TextItem>(p, b.id, (d) => { d.enabled = false })
    expect(ops.captionCues(p)).toEqual([cue(1, 2, 'A'), cue(5, 6, 'C')])
  })
})

describe('setCaptionTimes', () => {
  it('muda início e fim; sobrepor a vizinha, curta demais ou negativa → EditError', () => {
    const p = ops.importCaptions(withClip(), [cue(1, 2, 'A'), cue(3, 4, 'B')], { mode: 'replace' }).project
    const [a, b] = caps(p)
    const q = ops.setCaptionTimes(p, a.id, 0.5 * S, 2.5 * S)
    expect(caps(q)[0]).toMatchObject({ startUs: 0.5 * S, durationUs: 2 * S })
    expect(code(() => ops.setCaptionTimes(p, a.id, S, 3.5 * S))).toMatch(/^overlap: /)
    expect(code(() => ops.setCaptionTimes(p, b.id, 1.5 * S, 4 * S))).toMatch(/^overlap: /)
    expect(code(() => ops.setCaptionTimes(p, a.id, 2 * S, 2 * S))).toMatch(/^invalid: /)
    expect(code(() => ops.setCaptionTimes(p, a.id, -1, S))).toMatch(/^invalid: /)
    // nada mudou: o mesmo projeto
    expect(ops.setCaptionTimes(p, a.id, S, 2 * S)).toBe(p)
  })
  it('só itens da faixa de legendas', () => {
    const p = withClip()
    const clip = p.tracks[0].items[0].id
    expect(code(() => ops.setCaptionTimes(p, clip, 0, S))).toMatch(/^invalid: /)
  })
})

describe('setCaptionPosition', () => {
  it('posição vertical de TODAS as legendas (um passo); legenda nova herda', () => {
    let p = ops.importCaptions(withClip(), [cue(1, 2, 'A'), cue(3, 4, 'B')], { mode: 'replace' }).project
    const empty = withClip()
    expect(ops.setCaptionPosition(empty, 0.2)).toBe(empty)
    p = ops.setCaptionPosition(p, 0.15)
    expect(caps(p).map((i) => i.visual.transform.y)).toEqual([{ value: 0.15 }, { value: 0.15 }])
    const n = ops.addCaption(p, 6 * S, 'C')
    expect((ops.findItem(n.project, n.itemId)!.item as TextItem).visual.transform.y).toEqual({ value: 0.15 })
  })
})

describe('withCaptionsHidden (exportação sem queimar)', () => {
  it('nenhuma camada de legenda no quadro; o resto igual; sem legendas = o mesmo projeto', async () => {
    const { resolveFrame } = await import('./resolve')
    const base = withClip()
    expect(ops.withCaptionsHidden(base)).toBe(base)
    const p = ops.importCaptions(base, [cue(1, 2, 'A')], { mode: 'replace' }).project
    const at = 1.5 * S
    const all = resolveFrame(p, at)
    const hidden = resolveFrame(ops.withCaptionsHidden(p), at)
    expect(all.some((l) => l.kind === 'text')).toBe(true)
    expect(hidden.some((l) => l.kind === 'text')).toBe(false)
    expect(hidden).toEqual(all.filter((l) => l.kind !== 'text'))
    expect(capTrack(p).hidden).toBe(false)
  })
})
