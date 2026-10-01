import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectStore } from './projectStore'
import { SessionStore } from '../session/sessionStore'
import { createEmptyProject } from '@shared/editor/factory'
import type { Asset, Project } from '@shared/editor/project'

function mk(id: string, updatedAt: string): Project {
  return { ...createEmptyProject(`Projeto ${id}`), id, updatedAt }
}

describe('ProjectStore', () => {
  let root: string
  let trashed: string[]
  let clock: number
  let store: ProjectStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cialight-proj-'))
    trashed = []
    clock = 1_000_000
    store = new ProjectStore({ projectsRoot: () => root, trash: async (p) => void trashed.push(p), now: () => clock })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('create + load: round-trip e subpastas', () => {
    const p = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p)
    for (const d of ['proxies', 'cache', 'generated', 'versions']) expect(existsSync(join(root, 'p-a', d))).toBe(true)
    expect(store.load('p-a')).toEqual(p)
  })

  it('save é atômico: nenhum .tmp sobra', () => {
    const p = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p)
    store.save({ ...p, name: 'Novo' })
    expect(readdirSync(join(root, 'p-a')).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(join(root, 'p-a', 'versions')).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(store.load('p-a').name).toBe('Novo')
  })

  it('versions: só grava nova versão após 60 s e mantém 20', () => {
    const p = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p)
    store.save(p)
    expect(readdirSync(join(root, 'p-a', 'versions'))).toEqual(['001.json'])
    for (let i = 0; i < 25; i++) {
      clock += 1e13 // bem depois do mtime real
      store.save(p)
    }
    const v = readdirSync(join(root, 'p-a', 'versions')).sort()
    expect(v).toHaveLength(20)
    expect(v[v.length - 1]).toBe('026.json')
  })

  it('load com project.json corrompido recupera a versão mais nova válida', () => {
    const p = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p)
    writeFileSync(join(root, 'p-a', 'project.json'), '{ corrompido', 'utf8')
    expect(store.load('p-a')).toEqual(p)
  })

  it('load lança quando não há nada recuperável', () => {
    store.create(mk('p-a', '2026-10-01T10:00:00.000Z'))
    writeFileSync(join(root, 'p-a', 'project.json'), 'x', 'utf8')
    writeFileSync(join(root, 'p-a', 'versions', '001.json'), 'x', 'utf8')
    expect(() => store.load('p-a')).toThrow()
  })

  it('list ordena por updatedAt desc e ignora pastas inválidas', () => {
    store.create(mk('p-a', '2026-10-01T10:00:00.000Z'))
    store.create(mk('p-b', '2026-10-02T10:00:00.000Z'))
    store.create(mk('p-c', '2026-09-30T10:00:00.000Z'))
    writeFileSync(join(root, 'lixo.txt'), 'x')
    rmSync(join(root, 'p-c', 'project.json'))
    rmSync(join(root, 'p-c', 'versions'), { recursive: true })
    expect(store.list().map((s) => s.id)).toEqual(['p-b', 'p-a'])
  })

  it('cached resolve id em minúsculo após save', () => {
    store.create(mk('P-Abc', '2026-10-01T10:00:00.000Z'))
    expect(store.cached('p-abc').id).toBe('P-Abc')
  })

  it('filePath e dirOf rejeitam caminhos inválidos', () => {
    expect(() => store.filePath('p-a', '../x')).toThrow()
    expect(() => store.filePath('p-a', 'a/b/c')).toThrow()
    expect(() => store.dirOf('a/b')).toThrow()
    expect(() => store.dirOf('..')).toThrow()
    expect(store.filePath('p-a', 'proxies/x.mp4')).toBe(join(root, 'p-a', 'proxies', 'x.mp4'))
  })

  it('remove envia a pasta à lixeira', async () => {
    store.create(mk('p-a', '2026-10-01T10:00:00.000Z'))
    await store.remove('p-a')
    expect(trashed).toEqual([join(root, 'p-a')])
  })

  it('assetPath resolve por origem e variante; asset desconhecido lança', () => {
    const sessions = new SessionStore({ rawRoot: () => join(root, 'Brutos'), trash: async () => {} })
    const base = { name: 'x', kind: 'video' as const, durationUs: 1, status: 'ready' as const }
    const assets: Asset[] = [
      { ...base, id: 'f', source: { type: 'file', path: 'C:\\v\\a.mov', size: 1, mtimeMs: 1 }, proxy: 'proxies/f.mp4' },
      { ...base, id: 's', source: { type: 'session', sessionId: '2026-08-18T14-32-05', stream: 'screen' } },
      { ...base, id: 'g', source: { type: 'generated', file: 'generated/n.wav' } }
    ]
    const p = { ...mk('p-a', '2026-10-01T10:00:00.000Z'), assets }
    expect(store.assetPath(p, 'f', 'original', sessions)).toBe('C:\\v\\a.mov')
    expect(store.assetPath(p, 'f', 'proxy', sessions)).toBe(join(root, 'p-a', 'proxies', 'f.mp4'))
    expect(store.assetPath(p, 's', 'original', sessions)).toBe(join(root, 'Brutos', '2026-08-18T14-32-05', 'rec.mp4'))
    expect(store.assetPath(p, 'g', 'original', sessions)).toBe(join(root, 'p-a', 'generated', 'n.wav'))
    expect(() => store.assetPath(p, 'zz', 'original', sessions)).toThrow()
    expect(() => store.assetPath(p, 's', 'proxy', sessions)).toThrow()
  })

  it('create recusa sobrescrever um projeto existente', () => {
    const p = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p)
    expect(() => store.create({ ...p, name: 'outro' })).toThrow(/já existe/)
    expect(store.load('p-a').name).toBe(p.name)
  })

  it('withMediaStatus marca file assets ausentes ou com tamanho diferente como missing e restaura os que voltaram', () => {
    const media = join(root, 'midia.mp4')
    writeFileSync(media, Buffer.alloc(10))
    const base = { name: 'x', kind: 'video' as const, durationUs: 1 }
    const assets: Asset[] = [
      { ...base, id: 'ok', status: 'ready', source: { type: 'file', path: media, size: 10, mtimeMs: 1 } },
      { ...base, id: 'gone', status: 'ready', source: { type: 'file', path: join(root, 'nao-existe.mp4'), size: 10, mtimeMs: 1 } },
      { ...base, id: 'changed', status: 'processing', source: { type: 'file', path: media, size: 99, mtimeMs: 1 } },
      { ...base, id: 'back', status: 'missing', source: { type: 'file', path: media, size: 10, mtimeMs: 1 } },
      { ...base, id: 's', status: 'ready', source: { type: 'session', sessionId: 'x', stream: 'screen' } }
    ]
    const p = { ...mk('p-a', '2026-10-01T10:00:00.000Z'), assets }
    const r = store.withMediaStatus(p)
    expect(r.assets.map((a) => [a.id, a.status])).toEqual([['ok', 'ready'], ['gone', 'missing'], ['changed', 'missing'], ['back', 'ready'], ['s', 'ready']])
    expect(p.assets[1].status).toBe('ready') // não muta a entrada
    expect(store.withMediaStatus(r)).toBe(r) // nada mudou → mesma referência
  })

  it('cacheAssets acrescenta/substitui assets só na memória', () => {
    const p = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p)
    const a: Asset = { id: 'a1', name: 'a', kind: 'audio', source: { type: 'file', path: 'C:\m\a.mp3', size: 1, mtimeMs: 1 }, durationUs: 1, status: 'processing' }
    store.cacheAssets('p-a', [a])
    store.cacheAssets('P-A', [{ ...a, name: 'b' }])
    expect(store.cached('p-a').assets).toEqual([{ ...a, name: 'b' }])
    expect(store.load('p-a').assets).toEqual([]) // disco intocado
  })
})
