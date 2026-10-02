import { describe, expect, it, vi } from 'vitest'
import type { SpeechFile } from '@shared/editor/speech'
import { SpeechLoader } from './speechLoader'

const S = 1_000_000
const file: SpeechFile = { version: 1, thresholdDb: -35, minSilenceUs: 350_000, silences: [{ fromUs: 0, toUs: 2 * S }, { fromUs: 4 * S, toUs: null }], durationUs: 6 * S }

describe('SpeechLoader (fala do ducking no audio worker)', () => {
  it('carrega por URL com cache; arquivo que falha fica de fora e é avisado uma vez por URL', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes('ruim')) throw new Error('404')
      return file
    })
    const failed: string[] = []
    const l = new SpeechLoader(fetchJson, (id) => failed.push(id))
    const a = await l.load({ v: 'u/boa', w: 'u/ruim' })
    expect(Object.keys(a)).toEqual(['v'])
    expect(a.v[0].fromUs).toBeLessThan(2 * S)
    expect(failed).toEqual(['w'])
    await l.load({ v: 'u/boa', w: 'u/ruim' })
    expect(failed).toEqual(['w']) // não repete o aviso
    expect(fetchJson.mock.calls.filter(([u]) => u === 'u/boa')).toHaveLength(1) // cache
    expect(fetchJson.mock.calls.filter(([u]) => u === 'u/ruim')).toHaveLength(2) // falha não fica em cache
    await l.load({ w: 'u/ruim?f=novo' }) // outra URL (reanálise): avisa de novo
    expect(failed).toEqual(['w', 'w'])
  })

  it('JSON inválido conta como falha (sem dados)', async () => {
    const failed: string[] = []
    const l = new SpeechLoader(async () => ({ lixo: true }), (id) => failed.push(id))
    expect(await l.load({ v: 'u' })).toEqual({})
    expect(failed).toEqual(['v'])
  })

  it('plan: erro ao montar o plano não rejeita (nada fica esperando) e é avisado', async () => {
    const l = new SpeechLoader(async () => file, () => {})
    const errors: string[] = []
    await expect(l.plan({ v: 'u' }, () => { throw new Error('quebrou') }, (m) => errors.push(m))).resolves.toBeUndefined()
    expect(errors).toEqual(['quebrou'])
    let got: unknown = null
    await l.plan({ v: 'u' }, (sp) => { got = sp }, (m) => errors.push(m))
    expect(Object.keys(got as object)).toEqual(['v'])
  })
})
