import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@shared/editor/factory'
import type { Asset, Project } from '@shared/editor/project'
import { mediaUrlsFor } from './mediaUrls'

const asset = (id: string, o: Partial<Asset> = {}): Asset => ({
  id, name: id, kind: 'video', source: { type: 'file', path: `C:\m\${id}.mp4`, size: 1, mtimeMs: 0 }, durationUs: 1_000_000, status: 'ready', ...o
})

function project(assets: Asset[]): Project {
  return { ...createEmptyProject('t'), id: 'p-1', assets }
}

describe('mediaUrlsFor', () => {
  const p = project([
    asset('a_plain'),
    asset('a_proxy', { proxy: 'proxies/a_proxy.mp4' }),
    asset('a_inter', { intermediate: 'proxies/a_inter.intermediate.mp4' }),
    asset('a_both', { proxy: 'proxies/a_both.mp4', intermediate: 'proxies/a_both.intermediate.mp4' }),
    asset('a_img', { kind: 'image', durationUs: null }),
    asset('a_missing', { status: 'missing', proxy: 'proxies/a_missing.mp4' })
  ])
  const base = (id: string): string => `cialight-file://media/p-1/${id}`

  it('preview: proxy quando existe; senão intermediário; senão original', () => {
    const u = mediaUrlsFor(p, 'preview')
    expect(u.a_plain).toEqual({ original: `${base('a_plain')}?v=original` })
    expect(u.a_proxy).toEqual({ original: `${base('a_proxy')}?v=original`, proxy: `${base('a_proxy')}?v=proxy` })
    expect(u.a_inter).toEqual({ original: `${base('a_inter')}?v=intermediate` })
    expect(u.a_both).toEqual({ original: `${base('a_both')}?v=intermediate`, proxy: `${base('a_both')}?v=proxy` })
    expect(u.a_img).toEqual({ original: `${base('a_img')}?v=original` })
  })

  it('export: nunca proxy; intermediário antes do original', () => {
    const u = mediaUrlsFor(p, 'export')
    expect(u.a_proxy).toEqual({ original: `${base('a_proxy')}?v=original` })
    expect(u.a_both).toEqual({ original: `${base('a_both')}?v=intermediate` })
  })

  it('asset ausente fica sem URL (vira placeholder)', () => {
    expect(mediaUrlsFor(p, 'preview').a_missing).toBeUndefined()
  })

  it('codifica ids na URL', () => {
    const q = { ...project([asset('a b')]), id: 'p x' }
    expect(mediaUrlsFor(q, 'export')['a b'].original).toBe('cialight-file://media/p%20x/a%20b?v=original')
  })

  it('áudio pré-processado pronto: URL por chave (preview e exportação); chaves inválidas ficam de fora', () => {
    const q = project([asset('a_dn', { processedAudio: ['dn-sh', 'dn-old'] })])
    for (const mode of ['preview', 'export'] as const) {
      expect(mediaUrlsFor(q, mode).a_dn).toEqual({ original: `${base('a_dn')}?v=original`, audio: { 'dn-sh': `${base('a_dn')}?v=audio&k=dn-sh` } })
    }
  })
})
