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

  it('append: duas cues dentro de UMA legenda existente são descartadas com aviso (nunca falha a importação)', () => {
    const p = ops.addCaption(withClip(), 0, 'Longa', { durationUs: 5 * S }).project
    const r = ops.importCaptions(p, [cue(1, 2, 'a'), cue(3, 4, 'b')], { mode: 'append' })
    expect(caps(r.project).map((i) => i.text)).toEqual(['Longa'])
    expect(r.count).toBe(0)
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings.every((w) => /descartada/.test(w))).toBe(true)
    // e as seguintes, depois dela, ainda entram
    const r2 = ops.importCaptions(p, [cue(1, 2, 'a'), cue(3, 4, 'b'), cue(4.5, 7, 'c')], { mode: 'append' })
    expect(caps(r2.project).map((i) => [i.startUs / S, (i.startUs + i.durationUs) / S, i.text])).toEqual([[0, 5, 'Longa'], [5, 7, 'c']])
  })

  it('append: cue que atravessa duas existentes fica com o vão entre elas', () => {
    let p = ops.addCaption(withClip(), 0, 'A', { durationUs: 2 * S }).project // [0,2)
    p = ops.addCaption(p, 3 * S, 'B', { durationUs: 2 * S }).project // [3,5)
    const r = ops.importCaptions(p, [cue(1, 6, 'x')], { mode: 'append' })
    expect(caps(r.project).map((i) => [i.startUs / S, (i.startUs + i.durationUs) / S, i.text])).toEqual([[0, 2, 'A'], [2, 3, 'x'], [3, 5, 'B']])
    expect(r.warnings).toHaveLength(1)
  })

  it('aviso certo: fim ≤ início × antes do início do vídeo', () => {
    const r = ops.importCaptions(withClip(), [cue(3, 2, 'invertida'), cue(1, 2, 'antes')], { mode: 'replace', offsetUs: -2 * S })
    expect(r.count).toBe(0)
    expect(r.warnings.find((w) => w.startsWith('Legenda 1'))).toMatch(/fim não é depois do início/)
    expect(r.warnings.find((w) => w.startsWith('Legenda 2'))).toMatch(/antes do início do vídeo/)
  })

  it('propriedade: legendas existentes e cues aleatórias → nunca lança, sem sobreposição, existentes intactas', () => {
    let seed = 12345
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let round = 0; round < 300; round++) {
      let p = withClip()
      // existentes: encostadas ou com vãos, algumas desativadas
      let t = Math.round(rnd() * 2 * S)
      const nExisting = Math.floor(rnd() * 6)
      for (let k = 0; k < nExisting; k++) {
        const d = MIN_ITEM_US + Math.round(rnd() * 3 * S)
        const r = ops.addCaption(p, t, `e${k}`, { durationUs: d })
        p = r.project
        if (rnd() < 0.2) p = ops.updateItem<TextItem>(p, r.itemId, (x) => { x.enabled = false })
        t += d + (rnd() < 0.4 ? 0 : Math.round(rnd() * 2 * S))
      }
      const before = p.tracks.find(ops.isCaptionsTrack)?.items.map((i) => [i.id, i.startUs, i.durationUs]) ?? []
      const n = 1 + Math.floor(rnd() * 12)
      const cs: Cue[] = Array.from({ length: n }, () => {
        const s0 = Math.round((rnd() * 16 - 1) * S)
        return { startUs: s0, endUs: s0 + Math.round((rnd() * 3 - 0.2) * S), text: 'x' }
      })
      const offsetUs = rnd() < 0.3 ? Math.round((rnd() - 0.5) * 2 * S) : undefined
      let r: ReturnType<typeof ops.importCaptions>
      expect(() => { r = ops.importCaptions(p, cs, { mode: 'append', offsetUs }) }, `rodada ${round}`).not.toThrow()
      const items = [...caps(r!.project)].sort((a, b) => a.startUs - b.startUs)
      for (let k = 1; k < items.length; k++) expect(items[k].startUs, `rodada ${round}`).toBeGreaterThanOrEqual(items[k - 1].startUs + items[k - 1].durationUs)
      for (const it of items) expect(it.durationUs).toBeGreaterThanOrEqual(MIN_ITEM_US)
      for (const [id, s, d] of before) expect(items.find((i) => i.id === id)).toMatchObject({ startUs: s, durationUs: d })
      expect(r!.count + r!.warnings.filter((w) => /descartada/.test(w)).length).toBe(n)
    }
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
    expect(parseProjectV13(disk).success).toBe(true)
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

describe('texto da biblioteca solto na faixa de legendas vira legenda', () => {
  it('“Título” na faixa Legendas: estilo/altura comuns das legendas, texto e duração do modelo; o .srt mostra uma legenda', () => {
    let p = ops.addCaption(withClip(), 0, 'Primeira').project
    p = ops.setCaptionStyle(p, { color: '#ffee00' })
    p = ops.setCaptionPosition(p, 0.8)
    const r = ops.addText(p, 'title', 5 * S, { trackId: capTrack(p).id })
    const it = ops.findItem(r.project, r.itemId)!.item as TextItem
    expect(ops.isCaptionsTrack(ops.findItem(r.project, r.itemId)!.track)).toBe(true)
    expect(it.style).toEqual(caps(p)[0].style) // não o estilo de título (fonte grande, centro da tela)
    expect(it.style).not.toEqual(TEXT_PRESETS.title.style)
    expect(it.visual.transform.y).toEqual(caps(p)[0].visual.transform.y)
    expect([it.text, it.durationUs]).toEqual([TEXT_PRESETS.title.text, TEXT_PRESETS.title.durationUs])
    expect(ops.captionCues(r.project).map((c) => c.text)).toEqual(['Primeira', 'Título'])
  })
  it('“Contagem” na faixa Legendas perde a contagem (a legenda é texto fixo); fora dela continua título/contagem', () => {
    const p = ops.addCaption(withClip(), 0, 'A').project
    const r = ops.addText(p, 'countdown', 5 * S, { trackId: capTrack(p).id })
    const it = ops.findItem(r.project, r.itemId)!.item as TextItem
    expect(it.counter).toBeUndefined()
    expect(it.visual.animIn).toBeUndefined()
    const free = ops.addText(p, 'countdown', 5 * S)
    const f = ops.findItem(free.project, free.itemId)!.item as TextItem
    expect(f.counter).toEqual({ from: 3, to: 0 })
    expect(ops.isCaptionsTrack(ops.findItem(free.project, free.itemId)!.track)).toBe(false)
  })
})
