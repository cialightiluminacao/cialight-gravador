import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectStore } from './projectStore'
import { SessionStore } from '../session/sessionStore'
import { createEmptyProject } from '@shared/editor/factory'
import type { Asset, Project } from '@shared/editor/project'
import { sourceFingerprint } from '@shared/editor/audioProcess'

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
    store = new ProjectStore({ projectsRoot: () => root, trash: async (p) => void trashed.push(p), now: () => clock, sessionMediaExists: (id) => id !== 'apagada' })
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

  it('processedAudioPath: arquivo em generated/ por (asset, chave, impressão); chave/impressão inválida ou asset desconhecido lança', () => {
    const base = { name: 'x', kind: 'audio' as const, durationUs: 1, status: 'ready' as const }
    const p = { ...mk('p-a', '2026-10-01T10:00:00.000Z'), assets: [{ ...base, id: 'm', source: { type: 'session' as const, sessionId: 's', stream: 'mic' as const } }] }
    expect(store.processedAudioPath(p, 'm', 'dn-sh', '2n-ab')).toBe(join(root, 'p-a', 'generated', 'm.audio-dn-sh.2n-ab.m4a'))
    expect(() => store.processedAudioPath(p, 'm', '../x', '2n-ab')).toThrow()
    expect(() => store.processedAudioPath(p, 'm', 'dn-sh', '../x')).toThrow()
    expect(() => store.processedAudioPath(p, 'zz', 'dn-sh', '2n-ab')).toThrow()
  })

  it('withMediaStatus tira de processedAudio as chaves sem arquivo (outro PC), de parâmetros antigos ou de outra fonte', () => {
    const rec = join(root, 'rec.mp4')
    writeFileSync(rec, Buffer.alloc(10))
    const s2 = new ProjectStore({ projectsRoot: () => root, trash: async () => {}, sessionMediaExists: () => true, sessionMediaFile: () => rec })
    const p0 = mk('p-a', '2026-10-01T10:00:00.000Z')
    s2.create(p0)
    const st = statSync(rec)
    const fp = sourceFingerprint(st.size, st.mtimeMs)
    for (const f of [`m.audio-dn-sh.${fp}.m4a`, `m.audio-dn-old.${fp}.m4a`, 'm.audio-ln-i16-tp1.5.0-0.m4a']) writeFileSync(join(root, 'p-a', 'generated', f), 'x')
    const base = { name: 'x', kind: 'audio' as const, durationUs: 1, status: 'ready' as const, source: { type: 'session' as const, sessionId: 's', stream: 'mic' as const } }
    const p: Project = {
      ...p0,
      assets: [
        // ok | parâmetros antigos | arquivo de outra fonte (impressão diferente da do rec.mp4 atual) | sem arquivo
        { ...base, id: 'm', processedAudio: { 'dn-sh': fp, 'dn-old': fp, 'ln-i16-tp1.5': '0-0', 'dn-sh_ln-i16-tp1.5': fp } },
        { ...base, id: 'n', processedAudio: { 'dn-sh': fp } }
      ]
    }
    const r = s2.withMediaStatus(p)
    expect(r.assets.map((a) => a.processedAudio)).toEqual([{ 'dn-sh': fp }, undefined])
    expect(s2.withMediaStatus(r)).toBe(r)
  })

  it('removeProcessedAudio apaga só os arquivos do asset, um a um (falha num não impede os outros)', () => {
    const p0 = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p0)
    const gen = join(root, 'p-a', 'generated')
    for (const f of ['m.audio-dn-sh.1-1.m4a', 'm.audio-ln-i16-tp1.5.1-1.m4a', 'mm.audio-dn-sh.1-1.m4a', 'n.audio-dn-sh.1-1.m4a', 'm.wav']) writeFileSync(join(gen, f), 'x')
    mkdirSync(join(gen, 'm.audio-dn-sh.2-2.m4a')) // não removível como arquivo (diretório não vazio)
    writeFileSync(join(gen, 'm.audio-dn-sh.2-2.m4a', 'dentro'), 'x')
    const removed = store.removeProcessedAudio('p-a', 'm')
    expect(removed).toBe(2)
    expect(readdirSync(gen).sort()).toEqual(['m.audio-dn-sh.2-2.m4a', 'm.wav', 'mm.audio-dn-sh.1-1.m4a', 'n.audio-dn-sh.1-1.m4a'])
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
      { ...base, id: 'backDone', status: 'missing', filmstrip: 'cache/b.strip.jpg', source: { type: 'file', path: media, size: 10, mtimeMs: 1 } },
      { ...base, id: 'backErr', status: 'missing', error: 'proxy: falhou', source: { type: 'file', path: media, size: 10, mtimeMs: 1 } },
      { ...base, id: 'err', status: 'error', error: 'x', source: { type: 'file', path: media, size: 10, mtimeMs: 1 } },
      { ...base, id: 's', status: 'ready', source: { type: 'session', sessionId: 'x', stream: 'screen' } },
      { ...base, id: 'sGone', status: 'ready', source: { type: 'session', sessionId: 'apagada', stream: 'screen' } },
      { ...base, id: 'sBack', status: 'missing', source: { type: 'session', sessionId: 'x', stream: 'mic' } }
    ]
    const p = { ...mk('p-a', '2026-10-01T10:00:00.000Z'), assets }
    const r = store.withMediaStatus(p)
    expect(r.assets.map((a) => [a.id, a.status])).toEqual([
      ['ok', 'ready'], ['gone', 'missing'], ['changed', 'missing'],
      ['back', 'processing'], // voltou sem derivados → reprocessar
      ['backDone', 'ready'], // voltou com derivados completos
      ['backErr', 'error'], // erro anterior não some enquanto faltam derivados
      ['err', 'error'], ['s', 'ready'],
      ['sGone', 'missing'], // rec.mp4 da gravação sumiu (lixeira/limpeza)
      ['sBack', 'ready'] // gravação voltou
    ])
    expect(p.assets[1].status).toBe('ready') // não muta a entrada
    expect(store.withMediaStatus(r)).toBe(r) // nada mudou → mesma referência
  })

  it('cacheAssets acrescenta/substitui assets só na memória', () => {
    const p = mk('p-a', '2026-10-01T10:00:00.000Z')
    store.create(p)
    const a: Asset = { id: 'a1', name: 'a', kind: 'audio', source: { type: 'file', path: 'C:/m/a.mp3', size: 1, mtimeMs: 1 }, durationUs: 1, status: 'processing' }
    store.cacheAssets('p-a', [a])
    store.cacheAssets('P-A', [{ ...a, name: 'b' }])
    expect(store.cached('p-a').assets).toEqual([{ ...a, name: 'b' }])
    expect(store.load('p-a').assets).toEqual([]) // disco intocado
  })

  it('applyAssetPatch grava no disco mesclando assets só do cache e atualiza o cache', () => {
    const disk: Asset = { id: 'd1', name: 'd', kind: 'audio', source: { type: 'file', path: 'C:/m/d.mp3', size: 1, mtimeMs: 1 }, durationUs: 1, status: 'ready' }
    store.create({ ...mk('p-a', '2026-10-01T10:00:00.000Z'), assets: [disk] })
    const fresh: Asset = { ...disk, id: 'a1', name: 'novo', status: 'processing' }
    store.cacheAssets('p-a', [fresh])
    store.applyAssetPatch('p-a', 'a1', { peaks: 'cache/a1.peaks.bin', status: 'ready' }, '2026-10-02T00:00:00.000Z')
    const onDisk = JSON.parse(readFileSync(join(root, 'p-a', 'project.json'), 'utf8')) as Project
    expect(onDisk.assets.map((a) => [a.id, a.status, a.peaks])).toEqual([['d1', 'ready', undefined], ['a1', 'ready', 'cache/a1.peaks.bin']])
    expect(onDisk.updatedAt).toBe('2026-10-02T00:00:00.000Z')
    expect(store.cached('p-a').assets.find((a) => a.id === 'a1')?.peaks).toBe('cache/a1.peaks.bin')
  })

  it('applyAssetPatch de asset que não existe em lugar nenhum lança', () => {
    store.create(mk('p-a', '2026-10-01T10:00:00.000Z'))
    expect(() => store.applyAssetPatch('p-a', 'zz', { status: 'ready' }, '2026-10-02T00:00:00.000Z')).toThrow()
  })
})

describe('ProjectStore.sessionUsage', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cialight-proj-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lista, por gravação, os projetos que a usam (origem, assets de sessão, anotações); ignora pastas inválidas', () => {
    const store = new ProjectStore({ projectsRoot: () => root, trash: async () => {} })
    const a: Asset = { id: 'x', name: 'x', kind: 'video', durationUs: 1, status: 'ready', source: { type: 'session', sessionId: 's2', stream: 'screen' } }
    store.create({ ...mk('p-a', '2026-10-01T10:00:00.000Z'), originSessionId: 's1' })
    store.create({ ...mk('p-b', '2026-10-01T10:00:00.000Z'), assets: [a] })
    store.create({ ...mk('p-c', '2026-10-01T10:00:00.000Z'), originSessionId: 's1', assets: [a] })
    writeFileSync(join(root, 'lixo.txt'), 'x')
    const u = store.sessionUsage()
    expect(u.get('s1')?.map((p) => p.id).sort()).toEqual(['p-a', 'p-c'])
    expect(u.get('s2')?.map((p) => p.name).sort()).toEqual(['Projeto p-b', 'Projeto p-c'])
    expect(u.has('s3')).toBe(false)
  })
})

describe('ProjectStore.projectDirs', () => {
  it('só as pastas (para a limpeza de temporários)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cialight-proj-'))
    try {
      const store = new ProjectStore({ projectsRoot: () => root, trash: async () => {} })
      store.create(mk('p-a', '2026-10-01T10:00:00.000Z'))
      store.create(mk('p-b', '2026-10-01T10:00:00.000Z'))
      writeFileSync(join(root, 'solto.txt'), 'x')
      expect(store.projectDirs().sort()).toEqual([join(root, 'p-a'), join(root, 'p-b')])
      expect(new ProjectStore({ projectsRoot: () => join(root, 'nao-existe'), trash: async () => {} }).projectDirs()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ProjectStore: arquivos gerados (narração) e recuperação', () => {
  let root: string
  let store: ProjectStore
  const meta = (startUs: number) => ({ kind: 'narration' as const, startUs, inUs: 0, createdAt: '2026-10-02T10:00:00.000Z' })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cialight-gen-'))
    store = new ProjectStore({ projectsRoot: () => root, trash: async () => {} })
    store.create(mk('p-a', '2026-10-01T10:00:00.000Z'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('nome livre narracao-<n>, escrita por posição, marcador com o meta enquanto não vira asset', () => {
    const a = store.openGeneratedWrite('p-a', 'narracao', 'm4a', meta(1))
    expect(a.rel).toBe('generated/narracao-1.m4a')
    const b = store.openGeneratedWrite('p-a', 'narracao', 'm4a', meta(2))
    expect(b.rel).toBe('generated/narracao-2.m4a')
    store.writeGenerated(a.handle, new Uint8Array([1, 2, 3, 4]), 0)
    store.writeGenerated(a.handle, new Uint8Array([9]), 1)
    store.setGeneratedMeta(a.handle, { ...meta(1), startUs: 500, inUs: 20 })
    store.closeGeneratedWrite(a.handle)
    store.closeGeneratedWrite(b.handle)
    expect([...readFileSync(join(root, 'p-a', 'generated', 'narracao-1.m4a'))]).toEqual([1, 9, 3, 4])
    // o 2º ficou vazio: nada a recuperar (marcador limpo); o 1º volta com o meta atualizado
    expect(store.pendingGenerated('p-a')).toEqual([{ rel: 'generated/narracao-1.m4a', meta: { ...meta(1), startUs: 500, inUs: 20 }, bytes: 4 }])
    expect(existsSync(join(root, 'p-a', 'generated', 'narracao-2.m4a.pending.json'))).toBe(false)
    // o número seguinte não reusa nomes existentes
    const c = store.openGeneratedWrite('p-a', 'narracao', 'm4a', meta(3))
    expect(c.rel).toBe('generated/narracao-3.m4a')
    store.closeGeneratedWrite(c.handle)
  })

  it('gravação ainda aberta não aparece como pendente; usada por um asset do projeto ou limpa → some', () => {
    const a = store.openGeneratedWrite('p-a', 'narracao', 'm4a', meta(1))
    store.writeGenerated(a.handle, new Uint8Array([1]), 0)
    expect(store.pendingGenerated('p-a')).toEqual([])
    store.closeGeneratedWrite(a.handle)
    expect(store.pendingGenerated('p-a')).toHaveLength(1)
    const p = store.load('p-a')
    const asset: Asset = { id: 'n1', name: 'Narração 1', kind: 'audio', source: { type: 'generated', file: a.rel }, durationUs: 1, status: 'processing' }
    store.save({ ...p, assets: [asset] })
    expect(store.pendingGenerated('p-a')).toEqual([])
    expect(existsSync(join(root, 'p-a', 'generated', 'narracao-1.m4a.pending.json'))).toBe(false)

    const b = store.openGeneratedWrite('p-a', 'narracao', 'm4a', meta(2))
    store.writeGenerated(b.handle, new Uint8Array([1]), 0)
    store.closeGeneratedWrite(b.handle)
    store.clearPendingGenerated('p-a', b.rel)
    expect(store.pendingGenerated('p-a')).toEqual([])
    expect(existsSync(join(root, 'p-a', b.rel))).toBe(true) // o arquivo fica
  })

  it('closeGeneratedWritesOf fecha as escritas de uma janela (renderer caiu): o parcial vira pendente', () => {
    const a = store.openGeneratedWrite('p-a', 'narracao', 'm4a', meta(1), 7)
    const b = store.openGeneratedWrite('p-a', 'narracao', 'm4a', meta(2), 8)
    store.writeGenerated(a.handle, new Uint8Array([5, 5]), 0)
    store.writeGenerated(b.handle, new Uint8Array([6]), 0)
    store.closeGeneratedWritesOf(7)
    expect(store.pendingGenerated('p-a').map((x) => x.rel)).toEqual(['generated/narracao-1.m4a'])
    expect(() => store.writeGenerated(a.handle, new Uint8Array([1]), 0)).toThrow()
    store.closeGeneratedWrite(b.handle)
  })

  it('nome/extensão inválidos e meta malformado no disco', () => {
    expect(() => store.openGeneratedWrite('p-a', '../x', 'm4a', meta(1))).toThrow()
    expect(() => store.openGeneratedWrite('p-a', 'narracao', 'exe' as 'm4a', meta(1))).toThrow()
    writeFileSync(join(root, 'p-a', 'generated', 'lixo.m4a'), 'x')
    writeFileSync(join(root, 'p-a', 'generated', 'lixo.m4a.pending.json'), '{nao json')
    expect(store.pendingGenerated('p-a')).toEqual([])
  })
})
