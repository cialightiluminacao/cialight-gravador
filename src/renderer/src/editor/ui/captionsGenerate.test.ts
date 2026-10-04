import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import * as ops from '@shared/editor/ops'
import type { Asset, Project, TextItem } from '@shared/editor/project'
import type { SourceWord } from '@shared/editor/transcribePlan'
import { planTranscription } from '@shared/editor/transcribePlan'
import { buildGenerated, formatDuration, formatMb, generatedToast, modelChoiceLabel, modelStatusText, progressView, sourceSummary } from './captionsGenerate'

const S = 1_000_000
const aud = (id: string, durationUs = 30 * S): Asset => ({
  id, name: id, kind: 'audio', source: { type: 'file', path: `C:/${id}.wav`, size: 1, mtimeMs: 1 }, durationUs,
  audio: { channels: 1, sampleRate: 48000, codec: 'pcm' }, status: 'ready'
})
const w = (text: string, s: number, e: number): SourceWord => ({ text, startUs: Math.round(s * S), endUs: Math.round(e * S) })

/** Asset de áudio de 30 s numa faixa de voz em 0; devolve o projeto e o id do item. */
function voiceProject(): { p: Project; item: string; track: string } {
  const p0 = ops.addAsset(createEmptyProject('t'), aud('v'))
  const track = p0.tracks[1].id
  const r = ops.addMediaFromAsset(p0, 'v', 0, { audioTrackId: track })
  return { p: ops.updateTrack(r.project, track, { role: 'voice' }), item: r.itemIds[0], track }
}
const caps = (p: Project): TextItem[] => (p.tracks.find(ops.isCaptionsTrack)?.items ?? []) as TextItem[]

describe('rótulos', () => {
  it('tamanhos em MB decimais (pt-BR)', () => {
    expect(formatMb(147951465)).toBe('148 MB')
    expect(formatMb(487601967)).toBe('488 MB')
    expect(formatMb(1_500_000_000)).toBe('1.500 MB')
  })
  it('modelos: nome, tamanho e velocidade; estado baixado/precisa baixar', () => {
    expect(modelChoiceLabel({ id: 'base', label: 'Base', sizeBytes: 147951465, present: true })).toBe('Base (148 MB, mais rápido)')
    expect(modelChoiceLabel({ id: 'small', label: 'Preciso', sizeBytes: 487601967, present: false })).toBe('Preciso (488 MB, mais lento)')
    expect(modelStatusText({ id: 'base', label: 'Base', sizeBytes: 147951465, present: true })).toBe('baixado')
    expect(modelStatusText({ id: 'small', label: 'Preciso', sizeBytes: 487601967, present: false })).toBe('precisa baixar (488 MB)')
  })
  it('duração legível', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(40.4 * S)).toBe('40 s')
    expect(formatDuration(80 * S)).toBe('1 min 20 s')
    expect(formatDuration(120 * S)).toBe('2 min')
    expect(formatDuration(3900 * S)).toBe('1 h 05 min')
  })
  it('fonte: faixas de voz / áudio dos clipes, com a duração total', () => {
    const { p } = voiceProject()
    expect(sourceSummary(planTranscription(p))).toBe('Faixas de voz · 30 s de áudio')
    const p2 = ops.updateTrack(p, p.tracks[1].id, { role: undefined })
    expect(sourceSummary(planTranscription(p2))).toBe('Áudio dos clipes (não há faixa de voz) · 30 s de áudio')
  })
  it('progresso por etapa', () => {
    expect(progressView({ kind: 'download', receivedBytes: 37_000_000, totalBytes: 147951465 })).toEqual({ label: 'Baixando modelo (37 de 148 MB)', percent: 25 })
    expect(progressView({ kind: 'extract', fraction: 0.1 })).toEqual({ label: 'Extraindo áudio', percent: 10 })
    expect(progressView({ kind: 'transcribe', fraction: 0.456 })).toEqual({ label: 'Transcrevendo (46%)', percent: 46 })
    expect(progressView({ kind: 'build' })).toEqual({ label: 'Montando legendas', percent: 100 })
    expect(progressView({ kind: 'download', receivedBytes: 0, totalBytes: 0 }).percent).toBe(0)
  })
  it('toast: contagem, singular e puladas', () => {
    expect(generatedToast(1, 0, 'replace')).toBe('1 legenda gerada')
    expect(generatedToast(12, 0, 'replace')).toBe('12 legendas geradas')
    expect(generatedToast(12, 3, 'fill')).toBe('12 legendas geradas · 3 puladas (já havia legenda)')
    expect(generatedToast(5, 1, 'fill')).toBe('5 legendas geradas · 1 pulada (já havia legenda)')
  })
})

describe('buildGenerated', () => {
  const words = { v: [w('Bom', 1, 1.3), w('dia', 1.3, 1.7), w('a', 1.7, 1.8), w('todos.', 1.8, 2.4), w('Segunda', 5, 5.5), w('frase.', 5.5, 6.2)] }

  it('palavras da fonte → legendas na faixa de legendas (substituir)', () => {
    const { p } = voiceProject()
    const r = buildGenerated(p, words, 'replace')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.count).toBe(2)
    expect(caps(r.project).map((c) => [c.startUs, c.text])).toEqual([[S, 'Bom dia a todos.'], [5 * S, 'Segunda frase.']])
  })

  it('projeto mudou durante a transcrição (velocidade 2×): usa os segmentos do projeto ATUAL', () => {
    const { p, item } = voiceProject()
    const changed = ops.setSpeed(p, item, 2)
    const r = buildGenerated(changed, words, 'replace')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(caps(r.project).map((c) => c.startUs)).toEqual([0.5 * S, 2.5 * S])
  })

  it('nenhuma palavra (ou o asset saiu do projeto) → sem fala', () => {
    const { p, item } = voiceProject()
    expect(buildGenerated(p, {}, 'replace').kind).toBe('noSpeech')
    expect(buildGenerated(p, { v: [] }, 'replace').kind).toBe('noSpeech')
    const removed = ops.deleteItems(p, [item])
    expect(buildGenerated(removed, words, 'replace').kind).toBe('noSpeech')
  })

  it('legendas nunca passam do fim do conteúdo (sem contar legendas)', () => {
    const { p, item } = voiceProject()
    // clipe aparado em 2,1 s: a 1ª frase termina em 2,4 s na fonte
    const trimmed = ops.trimItem(p, item, 'end', 2.1 * S)
    const r = buildGenerated(trimmed, words, 'replace')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    const end = Math.max(...caps(r.project).map((c) => c.startUs + c.durationUs))
    expect(end).toBeLessThanOrEqual(2.1 * S)
    expect(ops.nonCaptionContentEndUs(r.project)).toBe(2.1 * S)
  })

  it('só onde não há legenda: mantém a manual e conta as puladas', () => {
    const { p } = voiceProject()
    const withManual = ops.addCaption(p, 5.2 * S, 'manual').project
    const r = buildGenerated(withManual, words, 'fill')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.skipped).toBe(1)
    expect(caps(r.project).map((c) => c.text)).toEqual(['Bom dia a todos.', 'manual'])
  })
})
