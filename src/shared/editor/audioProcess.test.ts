import { describe, expect, it } from 'vitest'
import type { Asset } from './project'
import { audioProcessKey, audioSourceKey, isAudioProcessKey, mergeProcessedAudio, parseAudioProcessKey, processedAudioRel, splitAudioSourceKey } from './audioProcess'

describe('chave de cache do pré-processamento de áudio', () => {
  it('nenhum processamento → null', () => {
    expect(audioProcessKey({ denoise: false, normalize: false })).toBeNull()
  })
  it('a chave codifica os parâmetros (modelo e alvo de loudness) e a ordem é fixa', () => {
    expect(audioProcessKey({ denoise: true, normalize: false })).toBe('dn-sh')
    expect(audioProcessKey({ denoise: false, normalize: true })).toBe('ln-i16-tp1.5')
    expect(audioProcessKey({ denoise: true, normalize: true })).toBe('dn-sh_ln-i16-tp1.5')
  })
  it('parse devolve as flags só para chaves dos parâmetros atuais', () => {
    expect(parseAudioProcessKey('dn-sh_ln-i16-tp1.5')).toEqual({ denoise: true, normalize: true })
    expect(parseAudioProcessKey('ln-i16-tp1.5')).toEqual({ denoise: false, normalize: true })
    expect(parseAudioProcessKey('dn-xx')).toBeNull() // outro modelo (parâmetros antigos) → reprocessa
    expect(parseAudioProcessKey('../x')).toBeNull()
    expect(isAudioProcessKey('dn-sh')).toBe(true)
    expect(isAudioProcessKey('')).toBe(false)
  })
  it('arquivo em generated/ por (asset, chave)', () => {
    expect(processedAudioRel('a_1', 'dn-sh')).toBe('generated/a_1.audio-dn-sh.m4a')
    expect(processedAudioRel('a_1', 'dn-sh_ln-i16-tp1.5')).toBe('generated/a_1.audio-dn-sh_ln-i16-tp1.5.m4a')
  })
  it('chave da fonte do mixer: original = assetId; processado = assetId~chave (ida e volta)', () => {
    expect(audioSourceKey('a1', null)).toBe('a1')
    expect(audioSourceKey('a1', 'dn-sh')).toBe('a1~dn-sh')
    expect(splitAudioSourceKey('a1~dn-sh')).toEqual({ assetId: 'a1', processKey: 'dn-sh' })
    expect(splitAudioSourceKey('a1')).toEqual({ assetId: 'a1', processKey: null })
  })
  it('mergeProcessedAudio une as chaves (nunca perde uma já pronta) e é estável', () => {
    const a = { processedAudio: ['dn-sh'] } as Pick<Asset, 'processedAudio'>
    expect(mergeProcessedAudio(a.processedAudio, ['ln-i16-tp1.5'])).toEqual(['dn-sh', 'ln-i16-tp1.5'])
    expect(mergeProcessedAudio(a.processedAudio, ['dn-sh'])).toBe(a.processedAudio)
    expect(mergeProcessedAudio(undefined, ['dn-sh'])).toEqual(['dn-sh'])
  })
})
