import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, promises as fsp, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findRelinkCandidates, relinkQuery, type RelinkFs, type RelinkMissing } from './relinkSearch'
import type { Asset, Project } from '@shared/editor/project'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relink-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Arquivo com `size` bytes (criando as pastas). */
function file(rel: string, size: number): string {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, Buffer.alloc(size, 1))
  return p
}

const missing = (assetId: string, rel: string, size: number): RelinkMissing => ({ assetId, path: join(root, rel), size, name: rel.split('/').pop()! })

describe('findRelinkCandidates', () => {
  it('acha na pasta irmã da original (nome sem diferenciar maiúsculas + tamanho exato)', async () => {
    mkdirSync(join(root, 'aulas/originais'), { recursive: true })
    const moved = file('aulas/movidos/Aula 1.MP4', 100)
    const r = await findRelinkCandidates([missing('a1', 'aulas/originais/aula 1.mp4', 100)])
    expect(r).toEqual([{ assetId: 'a1', path: moved, confidence: 'exact' }])
  })

  it('tamanho diferente não serve', async () => {
    file('aulas/movidos/aula.mp4', 99)
    mkdirSync(join(root, 'aulas/originais'), { recursive: true })
    expect(await findRelinkCandidates([missing('a1', 'aulas/originais/aula.mp4', 100)])).toEqual([])
  })

  it('ordem: subpasta da original e a própria pasta-mãe; a pasta de origem ausente não impede a busca', async () => {
    const inSub = file('proj/midia/novos/clip.mp4', 10)
    const inParent = file('proj/foto.png', 20)
    // clip.mp4 foi para uma subpasta da pasta original; foto.png subiu para a pasta-mãe
    const r = await findRelinkCandidates([missing('a', 'proj/midia/clip.mp4', 10), missing('b', 'proj/midia/foto.png', 20)])
    expect(r).toEqual([
      { assetId: 'a', path: inSub, confidence: 'exact' },
      { assetId: 'b', path: inParent, confidence: 'exact' }
    ])
    // pasta original apagada/renomeada: as irmãs continuam na busca
    const sib = file('proj2/renomeada/x.mp4', 3)
    expect(await findRelinkCandidates([missing('x', 'proj2/sumiu/x.mp4', 3)])).toEqual([{ assetId: 'x', path: sib, confidence: 'exact' }])
  })

  it('pastas onde estão os outros assets do projeto (moveram juntos) e extraRoots', async () => {
    const together = file('novo-lugar/b.mp4', 5)
    file('novo-lugar/a.mp4', 7) // o asset presente (outro)
    const extra = file('pendrive/fotos/c.png', 9)
    const r = await findRelinkCandidates(
      [missing('b', 'velho/b.mp4', 5), missing('c', 'velho/c.png', 9)],
      { otherAssetDirs: [join(root, 'novo-lugar')], extraRoots: [join(root, 'pendrive')] }
    )
    expect(r).toEqual([
      { assetId: 'b', path: together, confidence: 'exact' },
      { assetId: 'c', path: extra, confidence: 'exact' }
    ])
  })

  it('dois arquivos iguais (nome + tamanho) no mesmo nível de busca: ambíguo, sem candidato', async () => {
    mkdirSync(join(root, 'p/orig'), { recursive: true })
    file('p/copia1/v.mp4', 50)
    file('p/copia2/v.mp4', 50)
    const ok = file('p/copia1/w.mp4', 60)
    const r = await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50), missing('w', 'p/orig/w.mp4', 60)])
    expect(r).toEqual([{ assetId: 'w', path: ok, confidence: 'exact' }])
  })

  it('o nível mais próximo vence: achado na pasta original, cópia na irmã não torna ambíguo', async () => {
    const near = file('p/orig/sub/v.mp4', 50)
    file('p/outra/v.mp4', 50)
    const r = await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)])
    expect(r).toEqual([{ assetId: 'v', path: near, confidence: 'exact' }])
  })

  it('não desce mais de 1 nível abaixo de cada raiz', async () => {
    mkdirSync(join(root, 'p/orig'), { recursive: true })
    file('p/irma/fundo/v.mp4', 50) // 2 níveis abaixo da pasta-mãe
    file('extra/a/b/v.mp4', 50) // 2 níveis abaixo da raiz extra
    expect(await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)], { extraRoots: [join(root, 'extra')] })).toEqual([])
  })

  it('não segue links simbólicos/junções (pula o teste sem permissão para criá-los)', async (ctx) => {
    mkdirSync(join(root, 'p/orig'), { recursive: true })
    file('fora/v.mp4', 50)
    try {
      symlinkSync(join(root, 'fora'), join(root, 'p/link'), 'junction')
    } catch {
      ctx.skip()
      return
    }
    try {
      symlinkSync(join(root, 'fora/v.mp4'), join(root, 'p/orig/v2.mp4'), 'file')
    } catch {
      // link de arquivo exige privilégio no Windows: a junção já cobre o caso das pastas
    }
    expect(await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50), missing('v2', 'p/orig/v2.mp4', 50)])).toEqual([])
  })

  it('pastas ilegíveis são ignoradas em silêncio', async () => {
    const found = file('p/irma/v.mp4', 50)
    mkdirSync(join(root, 'p/orig'), { recursive: true })
    const real: RelinkFs = { readdir: (d, o) => fsp.readdir(d, o), lstat: (p) => fsp.lstat(p) }
    const failing: RelinkFs = {
      ...real,
      readdir: (d, o) => (d.toLowerCase().endsWith('orig') ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })) : real.readdir(d, o))
    }
    expect(await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)], {}, failing)).toEqual([{ assetId: 'v', path: found, confidence: 'exact' }])
  })

  it('para cedo quando todos foram achados (não lê as pastas dos outros assets nem as extras)', async () => {
    const found = file('p/orig2/v.mp4', 50)
    mkdirSync(join(root, 'p/orig'), { recursive: true })
    const read: string[] = []
    const spy: RelinkFs = { readdir: (d, o) => (read.push(d), fsp.readdir(d, o)), lstat: (p) => fsp.lstat(p) }
    const r = await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)], { otherAssetDirs: [join(root, 'x')], extraRoots: [join(root, 'y')] }, spy)
    expect(r).toEqual([{ assetId: 'v', path: found, confidence: 'exact' }])
    expect(read.some((d) => d.endsWith('x') || d.endsWith('y'))).toBe(false)
  })

  it('limites: maxDirs e maxEntries encerram a busca', async () => {
    mkdirSync(join(root, 'p/orig'), { recursive: true })
    for (let i = 0; i < 30; i++) mkdirSync(join(root, `p/irma${String(i).padStart(2, '0')}`))
    file('p/irma29/v.mp4', 50)
    const read: string[] = []
    const spy: RelinkFs = { readdir: (d, o) => (read.push(d), fsp.readdir(d, o)), lstat: (p) => fsp.lstat(p) }
    expect(await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)], { maxDirs: 5 }, spy)).toEqual([])
    expect(read.length).toBeLessThanOrEqual(5)
    expect(await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)], { maxEntries: 10 })).toEqual([])
    expect((await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)])).length).toBe(1)
  })

  it('timeout: pasta lenta (rede) não segura a busca além do prazo', async () => {
    mkdirSync(join(root, 'p/orig'), { recursive: true })
    const slow: RelinkFs = {
      readdir: (d, o) => new Promise((res) => setTimeout(() => res(fsp.readdir(d, o)), 10_000)),
      lstat: (p) => fsp.lstat(p)
    }
    const t0 = Date.now()
    expect(await findRelinkCandidates([missing('v', 'p/orig/v.mp4', 50)], { timeoutMs: 150 }, slow)).toEqual([])
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('lista vazia: nada a fazer', async () => {
    expect(await findRelinkCandidates([])).toEqual([])
  })
})

describe('relinkQuery', () => {
  const asset = (id: string, path: string, status: Asset['status'], type: 'file' | 'session' = 'file'): Asset =>
    ({ id, name: id + '.mp4', kind: 'video', durationUs: 1, status, source: type === 'file' ? { type, path, size: 10, mtimeMs: 0 } : { type, sessionId: 's', stream: 'screen' } }) as Asset
  const proj = (assets: Asset[]): Project => ({ assets }) as unknown as Project

  it('só importadas ausentes entram; pastas dos presentes viram otherAssetDirs; extraRoots só de pastas do projeto', () => {
    const p = proj([
      asset('a', 'C:\\v\\a.mp4', 'missing'),
      asset('b', 'D:\\novo\\b.mp4', 'ready'),
      asset('c', 'D:\\novo\\c.mp4', 'processing'),
      asset('s', '', 'missing', 'session')
    ])
    const q = relinkQuery(p, ['d:\\NOVO', 'C:\\Windows', 42 as unknown as string])
    expect(q.missing).toEqual([{ assetId: 'a', path: 'C:\\v\\a.mp4', size: 10, name: 'a.mp4' }])
    expect(q.otherAssetDirs).toEqual(['D:\\novo'])
    expect(q.extraRoots).toEqual(['d:\\NOVO'])
  })
})
